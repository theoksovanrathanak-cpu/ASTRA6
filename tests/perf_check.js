/* Is the app actually cheaper now? Same measurement as the diagnosis, on a 3x viewport. */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function pan(p, box, steps = 55) {
  await p.evaluate(() => {
    window.__ft = []; let last = performance.now(); window.__raf = true;
    const tick = () => { const n = performance.now(); window.__ft.push(n - last); last = n; if (window.__raf) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const cdp = await p.createCDPSession();
  const y = Math.round(box.y + box.h * 0.45);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.w * 0.8, y }] });
  for (let i = 0; i < steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.w * 0.8 - i * 1.7, y }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return p.evaluate(() => {
    window.__raf = false;
    const f = window.__ft.slice(4).sort((a, b) => a - b);
    const q = x => +f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1);
    return { n: f.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +f[f.length - 1].toFixed(0), over33: f.filter(v => v > 33).length };
  });
}

(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await br.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await p.setUserAgent(IPHONE);
  await p.evaluateOnNewDocument(() => sessionStorage.setItem('astra6_unlocked', '1'));
  await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90000 });
  await p.evaluate(() => setView('chart'));
  await sleep(9000);

  const geo = await p.evaluate(() => {
    const cv = document.querySelector('#oanda_chart canvas');
    const r = cv.getBoundingClientRect();
    return { cssW: Math.round(r.width), backingW: cv.width, dpr: window.devicePixelRatio, cssDpr: window.devicePixelRatio };
  });
  console.log('canvas: css ' + geo.cssW + 'px, backing ' + geo.backingW + 'px  (JS dpr ' + geo.dpr + ')');
  const blur = await p.evaluate(() => {
    const sel = ['#chart-toolbar', '#tf-float', '.flow-line', '#bnav'];
    return sel.map(s => { const e = document.querySelector(s); if (!e) return s + ' n/a'; const c = getComputedStyle(e); return s + ' ' + (c.backdropFilter || c.webkitBackdropFilter || 'none'); });
  });
  console.log('blur over the plot:', JSON.stringify(blur));

  const cdp = await p.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  console.log('\n4x throttled drag:', JSON.stringify(await pan(p, await p.evaluate(() => { const r = document.getElementById('oanda_chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }))));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  console.log('unthrottled drag: ', JSON.stringify(await pan(p, await p.evaluate(() => { const r = document.getElementById('oanda_chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }))));

  await p.screenshot({ path: '/home/user/perf-fixed.png' });
  console.log('errors', errs);
  await br.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
