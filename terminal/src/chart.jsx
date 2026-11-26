/* The footprint canvas.

   Columns are candles, rows are price levels. Inside a cell the bid side sits on the left
   and the ask side on the right, which is the bid | ask split the desk reads: a quote that
   ticked down is booked at the bid, a quote that ticked up at the ask. Six display modes
   read the same cells a different way; nothing is recomputed here beyond a subtraction the
   server already publishes per level, so what is on screen is what the engine counted.

   Everything is drawn from the payload: the renderer never invents a level, a volume or a
   price. Levels with no trade at all are simply absent, and repeated quotes are drawn as a
   dim count rather than a fake 0 x 0. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const HEAD_H = 22;      // column header: delta per candle
const AXIS_H = 18;      // time axis
const GUTTER = 76;      // price column on the right
const PAD_L = 4;
const MIN_BARW = 36;
const MAX_BARW = 132;

export const MODES = [
  ['bidask', 'Bid × Ask'],
  ['delta', 'Delta'],
  ['volume', 'Volume'],
  ['imbalance', 'Imbalance'],
  ['bid', 'Bid volume'],
  ['ask', 'Ask volume'],
];

export const MODE_HINT = {
  bidask: 'Bid volume (quotes that ticked down) on the left of each level, ask volume (ticked up) on the right.',
  delta: 'Ask volume minus bid volume at each price. Green means buyers lifted more quotes there.',
  volume: 'Every counted quote at that price, both sides, with the intensity of the level behind it.',
  imbalance: 'Only the levels the server flagged: one side at least the ratio above the level beside it.',
  bid: 'Bid volume only: quotes that printed lower than the one before them.',
  ask: 'Ask volume only: quotes that printed higher than the one before them.',
};

const fmtV = (v, mode) => {
  if (mode === 'hidden' || v == null) return '';
  const n = Number(v);
  if (mode === 'compact') {
    if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(2) + 'k';
    return String(Math.round(n));
  }
  return n % 1 === 0 ? String(n) : n.toFixed(1);
};
const sgn = (v) => (v > 0 ? '+' : '') + v;

function geomOf(data, W, H, S) {
  const bars = (data && data.bars) || [];
  const { barW, hoff, pan, rowH } = S;
  const plotW = Math.max(60, W - GUTTER - PAD_L);
  const n = Math.max(1, Math.min(bars.length || 1, Math.floor(plotW / barW)));
  const maxStart = Math.max(0, bars.length - n);
  const start = Math.max(0, Math.min(maxStart, maxStart - (hoff || 0)));
  const view = bars.slice(start, start + Math.max(1, n));
  const step = (data && data.step) || 0.01;
  let top = -Infinity, bottom = Infinity;
  view.forEach((b) => (b.levels || []).forEach((r) => {
    if (r[0] > top) top = r[0];
    if (r[0] < bottom) bottom = r[0];
  }));
  if (!isFinite(top)) { top = 0; bottom = 0; }
  const allRows = Math.max(1, Math.round((top - bottom) / step) + 1);
  const plotH = Math.max(80, H - HEAD_H - AXIS_H);
  const rows = Math.max(4, Math.min(allRows, Math.floor(plotH / rowH)));
  const maxOff = Math.max(0, allRows - rows);
  const off = Math.max(0, Math.min(maxOff, Math.round(pan || 0)));
  // a short price range would leave a dead band under the tape: scale the rows up a little
  // and centre them, so the chart always uses the height it was given
  let rh = rowH;
  let pad = 0;
  if (allRows <= rows && allRows * rowH < plotH) {
    rh = Math.min(rowH * 2, plotH / allRows);
    pad = Math.max(0, (plotH - allRows * rh) / 2);
  }
  return { view, start, n, barW, plotW, plotH, rows, allRows, off, top, step, rowH, maxOff,
    rh: Math.max(11, rh), y0: HEAD_H + Math.round(pad) };
}

export default function Footprint({ data, opts, onView, full, onFull }) {
  const box = useRef(null);
  const cvs = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 460 });
  const [barW, setBarW] = useState(58);
  const [hoff, setHoff] = useState(0);
  const [pan, setPan] = useState(0);
  const [hover, setHover] = useState(null);
  const gesture = useRef(null);

  const { mode, fmt, filter, intensity, rowH } = opts;

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: el.clientWidth || 900, h: el.clientHeight || 460 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const S = { barW, hoff, pan, rowH };
  const geom = useMemo(
    () => geomOf(data, size.w, size.h, S),
    [data, size.w, size.h, barW, hoff, pan, rowH],
  );

  // the lower charts read the same window as the footprint
  useEffect(() => {
    if (onView) onView({ start: geom.start, n: geom.n, barW: geom.barW });
  }, [geom.start, geom.n, geom.barW, onView]);

  useEffect(() => {
    const c = cvs.current;
    if (!c || !data || !data.bars || !data.bars.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = size.w, H = size.h;
    c.width = Math.max(1, Math.floor(W * dpr));
    c.height = Math.max(1, Math.floor(H * dpr));
    c.style.height = H + 'px';
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(x, W, H, data, geom, { mode, fmt, filter: filter || 0, intensity: intensity || 1, rowH }, hover);
  }, [size, data, geom, mode, fmt, filter, intensity, rowH, hover]);

  const hit = useCallback((px, py) => {
    if (!data || !geom.view.length) return null;
    const col = Math.floor((px - PAD_L) / geom.barW);
    if (col < 0 || col >= geom.view.length) return null;
    const b = geom.view[col];
    const row = Math.floor((py - geom.y0) / geom.rh) - geom.off;
    if (row < 0 || row >= geom.rows) return { kind: 'bar', b };
    const price = geom.top - row * geom.step;
    const cell = (b.levels || []).find((r) => Math.abs(r[0] - price) < 1e-6);
    return { kind: 'cell', b, price, cell, col, row };
  }, [data, geom]);

  const onWheel = (e) => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
      setHoff((h) => Math.max(0, h + (d > 0 ? 1 : -1) * 2));
      return;
    }
    setBarW((w) => Math.max(MIN_BARW, Math.min(MAX_BARW, w + (e.deltaY > 0 ? -5 : 5))));
  };

  const onDown = (e) => {
    const el = cvs.current;
    if (!el) return;
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const p = (gesture.current && gesture.current.points) || new Map();
    p.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    gesture.current = {
      points: p,
      barW, hoff, pan,
      x0: e.clientX, y0: e.clientY,
      dist: p.size === 2 ? dist(p) : 0,
    };
  };

  const onMove = (e) => {
    const el = cvs.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const g = gesture.current;
    if (g && g.points && g.points.has(e.pointerId)) {
      g.points.set(e.pointerId, { x: px, y: py });
      if (g.points.size >= 2) {
        const d = dist(g.points);
        if (g.dist > 0) {
          setBarW(Math.max(MIN_BARW, Math.min(MAX_BARW, Math.round(g.barW * (d / g.dist)))));
        }
        return;
      }
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (Math.abs(dx) > 2) setHoff(Math.max(0, g.hoff - Math.round(dx / Math.max(20, g.barW))));
      if (Math.abs(dy) > 1) setPan(g.pan + Math.round(dy / (opts.rowH || 14)));
      setHover(null);
      return;
    }
    setHover({ ...hit(px, py), x: px, y: py });
  };

  const onUp = (e) => {
    if (gesture.current && gesture.current.points) gesture.current.points.delete(e.pointerId);
    if (!gesture.current || !gesture.current.points || gesture.current.points.size === 0) gesture.current = null;
  };

  const hasBars = !!(data && data.bars && data.bars.length);
  const tip = hasBars && hover && (hover.kind === 'cell' ? cellTip(hover, data, fmt) : barTip(hover, data, fmt));
  // the wrapper is always mounted, so the resize observer measures the real box even when
  // the first thing on screen is the empty state (the old version attached it to a node
  // that did not exist yet and never learned the chart's size)
  return (
    <div ref={box} className="chartwrap" style={full ? { position: 'fixed', inset: 0, zIndex: 60, background: '#05080c' } : null}>
      {hasBars ? (
        <canvas
          ref={cvs}
          onWheel={onWheel}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => { setHover(null); gesture.current = null; }}
          onDoubleClick={() => { setBarW(58); setHoff(0); setPan(0); }}
          style={{ cursor: gesture.current ? 'grabbing' : 'crosshair' }}
        />
      ) : (
        <Empty data={data} onUse247={opts.onUse247} />
      )}
      {full ? (
        <button
          className="mbtn2"
          onClick={() => onFull && onFull(false)}
          style={{ position: 'absolute', right: 10, top: 8, width: 'auto', padding: '5px 10px', zIndex: 8,
            background: '#0b121acc', border: '1px solid #28323d' }}
          title="Leave full screen (Esc)"
        >
          exit full screen
        </button>
      ) : null}
      {tip ? (
        <div className="tip" style={{
          left: Math.min(Math.max(8, (hover.x || 0) + 14), Math.max(8, size.w - 214)),
          top: Math.min(Math.max(8, (hover.y || 0) + 12), Math.max(8, size.h - 96)),
        }} dangerouslySetInnerHTML={{ __html: tip }} />
      ) : null}
    </div>
  );
}

function dist(points) {
  const [a, b] = [...points.values()];
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
}

function cellTip(h, data, fmtMode) {
  const d = data.decimals ?? 2;
  const c = h.cell;
  const buy = c ? c[1] : 0, sell = c ? c[2] : 0, flat = (c && c[3]) || 0;
  const marks = (data.imbalance && data.imbalance.bars) || [];
  const bar = marks.find((m) => m.t0 === h.b.t0);
  const mark = bar && (bar.marks || []).find((m) => Math.abs(m.price - h.price) < 1e-6);
  const rows = [
    `<div class="row"><span class="t">${h.price.toFixed(d)}</span><span class="m">${clock(h.b.t0, data.tf)}</span></div>`,
    `<div class="row"><span class="g">ask ${fmtV(buy, 'plain')}</span><span class="r">bid ${fmtV(sell, 'plain')}</span></div>`,
  ];
  if (flat) rows.push(`<div class="row"><span class="m">repeated</span><span class="m">${flat} quote(s)</span></div>`);
  const total = buy + sell;
  rows.push(`<div class="row"><span class="m">delta</span><span class="${buy - sell >= 0 ? 'g' : 'r'}">${sgn(buy - sell)} of ${total}</span></div>`);
  if (mark) rows.push(`<div class="row"><span class="a">${mark.side === 'buy' ? 'ask' : 'bid'} imbalance</span><span class="a">${Math.round(mark.ratio * 100)}%</span></div>`);
  return rows.join('');
}

function barTip(h, data, fmtMode) {
  const d = data.decimals ?? 2;
  const b = h.b;
  return [
    `<div class="row"><span class="t">${clock(b.t0, data.tf)}</span><span class="m">${(b.ticks || 0)} quotes</span></div>`,
    `<div class="row"><span class="m">delta</span><span class="${b.delta >= 0 ? 'g' : 'r'}">${sgn(b.delta)}</span></div>`,
    `<div class="row"><span class="m">bid / ask</span><span>${fmtV(b.sell, 'plain')} / ${fmtV(b.buy, 'plain')}</span></div>`,
    `<div class="row"><span class="m">high / low</span><span>${b.high.toFixed(d)} / ${b.low.toFixed(d)}</span></div>`,
  ].join('');
}

function clock(ts, tf) {
  const d = new Date(ts * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return tf < 60 ? hh + ':' + mm + ':' + String(d.getUTCSeconds()).padStart(2, '0') : hh + ':' + mm;
}

/* ---------------------------------------------------------------- the drawing */

function draw(x, W, H, data, g, o, hover) {
  const { mode, fmt, filter, intensity } = o;
  const rowH = g.rh;
  const d = data.decimals ?? 2;
  const right = W - GUTTER;
  const y0 = g.y0;
  const yEnd = y0 + g.rows * rowH;
  const live = data.feed && data.feed.price;
  const prof = data.profile || {};

  x.fillStyle = '#05080c';
  x.fillRect(0, 0, W, H);

  // ---- rows
  for (let i = 0; i < g.rows; i += 1) {
    const y = y0 + i * rowH;
    if (i % 2 === 0) {
      x.fillStyle = 'rgba(255,255,255,.012)';
      x.fillRect(0, y, right, rowH);
    }
    x.strokeStyle = '#080d13';
    x.beginPath(); x.moveTo(0, y + 0.5); x.lineTo(right, y + 0.5); x.stroke();
  }

  // ---- value area band + POC / VAH / VAL
  const rowOf = (price) => Math.round((g.top - price) / g.step) - g.off;
  const pocRow = prof.poc != null ? rowOf(prof.poc) : null;
  const vahRow = prof.vah != null ? rowOf(prof.vah) : null;
  const valRow = prof.val != null ? rowOf(prof.val) : null;
  if (vahRow != null && valRow != null) {
    const t = Math.max(y0, y0 + Math.min(vahRow, valRow) * rowH);
    const b = Math.min(yEnd, y0 + Math.max(vahRow, valRow) * rowH + rowH);
    if (b > t) { x.fillStyle = 'rgba(59,106,155,.07)'; x.fillRect(0, t, right, b - t); }
  }

  // ---- cells
  const marksBy = {};
  ((data.imbalance && data.imbalance.bars) || []).forEach((m) => { marksBy[m.t0] = m.marks || []; });

  let maxTotal = 1;
  g.view.forEach((b) => (b.levels || []).forEach((r) => {
    const t = (r[1] || 0) + (r[2] || 0) + (r[3] || 0);
    if (t > maxTotal) maxTotal = t;
  }));

  x.textBaseline = 'middle';
  const fs = rowH >= 17 ? 10.5 : rowH >= 15 ? 10 : 9.5;
  const font = (w) => `${w} ${fs}px ${'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'}`;

  g.view.forEach((b, ci) => {
    const bx = PAD_L + ci * g.barW;
    const cw = g.barW - 1;
    const cx = bx + cw / 2;
    const marks = marksBy[b.t0] || [];

    // column tint behind everything, so candles are separable at a glance
    if (ci % 2 === 0) { x.fillStyle = 'rgba(255,255,255,.008)'; x.fillRect(bx, y0, cw, yEnd - y0); }
    x.strokeStyle = '#0a1017';
    x.beginPath(); x.moveTo(bx + 0.5, y0); x.lineTo(bx + 0.5, yEnd); x.stroke();

    (b.levels || []).forEach((r) => {
      const [price, buy, sell, flat] = r;
      const row = Math.round((g.top - price) / g.step) - g.off;
      if (row < 0 || row >= g.rows) return;
      const y = y0 + row * rowH;
      const total = (buy || 0) + (sell || 0) + (flat || 0);
      if (filter && total < filter) return;

      const mark = marks.find((m) => Math.abs(m.price - price) < 1e-6);
      const heat = Math.min(1, total / maxTotal) * 0.34 * (intensity || 1);
      const up = (buy || 0) > (sell || 0);
      const down = (sell || 0) > (buy || 0);

      if (mode === 'imbalance' && !mark) {
        x.fillStyle = 'rgba(255,255,255,' + (heat * 0.25).toFixed(3) + ')';
        if (heat > 0.02) x.fillRect(bx + 1, y + 1, cw - 1, rowH - 1);
        return;
      }

      if (mark) {
        x.fillStyle = mark.side === 'buy' ? 'rgba(47,146,104,.20)' : 'rgba(184,73,79,.20)';
        x.fillRect(bx + 1, y, cw - 1, rowH - 1);
        x.fillStyle = mark.side === 'buy' ? '#2f9268' : '#b8494f';
        x.fillRect(mark.side === 'buy' ? bx + 1 : bx + cw - 2, y, 2, rowH - 1);
      } else if (heat > 0.01) {
        const col = up ? '47,146,104' : down ? '184,73,79' : '120,134,152';
        x.fillStyle = 'rgba(' + col + ',' + heat.toFixed(3) + ')';
        x.fillRect(bx + 1, y, cw - 1, rowH - 1);
      }

      const cellY = y + rowH / 2;
      x.font = font(600);

      if (mode === 'bidask') {
        // A quote that repeated the last price votes for neither side. A dim count says the
        // level was active and none of it was directional - never a fake 0 x 0.
        if ((buy || 0) + (sell || 0) === 0 && flat) {
          x.textAlign = 'center';
          x.fillStyle = '#5c6d80';
          x.fillText('·' + fmtV(flat, fmt), cx, cellY);
          return;
        }
        const left = fmtV(sell, fmt);       // bid volume
        const right2 = fmtV(buy, fmt);      // ask volume
        if (!left && !right2) return;
        const room = cw - 6;
        const both = x.measureText(left + ' ' + right2).width;
        if (both <= room) {
          // a side that saw nothing is left blank rather than printed as 0: the empty half
          // is the cue, and it keeps the eye on the numbers that mean something
          if (Number(sell) !== 0) {
            x.textAlign = 'right';
            x.fillStyle = down ? '#e0757d' : '#b3606a';
            x.fillText(left, cx - 3, cellY);
          }
          if (Number(buy) !== 0) {
            x.textAlign = 'left';
            x.fillStyle = up ? '#57c795' : '#57ae86';
            x.fillText(right2, cx + 3, cellY);
          }
          x.strokeStyle = '#111a24';
          x.beginPath(); x.moveTo(cx + 0.5, y + 2); x.lineTo(cx + 0.5, y + rowH - 2); x.stroke();
        } else {
          // too narrow for two numbers: the one that carries the level, never an overlap
          x.textAlign = 'center';
          const net = (buy || 0) - (sell || 0);
          const label = fmtV(total, fmt);
          x.fillStyle = net > 0 ? '#57c795' : net < 0 ? '#e0757d' : '#8b9aad';
          x.fillText(label, cx, cellY);
        }
        return;
      }

      let label = '';
      let color = '#8b9aad';
      if (mode === 'delta') {
        const net = (buy || 0) - (sell || 0);
        if (!net) { x.fillStyle = '#3f4a58'; x.textAlign = 'center'; x.fillText('·', cx, cellY); return; }
        label = fmt === 'hidden' ? '' : sgn(net);
        color = net > 0 ? '#57c795' : '#e0757d';
      } else if (mode === 'volume') {
        label = fmtV(total, fmt);
        color = '#9aabbd';
      } else if (mode === 'bid') {
        label = fmtV(sell, fmt);
        color = down ? '#e0757d' : '#a2575c';
      } else if (mode === 'ask') {
        label = fmtV(buy, fmt);
        color = up ? '#57c795' : '#4f9e7c';
      } else if (mode === 'imbalance') {
        if (!mark) return;
        label = Math.round(mark.ratio * 100) + '%';
        color = mark.side === 'buy' ? '#7fe0b4' : '#ff9aa2';
      }
      if (!label) return;
      x.textAlign = 'center';
      x.fillStyle = color;
      if (x.measureText(label).width > cw - 6) {
        x.font = font(500);
        if (x.measureText(label).width > cw - 6) return;   // drop rather than overlap
      }
      x.fillText(label, cx, cellY);
    });
  });

  // ---- column headers: delta per candle
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  g.view.forEach((b, ci) => {
    const bx = PAD_L + ci * g.barW;
    x.fillStyle = b.delta === 0 ? '#39424f' : b.delta > 0 ? '#3f9c74' : '#b8565c';
    x.font = '600 9.5px ui-monospace,SFMono-Regular,Menlo,monospace';
    const label = (b.delta >= 0 ? '+' : '') + fmtV(b.delta, fmt === 'hidden' ? 'plain' : fmt);
    if (x.measureText(label).width <= g.barW - 6) x.fillText(label, bx + (g.barW - 1) / 2, y0 - 8);
  });

  // ---- price gutter
  x.textAlign = 'left';
  x.font = '500 9.5px ui-monospace,SFMono-Regular,Menlo,monospace';
  const every = Math.max(1, Math.ceil(17 / rowH));
  for (let i = 0; i < g.rows; i += every) {
    const price = g.top - (i + g.off) * g.step;
    const y = y0 + i * rowH + rowH / 2;
    x.fillStyle = '#66748a';
    x.fillText(price.toFixed(d), W - GUTTER + 9, y);
    x.strokeStyle = '#0b1118';
    x.beginPath(); x.moveTo(W - GUTTER, y + 0.5); x.lineTo(W - GUTTER + 5, y + 0.5); x.stroke();
  }

  // POC / VAH / VAL lines across the tape
  const line = (price, color, dash, name) => {
    const row = rowOf(price);
    if (row < 0 || row >= g.rows) return;
    const y = y0 + row * rowH + rowH / 2;
    x.strokeStyle = color; x.lineWidth = 1; x.setLineDash(dash);
    x.beginPath(); x.moveTo(0, y + 0.5); x.lineTo(right, y + 0.5); x.stroke();
    x.setLineDash([]);
    // the tag replaces the price tick on that row, so the two never print on top of each other
    x.fillStyle = '#05080c';
    x.fillRect(W - GUTTER, y - 7, GUTTER, 14);
    x.fillStyle = color;
    x.font = '700 8.5px ui-monospace,Menlo,monospace';
    x.fillText(name + ' ' + price.toFixed(d), W - GUTTER + 5, y);
  };
  if (prof.val != null) line(prof.val, '#3b6a9b', [3, 3], 'VAL');
  if (prof.vah != null) line(prof.vah, '#3b6a9b', [3, 3], 'VAH');
  if (prof.poc != null) line(prof.poc, '#cfa23a', [], 'POC');

  // ---- current price
  if (live != null) {
    const row = (g.top - live) / g.step - g.off;
    const y = y0 + row * rowH + rowH / 2;
    if (y > y0 && y < yEnd) {
      x.strokeStyle = '#dfe7f1'; x.lineWidth = 1; x.setLineDash([2, 3]);
      x.beginPath(); x.moveTo(0, y); x.lineTo(right, y); x.stroke();
      x.setLineDash([]);
      x.fillStyle = '#dfe7f1';
      x.fillRect(right, y - 8, GUTTER, 16);
      x.fillStyle = '#05080c';
      x.font = '700 10px ui-monospace,SFMono-Regular,Menlo,monospace';
      x.fillText(live.toFixed(d), right + 6, y + 0.5);
    }
  }

  // ---- crosshair
  if (hover && hover.x != null) {
    x.strokeStyle = 'rgba(180,198,219,.22)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(hover.x, y0); x.lineTo(hover.x, yEnd); x.stroke();
    x.beginPath(); x.moveTo(0, hover.y); x.lineTo(W - GUTTER, hover.y); x.stroke();
    if (hover.kind === 'cell' && hover.price != null) {
      x.fillStyle = '#111a24';
      x.fillRect(W - GUTTER, hover.y - 8, GUTTER, 16);
      x.fillStyle = '#cfdcec';
      x.font = '600 10px ui-monospace,Menlo,monospace';
      x.fillText(hover.price.toFixed(d), W - GUTTER + 6, hover.y);
    } else if (hover.b) {
      const label = clock(hover.b.t0, data.tf);
      x.fillStyle = '#111a24';
      x.fillRect(Math.max(0, hover.x - 24), H - AXIS_H, 48, AXIS_H - 2);
      x.fillStyle = '#cfdcec';
      x.textAlign = 'center';
      x.font = '600 9px ui-monospace,Menlo,monospace';
      x.fillText(label, hover.x, H - 8);
      x.textAlign = 'left';
    }
  }

  // ---- time axis
  x.textAlign = 'center';
  x.fillStyle = '#5a687a';
  x.font = '500 9px ui-monospace,SFMono-Regular,Menlo,monospace';
  const stepCols = Math.max(1, Math.round(70 / g.barW));
  g.view.forEach((b, ci) => {
    if (ci % stepCols !== 0) return;
    x.fillText(clock(b.t0, data.tf), PAD_L + ci * g.barW + (g.barW - 1) / 2, H - 8);
  });
  x.textAlign = 'left';

  // ---- edges
  x.strokeStyle = '#151c25';
  x.beginPath(); x.moveTo(right + 0.5, y0); x.lineTo(right + 0.5, yEnd); x.stroke();
  x.beginPath(); x.moveTo(0, y0 - 0.5); x.lineTo(W, y0 - 0.5); x.stroke();
  x.beginPath(); x.moveTo(0, H - AXIS_H + 0.5); x.lineTo(W, H - AXIS_H + 0.5); x.stroke();

  // ---- scroll affordance: how much history is off to the right
  if (g.start + g.n < (data.bars || []).length) {
    x.fillStyle = '#0c141d';
    x.fillRect(right - 3, y0, 3, (yEnd - y0) * ((g.start + g.n) / data.bars.length));
  }
}

/* ---------------------------------------------------------------- empty states */

function Empty({ data, onUse247 }) {
  const mk = (data && data.market) || {};
  const fs = (data && data.feed) || {};
  const shut = mk.open === false;
  const down = !shut && (fs.status === 'error' || fs.connected === false);
  const when = mk.opens_at ? new Date(mk.opens_at * 1000).toISOString().slice(11, 16) + ' UTC' : null;
  const local = mk.opens_at
    ? new Date(mk.opens_at * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: 240, height: '100%' }}>
      <div className="empty">
        <div className="box">
          <div className="h">
            {shut ? 'No footprint — gold is not trading'
              : down ? 'No quotes are reaching this account'
                : 'Waiting for the first quote'}
          </div>
          {down ? (
            <div className="b">
              The stream for {data && data.symbol ? data.symbol : 'this instrument'} is reporting
              <b> {fs.status || 'down'}</b>{fs.error ? <> — {fs.error}</> : null}.
              {fs.age != null ? <> The last quote arrived <b>{Math.round(fs.age)}s</b> ago.</> : null}
              {' '}Nothing is invented to fill the space; the chart starts at the next real quote.
            </div>
          ) : shut ? (
            <div className="b">
              {mk.detail || 'The gold market is closed.'}
              {when ? <> Reopens <b>{when}</b>{local ? <> — <b>{local}</b> on your clock.</> : null}</> : null}
              {' '}A footprint cell is a counted quote, so there is nothing to draw until quotes
              resume — and nothing here is filled in with invented volume.
            </div>
          ) : (
            <div className="b">
              The feed is up, so the chart fills as soon as this account receives quotes
              {data && data.feed && data.feed.age != null
                ? <> — the last one arrived <b>{Math.round(data.feed.age)}s</b> ago</> : null}.
              Every cell is a counted tick, never a synthetic one.
            </div>
          )}
          {shut && onUse247 && (data.instruments || []).includes('XAUUSD247')
            && !/247$/.test(String(data.symbol || '')) ? (
            <div className="acts">
              <button className="mbtn2" style={{ width: 'auto', padding: '6px 12px' }} onClick={onUse247}>
                Chart XAUUSD247 instead
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
