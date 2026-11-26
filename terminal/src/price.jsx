/* The market price chart: real candles from the same bars the footprint is built from.

   It shares the footprint's horizontal view - the same `start`, the same column width, the
   same candle count - so panning or zooming either one moves both, and the crosshair is one
   object owned by the page. Nothing is simulated: open/high/low/close are the counted
   quotes, and the current-price line is the feed's own last quote. When the wire publishes a
   bid and an ask they are drawn where they are; when it does not, they are simply absent. */

import React, { useEffect, useRef, useState } from 'react';
import { T, wash, MONO } from './theme.js';

const AXIS = 76;          // price gutter, the same width the footprint reserves
const TIME = 18;          // time axis
const VOL_H = 44;         // volume histogram
const PAD_T = 10;

export default function Price({ bars, view, decimals = 2, feed, hover, onHover, onPan, onZoom, showVolume }) {
  const box = useRef(null);
  const cvs = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 240 });
  const drag = useRef(null);

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

  useEffect(() => {
    const c = cvs.current;
    if (!c || !bars || !bars.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, Math.floor(size.w * dpr));
    c.height = Math.max(1, Math.floor(size.h * dpr));
    c.style.height = size.h + 'px';
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(x, size.w, size.h, bars, view, decimals, feed || {}, hover, showVolume);
  }, [size, bars, view, decimals, feed, hover, showVolume]);

  const at = (e) => {
    const r = cvs.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const barAt = (x) => {
    const i = Math.floor((x - 4) / (view.barW || 58));
    if (i < 0 || i >= (view.n || 0)) return null;
    return bars[view.start + i] || null;
  };

  const onDown = (e) => {
    const p = at(e);
    drag.current = { x0: e.clientX, barW: view.barW, moved: 0 };
    cvs.current.setPointerCapture && cvs.current.setPointerCapture(e.pointerId);
    onHover && onHover({ t0: (barAt(p.x) || {}).t0 || null, price: null });
  };
  const onMove = (e) => {
    const p = at(e);
    if (drag.current) {
      const dx = e.clientX - drag.current.x0;
      drag.current.moved = Math.abs(dx);
      if (Math.abs(dx) > 3 && onPan) onPan(-dx / Math.max(20, view.barW));
      return;
    }
    const b = barAt(p.x);
    const px = priceAt(p.y, size.h, bars, view, showVolume);
    onHover && onHover({ t0: b ? b.t0 : null, price: px });
  };
  const onUp = (e) => {
    drag.current = null;
    cvs.current.releasePointerCapture && cvs.current.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e) => {
    e.preventDefault();
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
        onPointerLeave={() => { drag.current = null; onHover && onHover(null); }}
        onWheel={onWheel}
        style={{ cursor: drag.current ? 'grabbing' : 'crosshair' }}
      />
    </div>
  );
}

/* price under the cursor, so both charts can print the same crosshair level */
function priceAt(y, H, bars, view, showVolume) {
  const vis = bars.slice(view.start, view.start + view.n);
  if (!vis.length) return null;
  let hi = -Infinity, lo = Infinity;
  vis.forEach((b) => { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); });
  const pad = (hi - lo) * 0.08 || 0.1;
  hi += pad; lo -= pad;
  const top = PAD_T;
  const bottom = H - TIME - (showVolume ? VOL_H : 0);
  const f = (y - top) / Math.max(1, bottom - top);
  return hi - f * (hi - lo);
}

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, raw))));
  const norm = raw / mag;
  const step = norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1;
  return step * mag;
}

function draw(x, W, H, bars, view, d, feed, hover, showVolume) {
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
    x.strokeStyle = T.line3;
    x.beginPath(); x.moveTo(0, Math.round(y) + 0.5); x.lineTo(right, Math.round(y) + 0.5); x.stroke();
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
    const col = up ? T.bull : T.bear;
    const yH = yOf(b.high), yL = yOf(b.low);
    x.strokeStyle = col;
    x.lineWidth = 1;
    x.beginPath(); x.moveTo(Math.round(cx) + 0.5, yH); x.lineTo(Math.round(cx) + 0.5, yL); x.stroke();
    const yo = yOf(b.open), yc = yOf(b.close);
    const yT = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
    x.fillStyle = up ? T.bull : T.bear;
    x.fillRect(Math.round(cx - cw / 2), Math.round(yT), Math.round(cw), Math.round(hh));
    x.strokeStyle = up ? T.bullHot : T.bearHot;
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
      x.fillStyle = b.close >= b.open ? wash(T.bull, 0.45) : wash(T.bear, 0.45);
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
  band(bid, wash(T.bear, 0.9), 'BID ' + Number(bid).toFixed(d));
  band(ask, wash(T.bull, 0.9), 'ASK ' + Number(ask).toFixed(d));

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
