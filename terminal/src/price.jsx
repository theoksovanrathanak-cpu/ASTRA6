/* The market price chart: real candles from the same bars the footprint is built from.

   It shares the footprint's horizontal view - the same `start`, the same column width, the
   same candle count - so panning or zooming either one moves both, and the crosshair is one
   object owned by the page. Nothing is simulated: open/high/low/close are the counted
   quotes, and the current-price line is the feed's own last quote. When the wire publishes a
   bid and an ask they are drawn where they are; when it does not, they are simply absent.

   Drawings are anchored to (market time, price), not to pixels, so they survive a pan, a
   zoom and a reload. */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { T, wash, MONO } from './theme.js';

const AXIS = 76;          // price gutter, the same width the footprint reserves
const TIME = 18;          // time axis
const VOL_H = 44;         // volume histogram
const PAD_T = 10;
const MARK = '#6598E8';   // drawings, the same blue the value area uses

const SCHEMES = {
  mint: { up: '#20C997', upHot: '#2CE6A5', down: '#F06470', downHot: '#FF6575' },
  classic: { up: '#26A69A', upHot: '#3DBDB0', down: '#EF5350', downHot: '#FF6E6B' },
};

export default function Price({ bars, view, decimals = 2, feed, hover, onHover, onPan, onZoom,
  showVolume, grid = true, scheme = 'mint', drawings = [], tool = '', onCreate, onErase }) {
  const box = useRef(null);
  const cvs = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 240 });
  const drag = useRef(null);
  const drawing = useRef(false);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const m = () => setSize({ w: el.clientWidth || 900, h: Math.max(120, el.clientHeight || 240) });
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    window.addEventListener('resize', m);
    return () => { ro.disconnect(); window.removeEventListener('resize', m); };
  }, []);

  // a tool that is put down without a second point is dropped rather than left dangling
  useEffect(() => { setPending(null); drawing.current = false; }, [tool]);

  /* the geometry the marks are placed with - mirrors what draw() uses for the candles */
  const G = useMemo(() => {
    const vis = bars ? bars.slice(view.start, view.start + view.n) : [];
    if (!vis.length) return null;
    let hi = -Infinity, lo = Infinity;
    vis.forEach((b) => { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); });
    const pad = (hi - lo) * 0.08 || 0.1;
    hi += pad; lo -= pad;
    const top = PAD_T;
    const bottom = size.h - TIME - (showVolume ? VOL_H : 0);
    const barW = view.barW || 58;
    const tf = (vis[0].t1 - vis[0].t0) || 60;
    const iOf = (t0) => Math.round((t0 - vis[0].t0) / tf);
    return {
      vis, hi, lo, top, bottom, barW,
      xOfI: (i) => 4 + i * barW + barW / 2,
      xOfT: (t0) => 4 + iOf(t0) * barW + barW / 2,
      yOf: (p) => top + (1 - (p - lo) / Math.max(1e-9, hi - lo)) * (bottom - top),
      priceOf: (y) => hi - ((y - top) / Math.max(1, bottom - top)) * (hi - lo),
      t0Of: (x) => vis[0].t0 + Math.round((x - 4 - barW / 2) / barW) * tf,
    };
  }, [bars, view, size, showVolume]);

  const marks = useMemo(() => {
    if (!G) return [];
    return (drawings || []).map((d) => ({
      id: d.id,
      type: d.type,
      x1: G.xOfT(d.a.t0), y1: G.yOf(d.a.price),
      x2: G.xOfT((d.b || d.a).t0), y2: G.yOf((d.b || d.a).price),
      p1: d.a.price, p2: (d.b || d.a).price,
      t1: d.a.t0, t2: (d.b || d.a).t0,
      bars: Math.round(((d.b || d.a).t0 - d.a.t0) / (((G.vis[0] || {}).t1 || 0) - ((G.vis[0] || {}).t0 || 1) || 60)),
    }));
  }, [drawings, G]);

  useEffect(() => {
    const c = cvs.current;
    if (!c || !bars || !bars.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, Math.floor(size.w * dpr));
    c.height = Math.max(1, Math.floor(size.h * dpr));
    c.style.height = size.h + 'px';
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(x, size.w, size.h, bars, view, decimals, feed || {}, hover, showVolume,
      grid !== false, SCHEMES[scheme] || SCHEMES.mint, marks, pending, dpr);
  }, [size, bars, view, decimals, feed, hover, showVolume, grid, scheme, marks, pending]);

  const at = (e) => {
    const r = cvs.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const barAt = (x) => {
    const i = Math.floor((x - 4) / (view.barW || 58));
    if (i < 0 || i >= (view.n || 0)) return null;
    return bars[view.start + i] || null;
  };
  const hitMark = (x, y) => {
    for (let i = marks.length - 1; i >= 0; i -= 1) {
      const m = marks[i];
      if (m.type === 'hline' && Math.abs(y - m.y1) < 5) return m;
      if (m.type === 'vline' && Math.abs(x - m.x1) < 5) return m;
      if (m.type === 'rect') {
        const inside = x >= Math.min(m.x1, m.x2) - 3 && x <= Math.max(m.x1, m.x2) + 3
          && y >= Math.min(m.y1, m.y2) - 3 && y <= Math.max(m.y1, m.y2) + 3;
        if (inside) return m;
      }
      if ((m.type === 'trend' || m.type === 'measure') && nearSegment(x, y, m.x1, m.y1, m.x2, m.y2) < 6) return m;
    }
    return null;
  };
  const anchor = (p) => (G ? { t0: G.t0Of(p.x), price: G.priceOf(p.y) } : null);

  const onDown = (e) => {
    const p = at(e);
    if (tool === 'erase') {
      const m = hitMark(p.x, p.y);
      if (m && onErase) onErase(m.id);
      return;
    }
    if (tool && G) {
      const a = anchor(p);
      if (tool === 'hline' || tool === 'vline') {
        if (onCreate) onCreate({ type: tool, a, b: a });
        return;
      }
      drawing.current = true;
      setPending({ type: tool, a, b: a });
      return;
    }
    drag.current = { x0: e.clientX, barW: view.barW, moved: 0 };
    if (cvs.current.setPointerCapture && e.pointerId != null) cvs.current.setPointerCapture(e.pointerId);
    onHover && onHover({ t0: (barAt(p.x) || {}).t0 || null, price: null });
  };

  const onMove = (e) => {
    const p = at(e);
    if (drawing.current && pending && G) {
      setPending({ ...pending, b: anchor(p) });
      return;
    }
    if (drag.current) {
      const dx = e.clientX - drag.current.x0;
      drag.current.moved = Math.abs(dx);
      if (Math.abs(dx) > 3 && onPan) onPan(-dx / Math.max(20, view.barW));
      return;
    }
    const b = barAt(p.x);
    onHover && onHover({ t0: b ? b.t0 : null, price: G ? G.priceOf(p.y) : null });
  };

  const onUp = (e) => {
    if (drawing.current && pending) {
      const moved = Math.abs(pending.b.t0 - pending.a.t0) > 0
        || Math.abs(pending.b.price - pending.a.price) > 1e-9;
      if (moved && onCreate) onCreate(pending);
      drawing.current = false;
      setPending(null);
    }
    drag.current = null;
    if (cvs.current.releasePointerCapture && e.pointerId != null) cvs.current.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e) => {
    e.preventDefault();
    if (tool) return;                       // a wheel while placing a line must not move the chart
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      if (onPan) onPan((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? -2 : 2);
      return;
    }
    if (onZoom) onZoom(e.deltaY > 0 ? -5 : 5);
  };

  if (!bars || !bars.length) {
    return (
      <div ref={box} className="chartwrap" style={{ display: 'grid', placeItems: 'center' }}>
        <div className="empty" style={{ padding: 12 }}>
          <div className="h">No candles yet</div>
          <div className="b">The price chart draws itself from the same counted quotes as the
            footprint — there is nothing to plot until the feed delivers one.</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={box} className="chartwrap">
      <canvas
        ref={cvs}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => { drag.current = null; if (!tool) onHover && onHover(null); }}
        onWheel={onWheel}
        style={{ cursor: tool === 'erase' ? 'not-allowed' : tool ? 'crosshair' : drag.current ? 'grabbing' : 'crosshair' }}
      />
    </div>
  );
}

function nearSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, raw))));
  const norm = raw / mag;
  const step = norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1;
  return step * mag;
}

function draw(x, W, H, bars, view, d, feed, hover, showVolume, grid, sc, marks, pending) {
  const right = W - AXIS;
  const vis = bars.slice(view.start, view.start + view.n);
  const barW = view.barW || 58;
  const top = PAD_T;
  const bottom = H - TIME - (showVolume ? VOL_H : 0);
  const tf = (vis[0] && vis[0].t1 - vis[0].t0) || 60;

  let hi = -Infinity, lo = Infinity;
  vis.forEach((b) => { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); });
  if (!vis.length) return;
  const pad = (hi - lo) * 0.08 || 0.1;
  hi += pad; lo -= pad;
  const yOf = (p) => top + (1 - (p - lo) / Math.max(1e-9, hi - lo)) * (bottom - top);

  x.fillStyle = T.chart;
  x.fillRect(0, 0, W, H);

  // price grid + labels
  const step = niceStep(hi - lo, Math.max(3, Math.floor((bottom - top) / 34)));
  x.font = '500 9.5px ' + MONO;
  x.textBaseline = 'middle';
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const y = yOf(p);
    if (grid) {
      x.strokeStyle = T.line3;
      x.beginPath(); x.moveTo(0, Math.round(y) + 0.5); x.lineTo(right, Math.round(y) + 0.5); x.stroke();
    }
    x.fillStyle = T.muted;
    x.textAlign = 'left';
    x.fillText(p.toFixed(d), right + 8, y);
  }

  // session separators: a UTC day boundary gets a dashed line and a label
  x.textAlign = 'left';
  vis.forEach((b, i) => {
    const day = Math.floor(b.t0 / 86400);
    const prev = i > 0 ? Math.floor(vis[i - 1].t0 / 86400) : day;
    if (i > 0 && day !== prev) {
      const bx = 4 + i * barW;
      x.strokeStyle = T.line2;
      x.setLineDash([2, 4]);
      x.beginPath(); x.moveTo(bx, top); x.lineTo(bx, bottom); x.stroke();
      x.setLineDash([]);
      x.fillStyle = T.dim;
      x.font = '500 8.5px ' + MONO;
      x.fillText(new Date(b.t0 * 1000).toISOString().slice(5, 10), bx + 3, top + 7);
    }
  });

  // candles
  const cw = Math.max(1, barW * 0.68);
  vis.forEach((b, i) => {
    const cx = 4 + i * barW + barW / 2;
    const up = b.close >= b.open;
    const col = up ? sc.up : sc.down;
    const yH = yOf(b.high), yL = yOf(b.low);
    x.strokeStyle = col;
    x.lineWidth = 1;
    x.beginPath(); x.moveTo(Math.round(cx) + 0.5, yH); x.lineTo(Math.round(cx) + 0.5, yL); x.stroke();
    const yo = yOf(b.open), yc = yOf(b.close);
    const yT = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
    x.fillStyle = up ? sc.up : sc.down;
    x.fillRect(Math.round(cx - cw / 2), Math.round(yT), Math.round(cw), Math.round(hh));
    x.strokeStyle = up ? sc.upHot : sc.downHot;
    if (hh < 3) { x.fillRect(Math.round(cx - cw / 2), Math.round(yT), Math.round(cw), 2); }
    else x.strokeRect(Math.round(cx - cw / 2) + 0.5, Math.round(yT) + 0.5, Math.round(cw) - 1, Math.round(hh) - 1);
  });

  // volume histogram
  if (showVolume) {
    const vy = bottom + 6;
    const vh = VOL_H - 14;
    const maxV = Math.max(1, ...vis.map((b) => b.volume || 0));
    x.fillStyle = T.line3;
    x.fillRect(0, vy - 3, right, 1);
    vis.forEach((b, i) => {
      const h = Math.max(1, ((b.volume || 0) / maxV) * vh);
      const cx = 4 + i * barW + barW / 2;
      x.fillStyle = b.close >= b.open ? wash(sc.up, 0.45) : wash(sc.down, 0.45);
      x.fillRect(Math.round(cx - cw / 2), Math.round(vy + vh - h), Math.round(cw), Math.round(h));
    });
    x.fillStyle = T.dim;
    x.font = '600 8px ' + MONO;
    x.textAlign = 'right';
    x.fillText('VOLUME', right - 4, vy + 1);
  }

  // bid / ask, only when the wire actually sent both sides
  const bid = feed.bid, ask = feed.ask;
  const band = (p, colour, label) => {
    if (p == null) return;
    const y = yOf(p);
    if (y < top || y > bottom) return;
    x.strokeStyle = colour;
    x.setLineDash([4, 3]);
    x.beginPath(); x.moveTo(0, Math.round(y) + 0.5); x.lineTo(right, Math.round(y) + 0.5); x.stroke();
    x.setLineDash([]);
    x.fillStyle = colour;
    x.font = '600 8.5px ' + MONO;
    x.textAlign = 'right';
    x.fillText(label, right - 4, y - 6);
    x.textAlign = 'left';
  };
  band(bid, wash(sc.down, 0.9), 'BID ' + Number(bid).toFixed(d));
  band(ask, wash(sc.up, 0.9), 'ASK ' + Number(ask).toFixed(d));

  // the reader's own marks, under the live price so nothing hides the quote
  const markOne = (m, ghost) => {
    x.save();
    x.strokeStyle = ghost ? wash(MARK, 0.6) : MARK;
    x.fillStyle = wash(MARK, ghost ? 0.08 : 0.12);
    x.lineWidth = 1;
    x.setLineDash(ghost ? [3, 3] : []);
    if (m.type === 'hline') {
      x.beginPath(); x.moveTo(0, Math.round(m.y1) + 0.5); x.lineTo(right, Math.round(m.y1) + 0.5); x.stroke();
      x.fillStyle = MARK;
      x.font = '600 8.5px ' + MONO;
      x.textAlign = 'left';
      x.fillText(Number(m.p1).toFixed(d), 3, m.y1 - 6);
    } else if (m.type === 'vline') {
      x.beginPath(); x.moveTo(Math.round(m.x1) + 0.5, top); x.lineTo(Math.round(m.x1) + 0.5, bottom); x.stroke();
    } else if (m.type === 'rect') {
      const rx = Math.min(m.x1, m.x2), ry = Math.min(m.y1, m.y2);
      const rw = Math.abs(m.x2 - m.x1), rh = Math.abs(m.y2 - m.y1);
      x.fillRect(rx, ry, rw, rh);
      x.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    } else {
      x.beginPath(); x.moveTo(m.x1, m.y1); x.lineTo(m.x2, m.y2); x.stroke();
      if (m.type === 'measure') {
        const diff = m.p2 - m.p1;
        const pct = m.p1 ? (diff / m.p1) * 100 : 0;
        x.setLineDash([]);
        const label = (diff >= 0 ? '+' : '') + diff.toFixed(d) + '  ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%  ' + Math.abs(m.bars) + ' bars';
        x.font = '600 9px ' + MONO;
        const tw = x.measureText(label).width + 10;
        const lx = Math.min(Math.max(4, m.x2 + 6), right - tw - 4);
        x.fillStyle = T.panel2;
        x.fillRect(lx, m.y2 - 8, tw, 16);
        x.strokeStyle = MARK;
        x.strokeRect(lx + 0.5, m.y2 - 7.5, tw, 16);
        x.fillStyle = T.ink;
        x.textAlign = 'left';
        x.fillText(label, lx + 5, m.y2);
      }
    }
    x.restore();
  };
  (marks || []).forEach((m) => markOne(m, false));
  if (pending && pending.b) {
    markOne({ type: pending.type, x1: 4 + Math.round((pending.a.t0 - vis[0].t0) / tf) * barW + barW / 2,
      y1: yOf(pending.a.price), x2: 4 + Math.round((pending.b.t0 - vis[0].t0) / tf) * barW + barW / 2,
      y2: yOf(pending.b.price), p1: pending.a.price, p2: pending.b.price,
      bars: Math.round((pending.b.t0 - pending.a.t0) / tf) }, true);
  }

  // current price
  const px = feed.price;
  if (px != null) {
    const y = yOf(px);
    if (y >= top && y <= bottom) {
      x.strokeStyle = T.ink;
      x.setLineDash([2, 3]);
      x.beginPath(); x.moveTo(0, Math.round(y) + 0.5); x.lineTo(right, Math.round(y) + 0.5); x.stroke();
      x.setLineDash([]);
      x.fillStyle = T.ink;
      x.fillRect(right, y - 8, AXIS, 16);
      x.fillStyle = T.bg;
      x.font = '700 10px ' + MONO;
      x.textAlign = 'left';
      x.fillText(Number(px).toFixed(d), right + 6, y);
    }
  }

  // crosshair, driven by the page so both charts show the same candle
  if (hover && hover.t0 != null) {
    const i = vis.findIndex((b) => b.t0 === hover.t0);
    if (i >= 0) {
      const cx = 4 + i * barW + barW / 2;
      x.strokeStyle = wash(T.ink2, 0.35);
      x.beginPath(); x.moveTo(Math.round(cx) + 0.5, top); x.lineTo(Math.round(cx) + 0.5, bottom); x.stroke();
    }
  }
  if (hover && hover.price != null) {
    const y = yOf(hover.price);
    if (y >= top && y <= bottom) {
      x.strokeStyle = wash(T.ink2, 0.22);
      x.beginPath(); x.moveTo(0, Math.round(y) + 0.5); x.lineTo(right, Math.round(y) + 0.5); x.stroke();
      x.fillStyle = T.panel2;
      x.fillRect(right, y - 8, AXIS, 16);
      x.fillStyle = T.ink2;
      x.font = '600 9.5px ' + MONO;
      x.fillText(Number(hover.price).toFixed(d), right + 6, y);
    }
  }

  // time axis
  x.fillStyle = T.muted;
  x.font = '500 9px ' + MONO;
  x.textAlign = 'center';
  const every = Math.max(1, Math.round(78 / barW));
  vis.forEach((b, i) => {
    if (i % every !== 0) return;
    const when = b.t0 ? new Date(b.t0 * 1000) : null;
    const label = !when ? ''
      : tf >= 3600 * 20 ? when.toLocaleDateString([], { day: '2-digit', month: 'short' })
        : tf < 60 ? when.toISOString().slice(11, 19) : when.toISOString().slice(11, 16);
    x.fillText(label, 4 + i * barW + barW / 2, H - 7);
  });
  x.textAlign = 'left';

  // frames
  x.strokeStyle = T.line2;
  x.beginPath(); x.moveTo(right + 0.5, 0); x.lineTo(right + 0.5, H); x.stroke();
}
