/* Preferences: what the reader chose, kept on this device.

   The defaults are the ones the desk would pick - bid x ask cells, plain numbers, a 300%
   imbalance, a 70% value area - and every choice is clamped on the way back in, so a
   hand-edited localStorage cannot leave the chart in a state it cannot draw. */

import React, { useCallback, useEffect, useState } from 'react';

const KEY = 'desento_prefs_v1';

export const DEFAULTS = {
  mode: 'bidask',
  fmt: 'plain',
  filter: 0,
  intensity: 1,
  rowH: 15,
  chartH: 560,
  sidebar: true,
  vaPct: 0.7,
  cvdRebase: false,
  volume: true,
  split: 0.48,
  grid: true,
  candles: 'mint',
  pocLines: true,
};

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    return {
      mode: ['bidask', 'delta', 'volume', 'imbalance', 'bid', 'ask'].includes(s.mode) ? s.mode : DEFAULTS.mode,
      fmt: ['plain', 'compact', 'hidden'].includes(s.fmt) ? s.fmt : DEFAULTS.fmt,
      filter: clamp(s.filter, 0, 500, 0),
      intensity: clamp(s.intensity, 0.4, 1.6, 1),
      rowH: s.rowH === 13 ? 13 : s.rowH === 18 ? 18 : 15,
      chartH: clamp(s.chartH, 360, 820, DEFAULTS.chartH),
      sidebar: s.sidebar !== false,
      vaPct: clamp(s.vaPct, 0.5, 0.95, 0.7),
      cvdRebase: !!s.cvdRebase,
      volume: s.volume !== false,
      split: clamp(s.split, 0.22, 0.72, 0.48),
      grid: s.grid !== false,
      candles: s.candles === 'classic' ? 'classic' : 'mint',
      pocLines: s.pocLines !== false,
    };
  } catch (e) { return { ...DEFAULTS }; }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState(read);
  const set = useCallback((patch) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
      return next;
    });
  }, []);
  return [prefs, set];
}

function Val({ v }) {
  return <span className="m" style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>{v}</span>;
}

function Line({ k, hint, children }) {
  return (
    <div className="srow" style={{ padding: '7px 14px', alignItems: 'center' }}>
      <span className="k" style={{ fontSize: 10.5 }}>{k}{hint ? <span className="m" style={{ display: 'block', fontSize: 9, marginTop: 2 }}>{hint}</span> : null}</span>
      <span className="v" style={{ flex: '0 0 auto' }}>{children}</span>
    </div>
  );
}

export default function Settings({ open, onClose, prefs, set, quality, feed, link, onReconnect }) {
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, onClose]);
  if (!open) return null;

  return (
    <div className="sheetwrap" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet right" role="dialog" aria-label="Settings">
        <div className="sheet-h"><span>Chart settings</span>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="sgrp">
          <div className="sgrp-h">Market data</div>
          <Line k="Source" hint="server-side credentials, never in this page">
            <Val v={(quality && quality.source) || 'Exness Trading API'} />
          </Line>
          <Line k="Feed" hint={(link && link.mode === 'ws') ? 'websocket, one frame a second' : 'http polling, once every two seconds'}>
            <Val v={((quality && quality.age_ms) != null ? quality.age_ms + ' ms old' : 'no quote yet')
              + ((feed && feed.connected) ? ' · connected' : ' · not connected')} />
          </Line>
          <Line k="Volume type" hint="Exness publishes quotes, not traded size at each price">
            <Val v="counted quotes (tick volume)" />
          </Line>
          <Line k="Classification" hint="a quote above the previous one is booked to the ask, below to the bid">
            <Val v="estimated · tick rule" />
          </Line>
          <Line k="Frames booked" hint="quotes accepted into the tape">
            <Val v={(quality ? quality.events : 0).toLocaleString() + ' · ' + (quality ? quality.candles : 0) + ' candles'} />
          </Line>
          <Line k="Rejected on the way in" hint="re-deliveries, unusable prices, other instruments">
            <Val v={quality
              ? (quality.duplicates || 0) + ' dup · ' + (quality.invalid || 0) + ' bad · '
                + (quality.late || 0) + ' late · ' + (quality.rejected || 0) + ' other'
              : '—'} />
          </Line>
          <Line k="Reconnect">
            <button className="mbtn2" style={{ width: 'auto', padding: '3px 10px' }}
              onClick={() => { if (onReconnect) onReconnect(); onClose(); }}>Reconnect the feed</button>
          </Line>
        </div>

        <div className="sgrp">
          <div className="sgrp-h">Footprint</div>
          <Line k="Display mode">
            <select value={prefs.mode} onChange={(e) => set({ mode: e.target.value })}>
              <option value="bidask">Bid × Ask</option>
              <option value="delta">Delta</option>
              <option value="volume">Volume</option>
              <option value="imbalance">Imbalance</option>
              <option value="bid">Bid volume</option>
              <option value="ask">Ask volume</option>
            </select>
          </Line>
          <Line k="Numbers" hint="compact prints 1.2k instead of 1200">
            <select value={prefs.fmt} onChange={(e) => set({ fmt: e.target.value })}>
              <option value="plain">Plain</option>
              <option value="compact">Compact</option>
              <option value="hidden">Hidden (tint only)</option>
            </select>
          </Line>
          <Line k="Volume filter" hint="hide levels under this many quotes">
            <select value={prefs.filter} onChange={(e) => set({ filter: Number(e.target.value) })}>
              {[0, 2, 5, 10, 20].map((v) => <option key={v} value={v}>{v === 0 ? 'off' : v + '+'}</option>)}
            </select>
          </Line>
          <Line k="Colour intensity">
            <input type="range" min="0.4" max="1.6" step="0.1" value={prefs.intensity}
              onChange={(e) => set({ intensity: Number(e.target.value) })} style={{ width: 110 }} />
          </Line>
          <Line k="Row height">
            <div className="seg">
              <button className={prefs.rowH === 13 ? 'on' : ''} onClick={() => set({ rowH: 13 })}>Compact</button>
              <button className={prefs.rowH === 15 ? 'on' : ''} onClick={() => set({ rowH: 15 })}>Standard</button>
              <button className={prefs.rowH === 18 ? 'on' : ''} onClick={() => set({ rowH: 18 })}>Comfortable</button>
            </div>
          </Line>
        </div>

        <div className="sgrp">
          <div className="sgrp-h">Layout</div>
          <Line k="Chart height" hint={prefs.chartH + ' px'}>
            <input type="range" min="360" max="820" step="20" value={prefs.chartH}
              onChange={(e) => set({ chartH: Number(e.target.value) })} style={{ width: 110 }} />
          </Line>
          <Line k="Analytics sidebar">
            <div className="seg">
              <button className={prefs.sidebar ? 'on' : ''} onClick={() => set({ sidebar: true })}>Shown</button>
              <button className={!prefs.sidebar ? 'on' : ''} onClick={() => set({ sidebar: false })}>Hidden</button>
            </div>
          </Line>
          <Line k="Chart split" hint={'price ' + Math.round((prefs.split || 0.42) * 100) + '% · footprint ' + (100 - Math.round((prefs.split || 0.42) * 100)) + '%'}>
            <div className="seg">
              <button className={prefs.split < 0.34 ? 'on' : ''} onClick={() => set({ split: 0.28 })}>Footprint</button>
              <button className={prefs.split >= 0.34 && prefs.split <= 0.5 ? 'on' : ''} onClick={() => set({ split: 0.42 })}>Balanced</button>
              <button className={prefs.split > 0.5 ? 'on' : ''} onClick={() => set({ split: 0.6 })}>Price</button>
            </div>
          </Line>
          <Line k="Price grid" hint="horizontal price lines behind the candles">
            <div className="seg">
              <button className={prefs.grid ? 'on' : ''} onClick={() => set({ grid: true })}>Shown</button>
              <button className={!prefs.grid ? 'on' : ''} onClick={() => set({ grid: false })}>Hidden</button>
            </div>
          </Line>
          <Line k="Candle colours" hint="both schemes keep green up, red down">
            <select value={prefs.candles || 'mint'} onChange={(e) => set({ candles: e.target.value })}>
              <option value="mint">Mint · coral</option>
              <option value="classic">Classic · brick</option>
            </select>
          </Line>
          <Line k="POC / value area lines" hint="drawn across the footprint">
            <div className="seg">
              <button className={prefs.pocLines !== false ? 'on' : ''} onClick={() => set({ pocLines: true })}>Shown</button>
              <button className={prefs.pocLines === false ? 'on' : ''} onClick={() => set({ pocLines: false })}>Hidden</button>
            </div>
          </Line>
          <Line k="CVD" hint="the line starts where the screen starts, or at zero">
            <div className="seg">
              <button className={!prefs.cvdRebase ? 'on' : ''} onClick={() => set({ cvdRebase: false })}>As recorded</button>
              <button className={prefs.cvdRebase ? 'on' : ''} onClick={() => set({ cvdRebase: true })}>Rebase 0</button>
            </div>
          </Line>
          <Line k="Price chart volume" hint="quote count per candle, not traded size">
            <div className="seg">
              <button className={prefs.volume ? 'on' : ''} onClick={() => set({ volume: true })}>Shown</button>
              <button className={!prefs.volume ? 'on' : ''} onClick={() => set({ volume: false })}>Hidden</button>
            </div>
          </Line>
          <Line k="Value area" hint={Math.round(prefs.vaPct * 100) + '% of the profile'}>
            <input type="range" min="0.5" max="0.95" step="0.05" value={prefs.vaPct}
              onChange={(e) => set({ vaPct: Number(e.target.value) })} style={{ width: 110 }} />
          </Line>
        </div>

        <div className="acct">
          <button className="mbtn2" onClick={() => set({ ...DEFAULTS })}>Reset to defaults</button>
          <div className="mnote">
            Saved on this device only. Nothing here changes what the server counts — it changes
            how much of it is drawn, in which of the six footprints, and how the two charts
            share the column. Market data, credentials and calculations never leave the server.
          </div>
        </div>
      </div>
    </div>
  );
}
