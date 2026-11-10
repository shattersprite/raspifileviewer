// PiScreen desktop app — window UI: connecting, the remote, and screen sharing.
const P = window.piscreen;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PRESETS = {
  sharp: { fps: 30, bitrate: 12_000_000, hint: 'detail', degradation: 'maintain-resolution' },
  smooth: { fps: 60, bitrate: 20_000_000, hint: 'motion', degradation: 'maintain-framerate' },
  light: { fps: 15, bitrate: 4_000_000, hint: 'detail', degradation: 'balanced' },
};
const isWindows = navigator.userAgent.includes('Windows');

let server = null;      // "http://192.168.1.50:8080"
let events = null;      // EventSource to the Pi
let state = null;       // latest state from the Pi
let sources = [];
let selectedId = null;
let share = null;       // { session, stream, pc, preset, statsTimer, lastBytes, lastTime }

// ------------------------------------------------------------------ helpers

function normalize(addr) {
  let a = addr.trim().replace(/\/+$/, '');
  if (!a) return null;
  if (!/^https?:\/\//.test(a)) a = 'http://' + a;
  const u = new URL(a);
  if (!u.port) u.port = '8080';
  return u.origin;
}

// text/plain avoids a CORS preflight; the server parses the JSON regardless.
function post(path, body) {
  return fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
}

function setUpdateStatus(text) {
  const el = $('#updateStatus');
  el.textContent = text || '';
  el.title = text || '';
}

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
    if (!quiet) $('#setupMsg').textContent = `Couldn't reach PiScreen at ${url} (${err.message}).`;
    return false;
  }
  if (share) stopShare(true);
  server = url;
  $('#address').value = url.replace(/^http:\/\//, '').replace(/:8080$/, '');
  await P.setConfig({ server: url });
  P.setServer(url);
  $('#remoteFrame').src = url + '/';
  $('#setup').classList.add('hidden');
  $('#main').classList.remove('hidden');
  openEvents();
  return true;
}

function openEvents() {
  if (events) events.close();
  events = new EventSource(server + '/api/events');
  events.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    // The Pi no longer shows our share (e.g. it restarted): clean up here too.
    const st = state.view.stream;
    if (share && share.pc && (!st || st.session !== share.session)) {
      stopShare(false);
      shareStatus('Sharing ended on the Pi.');
    }
    renderShareInfo();
  });
  events.addEventListener('signal', (e) => onSignal(JSON.parse(e.data)));
  events.onopen = () => $('#dot').classList.add('on');
  events.onerror = () => $('#dot').classList.remove('on');
}

async function findPis() {
  const list = $('#found');
  $('#setupMsg').textContent = '';
  list.innerHTML = '<li class="muted">Searching…</li>';
  $('#findBtn').disabled = true;
  const found = await P.scan();
  $('#findBtn').disabled = false;
  if (!found.length) {
    list.innerHTML = '';
    $('#setupMsg').textContent = 'No Pi found. Type its address in the box at the top (shown on the Pi\'s screen).';
    return found;
  }
  list.innerHTML = found.map((f) => `<li><span class="grow"><b>${esc(f.url.replace('http://', ''))}</b>
    <span class="muted small"> · version ${esc(f.version)}</span></span>
    <button class="primary" data-url="${esc(f.url)}">Connect</button></li>`).join('');
  return found;
}

$('#found').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-url]');
  if (b) connect(b.dataset.url);
});
$('#connectForm').addEventListener('submit', (e) => { e.preventDefault(); connect($('#address').value); });
$('#findBtn').addEventListener('click', async () => {
  $('#main').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  const found = await findPis();
  if (found.length === 1 && !server) connect(found[0].url);
});

// ------------------------------------------------------------------ tabs

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#tab-remote').classList.toggle('hidden', t.dataset.tab !== 'remote');
  $('#tab-share').classList.toggle('hidden', t.dataset.tab !== 'share');
  if (t.dataset.tab === 'share' && !share) loadSources();
}));

// ------------------------------------------------------------------ sources

async function loadSources() {
  sources = await P.listSources();
  renderSources();
}

function renderSources() {
  const pi = state && state.display;
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
  updateShareButton();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('.source');
  if (!b || share) return;
  selectedId = b.dataset.id;
  renderSources();
});
$('#refreshSources').addEventListener('click', loadSources);

function renderShareInfo() {
  const d = state && state.display;
  $('#piInfo').textContent = d ? `Pi screen: ${d.width}×${d.height}` : 'Pi screen: waiting for the display…';
  $('#piRes').textContent = d ? `${d.width}×${d.height}` : 'match the Pi';
  if (sources.length) renderSources();
}

function updateShareButton() {
  const btn = $('#shareBtn');
  btn.disabled = !share && !selectedId;
  btn.textContent = share ? 'Stop sharing' : 'Start sharing';
  btn.classList.toggle('primary', !share);
  btn.classList.toggle('stop', !!share);
  $('#liveBadge').classList.toggle('hidden', !share);
}

// ------------------------------------------------------------------ screen sharing (WebRTC)

function shareStatus(text, live) {
  $('#shareStatus').textContent = text;
  $('#shareStatus').classList.toggle('live', !!live);
}

async function startShare() {
  const src = sources.find((s) => s.id === selectedId);
  if (!src || !server) return;
  const preset = PRESETS[$('#quality').value];
  const wantAudio = isWindows && $('#audio').checked && src.type === 'screen';
  await P.chooseSource(src.id, wantAudio);

  const video = { frameRate: { ideal: preset.fps, max: preset.fps } };
  const d = state && state.display;
  if (d) { video.width = { max: d.width }; video.height = { max: d.height }; }

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

  share = { session: crypto.randomUUID().slice(0, 12), stream, pc: null, preset, src };
  updateShareButton();
  renderSources();
  shareStatus('Waiting for the Pi display…');
  share.readyTimer = setTimeout(() => {
    if (share && !share.pc) shareStatus('The Pi display is not responding. Is the Pi screen on and showing PiScreen?');
  }, 8000);
  const res = await post('/api/signal', { type: 'start', session: share.session, source: src.name });
  if (!res.ok) { shareStatus('The Pi refused the screen share.'); stopShare(false); }
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
  pc.addEventListener('connectionstatechange', () => {
    if (share !== s || s.pc !== pc) return;
    const st = pc.connectionState;
    if (st === 'connected') shareStatus(`Live on the Pi: ${s.src.name}`, true);
    else if (st === 'connecting') shareStatus('Connecting to the Pi…');
    else if (st === 'failed') shareStatus('Connection to the Pi failed — it will retry automatically.');
  });
  shareStatus('Connecting to the Pi…');
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);
  if (share !== s) return;
  await post('/api/signal', { type: 'offer', session: s.session, sdp: pc.localDescription.sdp });
}

async function applyEncoding(s) {
  const sender = s.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = s.preset.bitrate;
  params.encodings[0].maxFramerate = s.preset.fps;
  params.degradationPreference = s.preset.degradation;
  try { await sender.setParameters(params); } catch (err) { console.warn('setParameters', err); }
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
      $('#stats').textContent = [r.frameWidth && `${r.frameWidth}×${r.frameHeight}`,
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
  updateShareButton();
  renderSources();
}

$('#shareBtn').addEventListener('click', () => (share ? stopShare(true) : startShare()));
window.addEventListener('beforeunload', () => stopShare(true));

// ------------------------------------------------------------------ updates

P.onUpdateStatus(setUpdateStatus);
$('#updatesBtn').addEventListener('click', async () => {
  setUpdateStatus('Checking for updates…');
  await P.checkUpdates();
});

// ------------------------------------------------------------------ start

(async () => {
  $('#appVersion').textContent = 'v' + (await P.appVersion());
  if (!isWindows) $('#audioRow').classList.add('hidden');
  const cfg = await P.getConfig();
  if (cfg.server && await connect(cfg.server, true)) return;
  if (cfg.server) $('#address').value = cfg.server.replace(/^http:\/\//, '').replace(/:8080$/, '');
  const found = await findPis();
  if (found.length === 1 && !server) connect(found[0].url);
})();
