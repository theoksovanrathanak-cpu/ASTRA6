/* The terminal bundle, mounted in a headless DOM with a recording canvas.

   This is a wiring test, not a maths test: it proves the page boots, that a real frame from
   the API reaches the footprint renderer, that the bid column really is drawn to the left of
   the ask column, that every panel and control exists, and that the estimate warning is on
   screen rather than buried. Every calculation is proven in tests/tape_test.py. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.dirname(__dirname);
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
  }
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
  market: { open: true, reason: 'quotes', opens_at: null, detail: '' },
  server_ts: 1795700181,
};

const calls = [];
function makeCtx() {
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 5 });
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
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
    url: 'https://desento.test/',
  });
  const { window } = dom;

  window.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe() { this.cb([]); } disconnect() {} };
  window.devicePixelRatio = 1;
  window.HTMLCanvasElement.prototype.getContext = () => makeCtx();
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 1000; } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 420; } });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });

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

  const nowS = Math.floor(Date.now() / 1000);
  const calPayload = {
    status: 'ok', updated: nowS,
    next_high: { time: Math.floor(Date.UTC(2026, 10, 30, 8, 30) / 1000), title: 'NBS Manufacturing PMI',
      currency: 'CN', impact: 'High', forecast: '50.2', previous: '50.0', actual: '', unit: '' },
    calendar: [
      { time: Math.floor(Date.UTC(2026, 10, 30, 8, 30) / 1000), title: 'NBS Manufacturing PMI',
        currency: 'CN', impact: 'High', forecast: '50.2', previous: '50.0', actual: '', unit: '' },
    ],
    source: 'TradingView economic calendar', real: true,
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
    ],
    watch: [], real: true,
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
const doc = window.document;
const click = (w, sel) => {
  const el = (w || window).document.querySelector(sel);
  if (el) el.dispatchEvent(new (w || window).MouseEvent('click', { bubbles: true }));
  return !!el;
};

setTimeout(() => {
  const text = doc.body.textContent || '';
  const flat = text.split('\n').join(' ');
  const q = (s) => doc.querySelector(s);

  // ---------- navigation ----------
  ok('the page boots at all', text.length > 200);
  ok('the brand reads DESENTO with the product line', /DESENTO/.test(text) && /Order Flow Terminal/.test(text));
  ok('the estimate warning is in the header, not hidden in a tooltip',
    /estimated · tick rule/i.test(text));
  ok('the navigation carries the instrument selector', /Auto/.test(flat) && /XAUUSD247/.test(flat));
  ok('it carries the live price', /3571\.32/.test(text));
  ok('and the change since the first candle on screen', /\+0\.22/.test(text), text.slice(0, 120));
  ok('the market state is named', /open/.test(flat));
  ok('the connection readout states the socket and the age of the quote', /live · 0\.4s/.test(flat));
  ok('a hamburger is present', !!q('.mbtn'));
  ok('the transport readout is still gone', !/transport/.test(text));

  // ---------- toolbar ----------
  ok('every timeframe is offered', ['15s', '30s', '1m', '2m', '5m', '15m']
    .every((t) => new RegExp('>' + t + '<').test(doc.body.innerHTML)));
  ok('all six footprint modes are offered', ['Bid × Ask', 'Delta', 'Volume', 'Imbalance', 'Bid volume', 'Ask volume']
    .every((m) => flat.indexOf(m) >= 0));
  ok('price aggregation, imbalance ratio, profile range and history are in the toolbar',
    /price/.test(flat) && /imbalance %/.test(flat) && /profile/.test(flat) && /history/.test(flat));

  // ---------- the footprint ----------
  ok('the chart is titled with the contract, the candle and the grid',
    /Footprint · XAUUSD · 1m · 0\.05 grid/.test(flat));
  ok('the legend says which side sits where', /cell = bid on the left, ask on the right/.test(flat));
  ok('a websocket to the tape endpoint was opened', !!window.__ws && /\/ws\/tape/.test(window.__ws.url));

  const drawn = calls.filter((c) => c[0] === 'fillText').map((c) => ({ t: String(c[1]), x: c[2], y: c[3] }));
  const at = (t) => drawn.filter((c) => c.t === t);
  // 3571.10 in the first candle: bid 1, ask 3. The bid number must sit left of the ask.
  const pair = [];
  at('1').forEach((a) => at('3').forEach((b) => { if (Math.abs(a.y - b.y) < 1) pair.push([a.x, b.x]); }));
  ok('the footprint draws the bid number left of the ask number on the same level',
    pair.some(([bx, ax]) => bx < ax), pair.slice(0, 4));
  ok('the canvas wrote price labels', drawn.some((c) => /^35\d\d\.\d\d$/.test(c.t)));
  ok('the canvas marked the POC line in the price gutter',
    drawn.some((c) => /^POC 35\d\d\.\d\d$/.test(c.t)));
  ok('the canvas marked the value area',
    drawn.some((c) => /^VAH /.test(c.t)) && drawn.some((c) => /^VAL /.test(c.t)));
  ok('a per-candle delta is printed in the column header',
    drawn.some((c) => c.t === '+4') && drawn.some((c) => c.t === '-2'));

  // ---------- sidebar ----------
  ok('the analytics column groups market, delta, volume and order flow',
    /Market/.test(flat) && /Delta/.test(flat) && /Volume/.test(flat) && /Order flow/.test(flat));
  ok('the session delta is printed from the payload', /Session\+8/.test(flat.replace(/\s/g, '')));
  ok('volume is split into the ask side and the bid side',
    /Ask side \(bought\)/.test(flat) && /Bid side \(sold\)/.test(flat));
  ok('the concentration of volume is reported', /Concentration/.test(flat));
  ok('imbalance counts are reported for both sides', /Ask imbalances/.test(flat) && /Bid imbalances/.test(flat));

  // ---------- lower analytics ----------
  ok('the cumulative delta panel is present', /Cumulative delta/.test(flat));
  ok('the delta histogram panel is present', /Delta per candle/.test(flat));
  ok('the volume profile panel names POC, VAH, VAL, HVN and LVN',
    /POC 3571\.30/.test(flat) && /VAH/.test(flat) && /VAL/.test(flat) && /HVN/.test(flat) && /LVN/.test(flat));
  ok('the profile says the value area is recalculated in the browser',
    /recalculated in the browser/.test(flat));

  // ---------- honesty ----------
  ok('the page states that volumes are counted quotes, not traded volume',
    /counted quotes, not reported traded volume/.test(flat));

  // ---------- settings ----------
  click(window, '[title="Settings"]');
  setTimeout(() => {
    const s = (doc.body.textContent || '').split('\n').join(' ');
    ok('the settings sheet opens from the navigation', /Chart settings/.test(s));
    ok('it offers the display mode, the numbers and the volume filter',
      /Display mode/.test(s) && /Numbers/.test(s) && /Volume filter/.test(s));
    ok('it offers chart height, the sidebar and the value area',
      /Chart height/.test(s) && /Analytics sidebar/.test(s) && /Value area/.test(s));

    // switching a mode must repaint the cells and stick
    const modeBtn = [...doc.querySelectorAll('.toolbar .seg button')].find((b) => b.textContent === 'Delta');
    if (modeBtn) modeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    setTimeout(() => {
      let stored = {};
      try { stored = JSON.parse(window.localStorage.getItem('desento_prefs_v1') || '{}'); } catch (e) { /* */ }
      ok('switching the footprint mode is remembered on the device', stored.mode === 'delta', stored);

      // ---------- drawer ----------
      click(window, '.mbtn');
      setTimeout(() => {
        const sheet = (doc.querySelector('.sheet') || {}).textContent || '';
        const f2 = sheet.split('\n').join(' ');
        ok('the drawer still leads with the economic calendar',
          /Economic calendar/.test(f2) && /NBS Manufacturing PMI/.test(f2) && /Open calendar/.test(f2));
        ok('the gold reading is in the drawer with its 90-second clock',
          /Gold fundamentals · XAUUSD/.test(f2) && /every 90 s/.test(f2) && /fastest:/.test(f2));
        ok('alerts and install are in the drawer',
          /Signal alerts on this device/.test(f2) && /Send a test card/.test(f2) && /Install Desento/.test(f2));
        ok('sign-in says plainly when Google is not configured',
          /not configured on this server/i.test(f2));

        // ---------- a shut exchange ----------
        const shut = JSON.parse(JSON.stringify(frame));
        shut.bars = [];
        shut.cvd = [];
        shut.points = 0;
        shut.imbalance.bars = [];
        shut.profile = { poc: null, vah: null, val: null, total: 0, hvn: [], lvn: [], levels: [] };
        shut.feed = { status: 'closed', connected: false, age: null, stale: true, price: null, error: '' };
        shut.market = { open: false, reason: 'daily_break',
          opens_at: Math.floor(Date.UTC(2026, 10, 26, 22, 2, 0) / 1000),
          detail: 'Gold is in its daily break, 20:58-22:02 UTC.' };
        shut.instruments = ['XAUUSD', 'XAUUSD247'];

        const f247 = JSON.parse(JSON.stringify(shut));
        f247.symbol = 'XAUUSD247';

        const w2 = boot(shut);
        const w3 = boot(f247);
        const w4 = boot(frame, { down: true });
        setTimeout(() => click(w4, '.mbtn'), 60);

        setTimeout(() => {
          const t2 = (w2.document.body.textContent || '').split('\n').join(' ');
          ok('a shut exchange is named on the chart, not left as a blank panel',
            /gold is not trading/i.test(t2), t2.slice(0, 180));
          ok('it says when gold reopens, in UTC', /Reopens\s*22:02 UTC/.test(t2));
          ok('and that nothing was invented to fill the gap',
            /nothing here is filled in with invented volume/i.test(t2));
          ok('the header carries the market state', /market|closed/i.test(t2) && /closed/.test(t2));
          ok('a shut ordinary contract offers the 24/7 one instead',
            /Chart XAUUSD247 instead/.test(t2));
          ok('a 24/7 contract is named as such in the header',
            /24\/7 gold/.test(w3.document.body.textContent || ''));

          setTimeout(() => {
            const t4 = ((w4.document.querySelector('.sheet') || {}).textContent || '').split('\n').join(' ');
            ok('with the drawer feeds down, the cards say so instead of inventing a reading',
              /calendar feed is unreachable right now/i.test(t4)
              && /gold feeds are unreachable right now/i.test(t4), t4.slice(0, 200));

            ok('the mobile bottom navigation exists',
              !!doc.querySelector('.bnav') && /Chart/.test(doc.querySelector('.bnav').textContent));

            ok('the stylesheet carries the responsive rules', /@media \(max-width:820px\)/.test(css));

            console.log('');
            console.log(pass + ' passed, ' + fail + ' failed' + (fail ? '' : ' — TERMINAL SMOKE PASSED'));
            process.exit(fail ? 1 : 0);
          }, 200);
        }, 220);
      }, 120);
    }, 80);
  }, 80);
}, 240);
