// PiScreen desktop app — main process.
// Handles the window, screen capture sources, finding the Pi on the network,
// and update prompts for both this app and the Pi server.
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The Pi's display page needs real LAN addresses (not mDNS names) to connect directly.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const PORT = 8080;
let win = null;
let serverUrl = null;
let pendingSource = { id: null, audio: false };
const declinedServerUpdates = new Set();

// ------------------------------------------------------------------ config

const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = null;
function readConfig() {
  if (!config) {
    try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
    // A random id for this computer, used for "Only this computer" locks.
    if (!config.deviceId) writeConfig({ deviceId: require('crypto').randomBytes(16).toString('hex') });
  }
  return config;
}
function writeConfig(patch) {
  config = { ...(config || {}), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  return config;
}

// Saved unlock/admin tokens for each Pi: { [serverUrl]: { access, admin } }
function tokensFor(url) {
  return (readConfig().tokens || {})[url] || {};
}

// Headers for requests the main process makes itself (they skip the session hooks).
function piHeaders() {
  const t = tokensFor(serverUrl);
  const h = { 'X-PiScreen-Device': readConfig().deviceId };
  if (t.access) h['X-PiScreen-Access'] = t.access;
  if (t.admin) h['X-PiScreen-Admin'] = t.admin;
  return h;
}

// ------------------------------------------------------------------ window

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: 'PiScreen',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep streaming smoothly while minimized
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; hideToolbar(); });

  // Links (e.g. to the virtual display driver) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ------------------------------------------------------------------ floating toolbar (while sharing)

let toolbar = null;
function showToolbar() {
  if (toolbar && !toolbar.isDestroyed()) { toolbar.showInactive(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  const width = 470, height = 64;
  toolbar = new BrowserWindow({
    width, height,
    x: Math.round(area.x + (area.width - width) / 2), y: area.y + 12,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  toolbar.setAlwaysOnTop(true, 'screen-saver');
  toolbar.setContentProtection(true); // keep the toolbar itself out of the shared picture
  toolbar.loadFile(path.join(__dirname, 'renderer', 'toolbar.html'));
  toolbar.once('ready-to-show', () => toolbar.showInactive());
  toolbar.webContents.on('did-finish-load', () => win && win.webContents.send('toolbar:action', 'sync'));
  toolbar.on('closed', () => { toolbar = null; });
}
function hideToolbar() {
  if (toolbar && !toolbar.isDestroyed()) toolbar.close();
}

function setupSession() {
  const ses = session.defaultSession;

  // Send this computer's id and saved tokens with every request to the connected Pi
  // (covers the app page, the embedded remote, live updates and media).
  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders;
    if (serverUrl && details.url.startsWith(serverUrl + '/')) {
      const t = tokensFor(serverUrl);
      headers['X-PiScreen-Device'] = readConfig().deviceId;
      if (t.access) headers['X-PiScreen-Access'] = t.access;
      if (t.admin) headers['X-PiScreen-Admin'] = t.admin;
    }
    callback({ requestHeaders: headers });
  });

  // The app page (file://) talks to the Pi's API; allow those cross-origin responses.
  ses.webRequest.onHeadersReceived({ urls: ['http://*/*'] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'access-control-allow-origin') delete headers[k];
    headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });

  // getDisplayMedia() in the page captures whichever screen/window the user picked in our UI.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === pendingSource.id);
      if (!source) return callback({});
      const audio = pendingSource.audio && process.platform === 'win32' ? 'loopback' : undefined;
      callback(audio ? { video: source, audio } : { video: source });
    } catch (err) {
      console.error(err);
      callback({});
    }
  });
}

// ------------------------------------------------------------------ IPC

ipcMain.handle('config:get', () => {
  const { tokens, ...rest } = readConfig(); // tokens stay in the main process
  return rest;
});
ipcMain.handle('config:set', (_e, patch) => {
  const { tokens, deviceId, ...safe } = patch || {};
  writeConfig(safe);
  return true;
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:computer-name', () => os.hostname());

// Unlock/admin tokens for the current Pi. Pass null to forget one.
ipcMain.handle('tokens:set', (_e, patch) => {
  if (!serverUrl) return false;
  const all = { ...(readConfig().tokens || {}) };
  const cur = { ...(all[serverUrl] || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!['access', 'admin'].includes(k)) continue;
    if (v) cur[k] = String(v); else delete cur[k];
  }
  all[serverUrl] = cur;
  writeConfig({ tokens: all });
  return { access: !!cur.access, admin: !!cur.admin };
});

ipcMain.on('toolbar:show', (_e, show) => (show ? showToolbar() : hideToolbar()));
ipcMain.on('toolbar:state', (_e, state) => {
  if (toolbar && !toolbar.isDestroyed()) toolbar.webContents.send('toolbar:state', state);
});
ipcMain.on('toolbar:action', (_e, action) => {
  if (!win) return;
  if (action === 'open') { win.show(); win.restore(); win.focus(); }
  win.webContents.send('toolbar:action', action);
});
ipcMain.on('window:minimize', () => win && win.minimize());

ipcMain.handle('sources:list', async () => {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => {
    const d = displays.find((x) => String(x.id) === s.display_id);
    const isScreen = s.id.startsWith('screen:');
    let label = s.name;
    let detail = '';
    if (isScreen && d) {
      const w = Math.round(d.size.width * d.scaleFactor);
      const h = Math.round(d.size.height * d.scaleFactor);
      label = d.label || s.name;
      detail = `${w}×${h}${d.id === primary.id ? ', main screen' : ''}`;
    }
    return { id: s.id, type: isScreen ? 'screen' : 'window', name: label, detail, thumbnail: s.thumbnail.toDataURL() };
  });
});

ipcMain.handle('sources:choose', (_e, id, audio) => {
  pendingSource = { id, audio: !!audio };
  return true;
});

ipcMain.handle('server:set', (_e, url) => {
  serverUrl = url;
  if (url) setTimeout(() => checkServerUpdate(false), 1500);
  return true;
});

ipcMain.handle('network:scan', () => scanNetwork());
ipcMain.handle('updates:check', async () => {
  await checkAppUpdate(true);
  await checkServerUpdate(true);
});

// ------------------------------------------------------------------ discovery

async function probe(host, timeout = 900) {
  try {
    const res = await fetch(`http://${host}:${PORT}/api/version`, { signal: AbortSignal.timeout(timeout) });
    const data = await res.json();
    return data.app === 'piscreen' ? { url: `http://${host}:${PORT}`, ...data } : null;
  } catch {
    return null;
  }
}

async function scanNetwork() {
  const found = new Map();
  const add = (r) => { if (r && !found.has(r.url)) found.set(r.url, r); };

  const hosts = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.netmask !== '255.255.255.0') continue; // only scan normal home-sized networks
      const base = a.address.split('.').slice(0, 3).join('.');
      for (let i = 1; i < 255; i++) {
        const ip = `${base}.${i}`;
        if (ip !== a.address && !hosts.includes(ip)) hosts.push(ip);
      }
    }
  }
  const named = probe('raspberrypi.local', 2500).then(add);
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) add(await probe(hosts[next++]));
  };
  await Promise.all([named, ...Array.from({ length: 64 }, worker)]);
  return [...found.values()];
}

// ------------------------------------------------------------------ updates

function status(text) {
  if (win && !win.isDestroyed()) win.webContents.send('update:status', text);
}

let autoUpdater = null;
function setupAppUpdater() {
  if (!app.isPackaged) return; // only installed builds can update themselves
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update available',
      message: `PiScreen ${info.version} is available`,
      detail: `You have version ${app.getVersion()}. Download and install the update now?`,
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      status('Downloading app update…');
      autoUpdater.downloadUpdate().catch((err) => status('Update download failed: ' + err.message));
    }
  });
  autoUpdater.on('download-progress', (p) => {
    status(`Downloading app update… ${Math.round(p.percent)}%`);
    win?.setProgressBar(p.percent / 100);
  });
  autoUpdater.on('update-downloaded', async () => {
    win?.setProgressBar(-1);
    status('App update ready');
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: 'The update has been downloaded.',
      detail: 'Restart PiScreen now to install it? (Otherwise it installs when you close the app.)',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => status('App update check failed: ' + (err?.message || err)));

  checkAppUpdate(false);
  setInterval(() => checkAppUpdate(false), 4 * 60 * 60 * 1000);
}

async function checkAppUpdate(manual) {
  if (!autoUpdater) {
    if (manual) status('App updates only work in the installed app (not in development mode).');
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (manual && (!result || !result.isUpdateAvailable)) status(`App is up to date (${app.getVersion()})`);
  } catch (err) {
    status('App update check failed: ' + err.message);
  }
}

async function checkServerUpdate(manual) {
  if (!serverUrl) return;
  let info;
  try {
    const res = await fetch(`${serverUrl}/api/update${manual ? '?force=1' : ''}`, { headers: piHeaders(), signal: AbortSignal.timeout(90000) });
    if (res.status === 401) { if (manual) status('Unlock the Pi first to check it for updates.'); return; }
    info = await res.json();
  } catch (err) {
    if (manual) status('Could not check the Pi for updates: ' + err.message);
    return;
  }
  if (!info.supported) { if (manual) status(info.reason); return; }
  if (info.error) { if (manual) status(info.error); return; }
  if (!info.behind) { if (manual) status(`Pi server is up to date (${info.version})`); return; }

  const key = `${serverUrl}|${info.commit}|${info.behind}`;
  if (!manual && declinedServerUpdates.has(key)) return;

  const changes = (info.changes || []).slice(0, 8).map((c) => '• ' + c).join('\n');
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Pi update available',
    message: `An update is available for the PiScreen server on your Pi`,
    detail: `Installed: ${info.version}${info.latest_version ? `\nAvailable: ${info.latest_version}` : ''}\n\n` +
      `${changes}\n\nThe Pi will update and restart (takes a few seconds). Update now?`,
    buttons: ['Update Pi now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) { declinedServerUpdates.add(key); return; }

  status('Updating the Pi…');
  try {
    const res = await fetch(`${serverUrl}/api/update`, { method: 'POST', headers: piHeaders(), signal: AbortSignal.timeout(200000) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || res.statusText);
  } catch (err) {
    status('');
    dialog.showMessageBox(win, { type: 'error', title: 'Pi update failed', message: 'The Pi could not update.', detail: err.message });
    return;
  }
  // Wait for the server to come back with the new code.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const v = await (await fetch(`${serverUrl}/api/version`, { signal: AbortSignal.timeout(1500) })).json();
      if (v.commit && v.commit !== info.commit) {
        status(`Pi updated to ${v.version}`);
        return;
      }
    } catch { /* still restarting */ }
  }
  status('The Pi was updated but has not come back yet. Check it with: sudo systemctl status piscreen');
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    setupSession();
    createWindow();
    setupAppUpdater();
    setInterval(() => checkServerUpdate(false), 30 * 60 * 1000);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', hideToolbar);
}
