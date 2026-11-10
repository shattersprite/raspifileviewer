"""Admin code and screen lock for PiScreen.

Lock modes (set from the Admin tab after entering the admin code):
  off       anyone on the network can control the screen
  passcode  people must enter a passcode first
  device    only one chosen computer (the admin's) can control it

The admin code always unlocks everything, so a lost computer can't lock you out.
The Pi itself (localhost, i.e. the display page) always has access.
"""
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path

DEFAULT_ADMIN_CODE = os.environ.get("PISCREEN_ADMIN_CODE", "6952")
MODES = ("off", "passcode", "device")
MAX_FAILS = 5        # wrong tries allowed…
LOCKOUT_SECONDS = 60  # …before that address must wait this long


def _hash(secret: str, salt: str = None) -> dict:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", secret.encode(), bytes.fromhex(salt), 100_000).hex()
    return {"salt": salt, "hash": digest}


def _matches(secret: str, record: dict) -> bool:
    return bool(record) and hmac.compare_digest(_hash(secret, record["salt"])["hash"], record["hash"])


def _device_hash(device_id: str) -> str:
    return hashlib.sha256(device_id.encode()).hexdigest()


class Auth:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._fails = {}  # ip -> (count, blocked_until)
        self.s = self._load()

    # ----------------------------------------------------------- storage
    def _load(self) -> dict:
        try:
            s = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            s = {}
        s.setdefault("secret", secrets.token_hex(32))
        s.setdefault("admin", _hash(DEFAULT_ADMIN_CODE))
        s.setdefault("admin_gen", 1)
        s.setdefault("lock_gen", 1)
        s.setdefault("name", "PiScreen")
        s.setdefault("lock", {"mode": "off"})
        self._save(s)
        return s

    def _save(self, s=None):
        s = s or self.s
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, indent=1), "utf-8")
        os.replace(tmp, self.path)

    # ----------------------------------------------------------- tokens
    def _sign(self, kind: str, gen: int) -> str:
        return hmac.new(bytes.fromhex(self.s["secret"]), f"{kind}|{gen}".encode(), "sha256").hexdigest()

    def admin_token(self) -> str:
        return self._sign("admin", self.s["admin_gen"])

    def access_token(self) -> str:
        return self._sign("access", self.s["lock_gen"])

    def is_admin(self, token) -> bool:
        return bool(token) and hmac.compare_digest(str(token), self.admin_token())

    def is_locked_device(self, device_id) -> bool:
        stored = self.s["lock"].get("device")
        return bool(device_id and stored) and hmac.compare_digest(_device_hash(str(device_id)), stored)

    def has_access(self, creds: dict) -> bool:
        if self.is_admin(creds.get("admin")):
            return True
        mode = self.s["lock"]["mode"]
        if mode == "off":
            return True
        if mode == "passcode":
            token = creds.get("access")
            return bool(token) and hmac.compare_digest(str(token), self.access_token())
        if mode == "device":
            return self.is_locked_device(creds.get("device"))
        return False

    # ----------------------------------------------------------- logins
    def _wait(self, ip) -> int:
        _, until = self._fails.get(ip, (0, 0))
        return max(0, int(until - time.time() + 0.999))

    def _record(self, ip, ok: bool):
        if ok:
            self._fails.pop(ip, None)
            return
        count, _ = self._fails.get(ip, (0, 0))
        count += 1
        self._fails[ip] = (0, time.time() + LOCKOUT_SECONDS) if count >= MAX_FAILS else (count, 0)

    def try_admin(self, code: str, ip: str):
        """Returns (ok, seconds_to_wait)."""
        with self._lock:
            wait = self._wait(ip)
            if wait:
                return False, wait
            ok = _matches(code, self.s["admin"])
            self._record(ip, ok)
            return ok, 0

    def try_passcode(self, code: str, ip: str):
        with self._lock:
            wait = self._wait(ip)
            if wait:
                return False, wait
            lock = self.s["lock"]
            ok = lock["mode"] == "passcode" and _matches(code, lock.get("passcode"))
            self._record(ip, ok)
            return ok, 0

    # ----------------------------------------------------------- settings
    def public(self) -> dict:
        lock = self.s["lock"]
        return {"name": self.s["name"], "lock": lock["mode"], "device_name": lock.get("device_name", "")}

    def update(self, name=None, mode=None, passcode=None, device_id=None, device_name=None):
        """Change settings. Returns an error message, or None on success."""
        with self._lock:
            if name is not None:
                name = str(name).strip()[:40]
                if not name:
                    return "The screen name can't be empty."
                self.s["name"] = name
            if mode is not None:
                if mode not in MODES:
                    return "Unknown lock mode."
                old = self.s["lock"]
                new = {"mode": mode}
                if mode == "passcode":
                    passcode = str(passcode or "")
                    if passcode:
                        if len(passcode) < 4:
                            return "The passcode must be at least 4 characters."
                        new["passcode"] = _hash(passcode)
                    elif old.get("mode") == "passcode" and old.get("passcode"):
                        new["passcode"] = old["passcode"]  # keep the current passcode
                    else:
                        return "Enter a passcode."
                elif mode == "device":
                    if not device_id:
                        return "This device can't be identified. Use the PiScreen app."
                    new["device"] = _device_hash(str(device_id))
                    new["device_name"] = str(device_name or "Admin's computer")[:60]
                if new != old:
                    self.s["lock"] = new
                    self.s["lock_gen"] += 1  # everyone who unlocked before must unlock again
            self._save()
            return None

    def set_admin_code(self, code: str):
        code = str(code or "")
        if len(code) < 4:
            return "The admin code must be at least 4 characters."
        with self._lock:
            self.s["admin"] = _hash(code)
            self.s["admin_gen"] += 1  # signs out admin sessions everywhere else
            self._save()
        return None
