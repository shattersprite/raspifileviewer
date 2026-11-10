#!/usr/bin/env bash
# PiScreen installer for Raspberry Pi OS (Bookworm or newer, Desktop edition).
# Run as your normal desktop user (NOT with sudo):   ./install.sh
# Add --office to also install LibreOffice for PowerPoint/Word/Excel support.
set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run this as your normal user (it uses sudo where needed): ./install.sh" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"
WITH_OFFICE=0
[[ "${1:-}" == "--office" ]] && WITH_OFFICE=1

echo "==> Installing packages"
sudo apt-get update
PKGS=(python3-flask python3-qrcode poppler-utils curl)
if ! command -v chromium-browser >/dev/null && ! command -v chromium >/dev/null; then
  PKGS+=(chromium-browser)
fi
[[ $WITH_OFFICE -eq 1 ]] && PKGS+=(libreoffice-impress libreoffice-writer libreoffice-calc)
sudo apt-get install -y "${PKGS[@]}"

chmod +x "$APP_DIR/kiosk.sh" "$APP_DIR/server.py"

echo "==> Creating the piscreen service (web server, starts at boot)"
sudo tee /etc/systemd/system/piscreen.service >/dev/null <<EOF
[Unit]
Description=PiScreen upload & display server
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/python3 $APP_DIR/server.py
Restart=always
RestartSec=2
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now piscreen.service
sudo systemctl restart piscreen.service

echo "==> Opening the display fullscreen when the desktop starts"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/piscreen-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=PiScreen Kiosk
Exec=$APP_DIR/kiosk.sh
X-GNOME-Autostart-enabled=true
EOF

# labwc (the default compositor on newer Pi OS) reads its own autostart file.
if [[ -d "$HOME/.config/labwc" ]] || command -v labwc >/dev/null; then
  mkdir -p "$HOME/.config/labwc"
  touch "$HOME/.config/labwc/autostart"
  grep -q "kiosk.sh" "$HOME/.config/labwc/autostart" || echo "$APP_DIR/kiosk.sh &" >> "$HOME/.config/labwc/autostart"
  # Avoid starting it twice via the XDG entry as well.
  rm -f "$HOME/.config/autostart/piscreen-kiosk.desktop"
fi

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Done!"
echo "  Control it from any device on your network:  http://$IP:8080/"
echo "                                           or:  http://$(hostname).local:8080/"
echo "  Reboot the Pi (sudo reboot) to start the fullscreen display, or run: $APP_DIR/kiosk.sh"
echo
echo "Tip: to stop the screen from going to sleep, run:  sudo raspi-config nonint do_blanking 1"
