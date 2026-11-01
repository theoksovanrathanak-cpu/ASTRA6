/* While nobody is touching it, is the chart smooth? And how long until it is usable? */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await p.setUserAgent(IPHONE);
  await p.evaluateOnNewDocument(() => {
    sessionStorage.setItem('astra6_unlocked', '1');
    window.__marks = {};
    const t0 = performance.now();
    window.__mark = (k) => { if (!(k in window.__marks)) window.__marks[k] = Math.round(performance.now() - t0); };
  });
  const t0 = Date.now();
  await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  const loadMs = Date.now() - t0;
  await p.evaluate(() => setView('chart'));
  // wait until the chart really has candles
  let ready = null;
  for (let i = 0; i < 60; i++) {
    const n = await p.evaluate(() => (typeof lastCandles !== 'undefined' ? lastCandles.length : 0));
    if (n > 20) { ready = i * 250; break; }
    await sleep(250);
  }
  console.log('DOMContentLoaded in', loadMs, 'ms · first candles after ~' + ready, 'ms');

  await sleep(4000);
  const cdp = await p.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.evaluate(() => {
    window.__ft = []; let last = performance.now(); window.__raf = true;
    const tick = () => { const n = performance.now(); window.__ft.push(n - last); last = n; if (window.__raf) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await sleep(12000);
  const idle = await p.evaluate(() => {
    window.__raf = false;
    const f = window.__ft.slice(3).sort((a, b) => a - b);
    const q = x => +f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1);
    return { frames: f.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), over33: f.filter(v => v > 33).length, over100: f.filter(v => v > 100).length };
  });
  console.log('12 s idle at 4x throttle:', JSON.stringify(idle));

  const counters = await p.evaluate(async () => {
    const c = {}; const wrap = (n) => { const f = window[n]; if (typeof f !== 'function') return; window[n] = function () { c[n] = (c[n] || 0) + 1; return f.apply(this, arguments); }; };
    ['glidePrice', 'updateLegend', 'paintHeaderQuote', 'scheduleZoneDraw', 'drawVolume', 'paintSMC', 'setCandleAge', 'updateTimeSmooth', 'renderMarketSwitch', 'fetchFastPrice', 'paintLivePill'].forEach(wrap);
    await new Promise(r => setTimeout(r, 8000));
    return c;
  });
  console.log('calls in 8 s idle:', JSON.stringify(counters));
  console.log('errors', errs);
  await br.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
