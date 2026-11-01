/* Frame-by-frame timing while panning, with each overlay switched on and off, under 4x CPU throttle. */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function panFrames(p, box, steps = 60) {
  await p.evaluate(() => {
    window.__ft = [];
    let last = performance.now();
    window.__raf = true;
    const tick = () => { const n = performance.now(); window.__ft.push(n - last); last = n; if (window.__raf) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__lt = [];
    try {
      window.__po = new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration))));
      window.__po.observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  });
  const cdp = await p.createCDPSession();
  const y = Math.round(box.y + box.h * 0.45);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.w * 0.75, y }] });
  for (let i = 0; i < steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.w * 0.75 - i * 1.6, y }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const out = await p.evaluate(() => {
    window.__raf = false; try { window.__po && window.__po.disconnect(); } catch (e) {}
    const f = window.__ft.slice(4); f.sort((a, b) => a - b);
    const q = x => +f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1);
    return { frames: f.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), worst: +f[f.length - 1].toFixed(0), over33: f.filter(x => x > 33).length, long: window.__lt };
  });
  await sleep(400);
  return out;
}

(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await br.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.setUserAgent(IPHONE);
  await p.evaluateOnNewDocument(() => sessionStorage.setItem('astra6_unlocked', '1'));
  await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90000 });
  await p.evaluate(() => setView('chart'));
  await sleep(9000);

  const cdp = await p.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const box = await p.evaluate(() => { const r = document.getElementById('oanda_chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

  const env = await p.evaluate(() => ({
    series: (() => { try { return Object.keys(window.paneRef || {}).length; } catch (e) { return -1; } })(),
    indicators: (() => { try { return (IND_LIST || []).filter(i => i.on !== false).length; } catch (e) { return -1; } })(),
    drawings: (() => { try { return (drawings || []).length; } catch (e) { return -1; } })(),
    smc: (() => { try { return Object.keys(SMC).filter(k => SMC[k]); } catch (e) { return []; } })()
  }));
  console.log('environment', JSON.stringify(env));

  console.log('\n--- all overlays on (as shipped) ---');
  console.log(JSON.stringify(await panFrames(p, box)));

  // attribute the cost: switch each layer off in turn
  const cases = [
    ['SMC off', () => { Object.keys(SMC).forEach(k => SMC[k] = false); paintSMC(); }],
    ['drawings off', () => { if (typeof drawHidden !== 'undefined') window.drawHidden = true; try { drawOverlay(); } catch (e) {} }],
    ['volume profile off', () => { window._noVolume = true; }],
  ];
  for (const [label, fn] of cases) {
    await p.evaluate(fn);
    console.log('\n--- ' + label + ' ---');
    console.log(JSON.stringify(await panFrames(p, box)));
  }

  // restore SMC and hide the SVG layers entirely, to see the floor the chart sets
  await p.evaluate(() => { Object.keys(SMC).forEach(k => SMC[k] = true); ['smc-layer', 'zone-layer', 'vwap-layer', 'draw-layer'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; }); });
  console.log('\n--- every SVG overlay hidden (the chart engine alone) ---');
  console.log(JSON.stringify(await panFrames(p, box)));

  console.log('\nerrors', errs);
  await br.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
