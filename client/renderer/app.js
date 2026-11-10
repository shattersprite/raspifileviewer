// PiScreen desktop app — window UI: connecting, unlocking, home, sharing, files and admin.
const P = window.piscreen;
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(4, '0');

const PRESETS = {
  sharp: { fps: 30, bitrate: 12_000_000, hint: 'detail', degradation: 'maintain-resolution' },
  smooth: { fps: 60, bitrate: 20_000_000, hint: 'motion', degradation: 'maintain-framerate' },
  light: { fps: 15, bitrate: 4_000_000, hint: 'detail', degradation: 'balanced' },
};
const isWindows = navigator.userAgent.includes('Windows');

// A Pi 3 (or Zero) can only decode about 720p at 15 fps smoothly.
const LOW_POWER_MAX = { width: 1280, height: 720, fps: 15, bitrate: 3_000_000 };
const lowPower = () => !!(state && state.server && state.server.low_power);

// The resolution to send: the Pi's screen size, capped on a low-power Pi.
function targetSize() {
  const d = state && state.display && state.display.width > 0 ? state.display : null;
  if (!lowPower()) return d ? { width: d.width, height: d.height } : null;
  if (!d) return { width: LOW_POWER_MAX.width, height: LOW_POWER_MAX.height };
  const scale = Math.min(1, LOW_POWER_MAX.width / d.width, LOW_POWER_MAX.height / d.height);
  return { width: Math.round(d.width * scale), height: Math.round(d.height * scale) };
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

let server = null;      // "http://192.168.1.50:8080"
let access = null;      // result of /api/auth
let events = null;      // EventSource to the Pi
let state = null;       // latest state from the Pi
let sources = [];
let selectedId = null;
let share = null;       // { session, stream, pc, preset, src, paused, … }
let currentView = 'connect';
let computerName = 'this computer';

// ------------------------------------------------------------------ helpers

function normalize(addr) {
  let a = addr.trim().replace(/\/+$/, '');
  if (!a) return null;
  if (!/^https?:\/\//.test(a)) a = 'http://' + a;
  const u = new URL(a);
  if (!u.port) u.port = '8080';
  return u.origin;
}
const shortAddr = (url) => url.replace(/^http:\/\//, '').replace(/:8080$/, '');

// text/plain avoids a CORS preflight; the server parses the JSON regardless.
async function post(path, body) {
  const res = await fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) refreshAccess();
  return { ok: res.ok, status: res.status, data };
}
const control = (action, extra = {}) => post('/api/control', { action, ...extra });

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('bad', kind === 'bad');
}

// ------------------------------------------------------------------ views

const NEEDS_ACCESS = ['home', 'share', 'files'];

function show(view) {
  if (NEEDS_ACCESS.includes(view) && !(access && access.access)) view = server ? 'locked' : 'connect';
  if (view === 'admin' && !server) view = 'connect';
  currentView = view;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  if (view === 'share' && !share) loadSources();
  if (view === 'admin') openAdmin();
}

function updateChrome() {
  const connected = !!server;
  const ok = connected && access && access.access;
  $$('.nav-item').forEach((n) => { n.disabled = n.dataset.view === 'admin' ? !connected : !ok; });
  $('#blankBtn').disabled = !ok;
  $('#stopAllBtn').disabled = !ok;
  $('#changeBtn').textContent = connected ? 'Change screen' : '';
  if (!connected) {
    $('#roomName').textContent = 'Not connected';
    $('#roomSub').textContent = 'Choose a screen to get started';
    $('#dot').classList.remove('on');
    return;
  }
  const name = (access && access.name) || 'PiScreen';
  const lock = access && access.lock;
  $('#roomName').textContent = name;
  $('#homeName').textContent = name;
  $('#roomSub').textContent = shortAddr(server) + (lock === 'passcode' ? ' · 🔒 Passcode' : lock === 'device' ? ' · 🔒 One computer only' : '');
  $('#blankBtn').classList.toggle('on', !!(state && state.view.blank));
}

$$('.nav-item').forEach((n) => n.addEventListener('click', () => show(n.dataset.view)));
$$('[data-go]').forEach((t) => t.addEventListener('click', () => show(t.dataset.go)));

// ------------------------------------------------------------------ connecting

async function connect(addr, quiet) {
  let url;
  try { url = normalize(addr); } catch { url = null; }
  if (!url) return false;
  try {
    const res = await fetch(url + '/api/version', { signal: AbortSignal.timeout(4000) });
    const info = await res.json();
    if (info.app !== 'piscreen') throw new Error('not a PiScreen server');
  } catch (err) {
    if (!quiet) $('#setupMsg').textContent = `Couldn't reach PiScreen at ${shortAddr(url)} (${err.message}).`;
    return false;
  }
  if (share) stopShare(true);
  if (events) { events.close(); events = null; }
  server = url;
  state = null;
  await P.setServer(url);           // main process now adds our id/tokens to requests to this Pi
  await P.setConfig({ server: url });
  $('#address').value = '';
  await refreshAccess(true);
  return true;
}

async function refreshAccess(goHome) {
  if (!server) return;
  try {
    access = await (await fetch(server + '/api/auth', { signal: AbortSignal.timeout(4000) })).json();
  } catch {
    $('#dot').classList.remove('on');
    return;
  }
  updateChrome();
  if (access.access) {
    if (!events) openEvents();
    if (!$('#remoteFrame').src.startsWith(server)) $('#remoteFrame').src = server + '/';
    if (goHome || currentView === 'locked' || currentView === 'connect') show('home');
  } else {
    if (events) { events.close(); events = null; }
    if (share) { stopShare(false); }
    $('#remoteFrame').src = 'about:blank';
    renderLocked();
    if (currentView !== 'admin') show('locked');
  }
}

function openEvents() {
  events = new EventSource(server + '/api/events');
  events.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    if (state.screen && access) { access.name = state.screen.name; access.lock = state.screen.lock; }
    // The Pi no longer shows our share (e.g. it restarted): clean up here too.
    const st = state.view.stream;
    if (share && share.pc && (!st || st.session !== share.session)) {
      stopShare(false);
      shareStatus('Sharing ended on the Pi.');
    }
    updateChrome();
    renderHome();
    renderShareInfo();
  });
  events.addEventListener('signal', (e) => onSignal(JSON.parse(e.data)));
  events.addEventListener('auth', () => refreshAccess());
  events.onopen = () => $('#dot').classList.add('on');
  events.onerror = () => {
    $('#dot').classList.remove('on');
    if (events && events.readyState === EventSource.CLOSED) { events = null; setTimeout(refreshAccess, 2000); }
  };
}

async function findPis() {
  const list = $('#found');
  $('#setupMsg').textContent = '';
  list.innerHTML = '<li class="muted">Searching your network…</li>';
  $('#findBtn').disabled = true;
  const found = await P.scan();
  $('#findBtn').disabled = false;
  if (!found.length) {
    list.innerHTML = '';
    $('#setupMsg').textContent = 'No screens found. Type the address shown on the Pi\'s screen.';
    return found;
  }
  list.innerHTML = found.map((f) => `<li><span class="scr">🖥</span><span class="grow"><b>${esc(f.name || 'PiScreen')}</b>
    <div class="muted">${esc(shortAddr(f.url))}${f.lock && f.lock !== 'off' ? ' · 🔒 locked' : ''}</div></span>
    <button class="btn primary" data-url="${esc(f.url)}">Connect</button></li>`).join('');
  return found;
}

$('#found').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-url]');
  if (b) connect(b.dataset.url);
});
$('#connectForm').addEventListener('submit', (e) => { e.preventDefault(); connect($('#address').value); });
$('#findBtn').addEventListener('click', findPis);
$('#changeBtn').addEventListener('click', () => { show('connect'); findPis(); });

// ------------------------------------------------------------------ locked screen

function renderLocked() {
  const pass = access.lock === 'passcode';
  $('#lockedTitle').textContent = `${access.name} is locked`;
  $('#lockedText').textContent = pass ? 'Enter the passcode to share to this screen.'
    : `Only ${access.device_name || "the admin's computer"} can use this screen right now.`;
  $('#unlockArea').classList.toggle('hidden', !pass);
  $('#unlockErr').textContent = '';
}

$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/auth/unlock', { passcode: $('#unlockInput').value });
  if (!r.ok) { $('#unlockErr').textContent = r.data.error || 'Could not unlock.'; $('#unlockInput').select(); return; }
  $('#unlockInput').value = '';
  await P.setTokens({ access: r.data.access_token });
  refreshAccess(true);
});
$('#lockedAdminBtn').addEventListener('click', () => show('admin'));

// ------------------------------------------------------------------ top bar actions

$('#blankBtn').addEventListener('click', () => control('blank'));
$('#stopAllBtn').addEventListener('click', async () => {
  if (share) stopShare(true);
  // "stop" ends a screen share first, then clears the file on screen.
  for (let i = 0; i < 2; i++) {
    const r = await control('stop');
    if (!r.ok || !r.data.view || (!r.data.view.item && !r.data.view.stream)) break;
  }
});

// ------------------------------------------------------------------ home

function renderHome() {
  if (!state) return;
  const v = state.view;
  const item = state.items.find((i) => i.id === v.item);
  let title = 'Welcome screen', sub = 'Waiting for something to show', img = null;
  if (v.stream) { title = 'Screen sharing'; sub = v.stream.source; }
  else if (item) {
    title = item.name;
    if (item.kind === 'pdf') {
      sub = `Page ${v.page} of ${item.pages}`;
      if (v.page <= item.ready_pages) img = `${server}/media/${item.id}/thumb-${pad(v.page)}.jpg`;
    } else if (item.kind === 'image') { sub = 'Image'; img = `${server}/media/${item.id}/source${item.ext}`; }
    else sub = 'Video';
  }
  if (v.blank) sub += ' · screen blanked';
  $('#nowTitle').textContent = title;
  $('#nowSub').textContent = sub;
  const prev = $('#nowPreview');
  if (img) { if (prev.querySelector('img')?.getAttribute('src') !== img) prev.innerHTML = `<img src="${img}" alt="">`; }
  else prev.textContent = v.stream ? '🖥 Live' : item ? '▶' : (access?.name || 'PiScreen');
}

// ------------------------------------------------------------------ sources

async function loadSources() {
  sources = await P.listSources();
  renderSources();
}

function renderSources() {
  const pi = targetSize();
  const card = (s) => {
    const match = pi && s.detail.startsWith(`${pi.width}×${pi.height}`);
    return `<button class="source ${s.id === selectedId ? 'selected' : ''}" data-id="${esc(s.id)}" ${share ? 'disabled' : ''}>
      <img src="${s.thumbnail}" alt="">
      <span class="name">${esc(s.name)}</span>
      <span class="detail">${esc(s.detail || 'Window')}${match ? ' · <span class="match">matches the Pi</span>' : ''}</span>
    </button>`;
  };
  $('#screens').innerHTML = sources.filter((s) => s.type === 'screen').map(card).join('');
  $('#windows').innerHTML = sources.filter((s) => s.type === 'window').map(card).join('') || '<span class="muted">No windows</span>';
  updateShareUi();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('.source');
  if (!b || share) return;
  selectedId = b.dataset.id;
  renderSources();
});
$('#refreshSources').addEventListener('click', loadSources);

function renderShareInfo() {
  const d = state && state.display && state.display.width > 0 ? state.display : null;
  const t = targetSize();
  const lp = lowPower();
  $('#piInfo').textContent = (d ? `Pi screen: ${d.width}×${d.height}` : 'Pi screen: waiting for the display…')
    + (state && state.server && state.server.model ? ` · ${state.server.model.replace(/ Rev [\d.]+$/, '')}` : '');
  $('#piRes').textContent = t ? `${t.width}×${t.height}` : "the Pi's resolution";
  $('#lowPowerNote').classList.toggle('hidden', !lp);
  const smooth = $('#quality option[value=smooth]');
  smooth.disabled = lp;
  if (lp && $('#quality').value === 'smooth') $('#quality').value = 'sharp';
  if (sources.length && currentView === 'share') renderSources();
}

function updateShareUi() {
  const btn = $('#shareBtn');
  btn.disabled = !share && !selectedId;
  btn.textContent = share ? 'Stop sharing' : 'Start sharing';
  btn.classList.toggle('primary', !share);
  btn.classList.toggle('orange', !!share);
  $('#navLive').classList.toggle('hidden', !share);
  $('#shareBar').classList.toggle('hidden', !share);
  $('#shareBar').classList.toggle('paused', !!(share && share.paused));
  if (share) {
    $('#shareBarTitle').textContent = `${share.paused ? 'Paused' : 'Sharing'} · ${share.src.name} → ${access?.name || 'PiScreen'}`;
    $('#pauseBtn').textContent = share.paused ? '▶ Resume' : '❚❚ Pause';
  }
  syncToolbar();
}

function syncToolbar() {
  P.sendToolbarState({ sharing: !!share, paused: !!(share && share.paused), blank: !!(state && state.view.blank),
    source: share ? share.src.name : '' });
}

// ------------------------------------------------------------------ screen sharing (WebRTC)

function shareStatus(text, live) {
  $('#shareStatus').textContent = text;
  $('#shareStatus').classList.toggle('live', !!live);
}

async function startShare() {
  const src = sources.find((s) => s.id === selectedId);
  if (!src || !server) return;
  let preset = PRESETS[$('#quality').value];
  if (lowPower()) {
    preset = { ...preset, fps: Math.min(preset.fps, LOW_POWER_MAX.fps),
      bitrate: Math.min(preset.bitrate, LOW_POWER_MAX.bitrate) };
  }
  const wantAudio = isWindows && $('#audio').checked && src.type === 'screen';
  await P.chooseSource(src.id, wantAudio);

  const video = { frameRate: { ideal: preset.fps, max: preset.fps } };
  const t = targetSize();
  if (t) { video.width = { max: t.width }; video.height = { max: t.height }; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: wantAudio });
  } catch (err) {
    shareStatus('Could not capture that screen: ' + err.message);
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.contentHint = preset.hint;
  track.addEventListener('ended', () => stopShare(true)); // window closed, etc.

  share = { session: crypto.randomUUID().slice(0, 12), stream, track, pc: null, preset, src, paused: false };
  updateShareUi();
  renderSources();
  shareStatus('Waiting for the Pi display…');
  share.readyTimer = setTimeout(() => {
    if (share && !share.pc) shareStatus('The Pi display is not responding. Is the Pi screen on and showing PiScreen?');
  }, 8000);
  const res = await post('/api/signal', { type: 'start', session: share.session, source: src.name });
  if (!res.ok) { shareStatus('The Pi refused the screen share.'); stopShare(false); return; }
  if ($('#miniMode').checked) { P.showToolbar(true); P.minimize(); }
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
    setTimeout(resolve, 2500);
  });
}

async function negotiate() {
  const s = share;
  if (s.pc) s.pc.close();
  const pc = new RTCPeerConnection({ iceServers: [] });
  s.pc = pc;
  for (const t of s.stream.getTracks()) pc.addTrack(t, s.stream);
  if (s.paused) await videoSender(s)?.replaceTrack(null);
  pc.addEventListener('connectionstatechange', () => {
    if (share !== s || s.pc !== pc) return;
    const st = pc.connectionState;
    if (st === 'connected') shareStatus(`Live on ${access?.name || 'the Pi'}`, true);
    else if (st === 'connecting') shareStatus('Connecting to the Pi…');
    else if (st === 'failed') shareStatus('Connection to the Pi failed — it will retry automatically.');
  });
  shareStatus('Connecting to the Pi…');
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);
  if (share !== s) return;
  await post('/api/signal', { type: 'offer', session: s.session, sdp: pc.localDescription.sdp });
}

function videoSender(s) {
  return s.pc && s.pc.getSenders().find((x) => x.track ? x.track.kind === 'video' : x === s.videoSender);
}

async function applyEncoding(s) {
  const sender = videoSender(s);
  if (!sender) return;
  s.videoSender = sender;
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = s.preset.bitrate;
  params.encodings[0].maxFramerate = s.preset.fps;
  params.degradationPreference = s.preset.degradation;
  try { await sender.setParameters(params); } catch (err) { console.warn('setParameters', err); }
}

// Pause freezes the last picture on the Pi without stopping the share.
async function togglePause() {
  const s = share;
  if (!s) return;
  s.paused = !s.paused;
  const sender = s.videoSender || videoSender(s);
  if (sender) await sender.replaceTrack(s.paused ? null : s.track);
  updateShareUi();
}

async function onSignal(sig) {
  const s = share;
  if (!s || sig.session !== s.session) return;
  try {
    if (sig.type === 'ready') {
      clearTimeout(s.readyTimer);
      await negotiate();
    } else if (sig.type === 'answer' && s.pc && s.pc.signalingState === 'have-local-offer') {
      await s.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
      await applyEncoding(s);
      startStats(s);
    } else if (sig.type === 'stop') {
      stopShare(false);
      shareStatus('Sharing was stopped from the Pi remote.');
    }
  } catch (err) {
    shareStatus('Screen share error: ' + err.message);
  }
}

function startStats(s) {
  clearInterval(s.statsTimer);
  s.statsTimer = setInterval(async () => {
    if (!s.pc) return;
    const report = await s.pc.getStats();
    report.forEach((r) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
      const now = r.timestamp;
      let mbps = '';
      if (s.lastBytes != null) mbps = (((r.bytesSent - s.lastBytes) * 8) / ((now - s.lastTime) * 1000)).toFixed(1) + ' Mbps';
      s.lastBytes = r.bytesSent; s.lastTime = now;
      $('#stats').textContent = s.paused ? 'Picture frozen on the Pi' : [r.frameWidth && `${r.frameWidth}×${r.frameHeight}`,
        r.framesPerSecond != null && `${Math.round(r.framesPerSecond)} fps`, mbps].filter(Boolean).join(' · ');
    });
  }, 2000);
}

function stopShare(notify) {
  const s = share;
  if (!s) return;
  share = null;
  clearTimeout(s.readyTimer);
  clearInterval(s.statsTimer);
  if (notify && server) post('/api/signal', { type: 'stop', session: s.session }).catch(() => {});
  if (s.pc) s.pc.close();
  s.stream.getTracks().forEach((t) => t.stop());
  $('#stats').textContent = '';
  shareStatus('');
  P.showToolbar(false);
  updateShareUi();
  if (sources.length) renderSources();
}

$('#shareBtn').addEventListener('click', () => (share ? stopShare(true) : startShare()));
$('#stopShareBtn').addEventListener('click', () => stopShare(true));
$('#pauseBtn').addEventListener('click', togglePause);
$('#miniBtn').addEventListener('click', () => { P.showToolbar(true); P.minimize(); });
window.addEventListener('beforeunload', () => stopShare(true));

P.onToolbarAction((action) => {
  if (action === 'sync') syncToolbar();
  else if (action === 'pause') togglePause();
  else if (action === 'blank') control('blank');
  else if (action === 'stop') stopShare(true);
  else if (action === 'open') show('share');
});

// ------------------------------------------------------------------ admin

async function openAdmin() {
  setMsg($('#lockMsg'), '');
  setMsg($('#codeMsg'), '');
  const r = await fetch(server + '/api/admin/settings').catch(() => null);
  if (r && r.ok) {
    showAdminPanel(await r.json());
  } else {
    if (r && r.status === 403) await P.setTokens({ admin: null }); // old/invalid admin session
    $('#adminPanel').classList.add('hidden');
    $('#adminLogin').classList.remove('hidden');
    $('#adminCode').value = '';
    $('#adminErr').textContent = '';
    setTimeout(() => $('#adminCode').focus(), 50);
  }
}

function showAdminPanel(s) {
  $('#adminLogin').classList.add('hidden');
  $('#adminPanel').classList.remove('hidden');
  $('#nameInput').value = s.name;
  const radio = document.querySelector(`input[name=lock][value=${s.lock}]`);
  if (radio) radio.checked = true;
  $('#newPasscode').value = '';
  $('#newPasscode').placeholder = s.lock === 'passcode' ? 'Leave empty to keep the current passcode' : 'New passcode (at least 4 characters)';
  $('#thisComputer').textContent = s.lock === 'device' && !s.this_device
    ? `Currently locked to ${s.device_name}. Choosing this moves the lock to ${computerName}.`
    : `Only ${computerName} can share or control.`;
  $('#passcodeRow').classList.toggle('hidden', s.lock !== 'passcode');
  $('#softwareInfo').textContent = `App ${$('#appVersion').textContent} · Pi server ${state?.server?.version || ''}`
    + ` (${state?.server?.commit || 'unknown'}) · ${state?.server?.model || 'Unknown device'}`
    + (lowPower() ? ' · low-power mode' : '');
  loadStorage();
}

// ------------------------------------------------------------------ admin: storage

function renderStorage(s) {
  const other = Math.max(0, s.disk_total - s.disk_free - s.uploads);
  $('#storageText').textContent = `${s.count} file${s.count === 1 ? '' : 's'} using ${fmtBytes(s.uploads)} · `
    + `${fmtBytes(s.disk_free)} free of ${fmtBytes(s.disk_total)}`;
  $('#meterUploads').style.width = (100 * s.uploads / s.disk_total) + '%';
  $('#meterOther').style.width = (100 * other / s.disk_total) + '%';
  $('#cleanDays').value = String(s.cleanup.days);
  $('#cleanFree').value = String(s.cleanup.min_free_gb);
  if (![...$('#cleanDays').options].some((o) => o.selected)) $('#cleanDays').value = '0';
  if (![...$('#cleanFree').options].some((o) => o.selected)) $('#cleanFree').value = '0';
}

async function loadStorage() {
  const r = await fetch(server + '/api/admin/storage').catch(() => null);
  if (r && r.ok) renderStorage(await r.json());
}

$('#saveCleanup').addEventListener('click', async () => {
  const r = await post('/api/admin/storage', { days: Number($('#cleanDays').value), min_free_gb: Number($('#cleanFree').value) });
  if (!r.ok) { setMsg($('#storageMsg'), r.data.error, 'bad'); return; }
  renderStorage(r.data);
  const off = !r.data.cleanup.days && !r.data.cleanup.min_free_gb;
  setMsg($('#storageMsg'), off ? 'Automatic cleanup is off.' : 'Saved. Cleanup runs every hour and after each upload.', 'ok');
});

$('#cleanNow').addEventListener('click', async () => {
  const r = await post('/api/admin/storage/clean');
  if (!r.ok) { setMsg($('#storageMsg'), r.data.error, 'bad'); return; }
  renderStorage(r.data);
  const off = !r.data.cleanup.days && !r.data.cleanup.min_free_gb;
  setMsg($('#storageMsg'), off ? 'Choose a cleanup rule first, or use "Delete all files".'
    : r.data.deleted ? `Deleted ${r.data.deleted} file${r.data.deleted === 1 ? '' : 's'} (${fmtBytes(r.data.freed)}).`
    : 'Nothing needed deleting.', off ? 'bad' : 'ok');
});

$('#clearAll').addEventListener('click', async () => {
  if (!confirm('Delete every file on the Pi? This also clears the screen and cannot be undone.')) return;
  const r = await post('/api/admin/storage/clear');
  if (!r.ok) { setMsg($('#storageMsg'), r.data.error, 'bad'); return; }
  renderStorage(r.data);
  setMsg($('#storageMsg'), 'All files deleted.', 'ok');
});

// Keypad
$('#keypad').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const input = $('#adminCode');
  if (b.dataset.k === 'clear') input.value = '';
  else if (b.dataset.k === 'back') input.value = input.value.slice(0, -1);
  else input.value += b.textContent;
  input.focus();
});

$('#adminLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/auth/admin', { code: $('#adminCode').value });
  if (!r.ok) { $('#adminErr').textContent = r.data.error || 'Wrong code.'; $('#adminCode').select(); return; }
  await P.setTokens({ admin: r.data.admin_token });
  await refreshAccess();    // the admin always has access
  show('admin');
});

$('#adminSignOut').addEventListener('click', async () => {
  await P.setTokens({ admin: null });
  await post('/api/auth/logout');
  await refreshAccess();
  openAdmin();
});

$$('input[name=lock]').forEach((r) => r.addEventListener('change', () => {
  $('#passcodeRow').classList.toggle('hidden', r.value !== 'passcode' || !r.checked);
}));

$('#saveName').addEventListener('click', async () => {
  const r = await post('/api/admin/settings', { name: $('#nameInput').value });
  setMsg($('#lockMsg'), r.ok ? 'Name saved.' : r.data.error, r.ok ? 'ok' : 'bad');
  if (r.ok) refreshAccess();
});

$('#applyLock').addEventListener('click', async () => {
  const mode = document.querySelector('input[name=lock]:checked')?.value;
  if (!mode) return;
  const passcode = $('#newPasscode').value;
  const r = await post('/api/admin/settings', { lock: mode, passcode, device_name: computerName });
  if (!r.ok) { setMsg($('#lockMsg'), r.data.error, 'bad'); return; }
  // Keep this app unlocked even after signing out of admin.
  if (mode === 'passcode' && passcode) {
    const u = await post('/api/auth/unlock', { passcode });
    if (u.ok) await P.setTokens({ access: u.data.access_token });
  }
  showAdminPanel(r.data);
  setMsg($('#lockMsg'), mode === 'off' ? 'Unlocked: anyone on the network can use this screen.'
    : mode === 'passcode' ? 'Locked with a passcode.' : `Locked to ${computerName}.`, 'ok');
  refreshAccess();
});

$('#saveAdminCode').addEventListener('click', async () => {
  const a = $('#newAdminCode').value, b = $('#newAdminCode2').value;
  if (a !== b) { setMsg($('#codeMsg'), "The two codes don't match.", 'bad'); return; }
  const r = await post('/api/admin/code', { code: a });
  if (!r.ok) { setMsg($('#codeMsg'), r.data.error, 'bad'); return; }
  await P.setTokens({ admin: r.data.admin_token });
  $('#newAdminCode').value = $('#newAdminCode2').value = '';
  setMsg($('#codeMsg'), 'Admin code changed.', 'ok');
});

$('#adminUpdates').addEventListener('click', () => { $('#updateStatus').textContent = 'Checking for updates…'; P.checkUpdates(); });

// ------------------------------------------------------------------ updates

P.onUpdateStatus((text) => { $('#updateStatus').textContent = text || ''; });
$('#updatesBtn').addEventListener('click', async () => {
  $('#updateStatus').textContent = 'Checking for updates…';
  await P.checkUpdates();
});

// ------------------------------------------------------------------ start

(async () => {
  $('#appVersion').textContent = 'v' + (await P.appVersion());
  computerName = await P.computerName();
  if (!isWindows) $('#audioRow').classList.add('hidden');
  const cfg = await P.getConfig();
  $('#miniMode').checked = cfg.miniToolbar !== false;
  $('#miniMode').addEventListener('change', () => P.setConfig({ miniToolbar: $('#miniMode').checked }));
  updateChrome();
  show('connect');
  if (cfg.server && await connect(cfg.server, true)) return;
  const found = await findPis();
  if (found.length === 1 && !server) connect(found[0].url);
})();
