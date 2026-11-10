# PiScreen

Upload a file from any phone or computer on your network, and the Raspberry Pi shows it fullscreen.
You control it from the same web page: change PDF pages, rotate, blank the screen, play or pause video.

```
 Phone / laptop  ──upload / control──▶  Raspberry Pi (server.py :8080)  ──live updates──▶  Chromium kiosk (/display)
```

## What it supports

| File type | What happens |
|---|---|
| **PDF** | Each page is rendered to an image on the Pi. Page 1 shows as soon as it's ready, while the rest are still converting. |
| **Images** (jpg, png, gif, webp, svg…) | Shown fullscreen. |
| **Video** (mp4, webm, mov…) | Plays fullscreen. You get play/pause, ±10s, mute and loop controls. |
| **PowerPoint / Word / Excel** | Converted to PDF with LibreOffice (install with `--office`), then shown page by page. |

**Remote controls:** Prev/Next (or swipe on the preview), jump to a page, a page thumbnail grid, fit (whole / width / fill), rotate, scroll (in fit-to-width mode), blank screen, and stop.
A keyboard or USB presenter clicker plugged into the Pi also works (arrow keys, Page Up/Down, `B` to blank).

## Install on the Pi

You need Raspberry Pi OS **with desktop** (Bookworm or newer).

1. Copy this folder to the Pi. For example, from your PC:
   ```bash
   scp -r RaspberryPiUploader pi@raspberrypi.local:~/piscreen
   ```
2. On the Pi:
   ```bash
   cd ~/piscreen
   chmod +x install.sh
   ./install.sh            # or: ./install.sh --office   (adds PowerPoint/Word support, ~500 MB)
   sudo reboot
   ```
3. After the reboot the screen shows an address and a QR code. Open it on your phone, for example `http://192.168.1.50:8080`.

To stop the display from sleeping: `sudo raspi-config nonint do_blanking 1`

## Useful commands (on the Pi)

```bash
sudo systemctl status piscreen     # is the server running?
journalctl -u piscreen -f          # server logs
sudo systemctl restart piscreen    # restart after editing files
```

Uploaded files are stored in `data/`, and they're kept across reboots. Delete them from the Library on the control page.

## Settings (environment variables in the service)

| Variable | Default | Meaning |
|---|---|---|
| `PISCREEN_PORT` | `8080` | Web port |
| `PISCREEN_PAGE_PX` | `2400` | Resolution of the long side of a rendered PDF page. Lower it (for example 1600) for faster conversion on older Pis. |
| `PISCREEN_DATA` | `./data` | Where uploads are stored |

## Security note

There is no login: anyone on your network can upload to the screen and control it. That's fine on a home network. Don't forward port 8080 to the internet.

## Trying it on a PC

```bash
pip install -r requirements.txt
python server.py
```
Open `http://localhost:8080/display` in one window and `http://localhost:8080/` in another.
To convert PDFs on a PC, `pdftoppm` and `pdfinfo` from poppler must be on your PATH.
