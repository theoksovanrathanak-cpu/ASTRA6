/* Time to a usable chart, cold cache, on a 3x phone viewport. */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const run of [1, 2]) {
    const p = await br.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await p.setUserAgent(IPHONE);
    await p.evaluateOnNewDocument(() => {
      sessionStorage.setItem('astra6_unlocked', '1');
      window.__t = {};
      const t0 = performance.now();
      window.__mark = k => { if (!(k in window.__t)) window.__t[k] = Math.round(performance.now() - t0); };
      const obs = new PerformanceObserver(l => l.getEntries().forEach(e => { if (!(e.name in window.__t)) window.__t[e.name] = Math.round(e.startTime); }));
      try { obs.observe({ entryTypes: ['paint', 'largest-contentful-paint'] }); } catch (e) {}
      try { window.__po2 = new PerformanceObserver(l => l.getEntries().forEach(e => window.__t['lcp'] = Math.round(e.startTime))); window.__po2.observe({ entryTypes: ['largest-contentful-paint'] }); } catch (e) {}
    });
    const t0 = Date.now();
    await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 90000 });
    const dcl = Date.now() - t0;
    // a user taps Open chart as soon as the button is there
    await p.waitForSelector('.home-cta', { timeout: 20000 });
    const readyUi = Date.now() - t0;
    await p.click('.home-cta');
    let chartReady = null;
    for (let i = 0; i < 80; i++) {
      const n = await p.evaluate(() => (typeof lastCandles !== 'undefined' ? lastCandles.length : 0));
      if (n > 20) { chartReady = Date.now() - t0; break; }
      await sleep(100);
    }
    const t = await p.evaluate(() => window.__t);
    console.log(`run ${run}: DCL ${dcl}ms · button ready ${readyUi}ms · chart with candles ${chartReady}ms · firstPaint ${t['first-paint']}ms · FCP ${t['first-contentful-paint']}ms · LCP ${t['lcp']}ms`);
    if (errs.length) console.log('  errors', errs);
    await p.close();
  }
  await br.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
