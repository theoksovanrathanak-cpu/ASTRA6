/* DESENTO order-flow terminal: one screen, one feed, every number traceable.

   Transport: a WebSocket pushes one computed frame a second. If it drops, the client
   falls back to polling the same endpoint and says so, then reconnects on its own. The
   header always shows which of those is happening. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Footprint from './chart.jsx';
import { Feed, Delta, Imbalance, Profile, Behaviour } from './panels.jsx';
import Menu, { useOwner } from './menu.jsx';
import './styles.css';

const TF = [[15, '15s'], [30, '30s'], [60, '1m'], [120, '2m'], [300, '5m'], [900, '15m']];
const STEPS = [[0.01, '0.01'], [0.05, '0.05'], [0.10, '0.10'], [0.25, '0.25'], [0.50, '0.50'], [1, '1.00']];
const MINS = [[60, '1h'], [240, '4h'], [480, '8h'], [1440, '24h']];

function useTape(q) {
  const [data, setData] = useState(null);
  const [link, setLink] = useState({ state: 'connecting', mode: 'ws', errors: 0 });
  const wsRef = useRef(null);
  const pollRef = useRef(null);
  const retryRef = useRef(null);
  const alive = useRef(true);

  const url = useMemo(() => {
    const p = new URLSearchParams({ tf: q.tf, step: q.step, bars: q.bars, ratio: q.ratio,
      stack: q.stack, minutes: q.minutes, sym: q.sym || 'auto' });
    return p.toString();
  }, [q.tf, q.step, q.bars, q.ratio, q.stack, q.minutes, q.sym]);

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
    ws.onopen = () => { stopPoll(); setLink((l) => ({ ...l, state: 'live', mode: 'ws' })); };
    ws.onmessage = (ev) => {
      try { setData(JSON.parse(ev.data)); } catch (e) { /* malformed frame is dropped */ }
    };
    ws.onerror = () => { setLink((l) => ({ ...l, errors: l.errors + 1 })); };
    ws.onclose = () => {
      if (!alive.current) return;
      setLink((l) => ({ ...l, state: 'reconnecting', mode: 'ws' }));
      poll();
      const wait = Math.min(15000, 1200 * Math.pow(1.7, Math.min(6, (wsRef.current ? 1 : 1))));
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

function App() {
  const [q, setQ] = useState({ tf: 60, step: 0.05, bars: 90, ratio: 3.0, stack: 3, minutes: 240, sym: 'auto' });
  const [barW, setBarW] = useState(56);
  const [menu, setMenu] = useState(false);
  const [data, link] = useTape(q);
  const [me, refreshOwner] = useOwner();
  const set = (k, v) => setQ((old) => ({ ...old, [k]: v }));

  const f = (data && data.feed) || {};
  const d = (data && data.decimals) ?? 2;
  const feedState = f.status === 'quiet' ? 'quiet'
    : f.connected ? 'live' : f.status === 'not_configured' ? 'off' : 'down';
  const last = data && data.bars && data.bars[data.bars.length - 1];

  return (
    <div className="dx">
      <header className="hd">
        <button className="mbtn" aria-label="Menu" onClick={() => setMenu(true)}>
          <i /><i /><i />
        </button>
        <div className="brand">
          <div className="mk"><i /></div>
          <div>
            <b>DESENTO</b>
            <span>order flow terminal</span>
          </div>
        </div>
        <div className="sym">
          <b>{data?.symbol || 'XAUUSD'}</b>
          <span className="px">{f.price != null ? Number(f.price).toFixed(d) : '—'}</span>
          <span className="age">{f.age != null ? f.age.toFixed(1) + 's' : ''}</span>
          <i className={'dot ' + (feedState === 'live' ? 'live' : feedState === 'off' ? 'bad' : 'warn')} />
          {feedState === 'quiet' && <span className="age" style={{ color: '#e8c76a' }}>quiet</span>}
        </div>
        {data?.symbol && /247$/.test(data.symbol) && (
          <span className="badge" style={{ borderColor: '#2b3f57', background: '#0d1a26', color: '#9dc0e8' }}
            title="XAUUSD247 is the 24/7 gold contract on this account. It trades through the daily break, and it is charted under its own name - never labelled XAUUSD.">
            24/7 gold
          </span>
        )}
        <span className="badge est" title="Exness publishes bid/ask quotes, not traded volume at each price. This terminal counts ticks: an up-tick is booked as buying, a down-tick as selling, so every volume figure is an estimate, not reported volume.">
          estimated · tick rule
        </span>
        {data?.market && (
          <span className="badge" style={data.market.open ? { borderColor: '#12513a', background: '#0a2018', color: '#5fe0aa' }
            : { borderColor: '#3d3410', background: '#161305', color: '#e8c76a' }}
            title={data.market.detail || 'Gold trades Sunday 22:05 to Friday 20:58 UTC with a daily break 20:58-22:02 UTC.'}>
            {data.market.open ? 'market open' : 'market closed'}
            {!data.market.open && data.market.opens_at
              ? ' · opens ' + new Date(data.market.opens_at * 1000).toLocaleTimeString(
                  undefined, { hour: '2-digit', minute: '2-digit' }) : ''}
          </span>
        )}
        <div className="spacer" />
        <div className="ctrls">
          <div className="seg" role="group" aria-label="Candle size">
            {TF.map(([v, label]) => (
              <button key={v} className={q.tf === v ? 'on' : ''} onClick={() => set('tf', v)}>{label}</button>
            ))}
          </div>
          <label className="fld">price
            <select value={q.step} onChange={(e) => set('step', Number(e.target.value))}>
              {STEPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="fld">imbalance
            <input type="number" min="120" max="2000" step="25" value={Math.round(q.ratio * 100)}
              onChange={(e) => set('ratio', Math.max(1.2, Math.min(20, Number(e.target.value) / 100 || 3)))} />
          </label>
          <label className="fld">profile
            <select value={q.minutes} onChange={(e) => set('minutes', Number(e.target.value))}>
              {MINS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>
      </header>

      <div className="ribbon">
        <span><b>{last ? last.ticks : 0}</b> quotes in the last candle</span>
        <span className="sep" />
        <span><b>{data?.settings?.bars || 90}</b> candles</span>
        <span className="sep" />
        <span>{data?.archive?.ticks ?? 0} quotes archived</span>
        <span className="sep" />
        <span>{data?.profile?.total ?? 0} in profile</span>
        {me.signed_in ? <><span className="sep" /><span>{me.owner ? 'owner' : me.email}</span></> : null}
      </div>

      <div className="main">
        <div className="card">
          <div className="card-h">
            <span>Footprint · bid × ask</span>
            <span className="r">
              {data?.settings ? `${data.settings.tf}s candle · ${data.settings.step} grid` : 'waiting for feed'}
              <span className="m"> · scroll to zoom · drag to pan</span>
            </span>
          </div>
          <Footprint data={data} barW={barW} onBarW={setBarW} />
          <div className="legend">
            <span><i style={{ background: '#16c784' }} />buy imbalance</span>
            <span><i style={{ background: '#ea3943' }} />sell imbalance</span>
            <span><i style={{ background: '#f0b90b' }} />POC</span>
            <span><i style={{ background: '#3d6ea8' }} />VAH / VAL</span>
            <span><i style={{ background: '#4c8dff' }} />cumulative delta</span>
            <span className="m">cells read buys × sells, counted from quotes</span>
            <span className="m">· a dim number is quotes that repeated the price and voted for neither side</span>
          </div>
        </div>

        <div className="side">
          <Feed data={data || {}} />
          <Delta data={data || {}} />
          <Imbalance data={data || {}} />
          <Profile data={data || {}} />
          <Behaviour data={data || {}} />
        </div>
      </div>

      <footer className="foot">
        <span>DESENTO</span>
        <span style={{ flex: 1 }} />
        <span>{data ? new Date(data.server_ts * 1000).toISOString().slice(11, 19) : '--:--:--'} UTC</span>
      </footer>

      <Menu open={menu} onClose={() => setMenu(false)} me={me} refreshOwner={refreshOwner}
        sym={q.sym} onSym={(v) => set('sym', v)} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
