/* Where does the time actually go? CPU profile + task metrics, under 4x throttling. */
const puppeteer = require('/home/user/tools/node_modules/puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8017);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await br.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.setUserAgent(IPHONE);
  await p.evaluateOnNewDocument(() => sessionStorage.setItem('astra6_unlocked', '1'));
  await p.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90000 });
  await p.evaluate(() => setView('chart'));
  await sleep(9000);

  const cdp = await p.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

  const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  await cdp.send('Profiler.start');
  await sleep(10000);                                    // ten seconds of simply being open
  const prof = await cdp.send('Profiler.stop');
  const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

  const d = k => +((m1[k] || 0) - (m0[k] || 0)).toFixed(3);
  console.log('=== 10 s idle, 4x CPU throttling ===');
  console.log('TaskDuration      ', d('TaskDuration'), 's   <- all main-thread work');
  console.log('ScriptDuration    ', d('ScriptDuration'), 's');
  console.log('LayoutDuration    ', d('LayoutDuration'), 's');
  console.log('RecalcStyleDuration', d('RecalcStyleDuration'), 's');
  console.log('TaskOtherDuration ', d('TaskOtherDuration'), 's');
  console.log('Frames            ', Math.round(m1.Frames - m0.Frames));
  console.log('Nodes             ', m1.Nodes, ' LayoutObjects', m1.LayoutObjects, ' JSEventListeners', m1.JSEventListeners);

  // aggregate self time per function
  const nodes = prof.profile.nodes, byId = new Map(nodes.map(n => [n.id, n]));
  const self = new Map();
  const total = prof.profile.endTime - prof.profile.startTime;
  const counts = new Map();
  (prof.profile.samples || []).forEach((id, i) => {
    const t = (prof.profile.timeDeltas || [])[i] || 0;
    const n = byId.get(id); if (!n) return;
    const f = n.callFrame;
    const key = (f.functionName || '(anon)') + ' @' + (f.url || '').split('/').pop() + ':' + f.lineNumber;
    self.set(key, (self.get(key) || 0) + t);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
  console.log('\n=== top self time (ms over ' + (total / 1000).toFixed(1) + 's of profile) ===');
  for (const [k, v] of top) console.log(String((v / 1000).toFixed(0)).padStart(6) + ' ms  ' + k);

  // how often the tick-driven painters actually run
  const counters = await p.evaluate(async () => {
    const c = {};
    const wrap = (obj, name, label) => {
      if (typeof obj[name] !== 'function') return;
      const f = obj[name];
      obj[name] = function () { c[label] = (c[label] || 0) + 1; return f.apply(this, arguments); };
    };
    wrap(window, 'drawVolume', 'drawVolume');
    wrap(window, 'drawZones', 'drawZones');
    wrap(window, 'paintSMC', 'paintSMC');
    wrap(window, 'paintSeries', 'paintSeries');
    wrap(window, 'updateLegend', 'updateLegend');
    wrap(window, 'renderMarketSwitch', 'renderMarketSwitch');
    wrap(window, 'fetchVolume', 'fetchVolume');
    await new Promise(r => setTimeout(r, 6000));
    return c;
  });
  console.log('\n=== calls in 6 s idle ===');
  console.log(JSON.stringify(counters));

  await br.close();
})().catch(e => { console.error('PROFILE FAIL', e.message); process.exit(1); });
