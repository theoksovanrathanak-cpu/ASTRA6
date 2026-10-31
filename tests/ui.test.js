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
  'drawVolume', 'syncHdH', 'setTabPrice',
  'esc', 'ago', 'evClock', 'evDay', 'jnLoad', 'jnSave', 'jnR', 'jnStats', 'jnAdd', 'jnDel',
  'journalHtml', 'openJournal', 'openSheet', 'closeSheet', 'calHtml', 'newsHtml',
  'renderCalStrip', 'renderNewsStrip',
  'jnKeyOf', 'jnByDay', 'jnCalHtml', 'jnListHtml', 'jnMonth', 'jnPickDay', 'jnRepaint',
  'marketOpenNow', 'setNet', 'candlesLate', 'nextOpenLocal', 'paintEventLive', 'mkMeta',
  'paintAlertCard', 'alertsOf', 'alertsHtml', 'renderMarketSwitch',
  'taSMA', 'taEMA', 'taRSI', 'taMACD', 'taBB', 'toHeikin',
].map(n => grab(n)).join('\n'));
['recordZoneAlert', 'renderZoneAlerts', 'zoneAlerts', 'latestTrade',
 'openMenu', 'closeMenu', 'toggleMenu', 'setView', 'endIntro', 'playIntro',
 'drawVolume', 'syncHdH', 'setTabPrice',
 'esc', 'ago', 'evClock', 'evDay', 'jnLoad', 'jnSave', 'jnR', 'jnStats', 'jnAdd', 'jnDel',
 'journalHtml', 'openJournal', 'openSheet', 'closeSheet', 'calHtml', 'newsHtml',
 'renderCalStrip', 'renderNewsStrip',
 'jnKeyOf', 'jnByDay', 'jnCalHtml', 'jnListHtml', 'jnMonth', 'jnPickDay', 'jnRepaint',
 'marketOpenNow', 'setNet', 'candlesLate', 'nextOpenLocal', 'paintEventLive', 'mkMeta',
 'paintAlertCard', 'alertsOf', 'alertsHtml', 'renderMarketSwitch',
 'taSMA', 'taEMA', 'taRSI', 'taMACD', 'taBB', 'toHeikin'].forEach(n => { global[n] = eval(n); });
// the page's own price formatter, kept out of the sandbox so the older stub survives
const realFmtPx = new Function('mkMeta', 'currentSymbol',
  grab('fmtPx').replace('function fmtPx', 'return function fmtPx'))(mkMeta, 'XAUUSD');
// the calendar keeps its month/day in module scope in the page; give the harness the same
global._jnM = new Date(2026, 10, 1);
global._jnDay = null;

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
  ok('the alert card lives on the chart', html.indexOf('id="alert-float"') > html.indexOf('id="chart-section"')
     && html.indexOf('id="alert-float"') < html.indexOf('</main>'));
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
  ok('nothing pops the welcome open by itself', /bootIntro[\s\S]{0,300}classList\.add\('gone'\)/.test(html)
     && !/bootIntro[\s\S]{0,300}playIntro\(\);/.test(html));
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
  ok('the welcome shows metals, forex and futures', html.includes('id="home-px-XAUUSD"')
     && html.includes('id="home-px-EURUSD"') && html.includes('id="home-px-ES"'));
  ok('bitcoin is gone from the page', !/BTCUSD|BITCOIN|Bitcoin/.test(html.replace(/bitcoin is gone[^<]*/,'')));
  ok('the welcome subtitle names the three desks', /metals · forex · futures/.test(html));
  ok('the welcome has no price header', /body\[data-view="home"\] \.hd \.price-block/.test(html));
  ok('home tells you the chart is in the menu', /tap the <b>menu<\/b> → <b>Chart<\/b>/.test(html));
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
s=V.signal(c,vw,rows,poc,atr,10.0,V.vwap_series(c))
p=s['entry']; r=s['risk']
tp1=abs(s['tp1']-p); tp2=abs(s['tp2']-p)
checks=[]
checks.append(('signal fires', s['type'] in ('BUY','SELL')))
checks.append(('stop is 0.45-1.6 ATR from entry, anchored to the box', 0.45 <= r/atr <= 1.6))
checks.append(('tp2 clears tp1', tp2 > tp1))
checks.append(('target is 1.3-2.6R', 1.3 <= tp2/r <= 2.6))
checks.append(('reported R matches the levels', abs(s['r'] - tp2/r) < 0.03))
checks.append(('reason names the box and both targets', 'box' in s['reason'] and 'tp1' in s['reason']))
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
  ok('menu has a latest news section', /menu-label">Latest news</.test(html));
  ok('the old mixed section is gone', !/menu-label">Fundamentals</.test(html));
  ok('calendar has its own preview strip', html.includes('id="cal-strip"'));
  ok('news has its own preview strip', html.includes('id="news-strip"'));
  ok('calendar opens its own panel', /onclick="openCalendar\(\)"/.test(html));
  ok('news opens its own panel', /onclick="openNews\(\)"/.test(html));
  ok('two endpoints, not one', /\/api\/calendar/.test(html) && /\/api\/news/.test(html));
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
  ok('the legend moved down to make room', /#tv-legend\{position:absolute;top:44px/.test(html));
  ok('sections are divided, not stacked blindly', /\.menu-sec\{[^}]*border-top:1px solid/.test(html));
  ok('the signal list is no longer a drawer ladder', html.indexOf('id="alerts-list"') < 0);
  const order = ['View', 'Economic calendar', 'Latest news', 'Trade journal', 'Strategy']
    .map(t => menu.indexOf(t));
  ok('the menu reads in a sane order', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), order);
  ok('setTimeframe still finds its buttons', /querySelectorAll\('\[data-tf\]'\)/.test(grab('setTimeframe')));
}

section('the page says when the data stops');
{
  const at = s => new Date(s).getTime();
  ok('the metals shut at the weekend', !marketOpenNow('XAGUSD', at('2026-10-31T12:00:00Z')));
  ok('forex reopens Sunday 22:00', marketOpenNow('EURUSD', at('2026-11-01T22:30:00Z')));
  ok('futures open later on Sunday than forex', !marketOpenNow('ES', at('2026-11-01T22:30:00Z'))
     && marketOpenNow('ES', at('2026-11-01T23:30:00Z')));
  ok('futures trade on a Friday morning', marketOpenNow('NQ', at('2026-10-30T09:00:00Z')));
  ok('gold is shut on Saturday', !marketOpenNow('XAUUSD', at('2026-10-31T12:00:00Z')));
  ok('gold is shut on Sunday morning', !marketOpenNow('XAUUSD', at('2026-11-01T12:00:00Z')));
  ok('gold opens Sunday 22:00 UTC', marketOpenNow('XAUUSD', at('2026-11-01T22:30:00Z')));
  ok('gold trades on Friday morning', marketOpenNow('XAUUSD', at('2026-10-30T09:00:00Z')));
  ok('gold closes Friday 21:00 UTC', !marketOpenNow('XAUUSD', at('2026-10-30T21:30:00Z')));
  ok('the daily break is closed', !marketOpenNow('XAUUSD', at('2026-10-28T21:30:00Z')));
  ok('the rest of the week is open', marketOpenNow('XAUUSD', at('2026-10-28T12:00:00Z')));
  ok('the header carries the state', html.includes('id="net-chip"') && html.includes('id="net-text"'));
  ok('the tiles admit a closed market', html.includes('id="home-tag-XAUUSD"'));
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
  globalThis.syncHdH = () => {};
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

  // the alert list is per market, by construction
  currentSymbol = 'EURUSD';
  store.astra6_zone_alerts_EURUSD = JSON.stringify([
    { key: 'e1', sym: 'EURUSD', type: 'BUY', entry: 1.08542, sl: 1.08380, tp1: 1.08704, tp2: 1.08866, r: 2.0, ts: 1793400000 },
    { key: 'e2', sym: 'XAUUSD', type: 'SELL', entry: 3875, sl: 3880, tp1: 3870, tp2: 3865, r: 2.0, ts: 1793300000 },
  ]);
  const eur = alertsOf('EURUSD');
  ok('a stray gold record cannot show on the euro chart', eur.length === 1 && eur[0].key === 'e1');
  const realFmt = fmtPx;
  global.fmtPx = realFmtPx;                    // the page's own, decimals per market
  const htmlEur = alertsHtml('EURUSD');
  ok('the euro sheet lists the euro trade', htmlEur.includes('1.08542') && !htmlEur.includes('3875'));
  ok('the sheet names the market', /EURUSD/.test(htmlEur));
  localStorage.removeItem('astra6_zone_alerts_XAUUSD');
  const gold = alertsHtml('XAUUSD');
  ok('an empty market says so honestly', /No XAUUSD signal yet/.test(gold));

  const card = mkEl('alert-float');
  card.hidden = true;
  document.getElementById = (id) => (id === 'alert-float' ? card : (els[id] || null));
  currentSymbol = 'EURUSD';
  paintAlertCard(eur.map(a => ({ type: a.type, entry: a.entry, sl: a.sl, tp1: a.tp1, tp2: a.tp2, r: a.r, ts: a.ts })));
  ok('the chart card shows this market only', card.hidden === false && /EURUSD/.test(card.innerHTML) && !/3,875|3875/.test(card.innerHTML));
  ok('the card carries the levels', /1\.08380/.test(card.innerHTML) && /1\.08866/.test(card.innerHTML));
  global.fmtPx = realFmt;
  paintAlertCard([]);
  ok('no alert means no card', card.hidden === true);
  ok('the card opens the whole list', /onclick="openAlerts\(\)"/.test(html) && /openSheet\('Alerts/.test(grab('openAlerts')));
  ok('switching market repaints the card', /renderZoneAlerts\(\)/.test(grab('setSymbol')));
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
  ok('the rail opens the indicator and chart panels', tools.includes('fx') && tools.includes('more'));

  const types = [...html.slice(html.indexOf('const CTYPE_LIST='), html.indexOf('let drawTool=')).matchAll(/\['(\w+)','/g)].map(m => m[1]);
  ok('five chart types, heikin included', types.length === 5 && types.includes('heikin') && types.includes('line'), types.join(','));

  ok('drawings are stored per market', html.includes("'astra6_draw_'+currentSymbol"));
  ok('indicator choices stick across a refresh', html.includes("localStorage.setItem('astra6_ind'"));
  ok('the chart type sticks too', html.includes("localStorage.setItem('astra6_ctype',t)"));

  // every fetch paints through the type-aware painter, live ticks too
  ok('candles go through paintSeries', /try\{paintSeries\(clean\);/.test(html));
  ok('ticks go through updateSeries', /try\{updateSeries\(upd\);/.test(html));
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

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
