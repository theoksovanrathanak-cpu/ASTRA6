/* The right-hand readouts. Each panel states what it measured and, where it matters,
   how it was measured - the estimate badge is never more than one line away. */

import React from 'react';

const n = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
const sgn = (v, d = 0) => (v == null ? '-' : (v > 0 ? '+' : '') + Number(v).toFixed(d));
const cls = (v) => (v > 0 ? 'g' : v < 0 ? 'r' : 'm');
const hm = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(11, 19) + 'Z' : '-');

export function Feed({ data }) {
  const f = data.feed || {};
  const a = data.archive || {};
  const d = data.decimals ?? 2;
  const state = f.connected ? 'live' : f.status === 'not_configured' ? 'off' : 'reconnect';
  return (
    <div className="card">
      <div className="card-h">Feed <span className="r">
        <i className={'dot ' + (state === 'live' ? 'live' : state === 'off' ? 'bad' : 'warn')} />{state}
      </span></div>
      <div className="big">{f.price != null ? n(f.price, d) : '—'}<span className="m" style={{ fontSize: 11 }}> {data.symbol}</span></div>
      <div className="small">{f.age != null ? `last quote ${f.age.toFixed(1)}s ago` : 'no quote yet'}
        {f.stale ? ' · stale' : ''}</div>
      <div className="rows">
        <div className="row"><span className="k">Quotes recorded</span><span className="v">{a.ticks ?? 0}</span></div>
        <div className="row"><span className="k">Recording since</span><span className="v">{hm(a.first_ts)}</span></div>
        <div className="row"><span className="k">Archive</span><span className="v">{a.persistent ? 'this instance' : 'memory only'}</span></div>
      </div>
      {f.error ? <div className="note" style={{ color: '#ff9aa2' }}>{f.error}</div> : null}
    </div>
  );
}

export function Delta({ data }) {
  const bars = data.bars || [];
  const last = bars[bars.length - 1] || {};
  const cvd = data.cvd || [];
  const div = data.divergence || [];
  const d = data.decimals ?? 2;
  return (
    <div className="card">
      <div className="card-h">Delta <span className="r">tick-rule</span></div>
      <div className="big" style={{ color: last.delta > 0 ? '#16c784' : last.delta < 0 ? '#ea3943' : '#8d9db0' }}>
        {sgn(last.delta, 0)}<span className="m" style={{ fontSize: 10 }}> candle</span>
      </div>
      <div className="small">buys {n(last.buy)} − sells {n(last.sell)} over {last.ticks ?? 0} quotes</div>
      <div className="rows">
        <div className="row"><span className="k">Cumulative (window)</span><span className={'v ' + cls(cvd[cvd.length - 1])}>{sgn(cvd[cvd.length - 1])}</span></div>
        <div className="row"><span className="k">Session (UTC)</span><span className={'v ' + cls(data.session?.delta)}>{sgn(data.session?.delta)}</span></div>
        <div className="row"><span className="k">Candle high / low</span><span className="v">{n(last.high, d)} / {n(last.low, d)}</span></div>
      </div>
      {div.length ? (
        <div className="chips">
          {div.slice(-3).reverse().map((v, i) => (
            <span key={i} className={'chip ' + (v.side === 'bullish' ? 'buy' : 'sell')}>
              {v.side} divergence @ {n(v.price, d)}
            </span>
          ))}
        </div>
      ) : <div className="note">No price / delta divergence in the window. It only prints when price makes a new extreme that cumulative delta refuses to confirm.</div>}
    </div>
  );
}

export function Imbalance({ data }) {
  const ib = data.imbalance || { bars: [] };
  const ratio = Math.round((ib.ratio || 3) * 100);
  const lastBars = (ib.bars || []).slice(-1)[0] || { marks: [], stacks: [] };
  const stacks = (ib.bars || []).slice(-12).flatMap((b) => (b.stacks || []).map((s) => ({ ...s, t0: b.t0 })));
  const d = data.decimals ?? 2;
  return (
    <div className="card">
      <div className="card-h">Imbalance <span className="r">diagonal · {ratio}%</span></div>
      {lastBars.marks.length ? (
        <div className="chips">
          {lastBars.marks.slice(0, 8).map((m, i) => (
            <span key={i} className={'chip ' + (m.side === 'buy' ? 'buy' : 'sell')}>
              {m.side === 'buy' ? 'B' : 'S'} {n(m.price, d)} · {Math.round(m.ratio * 100)}%
            </span>
          ))}
        </div>
      ) : <div className="empty">No level in the newest candle traded {ratio}% more on one side than the level beside it.</div>}
      <div className="rows">
        <div className="row"><span className="k">Stacked runs (12 bars)</span><span className="v">{stacks.length}</span></div>
        <div className="row"><span className="k">Longest run</span><span className="v">{stacks.length ? Math.max(...stacks.map((s) => s.levels)) + ' levels' : '—'}</span></div>
      </div>
      {stacks.length ? (
        <div className="chips">
          {stacks.slice(-4).reverse().map((s, i) => (
            <span key={i} className={'chip ' + (s.side === 'buy' ? 'buy' : 'sell')}>
              {s.side} stack {n(s.to, d)}–{n(s.from, d)} · {s.levels}
            </span>
          ))}
        </div>
      ) : null}
      <div className="note">A level is marked when its buys are {ratio}% of the sells one level below (or the mirror). Diagonal, not same-price, so it reads the book imbalance rather than a ratio of one cell.</div>
    </div>
  );
}

export function Profile({ data }) {
  const p = data.profile || {};
  const d = data.decimals ?? 2;
  const levels = p.levels || [];
  const max = Math.max(1, ...levels.map((r) => r[4]));
  return (
    <div className="card">
      <div className="card-h">Volume profile <span className="r">{data.settings?.minutes ?? 240}m</span></div>
      <div className="rows">
        <div className="row"><span className="k">POC</span><span className="v a">{n(p.poc, d)}</span></div>
        <div className="row"><span className="k">Value area high</span><span className="v b">{n(p.vah, d)}</span></div>
        <div className="row"><span className="k">Value area low</span><span className="v b">{n(p.val, d)}</span></div>
        <div className="row"><span className="k">Total ticks</span><span className="v">{n(p.total)}</span></div>
      </div>
      <div className="chips">
        {(p.hvn || []).slice(0, 4).map((v, i) => <span key={'h' + i} className="chip zone">HVN {n(v, d)}</span>)}
        {(p.lvn || []).slice(0, 4).map((v, i) => <span key={'l' + i} className="chip">LVN {n(v, d)}</span>)}
      </div>
      <div className="list">
        {levels.slice(0, 40).map((r) => {
          const w = Math.round((r[4] / max) * 100);
          const inside = p.val != null && r[0] <= p.vah && r[0] >= p.val;
          return (
            <div key={r[0]} className="row" style={{ paddingTop: 3, paddingBottom: 3 }}>
              <span className="v" style={{ width: 56, color: r[0] === p.poc ? '#f0b90b' : inside ? '#a8c4e6' : '#7d8ea3' }}>{n(r[0], d)}</span>
              <span style={{ flex: 1, height: 6, background: '#111a24', borderRadius: 2, position: 'relative', overflow: 'hidden' }}>
                <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: w + '%',
                  background: r[0] === p.poc ? '#f0b90b' : inside ? '#2b5b8f' : '#1d2b3a' }} />
              </span>
              <span className="v m" style={{ width: 46, textAlign: 'right' }}>{n(r[4])}</span>
            </div>
          );
        })}
      </div>
      <div className="note">Value area is 70% of the profile, grown outwards from the POC. Bars are counted quotes at each price, not contracts.</div>
    </div>
  );
}

export function Behaviour({ data }) {
  const ab = data.absorption || [];
  const ex = data.exhaustion || [];
  const ag = data.aggressive || [];
  const d = data.decimals ?? 2;
  return (
    <div className="card">
      <div className="card-h">Behaviour <span className="r">from quotes</span></div>
      <div className="rows">
        <div className="row"><span className="k">Absorption zones</span><span className="v">{ab.length}</span></div>
        <div className="row"><span className="k">Exhaustion bars</span><span className="v">{ex.length}</span></div>
        <div className="row"><span className="k">One-sided bars</span><span className="v">{ag.length}</span></div>
      </div>
      {ab.length ? (
        <div className="chips">
          {ab.slice(0, 4).map((z, i) => (
            <span key={i} className="chip zone">{n(z.price, d)} · {n(z.volume)} ticks · {z.candles} bars</span>
          ))}
        </div>
      ) : <div className="empty">No level has yet taken repeated two-way volume without the price leaving it.</div>}
      {ex.length ? (
        <div className="chips">
          {ex.slice(-3).map((e, i) => (
            <span key={'e' + i} className="chip sell">exhaustion {hm(e.t0)} · {n(e.volume)} ticks · Δ {sgn(e.delta)}</span>
          ))}
        </div>
      ) : null}
      {ag.length ? (
        <div className="chips">
          {ag.slice(-3).map((a, i) => (
            <span key={'a' + i} className={'chip ' + (a.side === 'buy' ? 'buy' : 'sell')}>
              {a.side} {Math.round(a.share * 100)}% {hm(a.t0)}
            </span>
          ))}
        </div>
      ) : null}
      <div className="note">Absorption: a level holding twice the average level volume, visited by 3+ candles, with net delta under 15% of its own volume. Exhaustion: volume twice the window average while the bar's range stays under half the average.</div>
    </div>
  );
}
