/* One market, everywhere: nothing on any screen may offer, name or price another pair. */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const res = [];
const ok = (n, c, x) => { res.push(!!c); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '   ' + JSON.stringify(x))); };
const OTHERS = ['XAGUSD', 'XPTUSD', 'XPDUSD', 'ES', 'NQ', 'CL', 'BTCUSD', 'ETHUSD', 'Bitcoin', 'Ethereum', 'Silver', 'Platinum', 'Palladium', 'Nasdaq', 'Crude'];

(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.setUserAgent(IPHONE);
  // plant the past: a watchlist, an alert and a saved symbol from the days of other pairs
  await p.evaluateOnNewDocument(() => {
    sessionStorage.setItem('astra6_unlocked', '1');
    localStorage.setItem('astra6_watch', JSON.stringify(['BTCUSD', 'XAUUSD', 'XAGUSD', 'ES']));
    localStorage.setItem('astra6_symbol', 'BTCUSD');
    localStorage.setItem('astra6_alt_alerts', JSON.stringify([
      { id: 'a1', sym: 'BTCUSD', kind: 'above', price: 1, on: true, fired: 0 },
      { id: 'a2', sym: 'XAUUSD', kind: 'above', price: 999999, on: true, fired: 0 }
    ]));
  });
  const calls = [];
  p.on('request', r => { const u = r.url(); if (/\/api\//.test(u)) calls.push(u.replace(BASE, '')); });
  await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(1200);
  const boot = await p.evaluate(() => ({
    sym: currentSymbol,
    saved: localStorage.getItem('astra6_symbol'),
    one: ONE_MARKET,
    keys: Object.keys(MKT),
    groups: MKT_GROUPS,
    watch: JSON.parse(localStorage.getItem('astra6_watch') || '[]'),
    // the app now arms its own signal watch on first run, so this counts the price alert
    // planted above and ignores the built-in watch
    alerts: (JSON.parse(localStorage.getItem('astra6_alt_alerts') || '[]') || [])
      .filter(a => a.kind !== 'signal').map(a => a.sym),
    pickerIsLabel: !document.querySelector('#mkt-float button') && !document.getElementById('mkt-float').onclick
  }));
  ok('the app opens on gold, even with bitcoin saved', boot.sym === 'XAUUSD' && boot.saved === 'XAUUSD', boot);
  ok('the market table holds one market', boot.one && boot.keys.length === 1 && boot.keys[0] === 'XAUUSD', boot.keys);
  ok('the groups collapse to the one that exists', boot.groups.length === 1 && boot.groups[0] === 'Metals', boot.groups);
  ok('an old multi-pair watchlist is cut back to gold', JSON.stringify(boot.watch) === '["XAUUSD"]', boot.watch);
  ok('an alert on a pair that no longer exists is dropped', JSON.stringify(boot.alerts) === '["XAUUSD"]', boot.alerts);
  ok('the market chip is a label, not a picker', boot.pickerIsLabel);

  await p.evaluate(() => setView('chart'));
  await sleep(8000);

  // the chart itself
  const chart = await p.evaluate(() => ({ n: (lastCandles || []).length, label: document.getElementById('mkt-float-sym').textContent, chip: document.getElementById('hd-sym').textContent }));
  ok('gold is on the chart', chart.n > 20 && chart.label === 'XAUUSD' && chart.chip === 'XAUUSD', chart);

  // every surface that used to list markets
  const surfaces = await p.evaluate(async () => {
    const out = {};
    openMenu(); await new Promise(r => setTimeout(r, 500));
    out.menu = document.getElementById('menu').innerText;
    closeMenu();
    openAlertsSheet(); await new Promise(r => setTimeout(r, 500));
    out.alerts = document.querySelector('#sheet-body').innerText;
    out.pairChips = document.querySelectorAll('#sheet-body .alt-pairs .tp-chip').length;
    closeSheet();
    renderWatchPanel(); await new Promise(r => setTimeout(r, 300));
    const wp = document.getElementById('watch-panel');
    out.watch = wp ? wp.innerText : '';
    out.watchRows = document.querySelectorAll('#watch-panel .wl-row, #watch-panel .watch-row').length;
    setLayout(2); await new Promise(r => setTimeout(r, 900));
    out.mv = document.getElementById('multi-view').innerText;
    setLayout(1);
    openJournal(); await new Promise(r => setTimeout(r, 400));
    out.journal = document.querySelector('#sheet-body').innerText;
    out.journalOpts = [...document.querySelectorAll('#jn-sym option')].map(o => o.value);
    closeSheet();
    openOrderFlow && openOrderFlow(); await new Promise(r => setTimeout(r, 400));
    out.flow = (document.querySelector('#sheet-body') || {}).innerText || '';
    closeSheet();
    out.body = document.body.innerText;
    return out;
  });
  for (const [name, text] of [['drawer', surfaces.menu], ['alerts sheet', surfaces.alerts], ['watchlist', surfaces.watch], ['multi-chart', surfaces.mv], ['journal', surfaces.journal], ['order flow', surfaces.flow]]) {
    const bad = OTHERS.filter(s => new RegExp('(^|[^A-Z])' + s + '([^A-Z]|$)').test(text));
    ok('no other pair on the ' + name, bad.length === 0, bad);
  }
  ok('the alert sheet offers no pair roster', surfaces.pairChips === 0, surfaces.pairChips);
  ok('the journal can only log gold', JSON.stringify(surfaces.journalOpts) === '["XAUUSD"]', surfaces.journalOpts);

  // the API the page reads must agree
  const api = await p.evaluate(async () => { const r = await fetch('/api/markets'); const d = await r.json(); return { ids: (d.markets || []).map(m => m.id), groups: d.groups }; });
  ok('the markets API returns gold only', JSON.stringify(api.ids) === '["XAUUSD"]', api);

  await p.evaluate(() => { openMenu(); document.getElementById('menu').scrollTop = 900; });
  await sleep(500);
  await p.screenshot({ path: '/home/user/gold-menu.png' });
  await p.evaluate(() => { closeMenu(); setView('chart'); });
  await sleep(1500);
  await p.screenshot({ path: '/home/user/gold-chart.png' });
  ok('no page errors', errs.length === 0, errs);
  await br.close();
  const failed = res.filter(x => !x).length;
  console.log('\n' + (res.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS FAIL', e.message); process.exit(1); });
