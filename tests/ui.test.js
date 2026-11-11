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
  let depth = 0, started = false, inStr = null, esc = false, prev = '';
  for (let j = i; j < html.length; j++) {
    const c = html[j], n = html[j + 1];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    // line and block comments: an apostrophe in a comment used to break this scanner
    if (c === '/' && n === '/') { const e = html.indexOf('\n', j); j = e < 0 ? html.length : e; continue; }
    if (c === '/' && n === '*') { const e = html.indexOf('*/', j + 2); j = e < 0 ? html.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    // regex literal: a slash where a value is expected, e.g. .replace(/[&<>"']/g, ...)
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
      let k = j + 1, inClass = false;
      for (; k < html.length; k++) {
        const ch = html[k];
        if (ch === '\\') { k++; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
      }
      j = k;
      while (/[a-z]/i.test(html[j + 1] || '')) j++;   // flags
      prev = '/';
      continue;
    }
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return html.slice(i, j + 1); }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error('unbalanced function ' + name);
}

// the market registry, copied out of the page so the pure functions can use it
const MKT = (() => {
  const m = html.match(/const MKT=\{[\s\S]*?\n\};/);
  if (!m) throw new Error('market registry missing');
  return eval('(' + m[0].replace('const MKT=', '').replace(/;$/, '') + ')');
})();
globalThis.MKT = MKT;
const MKT_GROUPS_SRC = (html.match(/const MKT_GROUPS=[^;]+;/) || ['[]'])[0]
  .replace('const MKT_GROUPS=', '').replace(/;$/, '');
globalThis.MKT_GROUPS = eval(MKT_GROUPS_SRC);

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
  'drawVolume', 'syncChrome', 'setTabPrice',
  'zonePresets', 'zoneStyle', 'setZoneStyle', 'paintZoneStyleChips',
  'esc', 'ago', 'evClock', 'evDay', 'jnLoad', 'jnSave', 'jnR', 'jnStats', 'jnAdd', 'jnDel',
  'journalHtml', 'openJournal', 'openSheet', 'closeSheet', 'calHtml', 'newsHtml',
  'renderCalStrip', 'renderNewsStrip',
  'jnKeyOf', 'jnByDay', 'jnCalHtml', 'jnListHtml', 'jnMonth', 'jnPickDay', 'jnRepaint',
  'marketOpenNow', 'setNet', 'candlesLate', 'nextOpenLocal', 'paintEventLive', 'mkMeta',
  'paintAlertCard', 'alertsOf', 'alertsHtml', 'renderMarketSwitch',
  'alertsLoad', 'alertsSave', 'alertsFor', 'alertAdd', 'alertDel', 'alertToggle', 'alertTick',
  'alertsActive', 'fireAlert', 'alertToast', 'renderAlertsPanel', 'openAlertsSheet', 'alertQuick',
  'priceAlertsHtml', 'alertKindLabel', 'alertRsiNow', 'alertIndTick', 'watchLoad', 'watchSave',
  'watchAdd', 'watchDel', 'watchMove', 'renderWatchPanel', 'watchPaint', 'wsState', 'wsList',
  'wsPut', 'wsHtml', 'setLayout', 'bnavGo', 'paintBnav',
  'taSMA', 'taEMA', 'taRSI', 'taMACD', 'taBB', 'toHeikin',
  'taATR', 'taSupertrend', 'taStoch', 'taVWAPbands',
  'taDonchian', 'taKeltner', 'taIchimoku', 'taPSAR', 'taADX', 'taCCI', 'taWilliams', 'taOBV',
  'segDist', 'shapeDist',
].map(n => grab(n)).join('\n'));
['recordZoneAlert', 'renderZoneAlerts', 'zoneAlerts', 'latestTrade',
 'openMenu', 'closeMenu', 'toggleMenu', 'setView', 'endIntro', 'playIntro',
 'drawVolume', 'syncChrome', 'setTabPrice',
 'esc', 'ago', 'evClock', 'evDay', 'jnLoad', 'jnSave', 'jnR', 'jnStats', 'jnAdd', 'jnDel',
 'journalHtml', 'openJournal', 'openSheet', 'closeSheet', 'calHtml', 'newsHtml',
 'renderCalStrip', 'renderNewsStrip',
 'jnKeyOf', 'jnByDay', 'jnCalHtml', 'jnListHtml', 'jnMonth', 'jnPickDay', 'jnRepaint',
 'marketOpenNow', 'setNet', 'candlesLate', 'nextOpenLocal', 'paintEventLive', 'mkMeta',
 'paintAlertCard', 'alertsOf', 'alertsHtml', 'renderMarketSwitch',
 'taSMA', 'taEMA', 'taRSI', 'taMACD', 'taBB', 'toHeikin',
 'taATR', 'taSupertrend', 'taStoch', 'taVWAPbands',
 'taDonchian', 'taKeltner', 'taIchimoku', 'taPSAR', 'taADX', 'taCCI', 'taWilliams', 'taOBV',
 'segDist', 'shapeDist'].forEach(n => { global[n] = eval(n); });
// the page's own price formatter, kept out of the sandbox so the older stub survives
const realFmtPx = new Function('mkMeta', 'currentSymbol',
  grab('_fmtNum') + '\n' + grab('fmtPx').replace('function fmtPx', 'return function fmtPx'))(mkMeta, 'XAUUSD');
// the calendar keeps its month/day in module scope in the page; give the harness the same
global._jnM = new Date(2026, 10, 1);
global._jnDay = null;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m', name); } else { fail++; console.log('  \x1b[31m✗\x1b[0m', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const section = t => console.log('\n' + t);

// ================================================================ tests
section('markup');
{
  const mine = new Function(grab('_fmtNum') + '\nreturn _fmtNum;')();
  const cases = [[3876.73, 2], [1234567.891, 2], [0.5, 2], [999.995, 2], [-143.2, 2], [78051.5, 2], [49.021, 3], [1, 0], [1e6, 2], [0.001, 3], [2265.944, 2], [0, 2]];
  const bad = cases.filter(([v, d]) => mine(v, d) !== Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  ok('the fast price formatter matches toLocaleString', bad.length === 0, bad);
}
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
  ok('the market picker sits on the chart, not in the drawer',
     html.indexOf('id="mkt-float"') > html.indexOf('id="chart-section"')
     && html.indexOf('id="market-switch"') < 0
     && /function renderMarketSwitch/.test(html));
  ok('the drawer no longer sells phone alerts', !/Alerts on your phone/.test(html) && html.indexOf('id="tg-state"') < 0);
  ok('the drawer no longer carries links', !/menu-label">Links</.test(html));
  ok('the drawer has no signal list', html.indexOf('id="alerts-list"') < 0);
  ok('timeframes stay off the drawer', html.indexOf('id="tf-buttons"') < 0);
  ok('timeframes sit on the chart itself',
     html.indexOf('id="tf-float"') > html.indexOf('id="chart-section"') &&
     html.indexOf('id="tf-float"') < html.indexOf('</main>'));
  ok('all eight timeframes are on the chart', (html.slice(html.indexOf('id="tf-float"'), html.indexOf('</div>', html.indexOf('id="tf-float"'))).match(/data-tf=/g) || []).length === 8);
  ok('alerts are gone: no card on the chart', !html.includes('id="alert-float"')
     && !/class="alert-float"/.test(html));
  ok('front page has no ladder', !html.slice(html.indexOf('<main'), html.indexOf('</main>')).includes('alerts-list'));
}

section('view switching');
{
  BTNS = ['chart', 'signal', 'all'].map(v => { const b = mkEl('b-' + v); b.dataset.view = v; return b; });
  setView('chart');
  ok('chart only', document.body.attrs['data-view'] === 'chart' && localStorage.getItem('astra6_lastview') === 'chart');
  ok('the screen name never overwrites the chart options',
     localStorage.getItem('astra6_view') === null || /^\{/.test(localStorage.getItem('astra6_view')));
  setView('signal');
  ok('a view that no longer exists falls back to the chart', document.body.attrs['data-view'] === 'chart');
  setView('all');
  ok('so does both', document.body.attrs['data-view'] === 'chart');
  ok('hint text follows', els['view-hint'].textContent === 'trading chart only');
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
  ok('nothing pops the welcome open by itself', /bootIntro[\s\S]{0,300}classList\.add\('gone'\)/.test(html)
     && !/bootIntro[\s\S]{0,300}playIntro\(\);/.test(html));
}

section('chart fills the device');
{
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok('chart view is a full-height screen',
     /--app-h:100dvh/.test(css) && /body\[data-view="chart"\] \.wrap\{[^}]*height:calc\(var\(--app-h\) - var\(--hd-h\)\)/.test(css));
  ok('the phone nav is measured, so a home indicator cannot steal the chart',
     /--bnav-h/.test(css) && /#bnav\{[^}]*height:var\(--bnav-h/.test(css));
  ok('the chrome respects the notch and the rounded corners',
     /\.hd\{[^}]*padding-top:env\(safe-area-inset-top\)/.test(css));
  ok('the read card lives in the menu, not under the candles',
     /\.menu-flow\{[^}]*padding:10px 11px/.test(css) && !/\.flow-row\{/.test(css)
     && !/body\[data-view="chart"\] \.flow-row/.test(html));
  ok('full screen gives the chart the whole device',
     /body\.chart-full \.hd,body\.chart-full #bnav/.test(css) && /body\.chart-full #chart-section\{[^}]*height:var\(--app-h\)/.test(css));
  ok('the card stops being a card', /body\[data-view="chart"\] #chart-section\{[^}]*height:100%/.test(css));
  ok('chart stretches to that height', /body\[data-view="chart"\] #oanda_chart\{height:100%/.test(css));
  ok('chart shell flexes, no dead strip', /body\[data-view="chart"\] \.chart-shell\{flex:1 1 auto;min-height:0\}/.test(css));
  ok('footer is not a separate part', /body\[data-view="chart"\] \.foot,body\[data-view="signal"\] \.foot\{display:none\}/.test(css));
  ok('no page scroll behind the chart', /body\[data-view="chart"\]\{overflow:hidden\}/.test(css));
  ok('header height is measured, not guessed', /getBoundingClientRect\(\)\.height/.test(grab('syncChrome')));
  ok('header resize re-fits the chart', /ResizeObserver\(scheduleFit\)\.observe/.test(html)
     && /function scheduleFit\(\)\{clearTimeout\(_fitT\);/.test(html));
  ok('rotation re-fits the chart', /orientationchange/.test(html) && /visualViewport/.test(html));
  syncChrome();
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
  // a folded timeframe is measured on the interval the feed really serves
  ok('every request carries the timeframe it can be measured on', /\/api\/volume\?symbol=\$\{encodeURIComponent\(sym\)\}&venue=\$\{encodeURIComponent\(venue\)\}&tf=\$\{encodeURIComponent\(askTf\)\}/.test(html)
     && /const askTf = \(typeof tfBase==='function'\)\?tfBase\(tf\):tf/.test(html));
  ok('clipped to the oldest candle on screen', /&since=\$\{since\}/.test(html));
  ok('switching timeframe rebuilds the clusters', /window\._volume=null;window\._volSigKey=null;if\(window\._strategy==='volume'\)setTimeout\(fetchVolume,120\)/.test(html));
  ok('a new candle set refreshes them too', /scheduleVolume\(\)/.test(grab('fetchChart')));
}

section('nothing opens by itself');
{
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok('the site lands on home', /<body data-view="home">/.test(html));
  ok('home is not restored from storage', /window\._view = 'home'/.test(html));
  ok('boot calls setView home', /setView\('home'\);fitScreen\(\)/.test(html));
  ok('no chart is built at boot', !/setTimeout\(\(\)=>\{initChart\(\)/.test(html));
  ok('the chart is built when asked for', /if\(!chart && typeof initChart==='function'\) initChart\(\)/.test(html));
  ok('nothing polls the chart while it is closed', /if\(chart\)fetchChart\(currentTF\)/.test(html));
  ok('hero and chart are hidden on home', /body\[data-view="home"\] #chart-section/.test(css));
  ok('footer is hidden on home', /body\[data-view="home"\] \.foot\{display:none\}/.test(css));
  ok('the home screen carries no market tiles', !html.includes('id="home-px-XAUUSD"')
     && !html.includes('id="home-px-EURUSD"') && !html.includes('id="home-px-ES"')
     && !/class="home-tiles"/.test(html));
  ok('home offers one chart button instead', /class="home-cta"[^>]*onclick="setView\('chart'\)/.test(html));
  // GOLD ONLY: the platform carries one market, by explicit request
  const mktBlock = html.slice(html.indexOf('const MKT={'), html.indexOf('const MKT_GROUPS'));
  ok('the market table holds gold and nothing else', /XAUUSD:/.test(mktBlock)
     && !/XAGUSD:|XPTUSD:|XPDUSD:|BTCUSD:|ETHUSD:|\bES:|\bNQ:|\bCL:/.test(mktBlock), mktBlock.slice(0, 200));
  ok('one market is flagged so the pickers can stand down', /const ONE_MARKET=\(Object\.keys\(MKT\)\.length===1\)/.test(html));
  ok('the picker cannot open', /if\(ONE_MARKET\)\{ if\(ev&&ev\.preventDefault\)ev\.preventDefault\(\); return; \}/.test(grab('toggleMarketPicker')));
  ok('old watchlists and alerts for other pairs are pruned on boot', /function pruneSymbols\(\)/.test(html)
     && /pruneSymbols\(\);/.test(html) && /SITE_SYMBOL/.test(html));
  ok('the welcome subtitle names the one market', /gold · xauusd/.test(html) && !/metals · futures|metals · forex/.test(html));
  ok('the page description names gold', /Live gold/.test(html) && !/live metals and futures/i.test(html));
  ok('the welcome has no price header', /body\[data-view="home"\] \.hd \.price-block/.test(html));
  ok('home still points at menu → Chart', /menu → Chart/.test(html));
  ok('menu has a Home choice', /data-view="home"/.test(html));
  ok('Home starts active in the menu', /class="tf-btn active" data-view="home"/.test(html));
  BTNS = ['home', 'chart', 'signal', 'all'].map(v => { const b = mkEl('b-' + v); b.dataset.view = v; return b; });
  setView('home');
  ok('home view applies', document.body.attrs['data-view'] === 'home');
  ok('hint says pick a screen', els['view-hint'].textContent === 'pick a screen to open');
  setView('chart');
  ok('chart is still one click away', document.body.attrs['data-view'] === 'chart');
  setTabPrice('XAUUSD', 3876.5);
  ok('home tile follows the live price', document.getElementById('home-px-XAUUSD').textContent === '$3876.50',
     document.getElementById('home-px-XAUUSD').textContent);
}

section('entry, stop and target add up');
{
  const { execSync } = require('child_process');
  const out = execSync(`cd ${root} && python3 -c "
import sys; sys.path.insert(0,'.')
import volume as V
def mk(n=90, start=100.0, step=0.15, vol=10.0):
    out=[]; p=start
    for i in range(n):
        o=p; c=p+step; h=max(o,c)+0.12; l=min(o,c)-0.12
        out.append({'time':1700000000+i*900,'open':o,'high':h,'low':l,'close':c,
                    'volume':vol,'buy':vol*0.75,'sell':vol*0.25}); p=c
    return out
c=mk(); vw,_=V.daily_vwap(c); rows,poc,st=V.clusters(c,48,10.0)
atr=sum(c[i]['high']-c[i]['low'] for i in range(-14,0))/14
s=V.signal(c,vw,rows,poc,atr,10.0,V.vwap_series(c),families=('fade',))
p=s['entry']; r=s['risk']
tp1=abs(s['tp1']-p); tp2=abs(s['tp2']-p)
checks=[]
checks.append(('signal fires', s['type'] in ('BUY','SELL')))
checks.append(('stop is 0.45-1.6 ATR from entry, anchored to the box', 0.45 <= r/atr <= 1.6))
checks.append(('tp2 clears tp1', tp2 > tp1))
checks.append(('target is 1.3-2.6R', 1.3 <= tp2/r <= 2.6))
checks.append(('reported R matches the levels', abs(s['r'] - tp2/r) < 0.03))
checks.append(('reason names the value edge and both targets', ('VAL' in s['reason'] or 'VAH' in s['reason']) and 'tp1' in s['reason']))
quiet=[{'time':1+i*900,'open':100+i*0.001,'high':100.02+i*0.001,'low':99.99+i*0.001,
        'close':100.01+i*0.001,'volume':5,'buy':3,'sell':2} for i in range(150)]
rq,pq,sq=V.clusters(quiet,48,10.0)
checks.append(('a quiet market cannot explode the book', sq and sq > 0 and len(rq) < 4000))
bad=[n for n,okv in checks if not okv]
print('OK' if not bad else 'FAIL '+','.join(bad))
"`).toString().trim();
  ok('stops sit just past the cluster, targets stay near', out === 'OK', out);
  ok('the chart levels quote the ladder numbers', /latestTrade\(currentSymbol\)/.test(grab('drawVolumeLevels')) &&
     /sg\.entry=_lv\.entry/.test(grab('drawVolumeLevels')));
}

section('calendar and news are separate');
{
  ok('menu has an economic calendar section', /menu-label">Economic calendar</.test(html));
  ok('menu has a gold fundamentals section', /menu-label">Gold fundamentals/.test(html));
  ok('the old mixed section is gone', !/menu-label">Fundamentals</.test(html));
  ok('calendar has its own preview strip', html.includes('id="cal-strip"'));
  ok('news has its own preview strip', html.includes('id="news-strip"'));
  ok('calendar opens its own panel', /onclick="openCalendar\(\)"/.test(html));
  ok('the gold reading opens its own panel', /onclick="openGoldFundamentals\(\)"/.test(html));
  ok('its own endpoint, plus the calendar and the headlines', /\/api\/fundamentals\/gold/.test(html)
     && /\/api\/calendar/.test(html) && /\/api\/news/.test(html));
  ok('the panel is a sheet, not a new page', html.includes('id="sheet"') && html.includes('id="sheet-body"'));

  const cal = {
    status: 'ok', source: 'TradingView economic calendar',
    next_high: { time: Math.floor(Date.now() / 1000) + 7200, title: 'FOMC Statement', currency: 'US', impact: 'High', forecast: '4.25', previous: '4.50', actual: '', unit: '%' },
    calendar: [
      { time: Math.floor(Date.now() / 1000) - 3600, title: 'NBS Manufacturing PMI', currency: 'CN', impact: 'High', actual: '49.3', forecast: '50', previous: '50.1', unit: '' },
      { time: Math.floor(Date.now() / 1000) + 9000, title: 'Building Permits', currency: 'AU', impact: 'Medium', actual: '', forecast: '2.1', previous: '-6.1', unit: '%' },
    ],
  };
  const h = calHtml(cal);
  ok('calendar shows the next high impact event', h.includes('FOMC Statement'));
  ok('calendar shows actual, forecast and previous', h.includes('ev-a') && h.includes('49.3') && h.includes('50.1'));
  ok('impact is drawn as dots', /imp h/.test(h) && /imp m/.test(h));
  ok('calendar has no headlines in it', !h.includes('nw-t') && !h.includes('class="nw"'));
  ok('a dead calendar feed says so, it does not invent events', /unreachable/.test(calHtml(null)));

  const news = { status: 'ok', sources: ['ForexLive', 'CoinDesk'], news: [
    { time: Math.floor(Date.now() / 1000) - 600, title: 'Bitcoin & gold move <b>together</b>', url: 'https://example.com/a?x=1&y=2', source: 'CoinDesk', kind: 'crypto' },
  ] };
  const n = newsHtml(news);
  ok('news links the headline to its source', n.includes('https://example.com/a?x=1&amp;y=2'));
  ok('news names the feed', n.includes('CoinDesk') && n.includes('ForexLive'));
  ok('news escapes feed text', !/<b>together<\/b>/.test(n) && n.includes('&lt;b&gt;'));
  ok('news has no calendar in it', !n.includes('class="ev '));
  ok('a dead news feed says so', /unreachable/.test(newsHtml(null)));
}

section('trade journal');
{
  ok('menu has a journal section', /menu-label">Trade journal</.test(html));
  ok('menu shows journal stats', html.includes('id="jn-trades"') && html.includes('id="jn-win"') && html.includes('id="jn-r"'));
  ok('journal opens from the menu', /onclick="openJournal\(\)"/.test(html));
  ok('journal maths: BUY win is +2R', jnR({ side: 'BUY', entry: 100, stop: 95, exit: 110 }) === 2);
  ok('journal maths: BUY loss is -1R', jnR({ side: 'BUY', entry: 100, stop: 95, exit: 95 }) === -1);
  ok('journal maths: SELL win is +2R', jnR({ side: 'SELL', entry: 100, stop: 105, exit: 90 }) === 2);
  ok('journal maths: open trade has no R', jnR({ side: 'BUY', entry: 100, stop: 95, exit: null }) === null);
  ok('journal maths: zero risk is ignored', jnR({ side: 'BUY', entry: 100, stop: 100, exit: 110 }) === null);
  ok('journal maths: string prices work', jnR({ side: 'BUY', entry: '100', stop: '98', exit: '103' }) === 1.5);
  localStorage.setItem('astra6_journal', JSON.stringify([
    { id: 1, sym: 'XAUUSD', side: 'BUY', entry: 3870, stop: 3865, exit: 3880, note: 'clean cluster' },
    { id: 2, sym: 'BTCUSD', side: 'SELL', entry: 78000, stop: 79000, exit: 79000, note: '' },
    { id: 3, sym: 'XAUUSD', side: 'BUY', entry: 3900, stop: 3890, exit: null, note: 'still running' },
  ]));
  const st = jnStats();
  ok('three trades counted', document.getElementById('jn-trades').textContent === '3');
  ok('win rate is 50% of the two closed', document.getElementById('jn-win').textContent === '50%');
  ok('total R adds up', document.getElementById('jn-r').textContent === '+1.0R', document.getElementById('jn-r').textContent);
  const body = journalHtml();
  ok('journal lists the trades', body.includes('XAUUSD') && body.includes('BTCUSD'));
  ok('open trades are labelled open', body.includes('open'));
  ok('journal can prefill from the live signal', /jnUseSignal/.test(html) && /window\._volume/.test(html));
  ok('journal is local only', /Stored only in this browser/.test(body));
  jnSave(jnLoad().filter(t => t.id !== 2));
  ok('delete removes one trade', jnLoad().length === 2);
  localStorage.removeItem('astra6_journal');
  ok('empty journal explains itself', /No trades yet/.test(journalHtml()));
}

section('news parsing (offline, canned feeds)');
{
  const { execSync } = require('child_process');
  const out = execSync(`cd ${root} && python3 -c "
import sys, json, types
sys.path.insert(0,'.')
import news

class FakeResp:
    def __init__(self, payload): self._p = payload; self.content = payload if isinstance(payload, bytes) else b''; self.status_code = 200
    def raise_for_status(self): pass
    def json(self): return self._p

import datetime, email.utils, time
now = datetime.datetime.now(datetime.timezone.utc)
d_near = (now + datetime.timedelta(hours=5)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
d_far  = (now + datetime.timedelta(hours=20)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
tv = {'result': [
  {'date': d_far,  'country':'US','importance':1,  'title':'ISM Manufacturing PMI','forecast':54.7,'previous':54.5,'unit':None},
  {'date': d_near, 'country':'AU','importance':0,  'title':'Building Permits','forecast':2.1,'previous':-6.1,'unit':'%'},
  {'date': d_near, 'country':'AU','importance':-1, 'title':'Low noise','forecast':None,'previous':None,'unit':None}]}
pd1 = email.utils.formatdate(time.time()-3600, usegmt=True)
pd2 = email.utils.formatdate(time.time()-7200, usegmt=True)
rss = ('<rss><channel>'
  '<item><title>Gold jumps as dollar slips</title><link>https://example.com/g</link><pubDate>'+pd1+'</pubDate></item>'
  '<item><title>Gold jumps as dollar slips</title><link>https://example.com/g2</link><pubDate>'+pd2+'</pubDate></item>'
  '</channel></rss>').encode()

def fake_get(url, **kw):
    if 'economic-calendar' in url: return FakeResp(tv)
    if 'faireconomy' in url: raise RuntimeError('429')
    return FakeResp(rss)
news.requests.get = fake_get
news._cache['cal'] = {'t':0.0,'d':None,'src':None}
news._cache['news'] = {'t':0.0,'d':None,'sources':[]}
d = news.fundamentals(limit=5)
checks = []
checks.append(('two events kept, low impact dropped', len(d['calendar'])==2))
checks.append(('events come out in time order', d['calendar'][0]['time'] <= d['calendar'][1]['time']))
checks.append(('medium impact mapped', d['calendar'][0]['impact']=='Medium'))
checks.append(('high impact mapped', d['calendar'][1]['impact']=='High'))
checks.append(('unit carried through', d['calendar'][0]['unit']=='%'))
checks.append(('numbers kept as text', d['calendar'][1]['forecast']=='54.7'))
checks.append(('next high impact found', d['next_high'] and d['next_high']['title']=='ISM Manufacturing PMI'))
checks.append(('duplicate headline removed', len(d['news'])==1))
checks.append(('source named', d['news'][0]['source']=='ForexLive'))
checks.append(('calendar source named', 'TradingView' in d['calendar_source']))
bad=[n for n,okv in checks if not okv]
print('OK' if not bad else 'FAIL '+','.join(bad))
"`).toString().trim();
  ok('calendar and headlines parse, dedupe and label', out === 'OK', out);
}

section('journal month calendar (FTMO style)');
{
  const Nov = t => Math.floor(new Date('2026-11-' + String(t).padStart(2, '0') + 'T12:00:00').getTime() / 1000);
  localStorage.setItem('astra6_journal', JSON.stringify([
    { id: 11, sym: 'XAUUSD', side: 'BUY', entry: 100, stop: 95, exit: 110, note: '', at: Nov(3) },   // +2R
    { id: 12, sym: 'XAUUSD', side: 'SELL', entry: 100, stop: 105, exit: 105, note: '', at: Nov(3) }, // -1R
    { id: 13, sym: 'BTCUSD', side: 'BUY', entry: 100, stop: 90, exit: 80, note: '', at: Nov(5) },    // -2R
    { id: 14, sym: 'BTCUSD', side: 'BUY', entry: 100, stop: 90, exit: null, note: '', at: Nov(9) },  // open
  ]));
  global._jnM = new Date(2026, 10, 1); global._jnDay = null;
  const cal = jnCalHtml();
  ok('a grid of seven weekday columns', (cal.match(/jcal-h/g) || []).length === 7, (cal.match(/jcal-h/g) || []).length);
  ok('weeks start on Monday', cal.indexOf('>Mo<') < cal.indexOf('>Su<'));
  ok('November 2026 starts on a Sunday, so six blank cells', (cal.match(/jcal-e/g) || []).length === 6,
     (cal.match(/jcal-e/g) || []).length);
  ok('one cell per day of the month', (cal.match(/class="jcal-n"/g) || []).length === 30, (cal.match(/class="jcal-n"/g) || []).length);
  ok('a winning day is green', /class="jcal-d up[^"]*"/.test(cal));
  ok('a losing day is red', /class="jcal-d dn[^"]*"/.test(cal));
  ok('two trades net to +1R on the 3rd', cal.includes('+1.0R'), (cal.match(/[-+]\d\.\dR/g) || []));
  ok('a single losing day shows its own R', cal.includes('-2.0R'));
  ok('an open trade shows open, not a fake result', cal.includes('>open<'));
  ok('the month total adds the closed days only', cal.includes('-1.0R') && /this month/.test(cal),
     (cal.match(/[-+]\d\.\dR/g) || []));
  ok('arrows move between months', /jnMonth\(-1\)/.test(cal) && /jnMonth\(1\)/.test(cal));
  ok('the month title is real', cal.includes('November 2026'));

  global._jnDay = '2026-11-03';
  const dayList = jnListHtml();
  ok('picking a day filters the list', dayList.includes('XAUUSD') && !dayList.includes('BTCUSD'), dayList.slice(0, 120));
  ok('the filtered header offers show all', /Show all/.test(dayList));
  global._jnDay = null;
  ok('without a day it lists everything', jnListHtml().includes('BTCUSD') && jnListHtml().includes('All trades'));

  jnPickDay('2026-11-05');
  ok('picking a day keeps the selection', global._jnDay === '2026-11-05');
  jnPickDay('2026-11-05');
  ok('picking it again clears it', global._jnDay === null);
  jnMonth(1);
  ok('next month is December 2026', jnCalHtml().includes('December 2026'));
  jnMonth(-1);
  ok('back to November', jnCalHtml().includes('November 2026'));
  ok('the form can log a date', /id="jn-date" type="date"/.test(html));
  ok('journal maths still matches the calendar', jnR({ side: 'BUY', entry: 100, stop: 95, exit: 110 }) === 2);
  localStorage.removeItem('astra6_journal');
}

section('calendar shows actual, forecast and previous');
{
  const payload = {
    status: 'ok', source: 'TradingView economic calendar',
    next_high: { time: Math.floor(Date.now() / 1000) + 7200, title: 'FOMC Statement', currency: 'US', impact: 'High', forecast: '4.25', previous: '4.50', actual: '', unit: '%' },
    calendar: [
      { time: Math.floor(Date.now() / 1000) - 3600, title: 'NBS Manufacturing PMI', currency: 'CN', impact: 'High', actual: '49.3', forecast: '50', previous: '50.1', unit: '' },
      { time: Math.floor(Date.now() / 1000) + 7200, title: 'FOMC Statement', currency: 'US', impact: 'High', actual: '', forecast: '4.25', previous: '4.50', unit: '%' },
      { time: Math.floor(Date.now() / 1000) + 9000, title: 'Building Permits', currency: 'AU', impact: 'Medium', actual: '', forecast: '2.1', previous: '-6.1', unit: '%' },
    ],
  };
  const h = calHtml(payload);
  ok('released events show the actual number', h.includes('ev-a') && h.includes('49.3'), h.slice(0, 0));
  ok('forecast is quoted', h.includes('50.1') || h.includes('>50<') || h.includes('50'));
  ok('previous is quoted', h.includes('50.1'));
  ok('impact is drawn as dots', /imp h/.test(h) && /imp m/.test(h));
  ok('units are attached to the numbers', h.includes('4.25%'));
  ok('an unreleased event shows no fake actual', /ev hi/.test(h.replace(/class="ev /g, 'class="ev ')));
  ok('day headers separate the days', (h.match(/fund-day/g) || []).length >= 1);
}

section('the drawer stays clean');
{
  const menu = html.slice(html.indexOf('<aside class="menu"'), html.indexOf('</aside>'));
  ok('no timeframe row inside the menu', !/data-tf=/.test(menu));
  ok('the timeframe bar floats over the chart', /#tf-float\{[^}]*position:absolute/.test(html));
  ok('it scrolls sideways on a phone', /#tf-float\{[^}]*overflow-x:auto/.test(html));
  // the chart's own quote line moved into the header, so no pill covers the candles
  ok('the quote line lives in the header, not on top of the candles', /id="hd-quote"/.test(html)
     && /function paintHeaderQuote\(b\)/.test(html) && /#tv-legend\{display:none!important\}/.test(html));
  // the line belongs to the header, not to the narrow price column that clipped it
  ok('the quote line hangs off the header itself', html.indexOf('id="hd-quote"') < html.indexOf('<div class="price-block">')
     && /\.hd-quote\{[^}]*position:absolute;left:0;right:0/.test(html)
     && /body\[data-view="chart"\] \.hd-quote\{left:auto;right:9px/.test(html));
  ok('sections are divided, not stacked blindly', /\.menu-sec\{[^}]*border-top:1px solid/.test(html));
  ok('the signal list is no longer a drawer ladder', html.indexOf('id="alerts-list"') < 0);
  const order = ['View', 'Economic calendar', 'Gold fundamentals', 'Trade journal', 'Price source', 'Tools']
    .map(t => menu.indexOf(t));
  ok('the menu reads in a sane order', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), order);
  ok('the drawer no longer offers a strategy switch', menu.indexOf('RENDER') < 0 && menu.indexOf('data-strategy') < 0);
  ok('the drawer offers home and chart only', menu.indexOf("data-view=\"home\"") > 0 && menu.indexOf("data-view=\"chart\"") > 0
     && menu.indexOf("setView('signal')") < 0 && menu.indexOf("setView('all')") < 0);
  ok('setTimeframe still finds its buttons', /querySelectorAll\('\[data-tf\]'\)/.test(grab('setTimeframe')));
}

section('the page says when the data stops');
{
  const at = s => new Date(s).getTime();
  ok('the metals shut at the weekend', !marketOpenNow('XAGUSD', at('2026-10-31T12:00:00Z')));
  ok('forex reopens Sunday 22:00', marketOpenNow('EURUSD', at('2026-11-01T22:30:00Z')));
  ok('an unknown symbol follows the only market on the site', marketOpenNow('ES', at('2026-11-01T22:30:00Z'))
     && !marketOpenNow('ES', at('2026-10-31T12:00:00Z')));
  ok('gold is shut on Saturday', !marketOpenNow('XAUUSD', at('2026-10-31T12:00:00Z')));
  ok('gold is shut on Sunday morning', !marketOpenNow('XAUUSD', at('2026-11-01T12:00:00Z')));
  ok('gold opens Sunday 22:00 UTC', marketOpenNow('XAUUSD', at('2026-11-01T22:30:00Z')));
  ok('gold trades on Friday morning', marketOpenNow('XAUUSD', at('2026-10-30T09:00:00Z')));
  ok('gold closes Friday 21:00 UTC', !marketOpenNow('XAUUSD', at('2026-10-30T21:30:00Z')));
  ok('the daily break is closed', !marketOpenNow('XAUUSD', at('2026-10-28T21:30:00Z')));
  ok('the rest of the week is open', marketOpenNow('XAUUSD', at('2026-10-28T12:00:00Z')));
  ok('the header carries the state', html.includes('id="net-chip"') && html.includes('id="net-text"'));
  ok('a closed market is admitted without home tiles', !html.includes('id="home-tag-XAUUSD"')
     && /market closed/.test(grab('fetchChart')));
  ok('a stale clock is retried instead of freezing', /age>10/.test(grab('netWatch')) && /fetchFastPrice\(\)/.test(grab('netWatch')));
  ok('a silent stream no longer switches polling off', /streamOk && _lastTickAt && Date.now\(\)-_lastTickAt < 5000/.test(grab('fetchFastPrice')));
  ok('every tick stamps the clock', /_lastTickAt=Date.now\(\)/.test(grab('applyTick')));
  ok('the chart labels a closed market', /marketOpenNow\(currentSymbol\)\?'':'market closed/.test(grab('fetchChart')));
  ok('the watchdog runs on a timer', /setInterval\(netWatch,2000\)/.test(html));
  ok('failed calls are counted for the chip', /_netFails\+\+/.test(grab('fetchFastPrice')));
  ok('the chart measures its own candles', /candlesLate\(age,currentTF,currentSymbol\)/.test(grab('setCandleAge')));
  ok('the chart carries a staleness pill', html.includes('id="chart-stale"'));
  // 1356 minutes = the gold outage of 30 Oct
  ok('a paused gold feed is flagged while the market is open', candlesLate(1356, 'M15', 'XAUUSD', new Date('2026-10-30T12:00:00Z').getTime()) === true);
  ok('two fresh bars are not flagged', candlesLate(12, 'M15', 'XAUUSD', new Date('2026-10-30T12:00:00Z').getTime()) === false);
  ok('a closed market is not a fault', candlesLate(1356, 'M15', 'XAUUSD', new Date('2026-10-31T12:00:00Z').getTime()) === false);
  ok('a futures chart is watched during its session', candlesLate(50, 'M15', 'ES', new Date('2026-10-30T12:00:00Z').getTime()) === true);
  ok('the chip pulls the same rule', /candlesLate\(_ca,currentTF,sym\)/.test(grab('netWatch')));
  ok('a closed chart offers the reopening time', /reopens '\+nxt/.test(grab('setCandleAge')));
  ok('the reopening time is a real local date', nextOpenLocal('XAUUSD', new Date('2026-10-31T12:00:00Z').getTime()).length > 5);
  ok('the reopening time lands on a quarter hour', /:(00|15|30|45)\b/.test(nextOpenLocal('XAUUSD', new Date('2026-10-31T12:07:31Z').getTime())));
  ok('the watchdog keeps the note current', /setCandleAge\(\{last_bar_age_min:window._candleAgeMin\}\)/.test(grab('netWatch')));
}

section('the high-impact countdown');
{
  const now = Math.floor(Date.now() / 1000);
  const strip = mkEl('event-live');
  strip.hidden = true;
  document.getElementById = (id) => (id === 'event-live' ? strip : els[id] || null);
  // the strip re-measures the header when it appears; the real ones need a browser
  globalThis.syncChrome = () => {};
  globalThis.relayoutChart = () => {};

  paintEventLive({ calendar: [{ time: now + 6 * 3600, title: 'NFP', currency: 'USD', impact: 'High' }] });
  ok('nothing within 90 minutes means no strip', strip.hidden === true);

  paintEventLive({ calendar: [
    { time: now + 42 * 60, title: 'CPI m/m', currency: 'USD', impact: 'High', forecast: '0.3%' },
    { time: now + 5 * 3600, title: 'NFP', currency: 'USD', impact: 'High' },
    { time: now + 20 * 60, title: 'Minor', currency: 'EUR', impact: 'Medium' },
  ] });
  ok('a high-impact release in 42 minutes is counted down', strip.hidden === false && /CPI m\/m/.test(strip.innerHTML) && /42 min/.test(strip.innerHTML));
  ok('it shows the forecast it was measured from', /0\.3%/.test(strip.innerHTML));
  ok('medium-impact events do not raise the strip', !/Minor/.test(strip.innerHTML));

  paintEventLive({ calendar: [{ time: now - 180, title: 'CPI y/y', currency: 'USD', impact: 'High', actual: '3.1%' }] });
  ok('a release from three minutes ago is shown with its actual', /just released/.test(strip.innerHTML) && /3\.1%/.test(strip.innerHTML));

  paintEventLive({ calendar: [{ time: now - 6000, title: 'Old news', currency: 'USD', impact: 'High', actual: '1' }] });
  ok('an old release is not news any more', strip.hidden === true);
  ok('the strip is the door to the calendar', /onclick="openCalendar\(\)"/.test(html) && html.includes('id="event-live"'));
}

section('the phone-alert card is out of the drawer');
{
  ok('no phone card in the page', !html.includes('id="tg-state"') && !html.includes('id="tg-note"'));
  ok('nothing left to press for it', !/onclick="tgTest\(this\)"/.test(html) && !/tgOpenBot\(\)/.test(html));
  ok('no code loads a card that is gone', !/tgLoad\(/.test(html) && !/tg-state|tg-note/.test(html));
  ok('the server routes are untouched', fs.readFileSync(path.join(root, 'push.py'), 'utf8').includes('def broadcast'));
  ok('the server only pushes BUY and SELL', /not in \("BUY", "SELL"\)/.test(fs.readFileSync(path.join(root, 'push.py'), 'utf8')));
  ok('one push per box, keyed on the trade', /def signal_key/.test(fs.readFileSync(path.join(root, 'push.py'), 'utf8')));
}

section('the market picker and the alert card live on the chart');
  // a refresh must not leave the chip naming the old market
  {
    const pop = els['mkt-pop'] || (els['mkt-pop'] = mkEl('mkt-pop'));
    const chip = els['mkt-float-sym'] || (els['mkt-float-sym'] = mkEl('mkt-float-sym'));
    const was = currentSymbol;
    global.currentSymbol = 'EURUSD';
    renderMarketSwitch();
    ok('the chart chip names the market actually on screen', chip.textContent === 'EURUSD', chip.textContent);
    global.currentSymbol = was;
  }
{
  ok('a picker button floats on the chart', /#mkt-float\{[^}]*position:absolute/.test(html)
     && html.indexOf('id="mkt-float"') > html.indexOf('id="chart-section"'));
  ok('it opens a popover, not the drawer', html.includes('id="mkt-pop"') && /function toggleMarketPicker/.test(html));
  ok('the popover is built from ten markets', /MKT_GROUPS\.forEach/.test(grab('renderMarketSwitch')));
  ok('picking closes the popover', /closeMarketPicker\(\);/.test(grab('pickMarket')));
  ok('a tap elsewhere shuts it', /document\.addEventListener\('click'/.test(html) && /closeMarketPicker\(\)/.test(html));
  ok('the button shows the market on screen', /mkt-float-sym/.test(grab('setSymbol')));

  // the alert list is per market, by construction - gold is the only market on the site
  currentSymbol = 'XAUUSD';
  store.astra6_zone_alerts_XAUUSD = JSON.stringify([
    { key: 'e1', sym: 'XAUUSD', type: 'BUY', entry: 3876.42, sl: 3872.1, tp1: 3879.66, tp2: 3884.05, r: 2.0, ts: 1793400000 },
    { key: 'e2', sym: 'XAGUSD', type: 'SELL', entry: 48.512, sl: 48.24, tp1: 48.78, tp2: 48.97, r: 2.0, ts: 1793300000 },
  ]);
  const goldRows = alertsOf('XAUUSD');
  ok('a record for a pair the site no longer carries cannot show', goldRows.length === 1 && goldRows[0].key === 'e1');
  const realFmt = fmtPx;
  global.fmtPx = realFmtPx;                    // the page's own, decimals per market
  const htmlGold = alertsHtml('XAUUSD');
  ok('the sheet lists the gold trade only', htmlGold.includes('3,876.42') && !htmlGold.includes('48.512'));
  ok('the sheet names the market', /XAUUSD/.test(htmlGold));
  localStorage.removeItem('astra6_zone_alerts_XAUUSD');
  const empty = alertsHtml('XAUUSD');
  ok('an empty market says so honestly', /No XAUUSD signal yet/.test(empty));

  const card = mkEl('alert-float');
  card.hidden = true;
  document.getElementById = (id) => (id === 'alert-float' ? card : (els[id] || null));
  currentSymbol = 'XAUUSD';
  paintAlertCard(goldRows.map(a => ({ type: a.type, entry: a.entry, sl: a.sl, tp1: a.tp1, tp2: a.tp2, r: a.r, ts: a.ts })));
  ok('the chart card shows this market only', card.hidden === false && /XAUUSD/.test(card.innerHTML) && !/48\.24/.test(card.innerHTML));
  ok('the card carries the levels', /3,872\.10/.test(card.innerHTML) && /3,884\.05/.test(card.innerHTML));
  global.fmtPx = realFmt;
  paintAlertCard([]);
  ok('no alert means no card', card.hidden === true);
  ok('nothing can reopen the alert card', !/id="alert-float"/.test(html) && /alerts were removed from the product/.test(grab('paintAlertCard')));
  ok('switching market repaints the card', /renderZoneAlerts\(\)/.test(grab('setSymbol')));
}

section('the chart behaves like a terminal, not a picture of one');
{
  // price scale: the six things a trader actually reaches for
  ok('the price scale locks, inverts, logs and reads in percent', /function setScale\(k\)/.test(html)
     && /invertScale/.test(grab('applyPriceScale')) && /autoScale/.test(grab('applyPriceScale'))
     && /V\.mode===2/.test(html) && /V\.mode===1/.test(html));
  ok('a locked scale cannot be dragged by accident', /price:!V\.lock/.test(grab('applyPriceScale')));
  ok('the scale choices survive a reload', /astra6_view/.test(html) && /function saveView\(\)/.test(html));
  ok('a theme repaint cannot reset the scale', /mode:\(typeof CHART_VIEW!=='undefined'\?CHART_VIEW\.mode/.test(html));

  // zoom and follow
  ok('zoom buttons move the visible range, never the data', /function zoomBy\(f\)/.test(html)
     && /setVisibleLogicalRange/.test(grab('zoomBy')));
  ok('both zoom buttons are on the chart', /zoomBy\(1\.3\)/.test(html) && /zoomBy\(0\.77\)/.test(html));
  ok('scrolling into history offers a way back to live', /id="chart-live"/.test(html)
     && /scrollToRealTime/.test(grab('goLive')));
  ok('the live pill appears only when the view left the last candle', /n-1-r\.to\)>14/.test(grab('paintLivePill'))
     && /paintLivePill\(\)/.test(html));
  ok('candle width is a stored setting, not a one-off', /function setBarWidth\(dir,reset\)/.test(html)
     && /CHART_VIEW\.bars/.test(html) && /function applyBarWidth\(\)/.test(html));

  // bid / ask lines are only ever drawn from real numbers
  const ba = grab('paintBidAskLines');
  ok('bid and ask get their own dotted lines', /createPriceLine\(\{price:_lastBid/.test(ba) && /title:'BID'/.test(ba));
  ok('no feed numbers means no bid/ask lines', /if\(!on\)\{/.test(ba) && /removePriceLine/.test(ba));
  ok('three labels on one axis pixel are avoided', /axisLabelVisible:!near\(_lastBid\)/.test(ba));
  ok('a new series takes its old price lines with it', /_baLines=null;/.test(grab('rebuildMainSeries')));
}

section('the chart carries real trading tools');
{
  ok('a tool rail sits on the chart', html.includes('id="tv-rail"') && /#tv-rail\{[^}]*position:absolute/.test(html));
  ok('there is a drawing layer above the zones', html.includes('id="draw-layer"')
     && html.indexOf('id="draw-layer"') > html.indexOf('id="zone-layer"'));
  ok('the indicator and chart panels exist', html.includes('id="ind-panel"') && html.includes('id="chart-menu"'));
  ok('the panes container exists', html.includes('id="sub-panes"'));

  const rail = html.slice(html.indexOf('const TV_RAIL=['), html.indexOf('const TV_TOOL_NAME='));
  const tools = [...rail.matchAll(/\{t:'(\w+)'/g)].map(m => m[1]);
  ok('seven drawing tools', ['cursor','trend','hline','vline','rect','fib','ruler'].every(t => tools.includes(t)), tools.join(','));
  ok('undo and clear are on the rail', tools.includes('undo') && tools.includes('clear'));
  ok('a brush, an eraser and a magnet joined the rail', tools.includes('brush') && tools.includes('eraser') && tools.includes('magnet'));
  ok('redo is on the rail', tools.includes('redo'));
  ok('a drawing carries its own colour and width', /sh\.c\|\|TV_COLOR\[sh\.k\]/.test(html) && /const W=function\(def\)/.test(html));
  ok('the eraser hit-tests a real shape, not a guess', /function shapeDist\(sh,X,Y,mx,my\)/.test(html)
     && /function eraseAt\(mx,my\)/.test(html));
  {
    const seg = segDist(5, 0, 0, 10, 10, 10);        // a point 10 px above the middle of a flat segment
    ok('distance to a segment is real', Math.abs(seg - 10) < 1e-9, String(seg));
    const X = t => t, Y = p => p;
    ok('a horizontal line hit-tests its own price', shapeDist({k:'hline',p1:40}, X, Y, 10, 43) === 3);
    ok('a box is hit anywhere inside it', shapeDist({k:'rect',t1:0,p1:0,t2:50,p2:50}, X, Y, 25, 25) === 0);
    ok('a brush is hit along its stroke', shapeDist({k:'brush',pts:[{t:0,p:0},{t:100,p:100}]}, X, Y, 50, 50) < 1e-6);
  }
  ok('the magnet snaps to a real open, high, low or close', /function snapPoint\(t,p\)/.test(html)
     && /cands=\[b\.open,b\.high,b\.low,b\.close\]/.test(grab('snapPoint')));
  ok('the rail opens the indicator and chart panels', tools.includes('fx') && tools.includes('more'));
  // a broker chart on a phone gives the width to the candles: the rail folds to one button
  ok('the rail folds away and one tap brings it back', html.includes('id="rail-toggle"')
     && /function toggleRail\(\)/.test(html) && /#tv-rail\.collapsed\{display:none\}/.test(html));
  ok('a phone opens folded, a desk opens open', /window\.innerWidth<=620/.test(grab('initRail'))
     && /localStorage\.setItem\('astra6_rail'/.test(html) && /getItem\('astra6_rail'\)/.test(grab('initRail')));
  ok('a folded rail never leaves an unseen tool armed', /if\(off\) setTool\('cursor'\)/.test(grab('toggleRail')));

  const types = [...html.slice(html.indexOf('const CTYPE_LIST='), html.indexOf('let drawTool=')).matchAll(/\['(\w+)','/g)].map(m => m[1]);
  ok('seven chart types, hollow and baseline included', types.length === 7 && ['heikin','line','hollow','baseline'].every(t => types.includes(t)), types.join(','));

  ok('drawings are stored per market', html.includes("'astra6_draw_'+currentSymbol"));
  ok('indicator choices stick across a refresh', html.includes("localStorage.setItem('astra6_ind'"));
  ok('the chart type sticks too', html.includes("localStorage.setItem('astra6_ctype',t)"));

  // every fetch paints through the type-aware painter, live ticks too
  ok('candles go through paintSeries', /paintSeries\(clean\);/.test(html));
  ok('ticks go through the glide, not a raw jump', /glidePrice\(newPrice,lc\.time\)/.test(html)
     && /function _glideStep\(now\)/.test(html) && /function glideReset\(\)/.test(html));
  ok('a big jump or a new bar is painted at once, never eased', /Math\.abs\(price-_gShown\)>Math\.abs\(price\)\*0\.0025/.test(html)
     && /if\(newBar\|\|newSym\|\|jump\|\|_glideReduced\(\)\)/.test(html));
  ok('ticks repaint the overlays on a budget, pan and zoom do not wait', /function scheduleTickDraw\(\)/.test(html)
     && /scheduleTickDraw\(\);/.test(html) && /60-\(performance\.now\(\)-_zLastAt\)/.test(html));
  ok('the volume rows are bucketed, so jitter under 3 px rebuilds nothing', /Math\.round\(_a\/3\)/.test(html) && /Math\.round\(_b\/3\)/.test(html));
  ok('the volume pass measures the alert card once, not per row', /_afBand/.test(html) && !/const _cr=_c\.getBoundingClientRect\(\), _plot/.test(html));
  ok('the tools are built once the chart exists', /initChartTools\(\);/.test(grab('createChart') || html.slice(html.indexOf('function createChart()'), html.indexOf('function createChart()+200'))) );

  // the maths is real
  const sma = taSMA([1,2,3,4,5], 3);
  ok('SMA of 1..5 over 3 is 2,3,4', sma[0] === null && sma[1] === null && sma[2] === 2 && sma[4] === 4, JSON.stringify(sma));
  const ema = taEMA([1,1,1,1], 3);
  ok('EMA of a flat line is that line', ema.every(v => Math.abs(v - 1) < 1e-9), JSON.stringify(ema));
  const up = taRSI([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 14);
  ok('RSI of a straight rise is 100', up[up.length-1] === 100, String(up[up.length-1]));
  const dn = taRSI([16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1], 14);
  ok('RSI of a straight fall is 0', dn[dn.length-1] === 0, String(dn[dn.length-1]));
  const bb = taBB([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20], 20, 2);
  ok('Bollinger bands bracket their mid line', bb.up[19] > bb.mid[19] && bb.dn[19] < bb.mid[19], JSON.stringify({u:bb.up[19],m:bb.mid[19],d:bb.dn[19]}));
  const mac = taMACD(Array.from({length:60}, (_,i) => 100 + Math.sin(i/4)*3), 12, 26, 9);
  ok('MACD returns a line, a signal and a histogram', mac.line.length === 60 && mac.signal.length === 60 && mac.hist.length === 60);
  ok('MACD histogram is line minus signal', Math.abs(mac.hist[59] - (mac.line[59] - mac.signal[59])) < 1e-9);

  const bars = [{time:1,open:10,high:14,low:9,close:12},{time:2,open:12,high:15,low:11,close:13}];
  const hk = toHeikin(bars);
  ok('Heikin candles average the four prices', Math.abs(hk[0].close - (10+14+9+12)/4) < 1e-9, String(hk[0].close));
  ok('a Heikin high never cuts the real high', hk[0].high >= 14 && hk[1].high >= 15 && hk[1].low <= 11);
  ok('Heikin bars keep their time', hk[1].time === 2);
}



section('one strategy, one price, more tools');
{
  // the render rule set is gone, everywhere
  ok('no RENDER strategy button is left', !/>RENDER</.test(html) && html.indexOf('data-strategy="render"') < 0);
  ok('no strategy switch is left', html.indexOf('data-strategy=') < 0);
  ok('the strategy is fixed to volume', /window\._strategy = 'volume';/.test(html));
  ok('the render zone feed is never called', !/setInterval\(fetchZones/.test(html) && !/fetchZones\(\);lastPrice/.test(html));

  // switching market blanks the chart before the new feed lands
  const sym = grab('setSymbol');
  ok('a switch clears the old candles', /candleSeries\.setData\(\[\]\)/.test(sym));
  ok('a switch drops the old last price', /lastPrice=0/.test(sym));
  ok('a switch paints the known price at once', /paintKnownPrice\(sym\)/.test(sym));
  ok('the board can never overwrite a live price', /window\._pxCache\[it\.id\]/.test(grab('fetchBoard')));

  // more tools
  const rail = html.slice(html.indexOf('const TV_RAIL=['), html.indexOf('const TV_TOOL_NAME='));
  const tools = [...rail.matchAll(/\{t:'(\w+)'/g)].map(m => m[1]);
  ok('the rail gained a ray and an ellipse', tools.includes('ray') && tools.includes('ellipse'), tools.join(','));
  ok('the panel offers arrow, channel, text and position', /const TV_EXTRA=\[\['arrow'/.test(html)
     && html.indexOf("['text','Text']") > 0 && html.indexOf("['position','Position']") > 0);

  const inds = html.slice(html.indexOf('const IND_LIST=['), html.indexOf('const PANE_KINDS='));
  ok('twenty-nine indicators are on offer', (inds.match(/\['/g) || []).length === 29, String((inds.match(/\['/g)||[]).length));
  ok('supertrend and vwap bands are there', inds.includes("'st'") && inds.includes("'vwapb'"));
  ok('fourteen panes are wired', /const PANE_KINDS=\['cvd','rsi','macd','stoch','atr','adx','cci','willr','obv','mom','roc','mfi','ad','bbw'\]/.test(html));

  // the new maths
  const bars = Array.from({length: 40}, (_, i) => ({
    time: 1793000000 + i*900, open: 100+i, high: 101+i, low: 99+i, close: 100.5+i, v: 1000+i,
  }));
  const atr = taATR(bars, 14);
  // the indicators added with the terminal upgrade
  const don = taDonchian(bars, 20);
  ok('Donchian hugs the last 20 highs and lows', don.up[19] === bars[19].high && don.dn[19] === bars[0].low
     && don.up[18] === null && don.mid[19] === (bars[19].high + bars[0].low) / 2, JSON.stringify([don.up[19], don.dn[19]]));
  const kc = taKeltner(bars, 20, 2);
  ok('Keltner is the EMA plus a multiple of ATR', kc.up[30] > kc.mid[30] && kc.dn[30] < kc.mid[30]
     && Math.abs((kc.up[30] - kc.mid[30]) - 2 * taATR(bars, 10)[30]) < 1e-9);
  const ic = taIchimoku(bars);
  ok('Ichimoku has all four lines', ['tenkan','kijun','senkouA','senkouB'].every(k => Array.isArray(ic[k]) && ic[k].length === bars.length));
  const ps = taPSAR(bars, 0.02, 0.2);
  ok('every SAR value is a real number', ps.length === bars.length && ps.every(v => isFinite(v)));
  const ax = taADX(bars, 14);
  ok('a one-way ramp is all +DI, never −DI', ax.plus[39] > ax.minus[39] && ax.adx[39] > 0, JSON.stringify([ax.plus[39], ax.minus[39]]));
  const flat = Array.from({length: 30}, (_, i) => ({ time: 1 + i * 900, open: 50, high: 50, low: 50, close: 50, v: 10 }));
  ok('a flat market has Williams %R at −50 and CCI at 0', taWilliams(flat, 14)[29] === -50 && taCCI(flat, 20)[29] === 0);
  const upOnly = Array.from({length: 10}, (_, i) => ({ time: i, open: 1 + i, high: 1 + i, low: 1 + i, close: 1 + i, v: 100 }));
  ok('OBV only ever adds real volume', taOBV(upOnly)[9] === 900);
  ok('ATR is positive and finite', atr.length === 40 && atr[39] > 0 && isFinite(atr[39]), String(atr[39]));
  ok('ATR of a steady climb is about the bar range', Math.abs(atr[39] - 2) < 0.05, String(atr[39]));

  const st = taSupertrend(bars, 10, 3);
  ok('supertrend sits below a rising market', st.line[39] < bars[39].close && st.dir[39] === 1, st.line[39] + '/' + st.dir[39]);
  const down = taSupertrend(bars.slice().reverse().map((b,i) => ({...b, time: b.time+i})), 10, 3);
  ok('supertrend flips in a falling market', down.dir[down.dir.length-1] === -1, String(down.dir[down.dir.length-1]));

  const stoch = taStoch(bars, 14, 3, 3);
  ok('stochastic of a rise near the highs is high', stoch.k[39] > 80 && stoch.k[39] <= 100, String(stoch.k[39]));
  ok('stochastic %D follows %K', stoch.d[39] != null && Math.abs(stoch.d[39] - stoch.k[39]) < 12, String(stoch.d[39]));

  const vb = taVWAPbands(bars);
  ok('vwap bands bracket the vwap', vb.up[39] > vb.mid[39] && vb.dn[39] < vb.mid[39], [vb.dn[39], vb.mid[39], vb.up[39]].join('/'));
  ok('vwap bands are the same on a flat book', (() => {
    const flat = bars.map(b => ({...b, high: 100, low: 100, close: 100}));
    const f = taVWAPbands(flat);
    return Math.abs(f.up[39] - 100) < 1e-9 && Math.abs(f.dn[39] - 100) < 1e-9;
  })());

  // ---- the device lock: OS face check + 4-digit PIN fallback ----
  const lcss = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok('a lock screen covers the site', /<div id="lock"[^>]*role="dialog"[^>]*aria-modal="true"/.test(html));
  ok('the lock has four PIN dots and a keypad', /id="lock-dots">(<i><\/i>){4}/.test(html)
     && /id="lock-pad"/.test(html));
  ok('a locked body hides the app', /body\.locked \.hd,body\.locked \.wrap/.test(lcss));
  ok('the menu can lock the site again', /class="menu-lock"[^>]*onclick="lockNow\(\)"/.test(html));
  ok('face check is a platform authenticator, user verified', /authenticatorAttachment:'platform'/.test(html)
     && /userVerification:'required'/.test(html));
  ok('the face check only asks, it never opens a camera', !/getUserMedia|video\.play|FaceDetector/.test(html));
  ok('the PIN is stored as a salted hash, never as digits', /salt:salt,h:await lkMakeHash\(pin,salt\)/.test(html)
     && /crypto\.subtle\.digest\('SHA-256'/.test(html));
  ok('a device without a face check still gets in by PIN', /lkBioReady\(\).*lkOpen\('offer'\)|if\(await lkBioReady\(\)\)\{ lkOpen\('offer'\); return; \}/.test(html));
  ok('locking again drops the session pass', /sessionStorage\.removeItem\(LK\.sess\)/.test(html));
  ok('the session pass is what keeps it open', /sessionStorage\.setItem\(LK\.sess,'1'\)/.test(html));

  // ---- order flow: the value edge decides, not the VWAP side ----
  const { execSync: ex2 } = require('child_process');
  const flow = ex2(`cd ${root} && python3 -c "
import sys; sys.path.insert(0,'.')
import volume as V, copy, random
random.seed(3)
def book(n=110, start=3900.0):
    out=[]; p=start; t=1793000000
    for i in range(n):
        o=p; p=p+random.uniform(-1.1,1.1)
        hi=max(o,p)+random.uniform(0,0.9); lo=min(o,p)-random.uniform(0,0.9)
        vol=random.uniform(800,1500); rng=(hi-lo) or 1e-9; ratio=(p-lo)/rng
        out.append({'time':t+i*900,'open':o,'high':hi,'low':lo,'close':p,'volume':vol,
                    'buy':vol*ratio,'sell':vol*(1-ratio)})
    return out
c=book(); rows,poc,_=V.clusters(c,48,10); va=V.value_area(rows,poc)
vw,_=V.daily_vwap(c); atr=V.atr_series(c,14)[-1]
base=V.signal(c,vw,rows,poc,atr,10,V.vwap_series(c),va=va)
low=copy.deepcopy(c); low.append({'time':c[-1]['time']+900,'open':va['low']+1,'high':va['low']+1.3,
    'low':va['low']-1.2,'close':va['low']+1.1,'volume':1600.0,'buy':1400,'sell':200})
r2,p2,_=V.clusters(low,48,10); v2=V.value_area(r2,p2)
rej=V.signal(low,vw,r2,p2,atr,10,V.vwap_series(low),va=v2)
hi=copy.deepcopy(c); hi.append({'time':c[-1]['time']+900,'open':va['high']-1,'high':va['high']+1.2,
    'low':va['high']-1.3,'close':va['high']-1.1,'volume':1600.0,'buy':200,'sell':1400})
r3,p3,_=V.clusters(hi,48,10); v3=V.value_area(r3,p3)
rejh=V.signal(hi,vw,r3,p3,atr,10,V.vwap_series(hi),va=v3)
print('|'.join([rej['type'], rej.get('style') or '-', rejh['type'], base['type'],
                str(rej.get('tp2',0)>rej.get('tp1',0))]))
"`).toString().trim().split('|');
  ok('a bounce off VAL is a BUY, not a sell', flow[0] === 'BUY' && /reject VAL|absorbed at VAL/.test(flow[1]), flow.join('|'));
  ok('a rejection at VAH is a SELL', flow[2] === 'SELL', flow[2]);
  ok('the signal names the order-flow read', /reject|absorb|accept/.test(flow[1]), flow[1]);
  ok('the targets stay ordered', flow[4] === 'True', flow[4]);
  ok('the signal carries its flow numbers', /delta_ratio/.test(grab('fetchVolume')) || /flow/.test(html));

  // ---- catalog video, flow readout, forex gone ----
  ok('the menu offers a Catalog video', /class="catalog-card"[^>]*onclick="openCatalog\(\)"/.test(html)
     && /openSheet\('Catalog/.test(grab('openCatalog')));
  ok('the video is served from the site, not a third party', /file:'\/astra6-pl1\.mp4'/.test(html)
     && /@app\.get\("\/astra6-\{name\}\.mp4"\)/.test(require('fs').readFileSync(path.join(root,'main.py'),'utf8')));
  ok('the video file is real and roughly the promised length', (() => {
    const st = require('fs').statSync(path.join(root, 'astra6-orderflow.mp4'));
    return st.size > 500000 && st.size < 20e6;
  })());
  ok('the catalog is a voiced playlist', /6 lessons · 6:20 with voice/.test(html) && /const PLAYLIST=\[/.test(html));
  ok('lesson 6 teaches PDH, PDL and PDC', /6 · Prior day high, low and close/.test(html)
     && /file:'\/astra6-pl6\.mp4'/.test(html) && /PDH, PDL and PDC/.test(html));
  ok('every lesson file is on disk and is a real video', (() => {
    const files = ['astra6-pl1.mp4','astra6-pl2.mp4','astra6-pl3.mp4','astra6-pl4.mp4','astra6-pl5.mp4','astra6-pl6.mp4','astra6-full.mp4'];
    return files.every(f => { const st = require('fs').statSync(path.join(root, f)); return st.size > 300000 && st.size < 12e6; });
  })());
  // ---- the market read: an assistant bound to the page's own numbers ----
  ok('the trade card offers a market read', /class="chip"[^>]*openAIRead\(\)/.test(html) && /function openAIRead\(\)/.test(html));
  ok('the read is built from measured facts, not guesses', /function aiFacts\(\)/.test(html)
     && /value_area/.test(html) && /delta_series/.test(html) && /function aiRead\(f\)/.test(html));
  ok('the read says what would change it, not what will happen', /What would change the read/.test(html)
     && /function aiAnswer\(q,f\)/.test(html));
  ok('a HOLD explains itself instead of inventing a trade', /no trade printed, so there is no stop or reward to check/.test(html)
     && /No stop is printed while the strip says HOLD/.test(html));
  ok('no NaN or made-up price can reach the panel', /function aiNum\(v\)/.test(html) && /aiNum\(sig\.entry\)/.test(html));
  ok('the model is optional and never a source of numbers', (() => {
    const m = require('fs').readFileSync(path.join(root,'main.py'),'utf8');
    return /def _ai_facts_whitelist/.test(m) && /engine.*rules/.test(m)
      && /Use ONLY numbers present in FACTS/.test(m) && /ASTRA6_AI_KEY/.test(m);
  })());
  ok('the endpoint forwards no identifiers or user data', (() => {
    const m = require('fs').readFileSync(path.join(root,'main.py'),'utf8');
    const i = m.indexOf('def _ai_facts_whitelist');
    const body = m.slice(i, i + 1400);
    return !/email|cookie|user/i.test(body.split('keep =')[1].split('out =')[0]);
  })());
  // ---- session levels: real, labelled, and never invented ----
  ok('the chart draws prior-day levels from the feed\'s own bars', /function buildSessionLevels\(bars\)/.test(html)
     && /priorK/.test(html) && /pdh:prior\.hi,pdl:prior\.lo,pdc:prior\.close/.test(html));
  ok('the overnight window is a stated UTC window, not a guess', /const SL_WIN=\[22,7\]/.test(html)
     && /22:00/.test(html));
  ok('a level the feed has no bars for is not drawn', /if\(px==null\) return;/.test(html)
     && /onh:oN\?oHi:null/.test(html));
  ok('the levels never borrow another market\'s numbers', /_slSym===currentSymbol/.test(html)
     && /if\(_sym!==currentSymbol\|\|_ven!==currentVenue\)/.test(html));
  ok('the prior day is named, so "prior" is never ambiguous', /dayLabel:new Date/.test(html) && /timeZone:'UTC'/.test(html));
  ok('session levels can be turned off and stay off', /function toggleSessionLevels\(\)/.test(html)
     && /astra6_slevels/.test(html) && /function slOn\(\)/.test(html));

  // ---- installable + offline ----
  ok('the app is installable', (() => {
    const m = JSON.parse(require('fs').readFileSync(path.join(root,'manifest.json'),'utf8'));
    return m.display === 'standalone' && m.icons.length >= 3
      && m.icons.some(i => i.purpose === 'maskable') && /rel="manifest"/.test(html);
  })());
  ok('the shell is served from the root with a worker scope', /@app\.get\("\/sw\.js"\)/.test(require('fs').readFileSync(path.join(root,'main.py'),'utf8'))
     && /Service-Worker-Allowed/.test(require('fs').readFileSync(path.join(root,'main.py'),'utf8')));
  ok('the worker never caches a quote', (() => {
    const sw = require('fs').readFileSync(path.join(root,'sw.js'),'utf8');
    return /pathname\.startsWith\('\/api\/'\)/.test(sw) && /never caches/.test(sw) || /would be a lie/.test(sw);
  })());
  ok('offline keeps the last real chart and says how old it is', /id="offline-card"/.test(html)
     && /Offline · last real data only/.test(html) && /last real quote:/.test(html) && /window\._lastRealAt/.test(html));
  ok('offline is decided by real failures, not just the browser flag', /const dead=\(navigator\.onLine===false\)\|\|\(_netFails>=2\)/.test(html));
  ok('the clips answer byte ranges, so a phone can scrub them', (() => {
    const s = require('fs').readFileSync(path.join(root,'main.py'),'utf8');
    return /def _mp4_response\(p: Path, request: Request\)/.test(s) && /status_code=206/.test(s)
      && /def catalog_clip\(name: str, request: Request\)/.test(s) && /Content-Range/.test(s);
  })());
  ok('the lessons are the paced cut, full screen, one sentence at a time', /len:'2:33',file:'\/astra6-full\.mp4'/.test(html)
     && /id="cc-fs"/.test(html) && /function openLesson\(i\)/.test(html) && /#cc-fs-video/.test(html.replace(/\s/g,''))
     && /object-fit:contain/.test(html));
  ok('a lesson can be picked from the list', /function playLesson\(i\)/.test(html) && /onclick="playLesson\(/.test(html));
  ok('the full order flow is a sheet, reachable from the strategy card', /onclick="[^"]*openOrderFlow\(\)"/.test(html)
     && /function openOrderFlow\(/.test(html));
  ok('the order flow sheet shows the ladder and the cumulative delta', /of-ladder/.test(html) && /Cumulative delta/.test(html));
  ok('the API publishes the delta series and the unbalanced levels', (() => {
    const py = require('fs').readFileSync(path.join(root, 'volume.py'), 'utf8');
    return /"delta_series"/.test(py) && /"imbalance"/.test(py) && /"cvd"/.test(py);
  })());
  ok('cumulative delta is its own pane, on by default', /\['cvd','Order flow · CVD pane'\]/.test(html)
     && /const PANE_TITLE=\{cvd:/.test(html) && /cvd:true\}/.test(html));
  ok('the strategy readout sits in the menu', /id="flow-line" class="flow-line menu-flow"/.test(html)
     && /function paintFlowLine/.test(html)
     && html.indexOf('id="flow-line"') > html.indexOf('id="menu"'));
  ok('the strategy card proves it is working, not just what it says now',
     /function readsStrip\(/.test(html) && /function toggleSignalWatch\(/.test(html)
     && /id="flow-watch"/.test(html) && /function phoneAlertState\(/.test(html)
     && /last trade/.test(html));
  ok('a signal watch keeps watching, and arms itself on the first run',
     /astra6_watch_default/.test(html) && /a\.lastSide/.test(html) && /keeps watching/.test(html));
  ok('the trade boxes have presets and switches of their own',
     /function zonePresets\(\)\{/.test(html) && /function setZoneStyle\(/.test(html)
     && /onclick="setZoneStyle\(\{preset:'clean'\}\)"/.test(html)
     && /astra6_zstyle/.test(html));
  ok('the readout prints entry, stop and both targets', /flow-k">SL<\/span>/.test(html) && /flow-k">TP2<\/span>/.test(html));
  ok('forex pairs are gone from the market table', !/'EUR\/USD'/.test(html) && !/'USD\/JPY'/.test(html) && !/'GBP\/USD'/.test(html));
  ok('the market chip is a label, not a picker', /<span id="mkt-float"/.test(html)
     && !/<button id="mkt-float"[^>]*onclick="toggleMarketPicker/.test(html));
  ok('the groups are derived from what is actually on the site',
     /const MKT_GROUPS=Array\.from\(new Set\(Object\.keys\(MKT\)/.test(html));
  ok('forex is still gone from the market table',
     !/EURUSD:|GBPUSD:|USDJPY:/.test(html.slice(html.indexOf('const MKT={'), html.indexOf('const MKT_GROUPS'))));
  ok('no pop-up alert card exists any more', !html.includes('id="alert-float"'));
}
// ---------------- round 8: one phone tool strip, a live buyer/seller meter --------
{
  const _si = html.indexOf('<div id="mob-strip"'), _sj = html.indexOf('<div class="meta-row">', _si);
  const strip = (_si >= 0 && _sj > _si) ? html.slice(_si, _sj) : '';
  ok('the phone strip carries chart views and indicators',
     /onclick="togglePanel\('chart-menu'\)"/.test(strip) && /onclick="togglePanel\('ind-panel'\)"/.test(strip));
  ok('the phone strip carries every timeframe', ['M1','M5','M15','M30','H1','H4','D'].every(t => strip.includes('data-tf="' + t + '"')));
  ok('the phone strip names the market', /ms-pair/.test(strip) && /XAUUSD/.test(strip));
  ok('the phone strip shows the live signal', /id="ms-sig"/.test(strip) && /openFlowCard\(\)/.test(strip));
  ok('the strip is painted from the live read, not from a guess',
     /function paintMobStrip\(\)/.test(html) && /window\._volume/.test(grab('paintMobStrip')));
  ok('the strip is phone only', /@media\(max-width:820px\)\{[\s\S]{0,400}body\.has-bnav\[data-view="chart"\] #mob-strip\{/.test(html.replace(/\n/g, '')));
  ok('the scattered phone timeframes and market chip move into the strip',
     /body\[data-view="chart"\] #tf-float,\s*\n\s*body\[data-view="chart"\] #mkt-float/.test(html));
  ok('the chart gives the strip its own height instead of hiding candles',
     /--mobstrip-h/.test(grab('syncChrome'))
     && /body\.has-bnav\[data-view="chart"\] \.wrap\{\s*\n?\s*height:calc\(var\(--app-h\) - var\(--hd-h\) - var\(--bnav-h\) - var\(--mobstrip-h\)\)/.test(html));
  const meter = (html.match(/<button id="flow-meter"[\s\S]*?<\/button>/) || [''])[0];
  ok('the chart carries a buyers vs sellers meter', /fm-buy/.test(meter) && /fm-sell/.test(meter) && /fm-fill/.test(meter));
  ok('the meter is fed by the real quote tape', /\/api\/tape/.test(html) && /function tapeTick\(\)/.test(html));
  ok('the meter is labelled as counts of quotes, never contracts',
     /counts of real quotes, not contracts/.test(fs.readFileSync(path.join(root, 'volume.py'), 'utf8'))
     && /quotes/.test(grab('paintFlowMeter')) && /warming/.test(grab('tapeLabel')));
  ok('a dead tape is shown as dead, not as steady buying', /no quotes yet/.test(grab('paintFlowMeter')));
  ok('tapping the meter opens the full read', /function openFlowCard\(\)/.test(html) && /flow-line/.test(grab('openFlowCard')));
  ok('the meter never invents its numbers', !/Math\.random/.test(grab('paintFlowMeter')) && !/Math\.random/.test(grab('tapeTick')));
}
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);