/* DESENTO order flow terminal.

   Two charts, one view: the market price candles and the bid × ask footprint are drawn from
   the same bars, share the same horizontal window and the same crosshair, and are read
   against the same delta, CVD and volume profile underneath. There is one WebSocket frame a
   second; if it drops the page polls the same endpoint and says so.

   Nothing here invents a price, a candle or a volume. The header keeps the estimate badge
   because Exness publishes quotes, not traded size. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Price from './price.jsx';
import Footprint, { MODES, MODE_HINT } from './chart.jsx';
import { Sidebar, Cvd, DeltaHist, Profile, screenProfile, valueArea } from './analytics.jsx';
import Menu, { useOwner } from './menu.jsx';
import Settings, { usePrefs } from './settings.jsx';
import './styles.css';

const TF = [
  [15, '15s'], [30, '30s'], [60, '1m'], [120, '2m'], [180, '3m'], [300, '5m'], [600, '10m'],
  [900, '15m'], [1800, '30m'], [3600, '1h'], [7200, '2h'], [14400, '4h'], [86400, '1D'],
];
const STEPS = [[0.01, '0.01'], [0.05, '0.05'], [0.10, '0.10'], [0.25, '0.25'], [0.50, '0.50'], [1, '1.00']];
const MINS = [[60, '1h'], [240, '4h'], [480, '8h'], [1440, '24h']];
const HIST = [90, 180, 360];
const SYMS = [['auto', 'Auto'], ['XAUUSD', 'XAUUSD'], ['XAUUSD247', '247']];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function useTape(q) {
  const [data, setData] = useState(null);
  const [link, setLink] = useState({ state: 'connecting', mode: 'ws', errors: 0 });
  const wsRef = useRef(null);
  const pollRef = useRef(null);
  const retryRef = useRef(null);
  const alive = useRef(true);
  const tries = useRef(0);

  const url = useMemo(() => new URLSearchParams({
    tf: q.tf, step: q.step, bars: q.bars, ratio: q.ratio,
    stack: q.stack, minutes: q.minutes, sym: q.sym || 'auto',
  }).toString(), [q.tf, q.step, q.bars, q.ratio, q.stack, q.minutes, q.sym]);

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const poll = useCallback(() => {
    stopPoll();
    const tick = async () => {
      try {
        const r = await fetch('/api/tape/snapshot?' + url);
        if (!r.ok) throw new Error('http ' + r.status);
        setData(await r.json());
        setLink((l) => ({ ...l, state: 'polling', mode: 'http' }));
      } catch (e) {
        setLink((l) => ({ ...l, state: 'offline', mode: 'http', errors: l.errors + 1 }));
      }
    };
    tick();
    pollRef.current = setInterval(tick, 2000);
  }, [url]);

  const connect = useCallback(() => {
    if (!alive.current) return;
    try { if (wsRef.current) wsRef.current.close(); } catch (e) { /* already gone */ }
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws/tape?' + url);
    } catch (e) { poll(); return; }
    wsRef.current = ws;
    setLink((l) => ({ ...l, state: 'connecting', mode: 'ws' }));
    ws.onopen = () => { tries.current = 0; stopPoll(); setLink((l) => ({ ...l, state: 'live', mode: 'ws' })); };
    ws.onmessage = (ev) => { try { setData(JSON.parse(ev.data)); } catch (e) { /* dropped */ } };
    ws.onerror = () => { setLink((l) => ({ ...l, errors: l.errors + 1 })); };
    ws.onclose = () => {
      if (!alive.current) return;
      tries.current += 1;
      setLink((l) => ({ ...l, state: 'reconnecting', mode: 'ws' }));
      poll();
      const wait = Math.min(20000, 1000 * Math.pow(1.7, Math.min(6, tries.current)));
      retryRef.current = setTimeout(() => { if (alive.current) connect(); }, wait);
    };
  }, [url, poll]);

  useEffect(() => {
    alive.current = true;
    connect();
    return () => {
      alive.current = false;
      if (wsRef.current) { try { wsRef.current.close(); } catch (e) { /* */ } }
      if (retryRef.current) clearTimeout(retryRef.current);
      stopPoll();
    };
  }, [connect]);

  return [data, link];
}

/* the one breakpoint the layout reacts to; the tabs only exist on a phone */
function useMedia(query) {
  const [hit, setHit] = useState(() => typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const on = () => setHit(mql.matches);
    on();
    if (mql.addEventListener) mql.addEventListener('change', on);
    else if (mql.addListener) mql.addListener(on);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', on);
      else if (mql.removeListener) mql.removeListener(on);
    };
  }, [query]);
  return hit;
}

const n2 = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
const n0 = (v) => (v == null ? '—' : Number(v).toLocaleString());

function Icon({ name }) {
  const p = {
    menu: 'M4 7h16M4 12h16M4 17h16',
    gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.5 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.5a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.5 9v.1a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    full: 'M4 9V4h5M20 9V4h-5M20 15v5h-5M4 15v5h5',
    chart: 'M3 20V10M9 20V4M15 20v-7M21 20V7',
    layers: 'M12 3 3 8l9 5 9-5-9-5zM3 14l9 5 9-5',
    profile: 'M4 5h16M7 10h13M10 15h10M13 20h7',
  }[name];
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={p} />
    </svg>
  );
}

function App() {
  const [q, setQ] = useState({ tf: 60, step: 0.05, bars: 90, ratio: 3.0, stack: 3, minutes: 240, sym: 'auto' });
  const [prefs, setPrefs] = usePrefs();
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [full, setFull] = useState('');            // '' | 'price' | 'footprint'
  const [tab, setTab] = useState('price');         // mobile only
  const [barW, setBarW] = useState(58);
  const [hoff, setHoff] = useState(0);
  const [hover, setHover] = useState(null);
  const [colW, setColW] = useState(900);
  const [data, link] = useTape(q);
  const [me, refreshOwner] = useOwner();
  const set = (k, v) => setQ((old) => ({ ...old, [k]: v }));

  const stack = useRef(null);
  const mobile = useMedia('(max-width: 820px)');

  useEffect(() => {
    const el = stack.current;
    if (!el) return undefined;
    const m = () => setColW(el.clientWidth || 900);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const f = (data && data.feed) || {};
  const d = (data && data.decimals) ?? 2;
  const bars = (data && data.bars) || [];

  // one view for both charts: the same start index, the same count, the same column width
  const n = useMemo(() => clamp(Math.floor((colW - 80) / barW), 1, Math.max(1, bars.length)), [colW, barW, bars.length]);
  const maxStart = Math.max(0, bars.length - n);
  const start = clamp(maxStart - hoff, 0, maxStart);
  const view = { start, n, barW };
  const visible = bars.slice(start, start + n);

  const onPan = useCallback((bars1) => {
    setHoff((h) => clamp(h + Math.round(bars1 * 1), 0, Math.max(0, bars.length - n)));
  }, [bars.length, n]);
  const onZoom = useCallback((delta) => {
    setBarW((w) => clamp(Math.round(w + delta), 36, 140));
  }, []);

  const lastPx = f.price != null ? f.price : (visible.length ? visible[visible.length - 1].close : null);
  const first = visible[0];
  const chg = first && lastPx != null ? lastPx - first.open : null;
  const chgPct = chg != null && first.open ? (chg / first.open) * 100 : null;

  // one profile for the whole page: the POC and value area drawn on the footprint are the
  // same ones the profile panel lists, over the candles both charts are showing
  const viewData = useMemo(() => {
    if (!data) return data;
    const levels = screenProfile(visible);
    if (!levels.length) return data;
    const va = valueArea(levels, prefs.vaPct);
    return {
      ...data,
      profile: {
        ...(data.profile || {}),
        levels,
        poc: va.poc,
        vah: va.vah,
        val: va.val,
        total: levels.reduce((a, r) => a + (r[4] || 0), 0),
        value_area: prefs.vaPct,
      },
    };
  }, [data, visible, prefs.vaPct]);

  const feedState = f.status === 'quiet' ? 'quiet' : f.connected ? 'live' : f.status === 'not_configured' ? 'off' : 'down';
  const dot = feedState === 'live' ? 'live' : feedState === 'off' || feedState === 'down' ? 'bad' : 'warn';

  const hoverBar = useMemo(() => {
    if (!hover || hover.t0 == null) return null;
    return bars.find((b) => b.t0 === hover.t0) || null;
  }, [hover, bars]);
  const ohlc = hoverBar || (visible.length ? visible[visible.length - 1] : null);

  useEffect(() => {
    if (!full) return undefined;
    const esc = (e) => { if (e.key === 'Escape') setFull(''); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [full]);

  const chartH = prefs.chartH;
  const split = clamp(prefs.split ?? 0.42, 0.22, 0.72);
  const priceH = Math.round(chartH * split);
  const footH = Math.max(240, chartH - priceH);

  const onSplit = (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = split;
    const move = (ev) => {
      const dy = ev.clientY - y0;
      setPrefs({ split: clamp(h0 + dy / Math.max(320, chartH), 0.22, 0.72) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const showPrice = !mobile || tab === 'price';
  const showFoot = !mobile || tab === 'footprint';

  return (
    <div className="dx" data-tab={tab}>
      <header className="nav">
        <button className="mbtn" aria-label="Menu" onClick={() => setMenu(true)}><i /><i /><i /></button>
        <div className="brand">
          <div className="mk"><i /></div>
          <div><b>DESENTO</b><span>Order Flow Terminal</span></div>
        </div>
        <div className="vsep" />

        <div className="inst">
          <div className="symsel" role="group" aria-label="Instrument">
            {SYMS.map(([v, t]) => (
              <button key={v} className={q.sym === v ? 'on' : ''} onClick={() => set('sym', v)}
                title={v === 'auto' ? 'Auto follows whichever gold contract is printing' : v}>{t}</button>
            ))}
          </div>
          <div className="px">
            <span className="sym">{data?.symbol || 'XAUUSD'}</span>
            <span className="last">{lastPx != null ? n2(lastPx, d) : '—'}</span>
            {chg != null ? (
              <span className="chg" style={{ color: chg >= 0 ? 'var(--bull)' : 'var(--bear)' }}
                title="Change since the first candle on screen">
                {chg >= 0 ? '+' : ''}{n2(chg, d)} ({chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%)
              </span>
            ) : null}
          </div>
          <span className={'mkt ' + (data?.market?.open ? 'open' : 'shut')}
            title={data?.market?.detail || 'Gold trades Sunday 22:05 to Friday 20:58 UTC with a daily break 20:58-22:02 UTC.'}>
            <i className={'dot ' + (data?.market?.open ? 'live' : 'warn')} />
            {data?.market?.open ? 'open' : 'closed'}
            {data?.market && !data.market.open && data.market.opens_at
              ? ' · ' + new Date(data.market.opens_at * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
              : ''}
          </span>
          {data?.symbol && /247$/.test(data.symbol) ? (
            <span className="badge blue" title="XAUUSD247 is the 24/7 gold contract on this account. It trades through the daily break and is charted under its own name — never labelled XAUUSD.">
              24/7 gold
            </span>
          ) : null}
          <span className="quotechips" title="Bid and ask exactly as the wire sent them. The spread is their difference — never derived from a mid.">
            <span className="qc"><em>bid</em>{f.bid != null ? n2(f.bid, d) : '—'}</span>
            <span className="qc"><em>ask</em>{f.ask != null ? n2(f.ask, d) : '—'}</span>
            <span className="qc"><em>spr</em>{f.spread != null ? Number(f.spread).toFixed(Math.min(3, d)) : '—'}</span>
          </span>
          <span className="badge" title="Exness publishes bid/ask quotes, not traded volume at each price. This terminal counts quotes: a quote above the previous one is booked to the ask, below to the bid. Every volume figure is an estimate of pressure, not reported volume.">
            estimated · tick rule
          </span>
        </div>

        <div className="spacer" />

        <div className="right">
          <div className="conn" title="WebSocket state and the age of the last quote">
            <i className={'dot ' + dot} />
            <span className="lbl"><b>{feedState}</b>{f.age != null ? ' · ' + f.age.toFixed(1) + 's' : ''}</span>
          </div>
          <button className={'icobtn' + (settings ? ' on' : '')} onClick={() => setSettings(true)} title="Settings" aria-label="Settings"><Icon name="gear" /></button>
          <button className={'icobtn' + (full ? ' on' : '')} onClick={() => setFull(full ? '' : 'footprint')}
            title={full ? 'Leave full screen' : 'Full screen footprint'} aria-label="Full screen"><Icon name="full" /></button>
          <button className={'acct-btn' + (me.signed_in ? ' on' : '')} onClick={() => setMenu(true)}
            title={me.signed_in ? (me.email || 'signed in') : 'Owner sign-in'} aria-label="Account">
            {me.signed_in ? (me.email || 'me').slice(0, 1) : '·'}
          </button>
        </div>
      </header>

      <div className="toolbar">
        <div className="seg tfs" role="group" aria-label="Candle size">
          {TF.map(([v, l]) => <button key={v} className={q.tf === v ? 'on' : ''} onClick={() => set('tf', v)}>{l}</button>)}
        </div>
        <div className="vsep" />
        <div className="seg modes" role="group" aria-label="Footprint mode">
          {MODES.map(([v, l]) => (
            <button key={v} className={prefs.mode === v ? 'on' : ''} onClick={() => setPrefs({ mode: v })}
              title={MODE_HINT[v]}>{l}</button>
          ))}
        </div>
        <div className="vsep" />
        <label className="fld">price
          <select value={q.step} onChange={(e) => set('step', Number(e.target.value))}>
            {STEPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="fld">imbalance %
          <input type="number" min="120" max="2000" step="25" value={Math.round(q.ratio * 100)}
            onChange={(e) => set('ratio', Math.max(1.2, Math.min(20, Number(e.target.value) / 100 || 3)))} />
        </label>
        <label className="fld">profile
          <select value={q.minutes} onChange={(e) => set('minutes', Number(e.target.value))}>
            {MINS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="fld">min size
          <select value={prefs.filter} onChange={(e) => setPrefs({ filter: Number(e.target.value) })}
            title="Hide price levels below this many counted quotes">
            {[0, 2, 5, 10, 20].map((v) => <option key={v} value={v}>{v === 0 ? 'off' : v + '+'}</option>)}
          </select>
        </label>
        <label className="fld">history
          <select value={q.bars} onChange={(e) => set('bars', Number(e.target.value))}>
            {HIST.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <div className="tb-right">
          <button className={'icobtn' + (prefs.volume ? ' on' : '')} onClick={() => setPrefs({ volume: !prefs.volume })}
            title="Volume histogram on the price chart" aria-label="Volume histogram">vol</button>
          <button className={'icobtn' + (prefs.sidebar ? ' on' : '')} onClick={() => setPrefs({ sidebar: !prefs.sidebar })}
            title={prefs.sidebar ? 'Hide the analytics column' : 'Show the analytics column'} aria-label="Analytics column">
            <Icon name="layers" />
          </button>
          <button className="icobtn" onClick={() => setSettings(true)} title="Chart settings" aria-label="Chart settings">
            <Icon name="gear" />
          </button>
        </div>
      </div>

      <div className={'work' + (prefs.sidebar && !mobile ? '' : ' noside')}>
        <div className="stack" ref={stack}>
          {showPrice ? (
            <section className={'panel t-price pricepanel' + (full === 'price' ? ' zoomed' : '')}
              style={full === 'price' ? null : { height: priceH }}>
              <div className="p-head">
                Price · {data?.symbol || 'XAUUSD'} · {TF.find(([v]) => v === q.tf)?.[1] || q.tf}
                <span className="ohlc">
                  {ohlc ? (
                    <>
                      <span className="m">{new Date(ohlc.t0 * 1000).toISOString().slice(11, 19)}</span>
                      <span><em>O</em> {n2(ohlc.open, d)}</span>
                      <span><em>H</em> {n2(ohlc.high, d)}</span>
                      <span><em>L</em> {n2(ohlc.low, d)}</span>
                      <span><em>C</em> {n2(ohlc.close, d)}</span>
                      <span className={ohlc.delta >= 0 ? 'g' : 'r'}><em>Δ</em> {ohlc.delta > 0 ? '+' : ''}{n0(ohlc.delta)}</span>
                      <span><em>V</em> {n0(ohlc.volume)}</span>
                    </>
                  ) : <span className="m">no candle</span>}
                </span>
                <span className="r">
                  <button className="tiny" onClick={() => setFull(full === 'price' ? '' : 'price')}>
                    {full === 'price' ? 'exit full screen' : 'full screen'}
                  </button>
                </span>
              </div>
              <Price bars={bars} view={view} decimals={d} feed={f} hover={hover}
                onHover={setHover} onPan={onPan} onZoom={onZoom} showVolume={prefs.volume} />
            </section>
          ) : null}

          {!mobile ? <div className="splitter" onPointerDown={onSplit} title="Drag to resize the two charts" /> : null}

          {showFoot ? (
            <section className={'panel t-foot footprintpanel' + (full === 'footprint' ? ' zoomed' : '')}
              style={full === 'footprint' ? null : { height: footH, flex: 1 }}>
              <div className="p-head">
                Footprint · {data?.symbol || 'XAUUSD'} · {TF.find(([v]) => v === q.tf)?.[1] || q.tf} · {q.step} grid
                <span className="r">
                  <span className="m">{MODES.find(([v]) => v === prefs.mode)?.[1]}</span>
                  <span>{visible.length} candles</span>
                  <button className="tiny" onClick={() => setFull(full === 'footprint' ? '' : 'footprint')}>
                    {full === 'footprint' ? 'exit full screen' : 'full screen'}
                  </button>
                </span>
              </div>
              <Footprint data={viewData} view={view} opts={{ ...prefs, onUse247: () => set('sym', 'XAUUSD247') }}
                hover={hover} onHover={setHover}
                onPan={onPan} onZoom={onZoom} full={full === 'footprint'}
                onFull={(v) => setFull(v ? 'footprint' : '')} />
              <div className="legend">
                <span><i style={{ background: 'var(--bull)' }} />ask imbalance</span>
                <span><i style={{ background: 'var(--bear)' }} />bid imbalance</span>
                <span><i style={{ background: 'var(--poc)' }} />POC</span>
                <span><i style={{ background: 'var(--va)' }} />VAH / VAL</span>
                <span className="m">cell = bid on the left, ask on the right</span>
                <span className="m">a dim · is a quote that repeated the price and voted for neither side</span>
              </div>
            </section>
          ) : null}
        </div>

        {prefs.sidebar && !mobile ? (
          <aside className="side side-scroll">
            <Sidebar data={viewData || {}} bars={visible} />
          </aside>
        ) : null}
      </div>

      <div className="under">
        {(!mobile || tab === 'delta') ? (
          <div className="duo">
            <div className="panel">
              <Cvd bars={visible} rebase={prefs.cvdRebase}
                onRebase={(v) => setPrefs({ cvdRebase: v })} />
            </div>
            <div className="panel">
              <DeltaHist bars={visible} />
            </div>
          </div>
        ) : null}
        {(!mobile || tab === 'profile') ? (
          <div className="panel">
            <Profile data={viewData || {}} bars={visible} pct={prefs.vaPct}
              onPct={(v) => setPrefs({ vaPct: v })} />
          </div>
        ) : null}
      </div>

      <footer className="foot">
        <span>DESENTO</span>
        <span className="vsep" />
        <span>order flow terminal</span>
        <span className="vsep" />
        <span>{data ? new Date(data.server_ts * 1000).toISOString().slice(11, 19) : '--:--:--'} UTC</span>
        <span className="vsep" />
        <span>{link.mode === 'ws' ? 'websocket' : 'http polling'} · {link.state}</span>
        <span className="vsep" />
        <span>{data?.archive?.ticks ?? 0} quotes archived</span>
        <span style={{ flex: 1 }} />
        <span className="m">every volume here is counted quotes, not reported traded volume</span>
      </footer>

      <nav className="bnav" aria-label="Sections">
        <button className={tab === 'price' ? 'on' : ''} onClick={() => setTab('price')}><Icon name="chart" />Price</button>
        <button className={tab === 'footprint' ? 'on' : ''} onClick={() => setTab('footprint')}><Icon name="layers" />Footprint</button>
        <button className={tab === 'delta' ? 'on' : ''} onClick={() => setTab('delta')}><Icon name="chart" />Delta</button>
        <button className={tab === 'profile' ? 'on' : ''} onClick={() => setTab('profile')}><Icon name="profile" />Profile</button>
        <button onClick={() => setMenu(true)}><Icon name="menu" />Menu</button>
      </nav>

      <Menu open={menu} onClose={() => setMenu(false)} me={me} refreshOwner={refreshOwner}
        sym={q.sym} onSym={(v) => set('sym', v)} />
      <Settings open={settings} onClose={() => setSettings(false)} prefs={prefs} set={setPrefs} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (location.protocol === 'https:' || local) {
    try { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}); } catch (e) { /* no worker scope */ }
  }
}
