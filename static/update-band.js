/* "Updating PiScreen" stand-by band.
 *
 * A full-width band across the middle of the screen, the rest dimmed, shown while the
 * Pi server updates itself. Used by the Pi display, the phone remote and the desktop app
 * (client/renderer/update-band.js is a copy of this file; keep them the same).
 *
 *   UpdateBand.handle({stage: 'start'|'restarting'|'failed', from, to, error})
 *   UpdateBand.done(version)   // the server came back on the new version
 *   UpdateBand.active          // true while the band is up
 *
 * After a page reloads onto the new version it calls done() by itself.
 */
(function () {
  const KEY = 'piscreen-updating';
  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; } },
    set(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } },
    clear() { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
  };

  const css = `
  .ub { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; pointer-events: none;
    font-family: "Archivo", system-ui, sans-serif; --ub-size: clamp(20px, min(6vh, 4.4vw), 84px); }
  .ub[hidden] { display: none; }
  .ub-dim { position: absolute; inset: 0; background: rgba(8, 10, 12, .74); opacity: 0; transition: opacity .5s; }
  .ub.on .ub-dim { opacity: 1; pointer-events: auto; }
  .ub-band { position: relative; width: 100%; background: #1e2226; color: #f6f7f8;
    box-shadow: 0 0 0 1px #000, 0 2.5vh 6vh rgba(0,0,0,.55);
    clip-path: inset(0 100% 0 0); transition: clip-path .7s cubic-bezier(.7,0,.2,1); }
  .ub.on .ub-band { clip-path: inset(0 0 0 0); }
  .ub.leaving .ub-band { clip-path: inset(0 0 0 100%); }
  .ub-bars { display: flex; height: calc(var(--ub-size) * .16); }
  .ub-bars i { flex: 1; }
  .ub-bars i:nth-child(1) { background: #c4c7ca; } .ub-bars i:nth-child(2) { background: #d9c23c; }
  .ub-bars i:nth-child(3) { background: #40b6c2; } .ub-bars i:nth-child(4) { background: #3fa35d; }
  .ub-bars i:nth-child(5) { background: #ad52ad; } .ub-bars i:nth-child(6) { background: #cf463b; }
  .ub-bars i:nth-child(7) { background: #3a55b5; }
  .ub-body { padding: calc(var(--ub-size) * 1.5) 6vw calc(var(--ub-size) * 1.35); text-align: center; }
  .ub-title { font-size: var(--ub-size); line-height: 1.15; font-weight: 700; letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: .55em; max-width: 100%; }
  .ub-lamp { width: .42em; height: .42em; border-radius: 50%; flex: none; background: #f2a40c;
    box-shadow: 0 0 .5em rgba(242,164,12,.7); }
  .ub.ok .ub-lamp { background: #2e9e62; box-shadow: 0 0 .5em rgba(46,158,98,.8); }
  .ub.bad .ub-lamp { background: #8b949d; box-shadow: none; }
  .ub-sub { margin-top: calc(var(--ub-size) * .5); font-size: max(15px, calc(var(--ub-size) * .5)); color: #aab3bc; max-width: 60ch; margin-left: auto; margin-right: auto; }
  .ub-track { height: calc(var(--ub-size) * .1); background: #2d3137; overflow: hidden; }
  .ub-track span { display: block; height: 100%; width: 28%; background: #f2a40c;
    animation: ub-sweep 1.6s cubic-bezier(.45,0,.25,1) infinite; }
  .ub.ok .ub-track span { width: 100%; background: #2e9e62; animation: none; }
  .ub.bad .ub-track span { width: 100%; background: #5e6873; animation: none; }
  @keyframes ub-sweep { from { transform: translateX(-100%); } to { transform: translateX(360%); } }
  @media (prefers-reduced-motion: reduce) {
    .ub-dim, .ub-band { transition: none; }
    .ub-track span { animation: none; width: 100%; opacity: .6; }
  }`;

  let root, title, sub, hideTimer, giveUpTimer;

  function build() {
    if (root) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.className = 'ub';
    root.hidden = true;
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.innerHTML = `<div class="ub-dim"></div><div class="ub-band">
      <div class="ub-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <div class="ub-body"><div class="ub-title"><span class="ub-lamp" aria-hidden="true"></span><span></span></div>
        <div class="ub-sub"></div></div>
      <div class="ub-track" aria-hidden="true"><span></span></div></div>`;
    document.body.appendChild(root);
    title = root.querySelector('.ub-title span:last-child');
    sub = root.querySelector('.ub-sub');
  }

  const v = (x) => (x ? 'v' + String(x).replace(/^v/, '') : '');

  function show(kind, heading, detail) {
    build();
    clearTimeout(hideTimer);
    title.textContent = heading;
    sub.textContent = detail;
    root.classList.toggle('ok', kind === 'ok');
    root.classList.toggle('bad', kind === 'bad');
    root.classList.remove('leaving');
    if (root.hidden) {
      root.hidden = false;
      root.getBoundingClientRect(); // start the wipe from the left edge
    }
    root.classList.add('on');
    api.active = true;
  }

  function hide(after) {
    clearTimeout(hideTimer);
    clearTimeout(giveUpTimer);
    hideTimer = setTimeout(() => {
      if (!root) return;
      root.classList.add('leaving');
      root.classList.remove('on');
      setTimeout(() => { root.hidden = true; root.classList.remove('leaving', 'ok', 'bad'); api.active = false; }, 750);
    }, after);
  }

  const api = {
    active: false,
    handle(d) {
      if (!d || !d.stage) return;
      const from = v(d.from), to = v(d.to);
      const heading = to ? `Updating PiScreen from ${from} to ${to}` : `Updating PiScreen from ${from}`;
      if (d.stage === 'start') {
        store.set({ from: d.from, to: d.to, at: Date.now() });
        show('busy', heading, 'The Pi will be back in a few seconds.');
        clearTimeout(giveUpTimer);
        giveUpTimer = setTimeout(() => {
          show('bad', 'PiScreen is taking longer than usual to update',
            'If nothing changes soon, restart the Pi.');
          store.clear();
          hide(10000);
        }, 120000);
      } else if (d.stage === 'restarting') {
        show('busy', heading, 'Installed. Restarting PiScreen…');
      } else if (d.stage === 'failed') {
        store.clear();
        show('bad', "PiScreen couldn't update", `It's still running ${from}.${d.error ? ' ' + d.error : ''}`);
        hide(9000);
      }
    },
    done(version) {
      const saved = store.get();
      store.clear();
      const to = v(version || (saved && saved.to));
      show('ok', to ? `Updated to ${to}` : 'PiScreen is up to date', 'Everything is back to normal.');
      hide(3500);
    },
  };
  window.UpdateBand = api;

  // Came back after the server update reloaded this page? Finish the story.
  const resume = () => {
    const saved = store.get();
    if (saved && Date.now() - saved.at < 3 * 60 * 1000) api.done(saved.to);
    else if (saved) store.clear();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resume);
  else resume();
})();
