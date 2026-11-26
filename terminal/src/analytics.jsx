/* The readouts around the footprint: the compact sidebar, and the lower analysis row
   (cumulative delta, delta histogram, volume profile).

   Every figure is derived from the payload the engine already computed - sums, extremes
   and ratios over the candles on screen. Nothing is modelled, smoothed or filled in, and
   the estimate badge in the header is never more than a glance away. */

import React, { useEffect, useMemo, useRef, useState } from 'react';

const n0 = (v) => (v == null ? '—' : Number(v).toLocaleString());
const n2 = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
const sg = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toLocaleString());
const cls = (v) => (v > 0 ? 'g' : v < 0 ? 'r' : 'm');

/* ---------------------------------------------------------------- sidebar */

function Row({ k, v, c, mono = true }) {
  return (
    <div className="srow">
      <span className="k">{k}</span>
      <span className={'v ' + (c || '')}>{v}</span>
    </div>
  );
}

export function Sidebar({ data, bars: onScreen }) {
  // the column describes the candles actually drawn in the footprint, not the whole payload
  const bars = (onScreen && onScreen.length ? onScreen : data.bars) || [];
  const d = data.decimals ?? 2;
  const last = bars[bars.length - 1] || {};
  const cvd = data.cvd || [];
  const feed = data.feed || {};
  const prof = data.profile || {};

  const st = useMemo(() => {
    let hi = -Infinity, lo = Infinity, total = 0, bid = 0, ask = 0, pos = 0, neg = 0, flat = 0;
    bars.forEach((b) => {
      hi = Math.max(hi, b.high);
      lo = Math.min(lo, b.low);
      total += b.volume || 0;
      bid += b.sell || 0;
      ask += b.buy || 0;
      flat += b.flat || 0;
      if (b.delta > 0) pos += b.delta; else neg += b.delta;
    });
    const levels = prof.levels || [];
    const maxLevel = levels.reduce((a, r) => Math.max(a, r[4] || 0), 0);
    const concentrated = total > 0 && maxLevel > 0 ? maxLevel / total : 0;
    const marks = ((data.imbalance && data.imbalance.bars) || []);
    const inWindow = marks.filter((m) => bars.some((b) => b.t0 === m.t0));
    const buyMarks = inWindow.reduce((a, m) => a + (m.marks || []).filter((k) => k.side === 'buy').length, 0);
    const sellMarks = inWindow.reduce((a, m) => a + (m.marks || []).filter((k) => k.side === 'sell').length, 0);
    const stacks = inWindow.reduce((a, m) => a + (m.stacks || []).length, 0);
    return { hi, lo, total, bid, ask, pos, neg, flat, concentrated, buyMarks, sellMarks, stacks };
  }, [bars, prof, data.imbalance]);

  const cvdNow = cvd.length ? cvd[cvd.length - 1] : null;
  const state = feed.status === 'quiet' ? 'quiet' : feed.connected ? 'live' : feed.status === 'not_configured' ? 'off' : 'reconnecting';

  return (
    <div className="side">
      <div className="sgrp">
        <div className="sgrp-h" title="The candles drawn in the footprint">Market <span className="tag">{data.symbol || 'XAUUSD'}</span></div>
        <div className="hero">
          <div className="p">{feed.price != null ? n2(feed.price, d) : '—'}</div>
          <div className="sub">
            <i className={'dot ' + (state === 'live' ? 'live' : state === 'off' ? 'bad' : 'warn')} />
            <span>{state}</span>
            <span>·</span>
            <span>{feed.age != null ? feed.age.toFixed(1) + 's ago' : 'no quote'}</span>
          </div>
        </div>
        <Row k="High on screen" v={isFinite(st.hi) ? n2(st.hi, d) : '—'} />
        <Row k="Low on screen" v={isFinite(st.lo) ? n2(st.lo, d) : '—'} />
        <Row k="Quotes on screen" v={n0(st.total + st.flat)} />
        <Row k="Candles" v={n0(bars.length)} />
      </div>

      <div className="sgrp">
        <div className="sgrp-h">Delta <span className="tag">tick rule</span></div>
        <Row k="Last candle" v={sg(last.delta)} c={cls(last.delta)} />
        <Row k="Session" v={sg(data.session && data.session.delta)} c={cls(data.session && data.session.delta)} />
        <Row k="Cumulative (screen)" v={sg(cvdNow)} c={cls(cvdNow)} />
        <Row k="Positive candles" v={'+' + n0(st.pos)} c="g" />
        <Row k="Negative candles" v={n0(st.neg)} c="r" />
      </div>

      <div className="sgrp">
        <div className="sgrp-h">Volume <span className="tag">counted quotes</span></div>
        <Row k="Total" v={n0(st.bid + st.ask)} />
        <Row k="Ask side (bought)" v={n0(st.ask)} c="g" />
        <Row k="Bid side (sold)" v={n0(st.bid)} c="r" />
        <Row k="Repeated price" v={n0(st.flat)} c="m" />
        <Row k="Concentration" v={(st.concentrated * 100).toFixed(1) + '%'} />
      </div>

      <div className="sgrp">
        <div className="sgrp-h">Order flow <span className="tag">{Math.round((data.imbalance && data.imbalance.ratio) * 100 || 0)}%</span></div>
        <Row k="Ask imbalances" v={n0(st.buyMarks)} c="g" />
        <Row k="Bid imbalances" v={n0(st.sellMarks)} c="r" />
        <Row k="Stacked runs" v={n0(st.stacks)} />
        <Row k="Absorption levels" v={n0((data.absorption || []).length)} />
        <Row k="Exhaustion bars" v={n0((data.exhaustion || []).length)} />
      </div>

      <div className="note" style={{ borderTop: '1px solid #1C2531' }}>
        Counting: a quote above the previous price is booked to the ask, below to the bid, equal
        to neither. Exness publishes quotes, not traded size, so every volume here is an estimate
        of pressure — never reported exchange volume.
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- lower panels */

function Mini({ height, draw, deps, label }) {
  const box = useRef(null);
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const m = () => setW(el.clientWidth || 600);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, Math.floor(w * dpr));
    c.height = Math.max(1, Math.floor(height * dpr));
    c.style.height = height + 'px';
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(x, w, height);
  }, [w, height, ...deps]);
  return <div ref={box}><canvas ref={ref} aria-label={label} /></div>;
}

const AXIS = 14;

export function Cvd({ bars, rebase, onRebase }) {
  const series = useMemo(() => {
    let run = 0;
    return bars.map((b) => (run += b.delta || 0));
  }, [bars]);
  const shown = rebase && series.length ? series.map((v) => v - series[0]) : series;
  const last = shown.length ? shown[shown.length - 1] : null;
  const lo = shown.length ? Math.min(...shown) : 0;
  const hi = shown.length ? Math.max(...shown) : 0;

  const draw = (x, W, H) => {
    x.fillStyle = '#0D121A'; x.fillRect(0, 0, W, H);
    const h = H - AXIS;
    const span = (hi - lo) || 1;
    const yOf = (v) => 6 + (1 - (v - lo) / span) * (h - 12);
    const xOf = (i) => (shown.length <= 1 ? W / 2 : (i / (shown.length - 1)) * (W - 4) + 2);

    // zero line, when it is in view
    if (lo <= 0 && hi >= 0) {
      x.strokeStyle = '#202A38'; x.setLineDash([2, 3]);
      x.beginPath(); x.moveTo(0, yOf(0)); x.lineTo(W, yOf(0)); x.stroke(); x.setLineDash([]);
      x.fillStyle = '#273243'; x.font = '9px ui-monospace,Menlo,monospace';
      x.fillText('0', 2, yOf(0) - 3);
    }
    if (!shown.length) {
      x.fillStyle = '#718096'; x.font = '10px ui-monospace,Menlo,monospace';
      x.fillText('no candles yet', 8, h / 2);
      return;
    }
    // area under the line, split at zero so the sign is readable at a glance
    let area = 'rgba(76,141,255,.10)';
    try {
      const grad = x.createLinearGradient(0, 0, 0, h);
      if (grad && grad.addColorStop) {
        grad.addColorStop(0, 'rgba(76,141,255,.18)');
        grad.addColorStop(1, 'rgba(76,141,255,0)');
        area = grad;
      }
    } catch (e) { /* a canvas without gradients still gets a flat wash */ }
    x.beginPath();
    x.moveTo(xOf(0), yOf(shown[0]));
    shown.forEach((v, i) => x.lineTo(xOf(i), yOf(v)));
    x.lineTo(xOf(shown.length - 1), yOf(lo <= 0 && hi >= 0 ? 0 : lo));
    x.lineTo(xOf(0), yOf(lo <= 0 && hi >= 0 ? 0 : lo));
    x.closePath();
    x.fillStyle = area; x.fill();
    // the line
    x.beginPath();
    shown.forEach((v, i) => (i ? x.lineTo(xOf(i), yOf(v)) : x.moveTo(xOf(i), yOf(v))));
    x.strokeStyle = last >= 0 ? '#6598E8' : '#6598E8'; x.lineWidth = 1.4; x.stroke();
    // last point
    x.fillStyle = last >= 0 ? '#6598E8' : '#6598E8';
    x.beginPath(); x.arc(xOf(shown.length - 1), yOf(last), 2, 0, Math.PI * 2); x.fill();
    // range labels
    x.fillStyle = '#718096'; x.font = '9px ui-monospace,Menlo,monospace';
    x.fillText(sg(hi), W - 42, 10);
    x.fillText(sg(lo), W - 42, h - 2);
  };

  return (
    <>
      <div className="p-head">
        Cumulative delta
        <span className="r">
          <span className={cls(last)}>{sg(last)}</span>
          <button className={'tiny' + (rebase ? ' on' : '')} onClick={() => onRebase(!rebase)}
            title="Rebase the line to zero at the first candle on screen">
            {rebase ? 'reset at window start' : 'as recorded'}
          </button>
        </span>
      </div>
      <div className="u-body">
        <Mini height={150} draw={draw} deps={[shown, lo, hi, last]} label="cumulative delta" />
      </div>
      <div className="note">
        Running sum of each candle's ask-minus-bid delta over the candles on screen.
        {rebase ? ' Rebasing to zero at the left edge only changes where the line starts — the shape and the sign of each step are the counted ones.' : ''}
      </div>
    </>
  );
}

export function DeltaHist({ bars }) {
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.delta || 0)));
  const draw = (x, W, H) => {
    x.fillStyle = '#0D121A'; x.fillRect(0, 0, W, H);
    const h = H - AXIS;
    const mid = h / 2;
    x.strokeStyle = '#202A38';
    x.beginPath(); x.moveTo(0, mid + 0.5); x.lineTo(W, mid + 0.5); x.stroke();
    if (!bars.length) {
      x.fillStyle = '#718096'; x.font = '10px ui-monospace,Menlo,monospace';
      x.fillText('no candles yet', 8, mid);
      return;
    }
    const cw = W / bars.length;
    bars.forEach((b, i) => {
      const v = b.delta || 0;
      const bh = (Math.abs(v) / max) * (mid - 4);
      const bx = i * cw + Math.min(2, cw * 0.15);
      const bw = Math.max(1, cw - Math.min(4, cw * 0.3));
      x.fillStyle = v >= 0 ? 'rgba(47,146,104,.85)' : 'rgba(184,73,79,.85)';
      if (v >= 0) x.fillRect(bx, mid - bh, bw, bh);
      else x.fillRect(bx, mid, bw, bh);
    });
    x.fillStyle = '#718096'; x.font = '9px ui-monospace,Menlo,monospace';
    x.fillText('+' + Math.round(max), 3, 10);
    x.fillText('-' + Math.round(max), 3, h - 2);
    x.fillStyle = '#202A38';
    x.fillText('0', W - 10, mid - 3);
  };
  const pos = bars.filter((b) => (b.delta || 0) > 0).length;
  const neg = bars.filter((b) => (b.delta || 0) < 0).length;
  return (
    <>
      <div className="p-head">
        Delta per candle
        <span className="r"><span className="g">{pos} up</span><span className="r">{neg} down</span></span>
      </div>
      <div className="u-body">
        <Mini height={150} draw={draw} deps={[bars, max]} label="delta histogram" />
      </div>
      <div className="note">Ask minus bid, candle by candle. The same number the column header carries.</div>
    </>
  );
}

/* the value area at any percentage the reader picks, grown outwards from the POC */
export function valueArea(levels, pct) {
  if (!levels.length) return { poc: null, vah: null, val: null, inside: new Set() };
  const rows = levels.map((r) => ({ p: r[0], v: r[4] || 0 })).sort((a, b) => b.p - a.p);
  let pocIdx = 0;
  rows.forEach((r, i) => { if (r.v > rows[pocIdx].v) pocIdx = i; });
  const total = rows.reduce((a, r) => a + r.v, 0) || 1;
  const target = total * pct;
  let sum = rows[pocIdx].v;
  let lo = pocIdx, hi = pocIdx;
  while (sum < target && (lo > 0 || hi < rows.length - 1)) {
    const up = lo > 0 ? rows[lo - 1].v : -1;
    const down = hi < rows.length - 1 ? rows[hi + 1].v : -1;
    if (down > up) { hi += 1; sum += rows[hi].v; } else if (up >= 0) { lo -= 1; sum += rows[lo].v; } else break;
  }
  return { poc: rows[pocIdx].p, vah: rows[lo].p, val: rows[hi].p, inside: new Set(rows.slice(lo, hi + 1).map((r) => r.p)) };
}

/* the profile of exactly the candles the two charts are showing, so the POC and the value
   area line up with what is drawn rather than with a range chosen somewhere else */
export function screenProfile(bars) {
  const acc = new Map();
  bars.forEach((b) => {
    (b.levels || []).forEach((r) => {
      const cur = acc.get(r[0]) || [0, 0, 0];
      cur[0] += r[1] || 0;
      cur[1] += r[2] || 0;
      cur[2] += r[3] || 0;
      acc.set(r[0], cur);
    });
  });
  return Array.from(acc.entries())
    .map(([p, v]) => [p, v[0], v[1], v[2], v[0] + v[1] + v[2]])
    .sort((a, b) => b[0] - a[0]);
}

export function Profile({ data, pct, onPct, bars }) {
  const d = data.decimals ?? 2;
  const fromScreen = useMemo(() => (bars && bars.length ? screenProfile(bars) : null), [bars]);
  const prof = fromScreen ? { ...(data.profile || {}), levels: fromScreen } : (data.profile || {});
  const levels = prof.levels || [];
  const va = useMemo(() => valueArea(levels, pct), [levels, pct]);
  const max = Math.max(1, ...levels.map((r) => r[4] || 0));
  const rows = levels.slice().sort((a, b) => b[0] - a[0]);
  const hvn = prof.hvn || [];
  const lvn = prof.lvn || [];

  return (
    <>
      <div className="p-head">
        Volume profile
        <span className="m" style={{ fontSize: 9.5 }}>{fromScreen ? 'on screen' : 'toolbar range'}</span>
        <span className="r">
          <button className="tiny" onClick={() => onPct(Math.max(50, pct - 5))} aria-label="smaller value area">−</button>
          <span>{Math.round(pct * 100)}% VA</span>
          <button className="tiny" onClick={() => onPct(Math.min(95, pct + 5))} aria-label="larger value area">+</button>
        </span>
      </div>
      {rows.length ? (
        <>
          <div className="pfl">
            {rows.map((r) => {
              const inside = va.inside.has(r[0]);
              const isPoc = r[0] === va.poc;
              return (
                <div key={r[0]} className={'pfr' + (isPoc ? ' poc' : inside ? ' va' : '')}>
                  <span className="pp">{n2(r[0], d)}</span>
                  <span className="bar"><i style={{ width: Math.max(2, Math.round(((r[4] || 0) / max) * 100)) + '%' }} /></span>
                  <span className="pv">{n0(r[4])}</span>
                </div>
              );
            })}
          </div>
          <div className="chips">
            <span className="chip zone">POC {n2(va.poc, d)}</span>
            <span className="chip">VAH {n2(va.vah, d)}</span>
            <span className="chip">VAL {n2(va.val, d)}</span>
            {hvn.slice(0, 2).map((p, i) => <span key={'h' + i} className="chip zone">HVN {n2(p, d)}</span>)}
            {lvn.slice(0, 2).map((p, i) => <span key={'l' + i} className="chip">LVN {n2(p, d)}</span>)}
          </div>
        </>
      ) : (
        <div className="note" style={{ padding: '14px 8px' }}>
          No profile yet — it is built from the quotes this account has received.
        </div>
      )}
      <div className="note">
        Counted quotes per price over the {fromScreen ? 'candles on screen' : 'range in the toolbar'} —
        the same window the two charts above are drawing. The value area is grown outwards from the
        POC to the percentage above; it is recalculated in the browser from the level totals, so
        changing it changes nothing but the two lines.
      </div>
    </>
  );
}

export function Under({ data, view, opts }) {
  const bars = (data && data.bars) || [];
  const slice = view && view.n ? bars.slice(view.start, view.start + view.n) : bars;
  return (
    <div className="under">
      <div className="panel">
        <Cvd bars={slice} rebase={opts.cvdRebase} onRebase={opts.onCvdRebase} />
      </div>
      <div className="panel">
        <DeltaHist bars={slice} />
      </div>
      <div className="panel">
        <Profile data={data || {}} pct={opts.vaPct} onPct={opts.onVaPct} />
      </div>
    </div>
  );
}
