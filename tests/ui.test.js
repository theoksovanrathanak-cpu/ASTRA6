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
  documentElement: { setAttribute() {}, getAttribute: () => 'dark' },
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
].map(n => grab(n)).join('\n'));
['recordZoneAlert', 'renderZoneAlerts', 'zoneAlerts', 'latestTrade',
 'openMenu', 'closeMenu', 'toggleMenu', 'setView', 'endIntro', 'playIntro'].forEach(n => { global[n] = eval(n); });

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

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
