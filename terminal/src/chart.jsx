/* The footprint canvas: bid x ask cells, delta strip, CVD line and profile markers.

   Everything drawn here comes straight from the server payload - the renderer does no
   arithmetic on volume, so what is on screen is what the engine counted. Cells carry a
   buy x sell pair; the tint says which side carried the level, and an imbalance mark
   from the server paints a band behind the cell. */

import React, { useEffect, useRef 	, useState } from 'react';

const PAD_R = 62;      // price gutter
const PAD_L = 6;
const ROW_H = 13;      // pixels per price level
const DELTA_H = 54;    // delta histogram strip
const CVD_H = 48;      // cumulative delta strip
const AXIS_H = 18;     // time labels
const HEAD_H = 14;     // per-column delta label

function fmtVol(v) {
  if (v == null) return '';
  if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
  return v % 1 === 0 ? String(v) : v.toFixed(1);
}

export default function Footprint({ data, barW, onBarW, show }) {
  const box = useRef(null);
  const cvs = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 560 });
  const [hover, setHover] = useState(null);
  const [pan, setPan] = useState(0);
  const drag = useRef(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || 900, h: el.clientHeight || 560 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = cvs.current;
    if (!c || !data || !data.bars) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = size.w, H = size.h;
    c.width = W * dpr; c.height = H * dpr;
    c.style.height = H + 'px';
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(x, W, H, data, barW, pan, show);
  }, [size, data, barW, pan, show]);

  if (!data || !data.bars || !data.bars.length) {
    return (
      <div ref={box} className="chartwrap" style={{ height: 520, display: 'grid', placeItems: 'center' }}>
        <div className="empty" style={{ textAlign: 'center', maxWidth: 460 }}>
          Recording the tape. The footprint is built from the quotes this account receives,
          so it appears as soon as the feed prints - there is no synthetic history to fill
          the space.
        </div>
      </div>
    );
  }

  const levels = levelsOf(data, size.w, barW, pan);
  const onMove = (e) => {
    const r = cvs.current.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (drag.current) { setPan(drag.current + py - drag.currentY); return; }
    setHover(hitTest(data, size.w, size.h, barW, pan, px, py));
  };
  const onWheel = (e) => {
    if (!e.ctrlKey && Math.abs(e.deltaY) > 0) { e.preventDefault(); }
    const next = Math.max(38, Math.min(96, barW + (e.deltaY > 0 ? -6 : 6)));
    if (next !== barW) onBarW(next);
  };

  return (
    <div ref={box} className="chartwrap">
      <canvas
        ref={cvs}
        onMouseMove={onMove}
        onMouseLeave={() => { setHover(null); drag.current = null; }}
        onMouseDown={(e) => { const r = cvs.current.getBoundingClientRect();
          drag.current = pan; drag.current = pan; drag.currentY = e.clientY - r.top; drag.base = pan; }}
        onMouseUp={() => { drag.current = null; }}
        onWheel={onWheel}
        style={{ cursor: 'crosshair' }}
      />
      {hover && (
        <div className="tip" style={{ left: Math.min(hover.x + 14, size.w - 190), top: hover.y + 12 }}>
          {hover.kind === 'cell' ? (
            <>
              <div><b className="a">{hover.price.toFixed(data.decimals)}</b> <span className="m">level</span></div>
              <div><span className="g">buy {fmtVol(hover.buy)}</span> · <span className="r">sell {fmtVol(hover.sell)}</span></div>
              <div><span className="m">delta</span> <b className={hover.buy - hover.sell >= 0 ? 'g' : 'r'}>
                {(hover.buy - hover.sell >= 0 ? '+' : '') + fmtVol(hover.buy - hover.sell)}</b></div>
              {hover.imbalance && <div className="a">imbalance {hover.imbalance}% {hover.side}</div>}
            </>
          ) : (
            <>
              <div><b>{hover.time}</b></div>
              <div><span className="m">delta</span> <b className={hover.delta >= 0 ? 'g' : 'r'}>
                {(hover.delta >= 0 ? '+' : '') + fmtVol(hover.delta)}</b></div>
              <div><span className="m">volume</span> <b>{fmtVol(hover.volume)}</b> ticks</div>
              <div><span className="m">high / low</span> <b>{hover.high.toFixed(data.decimals)} / {hover.low.toFixed(data.decimals)}</b></div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function levelsOf(data, W, barW, pan) {
  const n = Math.max(6, Math.floor((W - PAD_R - PAD_L) / barW));
  return data.bars.slice(-n);
}

function hitTest(data, W, H, barW, pan, px, py) {
  const n = Math.max(6, Math.floor((W - PAD_R - PAD_L) / barW));
  const bars = data.bars.slice(-n);
  const idx = Math.floor((px - PAD_L) / barW);
  if (idx < 0 || idx >= bars.length) return null;
  const b = bars[idx];
  const geom = priceGeometry(bars, data, H, pan);
  if (py >= geom.y0 && py <= geom.y0 + geom.rows * ROW_H) {
    const rowIdx = Math.floor((py - geom.y0) / ROW_H) - geom.offset;
    const price = geom.top - rowIdx * data.step;
    const cell = (b.levels || []).find((r) => Math.abs(r[0] - price) < 1e-6);
    if (cell) {
      const marks = (data.imbalance.bars || []).find((m) => m.t0 === b.t0);
      const mark = marks && marks.marks.find((m) => Math.abs(m.price - price) < 1e-6);
      return { kind: 'cell', x: px, y: py, price: cell[0], buy: cell[1], sell: cell[2],
               imbalance: mark ? Math.round(mark.ratio * 100) : null, side: mark && mark.side };
    }
  }
  return { kind: 'bar', x: px, y: py, time: clock(b.t0, data.tf), delta: b.delta,
           volume: b.volume, high: b.high, low: b.low };
}

function clock(ts, tf) {
  const d = new Date(ts * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return tf < 60 ? hh + ':' + mm + ':' + String(d.getUTCSeconds()).padStart(2, '0') : hh + ':' + mm;
}

function priceGeometry(bars, data, H, pan) {
  let top = -Infinity, bottom = Infinity;
  bars.forEach((b) => (b.levels || []).forEach((r) => {
    top = Math.max(top, r[0]); bottom = Math.min(bottom, r[0]);
  }));
  if (!isFinite(top)) { top = 0; bottom = 0; }
  const all = Math.round((top - bottom) / data.step) + 1;
  const strip = DELTA_H + CVD_H + AXIS_H + HEAD_H;
  const room = Math.max(120, H - strip - 8);
  const visible = Math.max(8, Math.floor(room / ROW_H));
  const rows = Math.min(all, visible);
  const offset = Math.max(0, Math.min(all - rows, Math.round(pan / ROW_H)));
  return { top, bottom, rows, offset, y0: HEAD_H + 4, strip, all };
}

function draw(x, W, H, data, barW, pan, show) {
  const bars = levelsOf(data, W, barW, pan);
  const geom = priceGeometry(bars, data, H, pan);
  const plotW = W - PAD_R - PAD_L;
  const stripY = geom.y0 + geom.rows * ROW_H;
  const deltaY = stripY + 8;
  const cvdY = deltaY + DELTA_H;
  const axisY = cvdY + CVD_H;

  x.fillStyle = '#070b10';
  x.fillRect(0, 0, W, H);

  // level rows, banded so the eye can follow one price across the whole tape
  for (let i = 0; i < geom.rows; i += 1) {
    const y = geom.y0 + i * ROW_H;
    if (i % 2 === 0) {
      x.fillStyle = 'rgba(255,255,255,.014)';
      x.fillRect(PAD_L, y, W - PAD_R - PAD_L, ROW_H);
    }
    x.strokeStyle = '#0b131b'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(PAD_L, y + 0.5); x.lineTo(W - PAD_R, y + 0.5); x.stroke();
  }

  // cells
  const marksByBar = {};
  (data.imbalance.bars || []).forEach((m) => { marksByBar[m.t0] = m.marks; });
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '600 9.5px ui-monospace,Menlo,monospace';

  bars.forEach((b, i) => {
    const bx = PAD_L + i * barW;
    const marks = marksByBar[b.t0] || [];
    (b.levels || []).forEach((row) => {
      const [price, buy, sell] = row;
      const rowIdx = Math.round((geom.top - price) / data.step) - geom.offset;
      if (rowIdx < 0 || rowIdx >= geom.rows) return;
      const y = geom.y0 + rowIdx * ROW_H;
      const mark = marks.find((m) => Math.abs(m.price - price) < 1e-6);
      if (mark) {
        x.fillStyle = mark.side === 'buy' ? 'rgba(22,199,132,.16)' : 'rgba(234,57,67,.16)';
        x.fillRect(bx + 1, y, barW - 2, ROW_H - 1);
        x.fillStyle = mark.side === 'buy' ? '#16c784' : '#ea3943';
        x.fillRect(mark.side === 'buy' ? bx + 1 : bx + barW - 3, y, 2, ROW_H - 1);
      }
      const bias = buy > sell ? '#7fe6bb' : sell > buy ? '#ff9aa2' : '#8fa2b5';
      x.fillStyle = buy === 0 || sell === 0 ? '#6c7f92' : bias;
      x.fillText(fmtVol(buy) + '×' + fmtVol(sell), bx + barW / 2, y + ROW_H / 2);
    });
    // column delta, above the plot
    const pos = b.delta >= 0;
    x.fillStyle = pos ? '#16c784' : '#ea3943';
    x.font = '700 9px ui-monospace,Menlo,monospace';
    x.fillText((pos ? '+' : '') + fmtVol(b.delta), bx + barW / 2, geom.y0 - 7);
    x.font = '600 9.5px ui-monospace,Menlo,monospace';
    // column separator
    x.strokeStyle = '#0c141d';
    x.beginPath(); x.moveTo(bx + 0.5, geom.y0 - 2); x.lineTo(bx + 0.5, stripY); x.stroke();
  });

  // price gutter labels + profile markers
  x.textAlign = 'left';
  x.font = '500 9.5px ui-monospace,Menlo,monospace';
  for (let i = 0; i <= geom.rows; i += 1) {
    if (i % 4 !== 0) continue;
    const price = geom.top - (i + geom.offset) * data.step;
    const y = geom.y0 + i * ROW_H + ROW_H / 2;
    x.fillStyle = '#5d6f83';
    x.fillText(price.toFixed(data.decimals), plotW + PAD_L + 8, y);
  }
  const prof = data.profile || {};
  [['poc', '#f0b90b'], ['vah', '#3d6ea8'], ['val', '#3d6ea8']].forEach(([key, color]) => {
    const price = prof[key];
    if (price == null) return;
    const rowIdx = Math.round((geom.top - price) / data.step) - geom.offset;
    if (rowIdx < 0 || rowIdx >= geom.rows) return;
    const y = geom.y0 + rowIdx * ROW_H;
    x.strokeStyle = color; x.lineWidth = 1;
    x.setLineDash(key === 'poc' ? [] : [3, 3]);
    x.beginPath(); x.moveTo(PAD_L, y + ROW_H / 2); x.lineTo(plotW + PAD_L, y + ROW_H / 2); x.stroke();
    x.setLineDash([]);
    x.fillStyle = color;
    x.fillRect(plotW + PAD_L + 2, y + ROW_H / 2 - 5, 2, 10);
    x.fillText(key.toUpperCase(), plotW + PAD_L + 8, y + ROW_H / 2);
  });

  // the quote the feed is on right now
  const livePx = data.feed && data.feed.price;
  if (livePx != null) {
    const rowIdx = (geom.top - livePx) / data.step - geom.offset;
    const y = geom.y0 + rowIdx * ROW_H + ROW_H / 2;
    if (y > geom.y0 && y < stripY) {
      x.strokeStyle = '#e8eef6'; x.lineWidth = 1; x.setLineDash([2, 3]);
      x.beginPath(); x.moveTo(PAD_L, y); x.lineTo(plotW + PAD_L, y); x.stroke();
      x.setLineDash([]);
      x.fillStyle = '#0a0f15';
      x.fillRect(plotW + PAD_L + 3, y - 8, PAD_R - 8, 15);
      x.fillStyle = '#e8eef6';
      x.textAlign = 'left';
      x.font = '700 10px ui-monospace,Menlo,monospace';
      x.fillText(livePx.toFixed(data.decimals), plotW + PAD_L + 8, y + 0.5);
      x.font = '600 9.5px ui-monospace,Menlo,monospace';
      x.textAlign = 'center';
    }
  }

  // delta histogram
  const maxD = Math.max(1, ...bars.map((b) => Math.abs(b.delta)));
  const half = DELTA_H / 2;
  x.strokeStyle = '#1a2430';
  x.beginPath(); x.moveTo(PAD_L, deltaY + half + 0.5); x.lineTo(W - PAD_R, deltaY + half + 0.5); x.stroke();
  bars.forEach((b, i) => {
    const bx = PAD_L + i * barW;
    const h = (Math.abs(b.delta) / maxD) * (half - 3);
    x.fillStyle = b.delta >= 0 ? '#16c784' : '#ea3943';
    if (b.delta >= 0) x.fillRect(bx + 3, deltaY + half - h, barW - 6, h);
    else x.fillRect(bx + 3, deltaY + half, barW - 6, h);
  });
  label(x, 'DELTA', PAD_L + 2, deltaY + 8);

  // cvd line
  const series = data.cvd || [];
  const shown = series.slice(-bars.length);
  if (shown.length > 1) {
    const lo = Math.min(...shown), hi = Math.max(...shown);
    const span = hi - lo || 1;
    x.beginPath();
    shown.forEach((v, i) => {
      const px = PAD_L + i * barW + barW / 2;
      const py = cvdY + 6 + (1 - (v - lo) / span) * (CVD_H - 12);
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    });
    x.strokeStyle = '#4c8dff'; x.lineWidth = 1.4; x.stroke();
    label(x, 'CVD ' + (series[series.length - 1] >= 0 ? '+' : '') +
      fmtVol(series[series.length - 1] || 0), PAD_L + 2, cvdY + 8);
  }

  // time axis
  x.textAlign = 'center';
  x.fillStyle = '#5d6f83';
  x.font = '500 9px ui-monospace,Menlo,monospace';
  bars.forEach((b, i) => {
    if (i % Math.max(1, Math.round(78 / barW)) !== 0) return;
    x.fillText(clock(b.t0, data.tf), PAD_L + i * barW + barW / 2, axisY + 9);
  });
  x.textAlign = 'left';

  if (show && show.spread !== false) {
    // nothing extra: kept as an extension point for spread shading
  }
}

function label(x, text, px, py) {
  x.save();
  x.textAlign = 'left';
  x.fillStyle = '#4e6076';
  x.font = '700 8.5px ui-monospace,Menlo,monospace';
  x.fillText(text, px, py);
  x.restore();
}
