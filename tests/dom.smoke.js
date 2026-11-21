/**
 * Boots the real index.html in jsdom and drives the "My signal" card.
 *   NODE_PATH=/home/user/_jsd/node_modules node tests/dom.smoke.js
 *
 * The point is not coverage: it is that the page survives a boot with every removed
 * panel gone, and that posting a signal validates, stores and draws it.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const errors = [];

const dom = new JSDOM(html, {
  url: 'https://astra6.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(win) {
    win.fetch = () => new Promise(() => {});          // never resolves: no network here
    win.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
    win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    win.scrollTo = () => {};
    win.addEventListener('error', e => errors.push(String(e.message || e.error)));
  },
});
const { window } = dom;
const doc = window.document;

function check(name, cond, extra) {
  if (!cond) {
    console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    process.exitCode = 1;
  } else {
    console.log('  ok   ' + name);
  }
}

setTimeout(() => {
  console.log('boot');
  check('no boot exception', errors.length === 0, errors.slice(0, 3));
  check('composer exists', !!doc.getElementById('mysig-form'));
  check('chart still exists', !!doc.getElementById('oanda_chart'));
  check('timeframe row still there', !!doc.querySelector('#tf-float [data-tf="M5"]'));

  console.log('removed surfaces');
  for (const id of ['alerts-panel', 'tv-rail', 'draw-layer', 'ind-panel', 'chart-menu',
                    'watch-panel', 'zone-layer', 'vwap-layer', 'mkt-pop', 'rail-toggle',
                    'hero-signal', 'chart-source']) {
    const el = doc.getElementById(id);
    check('  ' + id + ' gone from the page', !el || !el.isConnected, id);
  }
  check('no Telegram block in the footer', !/ASTRA6RENDER/.test(doc.body.innerHTML));
  check('no signal-alert button anywhere', !/alertSignal|Signal alert/.test(doc.body.innerHTML));

  console.log('posting');
  const val = (id, v) => { const el = doc.getElementById(id); el.value = v; return el; };
  doc.querySelector('.mside[data-side="SELL"]').dispatchEvent(new window.Event('click'));
  check('SELL selected', doc.querySelector('.mside[data-side="SELL"]').classList.contains('on'));

  val('mysig-entry', '4000');
  val('mysig-sl', '4010');
  val('mysig-tp1', '3980');
  doc.getElementById('mysig-form').dispatchEvent(new window.Event('submit'));

  const saved = JSON.parse(window.localStorage.getItem('astra6_my_signals') || '[]');
  check('signal stored', saved.length === 1 && saved[0].side === 'SELL', saved);
  check('entry/sl/tp kept', saved[0] && saved[0].entry === 4000 && saved[0].sl === 4010 && saved[0].tp1 === 3980);
  check('listed on the page, labelled private', /SELL/.test(doc.getElementById('mysig-list').innerHTML)
        && /private/.test(doc.getElementById('mysig-list').innerHTML));
  check('the count separates published from private',
        doc.getElementById('mysig-count').textContent === '0 published · 1 private',
        doc.getElementById('mysig-count').textContent);
  check('form cleared', doc.getElementById('mysig-entry').value === '');

  console.log('refusals');
  const before = JSON.parse(window.localStorage.getItem('astra6_my_signals')).length;
  val('mysig-entry', '4000'); val('mysig-sl', '3990');      // SELL stop below entry
  doc.getElementById('mysig-form').dispatchEvent(new window.Event('submit'));
  check('SELL with the stop on the wrong side refused',
        JSON.parse(window.localStorage.getItem('astra6_my_signals')).length === before,
        doc.getElementById('mysig-msg').textContent);
  check('...and says why', /above the entry/.test(doc.getElementById('mysig-msg').textContent));

  val('mysig-entry', '4000'); val('mysig-sl', '');          // no stop
  doc.getElementById('mysig-form').dispatchEvent(new window.Event('submit'));
  check('a signal with no stop refused', /stop loss is required/.test(doc.getElementById('mysig-msg').textContent));

  console.log('deleting');
  const id = JSON.parse(window.localStorage.getItem('astra6_my_signals'))[0].id;
  window.mysigDelete(id);
  check('deleted from storage', JSON.parse(window.localStorage.getItem('astra6_my_signals')).length === 0);
  check('empty state shown', /has not published a signal yet/.test(doc.getElementById('mysig-list').innerHTML));


  console.log('owner surfaces');
  check('the sign-in chip is in the header', !!doc.getElementById('owner-chip'));
  check('the banner slot exists and starts empty', !!doc.getElementById('owner-banner') && doc.getElementById('owner-banner').hidden);
  check('the site editor can be built', typeof window.openSiteEditor === 'function');
  // applySite is the whole customisation path: run it and read the page back
  window.applySite({ title: 'GOLD DESK', tagline: 'one market', accent: '#ff8800', theme: 'dark',
                     banner: { text: 'London open', tone: 'warn' }, sections: { calendar: false, journal: false },
                     signal_style: { buy: '#00ff00', sell: '#ff0000', decimals: 1, tps: 3 } });
  check('a saved title reaches the brand', doc.querySelector('.brand-name').textContent === 'GOLD DESK');
  check('a saved accent becomes the page accent',
        window.getComputedStyle(doc.documentElement).getPropertyValue('--brand').trim() === '#ff8800');
  check('a saved banner is shown with its tone',
        !doc.getElementById('owner-banner').hidden && doc.getElementById('owner-banner').textContent === 'London open'
        && doc.getElementById('owner-banner').getAttribute('data-tone') === 'warn');
  check('a section the owner hid disappears from the menu',
        Array.from(doc.querySelectorAll('#menu .menu-sec'))
          .some(sec => sec.querySelector('.menu-label') && sec.querySelector('.menu-label').textContent.trim() === 'Economic calendar'
                       && sec.hidden));
  check('decimals from the owner are used for prices', window.ownerFmt(3560.44) === '3560.4');

  console.log('published signals');
  // OWNER is a const at script scope, so it is not a window property: reach it through eval
  window.eval('OWNER.signals = [' +
    '{id:"a1",side:"SELL",entry:3560,sl:3572,tp1:3540,tp2:3520,note:"supply",at:1763000000,status:"open"},' +
    '{id:"a2",side:"BUY",entry:3500,sl:3490,tp1:3520,note:"",at:1762900000,status:"tp1 hit"}]');
  window.signalsRender();
  const listHtml = doc.getElementById('mysig-list').innerHTML;
  check('published signals are listed', /SELL/.test(listHtml) && /BUY/.test(listHtml));
  check('the count is the published count', doc.getElementById('mysig-count').textContent.indexOf('2 published') === 0);
  check('a status is shown on each row', /open/.test(listHtml) && /tp1 hit/.test(listHtml));
  check('a visitor gets no delete control', !/deleteSignal/.test(listHtml));
  console.log('\n' + (process.exitCode ? 'DOM SMOKE FAILED' : 'DOM SMOKE PASSED'));
  dom.window.close();
  process.exit(process.exitCode || 0);
}, 900);
