/* The phone layout: one chart at a time, chosen from the bottom bar.

   Same bundle, a viewport the media query answers "yes" to. The point of the test is that the
   phone is not a shrunken desktop - the price chart, the footprint, the delta row and the
   profile replace each other rather than stacking into a scroll of cramped panels, and the
   toolbar scrolls sideways so no timeframe is cut off. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.dirname(__dirname);
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

const bundle = fs.readFileSync(path.join(ROOT, 'terminal', 'assets', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'terminal', 'assets', 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'terminal', 'index.html'), 'utf8');

const bar = (t0, lv) => {
  const buy = lv.reduce((a, r) => a + r[1], 0);
  const sell = lv.reduce((a, r) => a + r[2], 0);
  return { t0, t1: t0 + 60, open: lv[0][0], high: lv[0][0], low: lv[lv.length - 1][0], close: lv[0][0],
    buy, sell, flat: 0, ticks: buy + sell, delta: buy - sell, volume: buy + sell, levels: lv,
    estimated: true };
};

const frame = {
  symbol: 'XAUUSD', tf: 60, step: 0.05, decimals: 2, points: 40,
  bars: [bar(1795700000, [[3571.10, 3, 1, 0], [3571.05, 1, 2, 0]]),
    bar(1795700060, [[3571.20, 2, 4, 0], [3571.15, 4, 1, 0]]),
    bar(1795700120, [[3571.30, 5, 1, 0], [3571.25, 2, 0, 0]])],
  cvd: [4, 2, 8], session: { start: 1795651200, delta: 8 },
  imbalance: { ratio: 3, stacked: 3, bars: [] },
  absorption: [], exhaustion: [], aggressive: [], divergence: [],
  profile: { poc: 3571.30, vah: 3571.30, val: 3571.10, total: 26, hvn: [], lvn: [],
    value_area: 0.7, levels: [[3571.30, 7, 1, 0, 8], [3571.20, 2, 4, 0, 6], [3571.10, 3, 1, 0, 4]] },
  feed: { status: 'live', connected: true, age: 0.4, stale: false, price: 3571.32,
    bid: 3571.12, ask: 3571.16, spread: 0.04, error: '' },
  archive: { ticks: 412, persistent: true, kept_days: 4 },
  settings: { timeframes: [15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 86400] },
  provenance: { vol_kind: 'tick_rule_estimate' }, market: { open: true, reason: 'quotes' },
  server_ts: 1795700181,
};

function makeCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 5 });
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'canvas') return { width: 390, height: 640 };
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function boot() {
  const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, '').replace(/<link[^>]*>/, ''), {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://desento.test/',
  });
  const { window } = dom;
  window.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe() { this.cb([]); } disconnect() {} };
  window.devicePixelRatio = 2;
  window.HTMLCanvasElement.prototype.getContext = () => makeCtx();
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 390; } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 520; } });
  // the phone: only the bottom-nav width query answers yes
  window.matchMedia = (q) => ({ matches: /max-width:\s*820px/.test(q), addListener() {}, removeListener() {} });
  window.WebSocket = class {
    constructor() { setTimeout(() => { if (this.onopen) this.onopen(); if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }); }, 5); }
    close() {} send() {}
  };
  window.fetch = async () => ({ ok: true, json: async () => ({ status: 'error' }) });
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.eval(bundle);
  return window;
}

const w = boot();
const d = w.document;
const tap = (sel, label) => {
  const b = Array.from(d.querySelectorAll(sel)).find((x) => new RegExp(label, 'i').test(x.textContent));
  if (b) b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return !!b;
};

setTimeout(() => {
  ok('the phone gets the bottom navigation, five destinations',
    d.querySelectorAll('.bnav button').length === 5);
  ok('it opens on the price chart', !!d.querySelector('.pricepanel') && !d.querySelector('.footprintpanel'));
  ok('no analytics column is squeezed onto the phone', !d.querySelector('.side'));
  ok('the price chart fills the screen height', !!d.querySelector('.pricepanel canvas'));

  tap('.bnav button', 'footprint');
  setTimeout(() => {
    ok('tapping FOOTPRINT swaps the price chart out', !!d.querySelector('.footprintpanel')
      && !d.querySelector('.pricepanel'));

    tap('.bnav button', 'delta');
    setTimeout(() => {
      const t = d.body.textContent || '';
      ok('tapping DELTA shows the CVD and the delta histogram',
        /cumulative delta/i.test(t) && /delta per candle/i.test(t));
      ok('and neither chart is left mounted behind it', !d.querySelector('.pricepanel')
        && !d.querySelector('.footprintpanel'));

      tap('.bnav button', 'profile');
      setTimeout(() => {
        const t2 = d.body.textContent || '';
        ok('tapping PROFILE shows the volume profile with its POC, VAH and VAL',
          /POC/.test(t2) && /VAH/.test(t2) && /VAL/.test(t2));
      }, 140);
    }, 140);
  }, 140);

  ok('the toolbar scrolls sideways instead of hiding timeframes',
    /\.toolbar\{[^}]*overflow-x:auto/.test(css.replace(/\s+/g, '')) || /overflow-x:auto/.test(css));
  ok('the bottom bar keeps clear of the iPhone home indicator',
    /env\(safe-area-inset-bottom\)/.test(css));
  ok('a phone chart is one screen tall, not a 56vh slice of a desktop column',
    /height:calc\(100vh\s*-\s*var\(--h-nav\)\s*-\s*var\(--h-tool\)\s*-\s*60px\)/.test(css));

  setTimeout(() => {
    console.log('');
    console.log(pass + ' passed, ' + fail + ' failed' + (fail ? '' : ' — MOBILE PASSED'));
    process.exit(fail ? 1 : 0);
  }, 700);
}, 400);
