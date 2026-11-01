/* CPU profile of the drag itself, to see what is left. */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await p.setUserAgent(IPHONE);
  await p.evaluateOnNewDocument(() => sessionStorage.setItem('astra6_unlocked', '1'));
  await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90000 });
  await p.evaluate(() => setView('chart'));
  await sleep(9000);
  const box = await p.evaluate(() => { const r = document.getElementById('oanda_chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const cdp = await p.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 150 });
  await cdp.send('Profiler.start');
  const y = Math.round(box.y + box.h * 0.45);
  const c2 = await p.createCDPSession();
  await c2.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.w * 0.8, y }] });
  for (let i = 0; i < 60; i++) { await c2.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.w * 0.8 - i * 1.7, y }] }); await sleep(16); }
  await c2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const prof = await cdp.send('Profiler.stop');
  const byId = new Map(prof.profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  (prof.profile.samples || []).forEach((id, i) => {
    const t = (prof.profile.timeDeltas || [])[i] || 0;
    const n = byId.get(id); if (!n) return;
    const f = n.callFrame;
    const k = (f.functionName || '(anon)') + ' @' + (f.url || '').split('/').pop().split('?')[0] + ':' + f.lineNumber;
    self.set(k, (self.get(k) || 0) + t);
  });
  const tot = [...self.values()].reduce((a, b) => a + b, 0);
  console.log('total sampled', (tot / 1000).toFixed(0), 'ms');
  [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([k, v]) => console.log(String((v / 1000).toFixed(0)).padStart(5) + ' ms  ' + k));
  await br.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
