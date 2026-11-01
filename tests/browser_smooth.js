/* Does the chart actually move better? Measured, not assumed.

   Three things are checked against a real running app at a phone viewport:
     1. unlocking the PIN lands on the chart, never on the welcome screen;
     2. a drag across the plot keeps panning and does not drag the page;
     3. a pair switch never paints an empty chart and never shows the old pair's candles.
*/
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || 8017;
const BASE = `http://127.0.0.1:${PORT}`;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const INSTA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 335.0.0.30.97 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 600454229)';

const results = [];
const ok = (name, cond, extra) => { results.push({ name, pass: !!cond, extra }); console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + JSON.stringify(extra))); };

// drive the app's own lock UI instead of forging a hash, so the test walks the path a
// real user walks: create the PIN, lock the phone, unlock it.
async function setPinThroughUi(page, pin = '1234') {
  await page.evaluate(async (pin) => {
    try { typeof endIntro === 'function' && endIntro(); } catch (e) {}
    lkOpen('setup');
    for (const d of pin) lkKey(d);
    await new Promise(r => setTimeout(r, 400));
    for (const d of pin) lkKey(d);
    await new Promise(r => setTimeout(r, 700));
    if (typeof lkUnlock === 'function' && !document.getElementById('lock').hidden) lkUnlock();
    lockNow();
  }, pin);
}

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // ---------------------------------------------------------------- 1. unlock -> chart
  {
    const page = await browser.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setUserAgent(IPHONE);
    await page.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);
    await setPinThroughUi(page);
    await sleep(900);
    const before = await page.evaluate(() => ({
      lock: !document.getElementById('lock').hidden,
      intro: !document.getElementById('intro').classList.contains('gone'),
      view: document.body.getAttribute('data-view')
    }));
    ok('a saved PIN shows the lock, not the welcome', before.lock && !before.intro, before);
    await page.evaluate(() => { lkKey('1'); lkKey('2'); lkKey('3'); lkKey('4'); });
    await sleep(2600);
    const after = await page.evaluate(() => ({
      lock: !document.getElementById('lock').hidden,
      view: document.body.getAttribute('data-view'),
      intro: !document.getElementById('intro').classList.contains('gone'),
      chart: !!chart,
      candles: (lastCandles || []).length,
      lastview: localStorage.getItem('astra6_lastview'),
      viewRaw: localStorage.getItem('astra6_view')
    }));
    ok('the PIN unlocks', !after.lock, after);
    ok('unlocking opens the chart, not the 3D welcome', after.view === 'chart' && !after.intro, after);
    ok('the chart is really built after unlock', after.chart && after.candles > 20, after);
    ok('the screen name is stored apart from the chart options',
      after.lastview === 'chart' && (after.viewRaw === null || /^\{/.test(after.viewRaw)), after);
    ok('no page errors while unlocking', errs.length === 0, errs);
    await page.close();
  }

  // ---------------------------------------------------------------- 2. drag the plot
  {
    const page = await browser.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setUserAgent(IPHONE);
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('astra6_unlocked', '1'));
    await page.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
    await page.evaluate(() => setView('chart'));
    await sleep(9000);

    const box = await page.evaluate(() => { const r = document.getElementById('oanda_chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const range0 = await page.evaluate(() => { const r = chart.timeScale().getVisibleLogicalRange(); return r && { from: r.from, to: r.to }; });
    const scroll0 = await page.evaluate(() => window.scrollY);

    // a real touch drag: 8 moves across the plot
    const cdp = await page.createCDPSession();
    const y = Math.round(box.y + box.h * 0.45);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.w * 0.3, y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.w * 0.3 + i * 12, y }] });
      await sleep(16);
    }
    const during = await page.evaluate(() => ({ gest: !!_gestActive || document.documentElement.classList.contains('is-panning') }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400);

    const range1 = await page.evaluate(() => { const r = chart.timeScale().getVisibleLogicalRange(); return r && { from: r.from, to: r.to }; });
    const scroll1 = await page.evaluate(() => window.scrollY);
    const settled = await page.evaluate(() => ({ gest: document.documentElement.classList.contains('is-panning') }));
    const moved = range0 && range1 ? Math.abs(range1.from - range0.from) : 0;
    ok('a touch drag pans the chart', moved > 0.3, { range0, range1 });
    ok('the drag starts before the page scroll', during.gest, during);
    ok('the page itself does not scroll under the finger', Math.abs(scroll1 - scroll0) < 2, { scroll0, scroll1 });
    ok('the heavy layers resume when the finger lifts', !settled.gest, settled);
    ok('no page errors while panning', errs.length === 0, errs);

    // ------------------------------------------------ 2b. how much work the pan actually does
    // Frame timing in a headless browser is noisy, so the honest metric is work: how many
    // times the SMC boxes, the value-area bands and the drawings are rebuilt during one
    // drag, with the governor and with it disabled.
    async function dragWork(reachable) {
      // A programmatic scroll exercises exactly the same path a finger does (timescale
      // change -> overlay repaint), 60 frames of it, so the work per frame is comparable.
      return page.evaluate(async (on) => {
        window._motionDebug = {};
        window.__gateOff = !on;
        try { SMC.bos = true; SMC.fvg = true; SMC.ob = true; _smcCache = null; paintSMC(); } catch (e) {}
        const ts = chart.timeScale();
        const base = (ts.scrollPosition ? ts.scrollPosition() : 0) - 30;
        motionBegin();
        for (let i = 0; i <= 60; i++) {
          try { ts.scrollToPosition(base + i, false); } catch (e) {}
          await new Promise(r => requestAnimationFrame(r));
        }
        motionEnd();
        await new Promise(r => setTimeout(r, 200));
        const d = window._motionDebug || {};
        window.__gateOff = false; window._motionDebug = null;
        return d;
      }, reachable);
    }
    const gatedRun = await dragWork(true);
    await sleep(500);
    const freeRun = await dragWork(false);
    console.log('with the governor:   ', JSON.stringify(gatedRun));
    console.log('without the governor:', JSON.stringify(freeRun));
    const gS = gatedRun.smcRebuild || 0, fS = freeRun.smcRebuild || 0;
    const gZ = gatedRun.zoneRebuild || 0, fZ = freeRun.zoneRebuild || 0;
    ok('SMC is rebuilt far less often during a pan', fS > gS * 1.5, { gS, fS });
    ok('the value-area bands are rebuilt far less often too', fZ > gZ * 1.5, { gZ, fZ });

    // ------------------------------------------------------------ 3. pair switch
    const timeline = await page.evaluate(async () => {
      const frames = [];
      const t0 = performance.now();
      setSymbol('BTCUSD');
      const tick = () => {
        const c = document.getElementById('swap-cover');
        const n = (lastCandles || []).length;
        frames.push({ t: Math.round(performance.now() - t0), cover: c && c.classList.contains('on'), n });
        if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise(r => setTimeout(r, 6200));
      return { frames, sym: currentSymbol, candles: (lastCandles || []).length };
    });
    const covered = timeline.frames.filter(f => f.cover).length;
    const blankWhileCovered = timeline.frames.filter(f => f.cover && f.n === 0).length;
    const blankUncovered = timeline.frames.filter(f => !f.cover && f.n === 0).length;
    ok('the switch shows a cover instead of a blank chart', covered > 0, { covered, total: timeline.frames.length });
    ok('the old series stays under the cover (nothing flashes empty)', blankWhileCovered === 0, { blankWhileCovered });
    ok('the new pair is drawn after the switch', timeline.sym === 'BTCUSD' && timeline.candles > 20, { sym: timeline.sym, n: timeline.candles });
    ok('the cover is gone once the candles are real', !timeline.frames[timeline.frames.length - 1].cover, timeline.frames.slice(-1)[0]);
    ok('no empty (uncovered) chart at any point', blankUncovered === 0, { blankUncovered });
    await page.screenshot({ path: '/home/user/switch-smooth.png' });

    // a mid-switch frame, to show what the cover actually looks like
    await page.evaluate(() => { setSymbol('ETHUSD'); });
    await sleep(120);
    await page.screenshot({ path: '/home/user/switch-cover.png' });
    await sleep(4000);

    // ---------------------------------------------------- 3b. two switches in quick succession
    const rapid = await page.evaluate(async () => {
      setSymbol('BTCUSD');
      await new Promise(r => setTimeout(r, 180));
      setSymbol('XAUUSD');
      await new Promise(r => setTimeout(r, 7000));
      const c = document.getElementById('swap-cover');
      return { sym: currentSymbol, candles: (lastCandles || []).length, cover: c.classList.contains('on'), key: window._chartKey };
    });
    ok('a second switch during the first still lands on the newest pair', rapid.sym === 'XAUUSD' && rapid.candles > 20, rapid);
    ok('the cover never stays stuck after a rapid switch', !rapid.cover, rapid);
    await page.close();
  }

  // ---------------------------------------------------------------- 4. inside an app browser
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setUserAgent(INSTA);
    await page.evaluateOnNewDocument(() => sessionStorage.setItem('astra6_unlocked', '1'));
    await page.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
    await page.evaluate(() => setView('chart'));
    await sleep(8000);
    const m = await page.evaluate(() => ({
      app: document.documentElement.classList.contains('ua-app'),
      hd: getComputedStyle(document.querySelector('.hd')).backdropFilter || getComputedStyle(document.querySelector('.hd')).webkitBackdropFilter,
      touch: getComputedStyle(document.getElementById('oanda_chart')).touchAction,
      candles: (lastCandles || []).length
    }));
    ok('an in-app browser is detected', m.app, m);
    ok('the costly blur is dropped in the WebView', m.hd === 'none', m);
    ok('the chart owns its gestures', m.touch === 'none', m);
    ok('the chart still draws inside the app browser', m.candles > 20, m);
    await page.screenshot({ path: '/home/user/inapp-browser.png' });
    await page.close();
  }

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('HARNESS FAIL', e.message); process.exit(1); });
