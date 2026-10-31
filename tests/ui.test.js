/**
 * ASTRA6 UI tests — run with: node tests/ui.test.js
 *
 * These pull the real functions out of index.html and exercise them against a
 * small DOM stub. No browser needed (the sandbox has no Playwright libs), which
 * is why every past regression here was caught by a harness like this one.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ---------------------------------------------------------------- helpers
function grab(name) {
  let i = html.indexOf('function ' + name + '(');
  if (i < 0) i = html.indexOf('async function ' + name + '(');
  if (i < 0) throw new Error('missing function ' + name);
  let depth = 0, started = false, inStr = null, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return html.slice(i, j + 1); }
  }
  throw new Error('unbalanced function ' + name);
}

const store = {};
const els = {};
function mkEl(id) {
  const cl = new Set();
  return {
    id, textContent: '', _html: '', style: {}, dataset: {}, attrs: {}, kids: [],
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (v === '') this.kids = []; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    appendChild(c) { this.kids.push(c); return c; },
    remove() { this.removed = true; },
    querySelector() { return null; },
    clientWidth: 800, clientHeight: 400, childNodes: [], offsetWidth: 1,
    getBoundingClientRect: () => ({ height: 64, width: 390, top: 0, left: 0 }),
    classList: {
      add: c => cl.add(c), remove: c => cl.delete(c),
      toggle: (c, on) => { on === undefined ? (cl.has(c) ? cl.delete(c) : cl.add(c)) : (on ? cl.add(c) : cl.delete(c)); },
      contains: c => cl.has(c),
    },
  };
}

const bodyCl = new Set();
let BTNS = [];
const timers = [];

global.document = {
  getElementById: id => els[id] || (els[id] = mkEl(id)),
  createElementNS: () => mkEl('svg'),
  querySelector: () => mkEl('q'),
  querySelectorAll: sel => (sel === '[data-strategy]' || sel === '[data-view]') ? BTNS : [],
  addEventListener: () => {},
  body: { style: {}, classList: { add: c => bodyCl.add(c), remove: c => bodyCl.delete(c), contains: c => bodyCl.has(c) },
          setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = v; } },
  documentElement: { setAttribute() {}, getAttribute: () => 'dark', style: { setProperty(k, v) { this[k] = v; } } },
};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
global.window = { innerWidth: 1280 };
global.requestAnimationFrame = f => f();
global.setTimeout = (f, ms) => { timers.push({ f, ms, canceled: false }); return timers.length; };
global.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].canceled = true; };
global.chart = { applyOptions() {}, timeScale: () => ({ timeToCoordinate: () => 100, width: () => 720, getVisibleRange: () => null }) };
global.candleSeries = { priceToCoordinate: p => 300 - p, update() {}, createPriceLine: () => ({}), removePriceLine() {} };
global.scheduleZoneDraw = () => {};
global.renderCurrent = s => { global.CURRENT = s; };
global.renderAlerts = a => { global.RENDERED = a; };
global.beep = () => {};
global.fmtPx = v => '$' + Number(v).toFixed(2);
global.isDark = () => false;
global.lastCandles = [{ time: 1000, open: 1, high: 2, low: 1, close: 1.5 }];
global.lastPrice = 100;
global.currentVenue = 'OANDA:XAUUSD';
let currentSymbol = 'XAUUSD';
Object.defineProperty(global, 'currentSymbol', { get: () => currentSymbol, set: v => { currentSymbol = v; } });

// ---- load the code under test ----
eval([
  'firedKeys', 'markFired', 'zoneAlerts', 'recordZoneAlert', 'latestTrade', 'renderZoneAlerts',
  'openMenu', 'closeMenu', 'toggleMenu', 'setView', 'endIntro', 'playIntro',
  'drawVolume', 'syncHdH',
].map(n => grab(n)).join('\n'));
['recordZoneAlert', 'renderZoneAlerts', 'zoneAlerts', 'latestTrade',
 'openMenu', 'closeMenu', 'toggleMenu', 'setView', 'endIntro', 'playIntro',
 'drawVolume', 'syncHdH'].forEach(n => { global[n] = eval(n); });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m', name); } else { fail++; console.log('  \x1b[31m✗\x1b[0m', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const section = t => console.log('\n' + t);

// ================================================================ tests
section('markup');
{
  const { execSync } = require('child_process');
  const bal = require('child_process').execSync(
    `python3 -c "
from html.parser import HTMLParser
class P(HTMLParser):
    def __init__(self):
        super().__init__(); self.stack=[]; self.bad=[]
        self.void={'area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr'}
    def handle_starttag(self,t,a):
        if t not in self.void: self.stack.append(t)
    def handle_endtag(self,t):
        if t in self.void: return
        if self.stack and self.stack[-1]==t: self.stack.pop()
        else: self.bad.append(t)
p=P(); p.feed(open('${root}/index.html').read())
print('BAD' if (p.bad or p.stack) else 'clean')
"`).toString().trim();
  ok('no unclosed or stray tags', bal === 'clean', bal);
  ok('title is ASTRA6', /<title>ASTRA6<\/title>/.test(html));
  ok('no duplicate ids', (() => {
    const ids = [...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
    return new Set(ids).size === ids.length;
  })());
}

section('hamburger menu');
{
  const menu = document.getElementById('menu'), scrim = document.getElementById('scrim'), burger = document.getElementById('burger');
  ok('starts closed', !menu.classList.contains('open'));
  toggleMenu();
  ok('opens', menu.classList.contains('open') && scrim.classList.contains('on'));
  ok('aria-expanded true', burger.getAttribute('aria-expanded') === 'true');
  ok('scroll locked', document.body.style.overflow === 'hidden');
  toggleMenu();
  ok('closes', !menu.classList.contains('open') && document.body.style.overflow === '');
  ok('market switch lives in the drawer', html.indexOf('data-sym="XAUUSD"') > html.indexOf('id="menu"'));
  ok('timeframes live in the drawer', html.indexOf('id="tf-buttons"') > html.indexOf('id="menu"'));
  ok('ladder lives in the drawer', html.indexOf('id="alerts-list"') > html.indexOf('id="menu"'));
  ok('front page has no ladder', !html.slice(html.indexOf('<main'), html.indexOf('</main>')).includes('alerts-list'));
}

section('view switching');
{
  BTNS = ['chart', 'signal', 'all'].map(v => { const b = mkEl('b-' + v); b.dataset.view = v; return b; });
  setView('chart');
  ok('chart only', document.body.attrs['data-view'] === 'chart' && localStorage.getItem('astra6_view') === 'chart');
  setView('signal');
  ok('signal only', document.body.attrs['data-view'] === 'signal');
  setView('all');
  ok('both', document.body.attrs['data-view'] === 'all');
  ok('hint text follows', els['view-hint'].textContent === 'chart and signal together');
}

section('the ladder and the card quote the same numbers');
{
  currentSymbol = 'XAUUSD';
  localStorage.removeItem('astra6_zone_alerts_XAUUSD');
  recordZoneAlert('XAUUSD|VOL|BUY|1', { type: 'BUY', entry: 3876.42, sl: 3872.10, tp1: 3879.66, tp2: 3884.05, r: 1.74, confidence: 71 });
  const rec = latestTrade('XAUUSD');
  ok('entry kept', rec.entry === 3876.42);
  ok('stop kept', rec.sl === 3872.10);
  ok('tp2 kept', rec.tp2 === 3884.05);
  ok('R kept', rec.r === 1.74);
  renderZoneAlerts();
  ok('tp2 reaches the renderer', global.RENDERED[0].tp2 === 3884.05);
  ok('no invented 0% win rate', global.RENDERED[0].winrate_est == null);
  ok('duplicate key ignored', (recordZoneAlert('XAUUSD|VOL|BUY|1', { type: 'BUY', entry: 1 }) === null));
  currentSymbol = 'BTCUSD';
  ok('other symbol has its own ladder', latestTrade('BTCUSD') === null);
}

section('3D welcome');
{
  const intro = document.getElementById('intro');
  intro.classList.add('gone');
  playIntro();
  ok('plays on every visit', !intro.classList.contains('gone') && intro.style.display === '');
  ok('locks scroll', bodyCl.has('intro-open'));
  ok('waits for the user (no auto-dismiss)', !timers.some(t => t.ms === 2600 && !t.canceled));
  ok('the burger dismisses it', /endIntro\(\)/.test(grab('toggleMenu')));
  endIntro();
  ok('dismiss releases the lock', !bodyCl.has('intro-open') && intro.classList.contains('gone'));
  ok('3D ring + shine + depth', html.includes('intro-ring') && html.includes('intro-shine') && html.includes('translateZ(-180px)'));
  ok('prompt points at the menu', html.includes('tap the menu to open'));
  ok('replay available in the menu', html.includes('Replay welcome'));
  ok('no session gate', !html.includes("sessionStorage.getItem('astra6_intro')"));
}

section('chart fills the device');
{
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok('chart view is a full-height screen',
     /body\[data-view="chart"\] \.wrap\{[^}]*height:calc\(100dvh - var\(--hd-h\)\)/.test(css));
  ok('the card stops being a card', /body\[data-view="chart"\] #chart-section\{[^}]*height:100%/.test(css));
  ok('chart stretches to that height', /body\[data-view="chart"\] #oanda_chart\{height:100%/.test(css));
  ok('chart shell flexes, no dead strip', /body\[data-view="chart"\] \.chart-shell\{flex:1 1 auto;min-height:0\}/.test(css));
  ok('footer is not a separate part', /body\[data-view="chart"\] \.foot,body\[data-view="signal"\] \.foot\{display:none\}/.test(css));
  ok('no page scroll behind the chart', /body\[data-view="chart"\]\{overflow:hidden\}/.test(css));
  ok('header height is measured, not guessed', /getBoundingClientRect\(\)\.height/.test(grab('syncHdH')));
  ok('header resize re-fits the chart', /ResizeObserver\(fitScreen\)\.observe/.test(html));
  ok('rotation re-fits the chart', /orientationchange/.test(html) && /visualViewport/.test(html));
  ok('the site opens on the chart', /localStorage\.getItem\('astra6_view'\) \|\| 'chart'/.test(html));
  syncHdH();
  ok('--hd-h lands on the root', document.documentElement.style['--hd-h'] === '64px', document.documentElement.style['--hd-h']);
}

section('the cluster sits on its own candles');
{
  // 150 M15 bars, 4 px each, prices 100..200 over a 400 px plot
  const T0 = 1793250000, STEP = 900, SP = 4;
  const toX = t => ((t - T0) / STEP + 0.5) * SP;
  const toY = p => 400 - ((p - 100) / 100) * 400;
  global.chart = { applyOptions() {}, timeScale: () => ({
    timeToCoordinate: toX, width: () => 720, options: () => ({ barSpacing: SP }), getVisibleRange: () => null }) };
  global.candleSeries = { priceToCoordinate: toY, update() {}, createPriceLine: () => ({}), removePriceLine() {} };
  global.lastCandles = [];
  for (let i = 0; i < 150; i++) {
    const low = i === 0 ? 100 : 120 + (i % 7), high = i === 149 ? 200 : 180 - (i % 5);
    global.lastCandles.push({ time: T0 + i * STEP, open: 150, high, low, close: 150 });
  }
  global.window._strategy = 'volume';
  global.window._volume = {
    status: 'ok', tf: 'M15', bars_used: 150, from: T0, to: T0 + 149 * STEP,
    split: 'estimated split', vwap: 150, poc: { bot: 150, top: 151 },
    // two rows are deliberately outside the candle range, as two venues' wicks would be
    rows: [
      { bot: 205, top: 210, buy: 1, sell: 1, total: 2, delta: 0 },
      { bot: 180, top: 185, buy: 9, sell: 3, total: 12, delta: 6 },
      { bot: 150, top: 156, buy: 4, sell: 8, total: 12, delta: -4 },
      { bot: 92,  top: 98,  buy: 2, sell: 2, total: 4, delta: 0 },
    ],
    vwap_series: [{ time: T0, value: 150 }, { time: T0 + 149 * STEP, value: 151 }],
  };
  global._VL = { bands: [], meters: [], labels: [], path: null, dot: null, tag: null };
  global._svgEl = () => mkEl('svg');
  global._pool = (parent, pool, n) => { while (pool.length < n) { const e = mkEl('r'); parent.appendChild(e); pool.push(e); } return pool; };
  global.drawVolumeLevels = () => {};
  global.fmtVol = n => String(n);
  drawVolume();
  const bands = global._VL.bands;
  ok('a band per row inside the candles', bands.length === 2, bands.length);
  const x = Number(bands[0].getAttribute('x')), w = Number(bands[0].getAttribute('width'));
  ok('left edge on the first candle', Math.abs(x - 1.5) < 0.6, x);            // clamped at the plot edge
  ok('right edge on the last candle', Math.abs((x + w) - (toX(T0 + 149 * STEP) + SP / 2)) < 0.6, x + w);
  const ys = bands.map(b => [Number(b.getAttribute('y')), Number(b.getAttribute('y')) + Number(b.getAttribute('height'))]);
  ok('every row stays inside the candle range', ys.every(([a, b]) => a >= toY(200) - 0.5 && b <= toY(100) + 0.5), ys);
  ok('the row above the top wick is clipped, not floating', ys.every(([a]) => a >= toY(200) - 0.5), ys[0][0]);
  ok('the legend says which bars were used', /M15 · 150 bars/.test(document.getElementById('lg-note').textContent),
     document.getElementById('lg-note').textContent);
}

section('the profile uses the chart timeframe');
{
  ok('every request carries the timeframe', /\/api\/volume\?symbol=\$\{encodeURIComponent\(sym\)\}&venue=\$\{encodeURIComponent\(venue\)\}&tf=\$\{encodeURIComponent\(tf\)\}/.test(html));
  ok('clipped to the oldest candle on screen', /&since=\$\{since\}/.test(html));
  ok('switching timeframe rebuilds the clusters', /window\._volume=null;window\._volSigKey=null;if\(window\._strategy==='volume'\)setTimeout\(fetchVolume,120\)/.test(html));
  ok('a new candle set refreshes them too', /scheduleVolume\(\)/.test(grab('fetchChart')));
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
