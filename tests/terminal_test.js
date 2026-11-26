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

function boot(payload, opts) {
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
// the drawer reads three endpoints of its own, so the stub answers by URL rather than
// handing the tape frame to every caller
const nowS = Math.floor(Date.now() / 1000);
const calPayload = {
  status: 'ok', updated: nowS,
  next_high: { time: Math.floor(Date.UTC(2026, 10, 30, 8, 30) / 1000), title: 'NBS Manufacturing PMI',
    currency: 'CN', impact: 'High', forecast: '50.2', previous: '50.0', actual: '', unit: '' },
  calendar: [
    { time: Math.floor(Date.UTC(2026, 10, 30, 8, 30) / 1000), title: 'NBS Manufacturing PMI',
      currency: 'CN', impact: 'High', forecast: '50.2', previous: '50.0', actual: '', unit: '' },
    { time: Math.floor(Date.UTC(2026, 11, 1, 13, 0) / 1000), title: 'ISM Manufacturing PMI',
      currency: 'US', impact: 'Medium', forecast: '48.9', previous: '48.7', actual: '', unit: '' },
  ],
  source: 'https://www.tradingview.com/economic-calendar/', real: true,
};
const goldPayload = {
  status: 'ok', market: 'XAUUSD', bias: 'SELL', label: 'gold-negative headlines',
  score: -0.512, confidence: 51, buy: 2, sell: 5, voters: 7, freshest_h: 0.6,
  stale: false, market_open: true, reopen_at: null, period_s: 90,
  next_update: nowS + 10, now: nowS, next_in: 10, news_age: 2280,
  feeds: Array.from({ length: 13 }, (_, i) => ({ name: i === 0 ? 'ZeroHedge' : 'wire ' + i, age: 600 + i * 60 })),
  stories: [
    { title: 'Gold price stalls near $3,570 as Fed hike bets keep bulls at bay', impact: 'SELL',
      weight: 2, strength: 2, why: 'hawkish Fed language weighs on gold', source: 'Reuters',
      time: nowS - 2280, url: 'https://example.com/a', gold: true },
    { title: 'Dollar firms as yields edge higher', impact: 'SELL', weight: 1, strength: 1,
      why: 'a stronger dollar offers gold', source: 'Bloomberg', time: nowS - 3600,
      url: 'https://example.com/b', gold: false },
  ],
  watch: [{ time: nowS + 7200, title: 'ISM Manufacturing PMI', currency: 'US', impact: 'High', note: 'x' }],
  real: true,
};
const ownerPayload = { signed_in: false, owner: false, google_ready: false, client_id: null };
window.fetch = async (url) => {
  const u = String(url);
  const down = opts && opts.down;
  if (u.indexOf('/api/calendar') === 0) return { ok: true, json: async () => (down ? { status: 'error' } : calPayload) };
  if (u.indexOf('/api/fundamentals/gold') === 0) return { ok: true, json: async () => (down ? { status: 'error' } : goldPayload) };
  if (u.indexOf('/api/owner/me') === 0) return { ok: true, json: async () => ownerPayload };
  return { ok: true, json: async () => payload };
};
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
  const flat = menuText.split('\n').join(' ');
  ok('the drawer leads with the economic calendar and the next high-impact event',
    /Economic calendar/.test(flat) && /CN/.test(flat) && /NBS Manufacturing PMI/.test(flat), flat.slice(0, 180));
  ok('it offers the full calendar without leaving the terminal', /Open calendar/.test(flat));
  ok('the gold reading is the second card: side, story and the 90-second clock',
    /Gold fundamentals · XAUUSD/.test(flat) && /SELL/.test(flat)
    && /Fed hike bets keep bulls at bay/.test(flat)
    && /next reading in/.test(flat) && /every 90 s/.test(flat)
    && /newest story 38 min ago/.test(flat) && /13 wires/.test(flat) && /fastest: ZeroHedge/.test(flat),
    flat.slice(0, 360));
  ok('it offers the full gold reading without leaving the terminal', /Open gold fundamentals/.test(flat));
  ok('alerts are armed from the drawer, with the same promise as the signals page',
    /Signal alerts on this device/.test(flat) && /Send a test card/.test(flat)
    && /same numbers the owner published/.test(flat));
  ok('install is in the drawer too', /Install Desento/.test(flat), flat.slice(-260));
  ok('the estimate warning did not leave the page just because the drawer changed',
    /estimated · tick rule/i.test(text) && /counted from quotes/i.test(text));
  ok('sign-in says plainly when Google is not configured, instead of failing silently',
    /not configured on this server/i.test(flat), menuText.slice(-120));
  ok('the old navigation rows are gone from the drawer, as asked',
    !/Signals & news/.test(flat) && !/footprint · delta · profile/.test(flat));
  ok('the menu still lets the reader choose which gold contract is charted',
    /Instrument/.test(flat) && /XAUUSD247/.test(flat) && /Auto/.test(flat));
  ok('and it says Auto may switch, under the contract\'s own name',
    /follows whichever gold contract is printing/i.test(flat));

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

  const _f247 = JSON.parse(JSON.stringify(shut));
  _f247.symbol = 'XAUUSD247';
  const w3 = boot(_f247);
  // and a third door: both drawer feeds are down, so the cards must say so
  const w4 = boot(frame, { down: true });
  // React mounts on its own tick, so the click waits for the button to exist
  setTimeout(() => {
    const m4 = w4.document.querySelector('.mbtn');
    if (m4) m4.dispatchEvent(new w4.MouseEvent('click', { bubbles: true }));
  }, 60);
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
    ok('a 24/7 contract is named as such in the header, never disguised as XAUUSD',
      /24\/7 gold/.test(w3.document.body.textContent || ''),
      (w3.document.body.textContent || '').slice(0, 90));
    ok('the estimate label still never doubles as a status',
      /estimated · tick rule/i.test(t2) && /market closed/i.test(t2));

    const t4 = ((w4.document.querySelector('.sheet') || {}).textContent || '').split('\n').join(' ');
    ok('with the drawer feeds down, the cards say so instead of inventing a reading',
      /calendar feed is unreachable right now/i.test(t4)
      && /gold feeds are unreachable right now/i.test(t4), t4.slice(0, 200));
    ok('and no headline, side or event is printed when there is no data',
      !/SELL|BUY|NO EDGE/.test(t4) && !/NBS Manufacturing PMI/.test(t4), t4.slice(0, 200));

    console.log('');
    console.log(pass + ' passed, ' + fail + ' failed' + (fail ? '' : ' — TERMINAL SMOKE PASSED'));
    process.exit(fail ? 1 : 0);
  }, 220);
  }, 40);
}, 220);
