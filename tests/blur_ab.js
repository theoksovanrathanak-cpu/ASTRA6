/* The decisive experiment: is the lag the blur on top of a repainting canvas? */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function pan(p, box, dpr3) {
  await p.evaluate(() => {
    window.__ft = []; let last = performance.now(); window.__raf = true;
    const tick = () => { const n = performance.now(); window.__ft.push(n - last); last = n; if (window.__raf) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const cdp = await p.createCDPSession();
  const y = Math.round(box.y + box.h * 0.45);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.w * 0.8, y }] });
  for (let i = 0; i < 55; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.w * 0.8 - i * 1.7, y }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const o = await p.evaluate(() => {
    window.__raf = false;
    const f = window.__ft.slice(4).sort((a, b) => a - b);
    const q = x => +f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1);
    return { n: f.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +f[f.length - 1].toFixed(0), over33: f.filter(v => v > 33).length };
  });
  await sleep(500);
  return o;
}

(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  async function open(dpr3) {
    const p = await br.newPage();
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: dpr3 ? 3 : 2, isMobile: true, hasTouch: true });
    await p.setUserAgent(IPHONE);
    await p.evaluateOnNewDocument(() => sessionStorage.setItem('astra6_unlocked', '1'));
    await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90000 });
    await p.evaluate(() => setView('chart'));
    await sleep(9000);
    const cdp = await p.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const box = await p.evaluate(() => { const r = document.getElementById('oanda_chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const dpr = await p.evaluate(() => window.devicePixelRatio);
    return { p, box, dpr };
  }

  // A. as shipped
  let s = await open(false);
  console.log('DPR ' + s.dpr + '  as shipped          ', JSON.stringify(await pan(s.p, s.box)));

  // B. blur removed
  await s.p.addStyleTag({ content: '*,*::before,*::after{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}' });
  await sleep(600);
  console.log('DPR ' + s.dpr + '  no backdrop-filter ', JSON.stringify(await pan(s.p, s.box)));

  // C. blur back, canvas pixel density capped at 2
  await s.p.evaluate(() => { document.querySelectorAll('style[data-inj]').forEach(e => e.remove()); });
  await s.p.close();

  s = await open(true);   // a 3x-DPR phone
  console.log('DPR ' + s.dpr + '  as shipped          ', JSON.stringify(await pan(s.p, s.box)));
  await s.p.addStyleTag({ content: '*,*::before,*::after{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}' });
  await sleep(600);
  console.log('DPR ' + s.dpr + '  no backdrop-filter ', JSON.stringify(await pan(s.p, s.box)));
  await s.p.close();

  // D. what does the browser actually say it is spending? (no throttle this time)
  s = await open(true);
  const cdp = await s.p.createCDPSession();
  await cdp.send('Performance.enable');
  const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  await pan(s.p, s.box);
  const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const d = k => +((m1[k] || 0) - (m0[k] || 0)).toFixed(3);
  console.log('inside one pan: script', d('ScriptDuration'), 'style', d('RecalcStyleDuration'), 'layout', d('LayoutDuration'), 'other', d('TaskOtherDuration'), 'frames', Math.round(m1.Frames - m0.Frames));
  await s.p.close();

  await br.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
