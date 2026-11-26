/* Chart drawings: placed with a tool, stored against the symbol, taken back out again.

   A drawing is only useful if it survives a reload and lands where the reader put it, so the
   test checks the stored anchor (market time and price), not the pixels, and then checks that
   undo, erase and clear really remove it. */

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
const html = fs.readFileSync(path.join(ROOT, 'terminal', 'index.html'), 'utf8');

const bar = (t0, p) => ({ t0, t1: t0 + 60, open: p, high: p + 0.2, low: p - 0.2, close: p + 0.1,
  buy: 3, sell: 1, flat: 0, ticks: 4, delta: 2, volume: 4, estimated: true,
  levels: [[p, 3, 1, 0]] });

const frame = {
  symbol: 'XAUUSD', instruments: ['XAUUSD', 'XAUUSD247'], tf: 60, step: 0.05, decimals: 2, points: 20,
  bars: Array.from({ length: 10 }, (_, i) => bar(1795700000 + i * 60, 3571 + i * 0.1)),
  cvd: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20], session: { start: 1795651200, delta: 20 },
  imbalance: { ratio: 3, stacked: 3, bars: [] }, absorption: [], exhaustion: [], aggressive: [],
  divergence: [],
  profile: { poc: 3571.5, vah: 3571.9, val: 3571.1, total: 40, hvn: [], lvn: [], levels: [[3571.5, 5, 1, 0, 6]] },
  feed: { status: 'live', connected: true, age: 0.3, stale: false, price: 3571.9, bid: 3571.8, ask: 3572.0, spread: 0.2, error: '' },
  archive: { ticks: 400, persistent: true, kept_days: 4 },
  quality: { events: 100, duplicates: 0, invalid: 0, late: 0, rejected: 0, candles: 10, age_ms: 300 },
  settings: { timeframes: [15, 60, 300] },
  provenance: { vol_kind: 'tick_rule_estimate' }, market: { open: true, reason: 'quotes' },
  server_ts: 1795701000,
};

function makeCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 5 });
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'canvas') return { width: 1000, height: 420 };
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
  window.devicePixelRatio = 1;
  window.HTMLCanvasElement.prototype.getContext = () => makeCtx();
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 1000; } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 420; } });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
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
const stored = () => JSON.parse(w.localStorage.getItem('desento_drawings_v1') || '{}');
const count = () => ((stored().XAUUSD) || []).length;
const ev = (type, x, y) => new w.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
const canvas = () => d.querySelector('.pricepanel canvas');
const menuBtn = () => d.querySelector('.toolpop button');
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function openMenu() {
  if (!d.querySelector('.toolmenu')) menuBtn().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(60);
  return Array.from(d.querySelectorAll('.toolmenu .tool')).map((x) => x.textContent);
}
async function pickTool(label) {
  const items = await openMenu();
  const b = Array.from(d.querySelectorAll('.toolmenu .tool'))
    .find((x) => new RegExp(label, 'i').test(x.textContent));
  if (b) b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(60);
  return b ? items : false;
}

(async () => {
  await wait(350);
  ok('the price chart carries a drawing menu', !!menuBtn() && /draw/i.test(menuBtn().textContent));

  const labels = await openMenu();
  ok('the menu offers a level, a vertical line, a trend line, a rectangle, a measure and an eraser',
    ['Horizontal', 'Vertical', 'Trend', 'Rectangle', 'Measure', 'Erase', 'Undo', 'Redo', 'Clear all']
      .every((l) => labels.some((x) => x.includes(l))), labels);
  await pickTool('Horizontal');
  ok('choosing a tool says what to do next, and how to get out',
    /click to place/i.test((d.querySelector('.toolhint') || {}).textContent || '')
    && /Esc to cancel/.test(d.querySelector('.toolhint').textContent));

  canvas().dispatchEvent(ev('pointerdown', 300, 120));
  await wait(30);
  canvas().dispatchEvent(ev('pointerup', 300, 120));
  await wait(90);

  const one = (stored().XAUUSD || [])[0] || {};
  ok('a horizontal level is stored against the symbol', count() === 1, stored());
  ok('it is anchored to a price and a candle, not to a pixel',
    typeof one.a.price === 'number' && typeof one.a.t0 === 'number'
    && Math.abs(one.a.price - 3572) < 40, one.a);
  ok('the tool is put down once the level is placed', !d.querySelector('.toolhint'));

  await pickTool('Undo');
  ok('undo takes the level back out', count() === 0, stored());

  await pickTool('Redo');
  ok('redo puts it back', count() === 1, stored());

  await pickTool('Trend');
  canvas().dispatchEvent(ev('pointerdown', 200, 100));
  await wait(40);
  canvas().dispatchEvent(ev('pointermove', 420, 240));
  await wait(40);
  canvas().dispatchEvent(ev('pointerup', 420, 240));
  await wait(90);
  const list = stored().XAUUSD || [];
  const trend = list[list.length - 1] || {};
  ok('a dragged trend line keeps both ends', list.length === 2 && trend.type === 'trend'
    && trend.a.t0 !== trend.b.t0, trend);

  await pickTool('Erase');
  canvas().dispatchEvent(ev('pointerdown', 300, 120));
  await wait(90);
  ok('the eraser removes only the drawing it was put on', count() === 1, stored());

  await pickTool('Clear all');
  ok('clear all empties the symbol', count() === 0, stored());

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed' + (fail ? '' : ' — DRAWINGS PASSED'));
  process.exit(fail ? 1 : 0);
})();
