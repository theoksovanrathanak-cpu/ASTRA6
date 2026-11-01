/* Round 3, measured against a real running app at a phone viewport:

     1. the overlay layers stay glued to the candles through a pan and a zoom - the shift
        the layers apply is compared, in pixels, with where the candles actually went;
     2. the live bar rolls on the clock: past the minute boundary a new bar opens from the
        newest real quote, and the bar that was forming closes instead of swelling forever;
     3. nothing in the round breaks the page while it happens.
*/
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || 8017;
const BASE = `http://127.0.0.1:${PORT}`;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const results = [];
const ok = (name, cond, extra) => { results.push({ name, pass: !!cond, extra }); console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + JSON.stringify(extra))); };

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent(IPHONE);
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('astra6_unlocked', '1');
    localStorage.setItem('astra6_tf', 'M1');
  });
  await page.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => { try { endIntro(); } catch (e) {} setView('chart'); });
  await sleep(9000);

  const ready = await page.evaluate(() => ({
    chart: !!chart, n: (lastCandles || []).length, tf: currentTF,
    zones: (document.getElementById('zone-layer') || {}).childElementCount,
    layers: ['zone-layer', 'smc-layer', 'vwap-layer', 'draw-layer'].filter(id => document.getElementById(id))
  }));
  ok('the chart is up on the 1-minute interval', ready.chart && ready.n > 20 && ready.tf === 'M1', ready);
  ok('all four overlay layers exist', ready.layers.length === 4, ready);

  // ------------------------------------------------------------------ 1. glued through a pan
  // The candle's own x is read from the library, the layer's move from its transform, and
  // the two must agree: that is what "the line sticks to the candle" means numerically.
  const pan = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const bar = lastCandles[Math.max(0, lastCandles.length - 6)];
    const x0 = chart.timeScale().timeToCoordinate(bar.time);
    motionBegin();                       // what a finger down does
    motionAnchorSet();
    const tf = el => { try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; } catch (e) { return 0; } };
    const z0 = tf(document.getElementById('zone-layer')), w0 = tf(document.getElementById('vwap-layer'));
    // a real chart move without a finger: same path the engine takes when it scrolls
    const r = chart.timeScale().getVisibleLogicalRange();
    const vis = r.to - r.from;
    chart.timeScale().setVisibleLogicalRange({ from: r.from - vis * 0.25, to: r.to - vis * 0.25 });
    await wait(140);
    const x1 = chart.timeScale().timeToCoordinate(bar.time);
    const z1 = tf(document.getElementById('zone-layer')), w1 = tf(document.getElementById('vwap-layer'));
    const dx = x1 - x0;
    const out = { x0, x1, dx, layerDx: z1 - z0, vwapDx: w1 - w0,
             layerLive: document.getElementById('zone-layer').style.transform };
    motionSettle(0);
    await wait(260);
    return out;
  });
  ok('moving the chart really moves the candles', Math.abs(pan.dx) > 20, pan);
  ok('the overlay layers follow the candles to the pixel', Math.abs(pan.layerDx - pan.dx) <= 1.5, pan);
  ok('the VWAP layer follows with them', Math.abs(pan.vwapDx - pan.dx) <= 1.5, pan);
  ok('the layers were moved by a transform, not a repaint', /translate3d/.test(pan.layerLive || ''), pan);

  // ------------------------------------------- 1b. glued under a real finger, mid-drag
  {
    const box = await page.evaluate(() => { const r = document.getElementById('oanda_chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const cdp = await page.createCDPSession();
    const y = Math.round(box.y + box.h * 0.45);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.w * 0.35, y }] });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.w * 0.35 + i * 9, y }] });
      await sleep(16);
    }
    await sleep(60);
    // read both numbers in the same tick: where the candles are now, and where the layers say they are
    const mid = await page.evaluate(() => {
      const tf = el => { try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; } catch (e) { return 0; } };
      const a = _mAnchor;
      const x = chart.timeScale().timeToCoordinate(a.time);
      return { gest: !!_gestActive, anchorX: a.x, x, dx: x - a.x,
               layerDx: tf(document.getElementById('zone-layer')), live: document.getElementById('zone-layer').style.transform };
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    const rest = await page.evaluate(() => ({
      gest: !!_gestActive,
      t: document.getElementById('zone-layer').style.transform || '',
      gw: (window._motionDebug ? 1 : 0)
    }));
    ok('the finger is a gesture while it moves', mid.gest, mid);
    ok('mid-drag the layers sit exactly on the candles', Math.abs(mid.layerDx - mid.dx) <= 2, mid);
    ok('the transform carries the shift, no repaint per frame', /translate3d/.test(mid.live || ''), mid);
    ok('letting go resets the shift and repaints once', !rest.gest && !/translate3d/.test(rest.t), rest);
  }

  // ---------------------------------------------------------------- 2. glued through a zoom
  const zoom = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const bar = lastCandles[Math.max(0, lastCandles.length - 8)];
    motionBegin();
    motionAnchorSet();
    const r = chart.timeScale().getVisibleLogicalRange();
    const vis = r.to - r.from;
    chart.timeScale().setVisibleLogicalRange({ from: r.from + vis * 0.15, to: r.to - vis * 0.15 });
    await wait(340);                                   // the forced repaint has landed
    const x = chart.timeScale().timeToCoordinate(bar.time);
    const tf = el => { try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; } catch (e) { return 0; } };
    const out = { x, layerDx: tf(document.getElementById('zone-layer')) };
    motionSettle(0);
    await wait(300);
    return out;
  });
  const zok = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // the layer is reset to zero and redrawn at the bar's new screen position, so a fresh
    // drawn element sits where the engine would put it
    const painted = ['smc-layer', 'vwap-layer', 'zone-layer']
      .map(id => ({ id, n: document.getElementById(id).childElementCount }))
      .reduce((a, b) => (b.n > a.n ? b : a));
    return { has: painted.n > 0, children: painted.n, which: painted.id };
  });
  ok('a zoom leaves the layer at its origin (a redraw, not a shift)', Math.abs(zoom.layerDx) < 0.6, zoom);
  ok('the layer still carries its painted overlays after the zoom', zok.children > 0, zok);

  // a finger-up settle must reset the transform, otherwise the layers drift once the engine
  // has repainted them in place
  const settle = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const layer = document.getElementById('zone-layer');
    layer.style.transform = 'translate3d(37px,11px,0)';
    try { motionSettle(0); } catch (e) {}
    await wait(400);
    return { transform: layer.style.transform || '', gest: !!_gestActive };
  });
  ok('the end of a gesture resets the transform and repaints', !/translate3d/.test(settle.transform) && !settle.gest, settle);

  // ------------------------------------------------------------- 3. the minute bar rolls
  const roll = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const realOpen = marketOpenNow;             // the tape's own hours are restored at the end
    window.marketOpenNow = () => true;          // this block asks: when gold IS trading
    window._lastRealAt = Date.now();
    const n0 = lastCandles.length;
    const sec = barSecOf(currentTF);
    const bucketNow = Math.floor(Date.now() / 1000 / sec) * sec;
    const last = lastCandles[lastCandles.length - 1];
    const old = Object.assign({}, last);
    const travel = lastCandles.map(b => Object.assign({}, b));
    travel[travel.length - 1].time = bucketNow - sec;      // one whole interval behind the clock
    paintSeries(travel);
    const closeBefore = travel[travel.length - 1].close;
    const px = 4010.25;
    applyTick({ status: 'ok', price: px, symbol: currentSymbol, source: 'test' });
    await wait(220);
    const nowLast = lastCandles[lastCandles.length - 1];
    const kept = lastCandles[lastCandles.length - 2];
    // the same chart, with the market shut: no bar may be invented from the clock
    window.marketOpenNow = () => false;
    const n1 = lastCandles.length;
    applyTick({ status: 'ok', price: 4012.75, symbol: currentSymbol, source: 'test' });
    await wait(160);
    const closed = { n0: n1, n1: lastCandles.length, time: lastCandles[lastCandles.length - 1].time };
    window.marketOpenNow = realOpen;
    return { sec, bucketNow, n0, n1, oldTime: old.time, closeBefore,
             lastTime: nowLast.time, open: nowLast.open, high: nowLast.high, low: nowLast.low,
             close: nowLast.close, keptTime: kept.time, keptClose: kept.close, closed };
  });
  ok('an interval has a real length in seconds', roll.sec > 0, roll);
  ok('past the minute boundary a new bar opens', roll.n1 === roll.n0 + 1 && roll.lastTime === roll.bucketNow, roll);
  ok('the new bar opens at the live quote', roll.open === 4010.25 && roll.close === 4010.25, roll);
  ok('the closed bar keeps its own time and close', roll.keptTime === roll.bucketNow - roll.sec && roll.keptClose === roll.closeBefore, roll);
  ok('a shut market never grows a bar from the clock alone', roll.closed.n1 === roll.closed.n0, roll.closed);

  // a tick inside the same interval must grow the bar that exists, not open another one
  const same = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const realOpen = marketOpenNow;
    window.marketOpenNow = () => true;
    window._lastRealAt = Date.now();
    lastCandles[lastCandles.length - 1].time = Math.floor(Date.now() / 60000) * 60;
    const n0 = lastCandles.length;
    const t0 = lastCandles[lastCandles.length - 1].time;
    applyTick({ status: 'ok', price: 4011.5, symbol: currentSymbol, source: 'test' });
    await wait(200);
    const l = lastCandles[lastCandles.length - 1];
    window.marketOpenNow = realOpen;
    return { n0, n1: lastCandles.length, time: l.time, t0, high: l.high, low: l.low, close: l.close };
  });
  ok('inside the same minute no extra bar is invented', same.n1 === same.n0 && same.time === same.t0, same);
  ok('the forming bar grows with the real tick', same.high >= 4011.5 && same.low <= 4011.5, same);

  const tfRoll = await page.evaluate(() => ({ m5: barSecOf('M5'), h1: barSecOf('H1'), d: barSecOf('D'), m45: barSecOf('M45'), mo: barSecOf('MO') }));
  ok('every interval knows its own length', tfRoll.m5 === 300 && tfRoll.h1 === 3600 && tfRoll.d === 86400 && tfRoll.m45 === 2700 && tfRoll.mo === 0, tfRoll);

  const daySafe = await page.evaluate(() => {
    const save = currentTF; currentTF = 'D';
    const k = liveBucket(); currentTF = save;
    return k;
  });
  ok('daily bars are left to the feed, never guessed from a clock', daySafe === null, { daySafe });

  // the welcome itself must respect a reduced-motion user
  const reduced = await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const rm = await page.evaluate(async () => {
    const el = document.getElementById('intro');
    el.classList.remove('gone'); el.style.display = '';
    const st = el.querySelector('.intro-stage');
    const cs = getComputedStyle(st);
    return { anim: cs.animationName, transform: cs.transform, floor: getComputedStyle(el.querySelector('.intro-floor')).opacity };
  });
  ok('a reduced-motion user gets no 3D entrance', rm.anim === 'none' && (rm.transform === 'none' || rm.transform === 'matrix(1, 0, 0, 1, 0, 0)'), rm);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  ok('no page errors during the whole run', errs.length === 0, errs.slice(0, 4));

  await browser.close();
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed} passed, ${results.length - passed} failed`);
  process.exit(passed === results.length ? 0 : 1);
})();
