#!/usr/bin/env bash
# Opens the PiScreen display page fullscreen in Chromium (kiosk mode).
URL="${PISCREEN_URL:-http://localhost:8080/display}"

# Wait for the server to come up (up to ~60s after boot).
for _ in $(seq 1 60); do
  curl -fs -o /dev/null "$URL" && break
  sleep 1
done

BROWSER="$(command -v chromium-browser || command -v chromium)"
if [[ -z "$BROWSER" ]]; then
  echo "Chromium not found" >&2
  exit 1
fi

exec "$BROWSER" \
  --kiosk \
  --incognito \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  "$URL"
