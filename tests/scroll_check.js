/* The rest of the surface: the drawer, the sheet and page scrolling, at 4x throttle. */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function framesWhile(p, fn, ms = 2500) {
  await p.evaluate(() => { window.__ft = []; let l = performance.now(); window.__raf = true; const t = () => { const n = performance.now(); window.__ft.push(n - l); l = n; if (window.__raf) requestAnimationFrame(t); }; requestAnimationFrame(t); });
  await fn();
  await sleep(200);
  return p.evaluate(() => {
    window.__raf = false;
    const f = window.__ft.slice(3).sort((a, b) => a - b);
    const q = x => +f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1);
    return { n: f.length, p50: q(0.5), p90: q(0.9), over33: f.filter(v => v > 33).length };
  });
}

(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await p.setUserAgent(IPHONE);
  await p.evaluateOnNewDocument(() => sessionStorage.setItem('astra6_unlocked', '1'));
  await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(1500);
  const cdp = await p.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  // the drawer, opened and scrolled
  console.log('drawer open+scroll:', JSON.stringify(await framesWhile(p, async () => {
    await p.evaluate(() => openMenu());
    await sleep(400);
    await p.evaluate(async () => {
      const m = document.getElementById('menu');
      for (let i = 0; i < 24; i++) { m.scrollTop += 40; await new Promise(r => requestAnimationFrame(r)); }
    });
  })));

  // a sheet with a long list
  console.log('order-flow sheet scroll:', JSON.stringify(await framesWhile(p, async () => {
    await p.evaluate(() => { closeMenu(); setView('chart'); });
    await sleep(2500);
    await p.evaluate(() => openOrderFlow());
    await sleep(400);
    await p.evaluate(async () => { const b = document.getElementById('sheet-body'); for (let i = 0; i < 24; i++) { b.scrollTop += 40; await new Promise(r => requestAnimationFrame(r)); } });
  })));

  // the whole page, on the home screen
  console.log('page scroll:', JSON.stringify(await framesWhile(p, async () => {
    await p.evaluate(() => { closeSheet(); setView('home'); });
    await sleep(500);
    await p.evaluate(async () => { for (let i = 0; i < 24; i++) { window.scrollBy(0, 40); await new Promise(r => requestAnimationFrame(r)); } });
  })));

  console.log('errors', errs);
  await br.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
