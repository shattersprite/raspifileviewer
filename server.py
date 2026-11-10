#!/usr/bin/env python3
"""PiScreen - upload files from any device on your network and show them
fullscreen on a Raspberry Pi, with remote control from your phone/laptop.

  Control page:  http://<pi-address>:8080/
  Display page:  http://localhost:8080/display   (opened in kiosk mode on the Pi)
"""
import io
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import Flask, Response, abort, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("PISCREEN_DATA", BASE_DIR / "data"))
MEDIA_DIR = DATA_DIR / "media"
STATE_FILE = DATA_DIR / "state.json"
HOST = os.environ.get("PISCREEN_HOST", "0.0.0.0")
PORT = int(os.environ.get("PISCREEN_PORT", "8080"))
PAGE_PX = int(os.environ.get("PISCREEN_PAGE_PX", "2400"))  # long side of rendered PDF pages
THUMB_PX = 360

KINDS = {
    "pdf": {".pdf"},
    "office": {".ppt", ".pptx", ".pps", ".ppsx", ".odp", ".doc", ".docx", ".odt", ".rtf",
               ".xls", ".xlsx", ".ods"},
    "image": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"},
    "video": {".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"},
}
FITS = ("contain", "width", "cover")
ID_RE = re.compile(r"^[0-9a-f]{12}$")

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 ** 3  # 4 GB

_lock = threading.RLock()
_subscribers: list = []
_worker = ThreadPoolExecutor(max_workers=1)  # convert one document at a time (Pi-friendly)


def default_view():
    return {"item": None, "page": 1, "fit": "contain", "rotation": 0,
            "blank": False, "playing": True, "muted": False, "loop": True}


_state = {"items": [], "view": default_view()}


# --------------------------------------------------------------------------- state

def load_state():
    global _state
    if STATE_FILE.exists():
        try:
            loaded = json.loads(STATE_FILE.read_text("utf-8"))
            _state["items"] = [i for i in loaded.get("items", []) if (MEDIA_DIR / i["id"]).is_dir()]
            _state["view"] = {**default_view(), **loaded.get("view", {})}
        except Exception as exc:  # corrupt file: start fresh
            print(f"Could not read {STATE_FILE}: {exc}")
    if _state["view"]["item"] and not find_item(_state["view"]["item"]):
        _state["view"] = default_view()


def save_state():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_state, indent=1), "utf-8")
    os.replace(tmp, STATE_FILE)


def find_item(item_id):
    return next((i for i in _state["items"] if i["id"] == item_id), None)


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def broadcast(event, data):
    msg = sse(event, data)
    with _lock:
        for q in list(_subscribers):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


def commit():
    """Persist and push the full state to every connected page."""
    with _lock:
        save_state()
        broadcast("state", _state)


def update_item(item_id, **changes):
    with _lock:
        item = find_item(item_id)
        if item:
            item.update(changes)
            commit()
        return item


# ---------------------------------------------------------------- document convert

def run(cmd, timeout):
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout or "conversion failed").strip()[-300:])
    return res.stdout


def convert_office(src: Path) -> Path:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError("LibreOffice is not installed on the Pi (run ./install.sh --office)")
    run([soffice, "--headless", "--convert-to", "pdf", "--outdir", str(src.parent), str(src)], 900)
    pdf = src.with_suffix(".pdf")
    if not pdf.exists():
        raise RuntimeError("LibreOffice did not produce a PDF")
    return pdf


def pdf_page_count(pdf: Path) -> int:
    out = run(["pdfinfo", str(pdf)], 60)
    m = re.search(r"^Pages:\s+(\d+)", out, re.M)
    if not m:
        raise RuntimeError("Could not read page count")
    return int(m.group(1))


def render_page(pdf: Path, n: int, prefix: Path, px: int):
    run(["pdftoppm", "-f", str(n), "-l", str(n), "-scale-to", str(px), "-jpeg",
         "-jpegopt", "quality=88", "-singlefile", str(pdf), str(prefix)], 180)


def process_document(item_id: str, src: Path):
    folder = src.parent
    try:
        if not shutil.which("pdftoppm"):
            raise RuntimeError("poppler-utils is not installed (sudo apt install poppler-utils)")
        pdf = src if src.suffix.lower() == ".pdf" else convert_office(src)
        pages = pdf_page_count(pdf)
        if not update_item(item_id, pages=pages):
            return
        for n in range(1, pages + 1):
            if not find_item(item_id):
                return  # deleted while converting
            render_page(pdf, n, folder / f"page-{n:04d}", PAGE_PX)
            render_page(pdf, n, folder / f"thumb-{n:04d}", THUMB_PX)
            update_item(item_id, ready_pages=n)
        update_item(item_id, status="ready")
    except Exception as exc:
        print(f"Processing {item_id} failed: {exc}")
        update_item(item_id, status="error", error=str(exc))


# ---------------------------------------------------------------------- helpers

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def control_urls():
    host = socket.gethostname()
    return {"ip_url": f"http://{lan_ip()}:{PORT}/", "host_url": f"http://{host}.local:{PORT}/"}


def static_page(name):
    resp = send_from_directory(STATIC_DIR, name)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# ----------------------------------------------------------------------- routes

@app.get("/")
def control_page():
    return static_page("control.html")


@app.get("/display")
def display_page():
    return static_page("display.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC_DIR, name)


@app.get("/media/<item_id>/<path:filename>")
def media(item_id, filename):
    if not ID_RE.match(item_id):
        abort(404)
    resp = send_from_directory(MEDIA_DIR / item_id, filename, conditional=True)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.get("/api/info")
def info():
    return jsonify(control_urls())


@app.get("/api/qr.svg")
def qr_svg():
    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        abort(404)
    img = qrcode.make(control_urls()["ip_url"], image_factory=qrcode.image.svg.SvgPathImage, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), mimetype="image/svg+xml", headers={"Cache-Control": "no-cache"})


@app.get("/api/state")
def get_state():
    with _lock:
        return jsonify(_state)


@app.get("/api/events")
def events():
    q = queue.Queue(maxsize=200)
    with _lock:
        _subscribers.append(q)
        first = sse("state", _state)

    def stream():
        try:
            yield first
            while True:
                try:
                    yield q.get(timeout=15)
                except queue.Empty:
                    yield ": keep-alive\n\n"
        finally:
            with _lock:
                if q in _subscribers:
                    _subscribers.remove(q)

    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/upload")
def upload():
    files = [f for f in request.files.getlist("files") if f and f.filename]
    if not files:
        return jsonify(error="No files received"), 400
    show = request.form.get("show", "1") == "1"
    created, rejected = [], []
    for f in files:
        name = Path(f.filename).name
        ext = Path(name).suffix.lower()
        kind = next((k for k, exts in KINDS.items() if ext in exts), None)
        if not kind:
            rejected.append(name)
            continue
        item_id = uuid.uuid4().hex[:12]
        folder = MEDIA_DIR / item_id
        folder.mkdir(parents=True, exist_ok=True)
        src = folder / f"source{ext}"
        f.save(src)
        is_doc = kind in ("pdf", "office")
        item = {"id": item_id, "name": name, "kind": "pdf" if is_doc else kind, "ext": ext,
                "status": "processing" if is_doc else "ready",
                "pages": 1, "ready_pages": 0 if is_doc else 1,
                "error": None, "created": time.time()}
        with _lock:
            _state["items"].insert(0, item)
        if is_doc:
            _worker.submit(process_document, item_id, src)
        created.append(item)
    with _lock:
        if show and created:
            _state["view"].update(item=created[0]["id"], page=1, blank=False,
                                  playing=True, rotation=0)
        commit()
    return jsonify(created=created, rejected=rejected)


@app.delete("/api/items/<item_id>")
def delete_item(item_id):
    with _lock:
        item = find_item(item_id)
        if not item:
            abort(404)
        _state["items"].remove(item)
        if _state["view"]["item"] == item_id:
            _state["view"].update(item=None, page=1)
        commit()
    shutil.rmtree(MEDIA_DIR / item_id, ignore_errors=True)
    return jsonify(ok=True)


@app.post("/api/control")
def control():
    data = request.get_json(silent=True) or {}
    action = data.get("action")

    # One-shot commands for the display (not stored in state).
    if action in ("seek", "restart", "scroll"):
        broadcast("command", data)
        return jsonify(ok=True)

    with _lock:
        v = _state["view"]
        item = find_item(v["item"]) if v["item"] else None
        pages = item["pages"] if item and item["kind"] == "pdf" else 1

        def go(page):
            v["page"] = max(1, min(pages, int(page)))

        if action == "show":
            target = find_item(data.get("item"))
            if not target:
                return jsonify(error="Unknown item"), 404
            v.update(item=target["id"], page=1, blank=False, playing=True, rotation=0)
            pages = target["pages"] if target["kind"] == "pdf" else 1
            go(data.get("page", 1))
        elif action == "next":
            go(v["page"] + 1)
        elif action == "prev":
            go(v["page"] - 1)
        elif action == "first":
            go(1)
        elif action == "last":
            go(pages)
        elif action == "goto":
            try:
                go(data.get("page", 1))
            except (TypeError, ValueError):
                return jsonify(error="Bad page number"), 400
        elif action == "fit":
            fit = data.get("fit")
            v["fit"] = fit if fit in FITS else FITS[(FITS.index(v["fit"]) + 1) % len(FITS)]
        elif action == "rotate":
            v["rotation"] = (v["rotation"] + int(data.get("delta", 90))) % 360
        elif action == "blank":
            v["blank"] = bool(data["value"]) if "value" in data else not v["blank"]
        elif action == "stop":
            v.update(item=None, page=1, blank=False)
        elif action == "play":
            v["playing"] = bool(data["value"]) if "value" in data else not v["playing"]
        elif action == "mute":
            v["muted"] = not v["muted"]
        elif action == "loop":
            v["loop"] = not v["loop"]
        else:
            return jsonify(error=f"Unknown action: {action}"), 400
        commit()
        return jsonify(view=v)


def resume_unfinished():
    for item in _state["items"]:
        if item["status"] == "processing":
            src = MEDIA_DIR / item["id"] / f"source{item['ext']}"
            if src.exists():
                item["ready_pages"] = 0
                _worker.submit(process_document, item["id"], src)
            else:
                item.update(status="error", error="Source file missing")


if __name__ == "__main__":
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    load_state()
    resume_unfinished()
    urls = control_urls()
    print(f"PiScreen running.\n  Control: {urls['ip_url']}  (or {urls['host_url']})\n"
          f"  Display: http://localhost:{PORT}/display")
    app.run(host=HOST, port=PORT, threaded=True)
