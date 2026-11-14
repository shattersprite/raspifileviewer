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

## Desktop app (Windows)

The desktop app does everything the web page does. It can also **send your screen to the Pi**, mirrored or as an **extra monitor**, and it **prompts you when updates are available** for the app or for the Pi.

1. Download `PiScreen-Setup-x.y.z.exe` from the [Releases page](https://github.com/shattersprite/raspifileviewer/releases) and install it.
2. Open PiScreen. It searches your network and connects to the Pi. You can also type the Pi's address at the top.
3. **Files & remote** tab: upload files and control the screen.
4. **Share screen** tab: pick a screen or window, then press **Start sharing**.

### Using the Pi as an extra monitor
Windows can only extend onto a screen it thinks is plugged in, so the app needs a virtual display:

1. Install the free [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver/releases). You only need to do this once.
2. Open Windows **Settings → System → Display**. Choose **Extend these displays**, and set the new display to the Pi's resolution. The app shows this resolution.
3. In PiScreen, click **Refresh**, pick the new screen (it's marked *matches the Pi*), and press **Start sharing**.

The picture is sent directly from your PC to the Pi over WebRTC, so it never leaves your network.
On a Pi 4, use **Sharp text · 30 fps** or **Light**. A Pi 5 can usually handle **Smooth · 60 fps**.

### If screen sharing shows a black screen
PiScreen checks every share and works around common problems by itself:
- **The Pi can't decode the video:** the app switches format (VP8, then H.264, which a Pi 4 decodes in hardware), then tries a lower resolution.
- **The Pi decodes the video but doesn't draw it:** the Pi switches to drawing frames itself ("canvas drawing").
- **Nothing reaches the Pi:** the Pi's screen and the app both say so. This is a network problem: put the computer and the Pi on the same network, or allow PiScreen through your firewall or VPN.

The app's **Share screen** panel shows what the Pi reports, for example "VP8, 1200 packets, 0 frames". Include that line if you report a problem.

To always use canvas drawing on a Pi, add `?canvas=1` to the display address. Then restart the Pi:
```bash
sed -i 's#^URL=.*#URL="${PISCREEN_URL:-http://localhost:8080/display?canvas=1}"#' ~/piscreen/kiosk.sh
```

### Using a Raspberry Pi 3 (or Zero)
PiScreen detects a Pi 3 or Zero and switches to **low-power mode** on its own:
- Screen sharing is capped at **1280×720, 15 fps**, and the 60 fps option is turned off. For the extra-monitor setup, set the virtual display to **1280×720** so text stays sharp.
- PDF pages render at 1920 px instead of 2400 px, which makes conversion faster.
- The welcome screen skips its blur effect.

Other tips for a Pi 3:
- **Videos:** use 720p MP4 (H.264). 1080p videos will likely stutter.
- **Big PDFs:** these take a while to convert. The first page shows as soon as it's ready.
- **`--office` (LibreOffice):** it works, but it's slow with 1 GB of RAM. Exporting slides to PDF on your computer first is much faster.

## Storage cleanup

In **Admin → Storage** you can see how much space PiScreen's files take up, and set rules:
- **Delete files that haven't been shown for** 1 day, 1 week, 30 days or 90 days.
- **Always keep this much space free:** when the SD card gets fuller than this, the least recently shown files are deleted first.

Cleanup runs every hour and after each upload. The file currently on screen, and files still converting, are never deleted.
There are also **Clean up now** and **Delete all files** buttons.

### Updates
- **App:** when a new release is published, the app asks whether to download it, then whether to restart and install it.
- **Pi server:** the app asks the Pi to check GitHub for new commits. If there are any, it shows what changed and asks whether to update. The Pi then runs `git pull` and restarts itself, and the display reloads automatically.
  This only works if you installed with `git clone`.

### Building and releasing the app
```bash
cd client
npm install
npm start          # run in development
npm run dist       # build the installer locally into client/dist
```
To publish a release that installed apps will offer as an update:
1. Bump `version` in `client/package.json` and in `VERSION`, then commit.
2. Push a tag that matches, for example `git tag v1.2.0 && git push origin v1.2.0`.
   GitHub Actions builds the installer and publishes the release.

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
| `PISCREEN_PAGE_PX` | `2400` (`1920` on a Pi 3) | Resolution of the long side of a rendered PDF page. Lower it (for example 1600) for faster conversion. |
| `PISCREEN_LOW_POWER` | automatic | `1` forces low-power mode on, `0` forces it off. |
| `PISCREEN_DATA` | `./data` | Where uploads are stored |

## Admin and locking the screen

In the desktop app, open **Admin** and enter the admin code. The default code is **6952**.

| Setting | What it does |
|---|---|
| **Screen name** | Shown on the Pi's welcome screen, in the app, and on the remote. |
| **Anyone on the network** | No lock. This is the default. |
| **Passcode** | Phones, browsers and other computers must enter your passcode before they can share or control the screen. |
| **Only this computer** | Only the computer you set this from can share or control the screen. Everyone else sees a locked screen. |
| **Admin code** | Change the admin code. |

- Changing the lock signs everyone out immediately, including remotes that are already open.
- The admin code always gets you in, so a lost computer can't lock you out for good.
- After 5 wrong guesses, that device has to wait 60 seconds before trying again.

> **Change the admin code after installing.** This repository is public, so the default code is too.

To reset everything, run this on the Pi (it removes the lock, the name and the admin code):
```bash
rm ~/piscreen/data/settings.json && sudo systemctl restart piscreen
```

## Security note

PiScreen is built for your home or office network. Don't forward port 8080 to the internet: the connection isn't encrypted (plain HTTP), so passcodes could be read by anyone between you and the Pi.

## Trying it on a PC

```bash
pip install -r requirements.txt
python server.py
```
Open `http://localhost:8080/display` in one window and `http://localhost:8080/` in another.
To convert PDFs on a PC, `pdftoppm` and `pdfinfo` from poppler must be on your PATH.
