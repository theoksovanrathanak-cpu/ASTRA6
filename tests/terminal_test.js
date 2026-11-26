/* The terminal bundle, mounted in a headless DOM with a recording canvas.

   This is a wiring test, not a maths test: it proves the page boots, that a real frame
   from the API reaches the footprint renderer, and that the estimate warning is on
   screen rather than buried. Every calculation is proven in tests/tape_test.py. */

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

function bar(t0, delta, levels) {
  const buy = levels.reduce((a, r) => a + r[1], 0);
  const sell = levels.reduce((a, r) => a + r[2], 0);
  return { t0, t1: t0 + 60, open: levels[0][0], high: levels[0][0], low: levels[levels.length - 1][0],
    close: levels[0][0], buy, sell, flat: 0, ticks: buy + sell, delta,
    volume: buy + sell, levels, estimated: true };
}

const frame = {
  symbol: 'XAUUSD', tf: 60, step: 0.05, decimals: 2, points: 40,
  first_ts: 1795700000, last_ts: 1795700180,
  bars: [
    bar(1795700000, 4, [[3571.10, 3, 1, 0], [3571.05, 1, 2, 0]]),
    bar(1795700060, -2, [[3571.20, 2, 4, 0], [3571.15, 4, 1, 0]]),
    bar(1795700120, 6, [[3571.30, 5, 1, 0], [3571.25, 2, 0, 0]]),
  ],
  cvd: [4, 2, 8],
  session: { start: 1795651200, delta: 8 },
  imbalance: { ratio: 3, stacked: 3, bars: [
    { t0: 1795700000, marks: [], stacks: [] },
    { t0: 1795700060, marks: [{ price: 3571.15, side: 'buy', ratio: 4.0 }], stacks: [] },
    { t0: 1795700120, marks: [{ price: 3571.30, side: 'buy', ratio: 5.0 }],
      stacks: [{ side: 'buy', from: 3571.25, to: 3571.30, levels: 2 }] },
  ] },
  absorption: [{ price: 3571.15, volume: 12, buy: 6, sell: 6, candles: 3, net_share: 0 }],
  exhaustion: [{ t0: 1795700060, volume: 9, range: 0.05, delta: -2, side: 'sell' }],
  aggressive: [{ t0: 1795700120, side: 'buy', share: 0.75, delta: 6 }],
  divergence: [{ t0: 1795700060, side: 'bearish', price: 3571.20, cvd: 2 }],
  profile: { poc: 3571.30, vah: 3571.30, val: 3571.10, total: 26,
    hvn: [3571.30], lvn: [3571.05], value_area: 0.7, estimate: true,
    levels: [[3571.30, 7, 1, 0, 8], [3571.25, 2, 0, 0, 2], [3571.20, 2, 4, 0, 6],
      [3571.15, 4, 1, 0, 5], [3571.10, 3, 1, 0, 4], [3571.05, 1, 2, 0, 3]] },
  feed: { status: 'live', connected: true, age: 0.4, stale: false, price: 3571.32, error: '' },
  archive: { ticks: 412, first_ts: 1795699000, last_ts: 1795700180, persistent: true, kept_days: 4 },
  settings: { tf: 60, step: 0.05, bars: 90, ratio: 3, stack: 3, minutes: 240,
    timeframes: [15, 30, 60, 120, 300, 900], steps: [0.01, 0.05, 0.1, 0.25, 0.5, 1] },
  provenance: { vol_kind: 'tick_rule_estimate', label: 'estimated', note: 'counted ticks' },
  note: 'estimate',
  server_ts: 1795700181,
};

const calls = [];
function makeCtx() {
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'canvas') return { width: 900, height: 560 };
      if (k in t) return t[k];
      return rec(String(k));
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function boot(payload) {
const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, '').replace(/<link[^>]*>/, ''), {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://desento.test/terminal',
});
const { window } = dom;

window.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe() { this.cb([]); } disconnect() {} };
window.devicePixelRatio = 1;
window.HTMLCanvasElement.prototype.getContext = () => makeCtx();
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 900; } });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 560; } });

window.__ws = null;
window.WebSocket = class {
  constructor(url) {
    window.__ws = this;
    this.url = url;
    setTimeout(() => {
      if (this.onopen) this.onopen();
      if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
    }, 5);
  }
  close() { if (this.onclose) this.onclose(); }
  send() {}
};
window.fetch = async () => ({ ok: true, json: async () => payload });
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

try {
  window.eval(bundle);
} catch (e) {
  console.log('  FAIL the bundle threw while booting: ' + e.message);
  process.exit(1);
}
return window;
}

const window = boot(frame);

setTimeout(() => {
  const text = window.document.body.textContent || '';

  ok('the page boots at all', text.length > 0);
  ok('the brand reads DESENTO', /DESENTO/.test(text));
  ok('the estimate warning is on the page, not hidden in a tooltip',
    /estimated · tick rule/i.test(text));
  ok('the chart is titled as a footprint', /Footprint · bid × ask/.test(text));
  ok('the transport readout is gone, as asked - it only ever twitched',
    !/transport/.test(text));
  ok('the feed panel reports the quote and its age', /3571\.32/.test(text) && /0\.4s/.test(text));
  ok('delta, session delta and CVD are all present',
    /Delta/.test(text) && /Session \(UTC\)/.test(text) && /Cumulative/.test(text));
  ok('the imbalance panel names the diagonal rule and the threshold',
    /diagonal · 300%/.test(text) && /diagonal, not same-price/i.test(text));
  ok('the profile reports POC, VAH and VAL', /POC/.test(text) && /Value area high/.test(text));
  ok('HVN and LVN are separated, not merged',
    /HVN 3571\.30/.test(text) && /LVN 3571\.05/.test(text));
  ok('absorption and exhaustion are described in the panel',
    /Absorption zones/.test(text) && /Exhaustion bars/.test(text));
  ok('the divergence alert is surfaced', /bearish divergence/.test(text));
  ok('the footer is down to the brand and the clock',
    /DESENTO/.test((window.document.querySelector('.foot') || {}).textContent || '')
    && !/no synthetic prices/.test(text));
  ok('a hamburger menu is back on the page',
    !!window.document.querySelector('.mbtn'));
  const _m = window.document.querySelector('.mbtn');
  if (_m) _m.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok('the session delta is printed from the payload', /\+8/.test(text));
  ok('a websocket to the tape endpoint was opened',
    !!window.__ws && /\/ws\/tape/.test(window.__ws.url));

  const drawn = calls.filter((c) => c[0] === 'fillText').map((c) => String(c[1]));
  ok('the canvas drew footprint cells as buy×sell', drawn.some((s) => s.includes('×')),
    drawn.slice(0, 8));
  ok('the canvas labelled the delta and cvd strips',
    drawn.some((s) => s === 'DELTA') && drawn.some((s) => s.startsWith('CVD')));
  ok('the canvas marked the POC line', drawn.some((s) => s === 'POC'));
  ok('the canvas wrote price labels', drawn.some((s) => /^35\d\d\.\d\d$/.test(s)));
  ok('the canvas filled rectangles for cells and strips',
    calls.filter((c) => c[0] === 'fillRect').length > 6);
  ok('a per-candle delta is printed in the column header',
    drawn.some((s) => s === '+4' || s === '+6' || s === '-2'), drawn.slice(0, 12));

  setTimeout(() => {
  const menuText = (window.document.querySelector('.sheet') || {}).textContent || '';
  ok('the menu carries the signals page and the owner door',
    /Signals & news/.test(menuText) && /Owner sign-in/.test(menuText), menuText.slice(0, 140));
  ok('the menu repeats the estimate warning rather than hiding it',
    /counted quotes, not reported traded volume/i.test(menuText.split('\n').join(' ')));
  ok('sign-in says plainly when Google is not configured, instead of failing silently',
    /not configured on this server/i.test(menuText.split('\n').join(' ')), menuText.slice(-120));

  // ---- second scenario: the exchange is shut, so there is no tape to draw
  const shut = JSON.parse(JSON.stringify(frame));
  shut.bars = [];
  shut.cvd = [];
  shut.points = 0;
  shut.imbalance.bars = [];
  shut.absorption = [];
  shut.exhaustion = [];
  shut.aggressive = [];
  shut.divergence = [];
  shut.profile = { poc: null, vah: null, val: null, total: 0, hvn: [], lvn: [], levels: [] };
  shut.feed = { status: 'closed', connected: false, age: null, stale: true, price: null, error: '' };
  shut.market = { open: false, reason: 'daily_break',
    opens_at: Math.floor(Date.UTC(2026, 10, 26, 22, 2, 0) / 1000),
    detail: 'Gold is in its daily break, 20:58-22:02 UTC.' };

  const w2 = boot(shut);
  setTimeout(() => {
    const t2 = w2.document.body.textContent || '';
    ok('a shut exchange is named on the chart, not left as a blank panel',
      /gold is not trading/i.test(t2), t2.slice(0, 160));
    ok('it says when gold reopens', /Reopens\s*22:02 UTC/.test(t2.replace(/\s+/g, ' ')));
    ok('and it states that nothing was invented to fill the gap',
      /nothing here is filled in with invented volume/i.test(t2.replace(/\s+/g, ' ')));
    ok('the header carries the market state, not just the estimate label',
      /market closed/.test(t2) && /opens 22:02 UTC/.test(t2));
    ok('the estimate label still never doubles as a status',
      /estimated · tick rule/i.test(t2) && /market closed/i.test(t2));

    console.log('');
    console.log(pass + ' passed, ' + fail + ' failed' + (fail ? '' : ' — TERMINAL SMOKE PASSED'));
    process.exit(fail ? 1 : 0);
  }, 220);
  }, 40);
}, 220);
