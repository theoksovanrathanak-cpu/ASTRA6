/* The four things the drawer is for.

   Economic calendar, the gold-fundamentals reading, this device's alerts and the install
   button - the same four the signals page carries, on the terminal itself so the chart is
   not a dead end.

   Nothing here is typed in by the page. The calendar is /api/calendar, the reading is
   /api/fundamentals/gold (rebuilt on the server's 90-second clock, and the page follows
   that clock instead of guessing), alerts go through the browser's own push service, and
   the install card only offers a one-tap install when the browser has actually handed us
   an install prompt. When a thing is not available, the card says so instead of showing a
   placeholder number. */

import React, { useCallback, useEffect, useRef, useState } from 'react';

/* ---------- small formatters ---------- */

const clock = (ts) => {
  try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return ''; }
};
const day = (ts) => {
  try { return new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }); }
  catch (e) { return ''; }
};
const ago = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  if (n < 90) return 'just now';
  if (n < 3600) return Math.floor(n / 60) + ' min ago';
  if (n < 86400) return Math.floor(n / 3600) + ' h ago';
  return Math.floor(n / 86400) + ' d ago';
};
const mmss = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  const m = Math.floor(n / 60), r = n % 60;
  return (m > 0 ? m + 'm ' : '') + String(r).padStart(2, '0') + 's';
};
const host = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u || 'the calendar feed'); }
};

/* ---------- economic calendar ---------- */

export function CalendarCard() {
  const [cal, setCal] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/calendar', { cache: 'no-store' });
      const d = await r.json();
      if (d && d.status === 'ok') { setCal(d); setErr(''); }
      else setErr('the calendar feed is unreachable right now');
    } catch (e) { setErr('the calendar feed is unreachable right now'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const nh = cal && cal.next_high;
  const events = (cal && cal.calendar) || [];
  return (
    <div className="msec">
      <div className="mlabel">Economic calendar</div>
      {nh ? (
        <div className="mrow">
          <span className="mcur">{nh.currency || '—'}</span>
          <span className="mx">{nh.title} · {day(nh.time)} {clock(nh.time)}</span>
        </div>
      ) : cal ? (
        <div className="mrow"><span className="mx">no high-impact event scheduled</span></div>
      ) : (
        <div className="mrow"><span className={'mx' + (err ? '' : ' sk')}>{err || 'loading the calendar…'}</span></div>
      )}

      <button className="mbtn2" onClick={() => setOpen((v) => !v)}>
        {open ? 'Close calendar' : 'Open calendar'}
      </button>

      {open ? (
        events.length ? (
          <div className="mlist">
            {events.slice(0, 40).map((e, i) => (
              <div className="mev" key={e.time + '-' + i}>
                <span className={'mimp ' + (e.impact === 'High' ? 'hi' : 'med')}>{e.impact === 'High' ? 'HIGH' : 'MED'}</span>
                <span className="mcur">{e.currency || '—'}</span>
                <span className="mt">{e.title}</span>
                <span className="mwhen">{day(e.time)} {clock(e.time)}</span>
                {(e.actual || e.forecast) ? (
                  <span className="mnum">
                    {e.forecast ? 'f ' + e.forecast + (e.unit || '') : ''}
                    {e.actual ? ' · a ' + e.actual + (e.unit || '') : ''}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="mnote">{cal && cal.status === 'ok'
            ? 'Nothing High or Medium impact is scheduled in the next ten days.'
            : 'The list is not available right now — nothing is invented to fill it.'}</div>
        )
      ) : null}
      {open && cal ? (
        <div className="mnote">
          Source: {host(cal.source)}. Times are in your own timezone. Nothing here is written
          or summarised by Desento.
        </div>
      ) : null}
    </div>
  );
}

/* ---------- gold fundamentals ---------- */

const BIAS_WORD = (gf) => {
  if (!gf || gf.status !== 'ok') return 'N/A';
  if (gf.stale) return 'NO NEWS';
  return gf.bias === 'BUY' ? 'BUY' : gf.bias === 'SELL' ? 'SELL' : 'NO EDGE';
};
const BIAS_CLASS = (gf) => {
  if (!gf || gf.status !== 'ok' || gf.stale) return 'hold';
  return gf.bias === 'BUY' ? 'buy' : gf.bias === 'SELL' ? 'sell' : 'hold';
};

export function GoldCard() {
  const [gf, setGf] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now() / 1000);
  const aligned = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/fundamentals/gold?limit=12', { cache: 'no-store' });
      const d = await r.json();
      if (d && d.status === 'ok') { setGf(d); setErr(''); }
      else setErr('the gold feeds are unreachable right now');
    } catch (e) { setErr('the gold feeds are unreachable right now'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // one interval, text only: it counts the server's own next-update second down, and it
  // re-reads the reading when that second passes instead of on a timer of its own
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const n = Date.now() / 1000;
      setNow(n);
      if (gf && gf.next_update && n > gf.next_update + 2 && aligned.current !== gf.next_update) {
        aligned.current = gf.next_update;
        load();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [gf, load]);

  const top = gf && (gf.stories || [])[0];
  const bits = [];
  if (gf && gf.news_age != null) bits.push('newest story ' + ago(gf.news_age));
  if (gf && (gf.feeds || []).length) bits.push(gf.feeds.length + ' wires');
  const fast = gf ? (gf.feeds || []).filter((f) => f.age != null).sort((a, b) => a.age - b.age)[0] : null;
  if (fast) bits.push('fastest: ' + fast.name);

  const left = gf && gf.next_update ? Math.max(0, gf.next_update - now) : null;
  const period = (gf && gf.period_s) || 90;

  return (
    <div className="msec">
      <div className="mlabel">Gold fundamentals · XAUUSD</div>

      {gf && gf.status === 'ok' ? (
        <>
          <div className="mrow">
            <span className={'mtag ' + BIAS_CLASS(gf)}>{BIAS_WORD(gf)}</span>
            <span className="mx">{top ? top.title : 'no gold headline right now'}</span>
          </div>
          <div className="mrow mono">
            <span className="mx">
              next reading in {left == null ? '—' : mmss(left)} · every {period} s
            </span>
          </div>
          <div className="mrow mono">
            <span className="mx">{bits.length ? bits.join(' · ') : 'the wires have not reported yet'}</span>
          </div>
        </>
      ) : (
        <div className="mrow"><span className={'mx' + (err ? '' : ' sk')}>{err || 'reading the gold headlines…'}</span></div>
      )}

      <button className="mbtn2" onClick={() => setOpen((v) => !v)}>
        {open ? 'Close gold fundamentals' : 'Open gold fundamentals'}
      </button>

      {open && gf && gf.status === 'ok' ? (
        <>
          <div className="mrow">
            <span className={'mtag ' + BIAS_CLASS(gf)}>{BIAS_WORD(gf)}</span>
            <span className="mx">
              {gf.stale ? 'no fresh headline to score — the market is quiet'
                : gf.bias === 'BUY' ? 'the news is bidding gold'
                  : gf.bias === 'SELL' ? 'the news is offering gold' : 'the news is balanced'}
            </span>
          </div>
          <div className="mrow mono">
            <span className="mx">
              {gf.buy} for gold · {gf.sell} against · {gf.voters} stories scored ({gf.score > 0 ? '+' : ''}{gf.score})
            </span>
          </div>
          {gf.market_open ? null : (
            <div className="mnote">
              Gold is closed for now{gf.reopen_at ? ' · reopens ' + clock(gf.reopen_at) : ''}. The reading still
              follows the wires; no price is invented while the market is shut.
            </div>
          )}
          <div className="mlist">
            {(gf.stories || []).slice(0, 8).map((s, i) => (
              <a className="mstory" key={(s.url || '') + i} href={s.url} target="_blank" rel="noopener">
                <span className="mstory-h">
                  <span className={'mtag ' + (s.impact === 'BUY' ? 'buy' : s.impact === 'SELL' ? 'sell' : 'hold')}>
                    {s.impact}
                  </span>
                  <span className="mt">{s.title}</span>
                </span>
                <span className="mnote-t">{s.why}</span>
                <span className="mwhen">{s.source} · {ago((gf.now || now) - (s.time || 0))}</span>
              </a>
            ))}
          </div>
          {(gf.watch || []).length ? (
            <div className="mnote">
              Next on the calendar: {(gf.watch[0].currency || '')} {gf.watch[0].title} · {day(gf.watch[0].time)} {clock(gf.watch[0].time)}
            </div>
          ) : null}
          <div className="mnote">
            Every headline is read by a fixed rule table and newer stories weigh more. It is a
            summary of published news, not a forecast and not advice — no stop, no target.
          </div>
        </>
      ) : null}
      {open && !(gf && gf.status === 'ok') ? (
        <div className="mnote">{err || 'The reading is on its way.'}</div>
      ) : null}
    </div>
  );
}

/* ---------- alerts on this device ---------- */

const pushSupported = () => typeof window !== 'undefined'
  && 'serviceWorker' in (navigator || {})
  && 'PushManager' in (window || {})
  && typeof Notification !== 'undefined';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent || '')
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  || navigator.standalone === true;

function b64ToU8(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function AlertsCard({ sym }) {
  const [state, setState] = useState('off');     // off | on | denied | busy | error
  const [msg, setMsg] = useState('');
  const [ep, setEp] = useState('');
  const reg = useRef(null);

  // a phone that already subscribed stays subscribed across a reload: read it back
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        if (!pushSupported()) return;
        const r = await navigator.serviceWorker.getRegistration('/');
        if (!r) return;
        const sub = await r.pushManager.getSubscription();
        if (!dead && sub) { reg.current = r; setEp(sub.endpoint); setState('on'); }
        if (!dead && typeof Notification !== 'undefined' && Notification.permission === 'denied') setState('denied');
      } catch (e) { /* nothing stored, nothing to read */ }
    })();
    return () => { dead = true; };
  }, []);

  // the signals page keeps its alarms and its two card switches in localStorage; the
  // drawer reads the same keys instead of overwriting them, so switching alerts on here
  // does not disarm what was armed there
  const flag = (k, dflt) => {
    try { const v = localStorage.getItem(k); return v == null ? dflt : v === '1'; }
    catch (e) { return dflt; }
  };
  const localRules = () => {
    try {
      const a = JSON.parse(localStorage.getItem('astra6_alt_alerts') || '[]');
      if (!Array.isArray(a)) return [];
      return a.filter((x) => x && x.on && !x.fired)
        .map((x) => ({ id: x.id, sym: x.sym, kind: x.kind, price: x.price }));
    } catch (e) { return []; }
  };
  const payload = (sub) => ({
    subscription: sub,
    rules: localRules(),
    readCard: { on: flag('astra6_push_read', true), syms: [sym || 'XAUUSD'] },
    fundCard: { on: flag('astra6_push_fund', true), sym: 'XAUUSD' },
    ua: (navigator.userAgent || '').slice(0, 110),
  });

  const turnOn = async () => {
    setMsg('');
    if (isIOS() && !standalone()) {
      setMsg('On iPhone a card can only reach the lock screen from an app on the Home Screen. '
        + 'Add Desento first (Install, below), open it from that icon, then turn alerts on here.');
      return;
    }
    if (!pushSupported()) {
      setMsg('This browser cannot receive push notifications.');
      return;
    }
    setState('busy');
    try {
      const r = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      reg.current = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState('denied');
        setMsg('Notifications are blocked in the browser settings. Allow them for this site, then try again.');
        return;
      }
      const v = await (await fetch('/api/push/vapid', { cache: 'no-store' })).json();
      if (!v || v.status !== 'ok' || !v.publicKey) {
        setState('off');
        setMsg('The server has no push keys configured, so nothing could ring. It says so rather than pretending.');
        return;
      }
      // a handle the push service already refused is not cured by re-sending it
      let sub = await reg.current.pushManager.getSubscription();
      if (sub) { try { await sub.unsubscribe(); } catch (e) { /* already gone */ } sub = null; }
      sub = await reg.current.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: b64ToU8(v.publicKey),
      });
      const out = await (await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(sub)),
      })).json();
      if (!out || out.status !== 'ok') {
        setState('error');
        setMsg('The server did not accept the subscription.');
        return;
      }
      setEp(sub.endpoint);
      setState('on');
      try { localStorage.setItem('desento_push', '1'); } catch (e) { /* private mode */ }
      // one switch for both pages: the signals page reads the same key
      try { localStorage.setItem('astra6_push_read', '1'); } catch (e) { /* private mode */ }
      const t = await fetch('/api/push/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint, sym: sym || 'XAUUSD' }),
      }).then((x) => x.json()).catch(() => null);
      setMsg(t && t.sent ? 'On — a test card was sent. Check the lock screen.'
        : 'Registered, but the push service refused the test card.');
    } catch (e) {
      setState('error');
      setMsg('Could not turn notifications on: ' + (e && e.message ? e.message : 'unknown error'));
    }
  };

  const turnOff = async () => {
    setState('busy');
    setMsg('');
    try {
      const r = reg.current || await navigator.serviceWorker.ready;
      const sub = ep ? await r.pushManager.getSubscription() : null;
      if (sub) {
        await fetch('/api/push/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint, unsubscribe: true }),
        });
        await sub.unsubscribe();
      }
      try { localStorage.setItem('desento_push', '0'); } catch (e) { /* */ }
      setEp('');
      setState('off');
      setMsg('Alerts are off on this device.');
    } catch (e) {
      setState('on');
      setMsg('Could not switch them off — the browser refused.');
    }
  };

  const sendTest = async () => {
    if (!ep) { setMsg('Turn alerts on first — a test card needs a device to ring.'); return; }
    setMsg('sending…');
    try {
      const d = await (await fetch('/api/push/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: ep, sym: sym || 'XAUUSD' }),
      })).json();
      setMsg(d && d.sent ? 'Sent — check the lock screen.' : 'The push service refused the card.');
    } catch (e) { setMsg('The test could not be sent.'); }
  };

  const on = state === 'on';
  return (
    <div className="msec">
      <div className="mlabel">Alerts</div>
      <button className={'mbtn2' + (on ? ' on' : '')} disabled={state === 'busy'} onClick={on ? turnOff : turnOn}>
        {state === 'busy' ? 'working…' : on ? 'Signal alerts are on — tap to turn off' : 'Signal alerts on this device'}
      </button>
      <div className="mhint">
        One card with the same numbers the owner published — on another tab, on the lock screen,
        or with the app shut.
      </div>
      <button className="mbtn2" onClick={sendTest}>{state === 'busy' ? '…' : 'Send a test card'}</button>
      {msg ? <div className="mnote">{msg}</div> : null}
      {!pushSupported() ? <div className="mnote">This browser has no push support — nothing is promised here that cannot ring.</div> : null}
    </div>
  );
}

/* ---------- install ---------- */

export function InstallCard() {
  const [prompt, setPrompt] = useState(null);
  const [msg, setMsg] = useState('');
  const installed = standalone();

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setPrompt(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const go = async () => {
    if (installed) { setMsg('Already installed — you are using the app.'); return; }
    if (prompt) {
      try { prompt.prompt(); } catch (e) { setMsg('The browser refused the install dialog.'); }
      setPrompt(null);
      return;
    }
    setMsg(isIOS()
      ? 'Safari: tap Share, then Add to Home Screen, then Add.'
      : 'Use the browser menu: Install app, or Add to Home screen.');
  };

  return (
    <div className="msec">
      <div className="mlabel">Install</div>
      <button className="mbtn2" onClick={go} disabled={installed}>
        {installed ? 'Installed — Desento is the app you are in' : 'Install Desento'}
      </button>
      <div className="mhint">
        {installed
          ? 'It already opens in its own window and can ring with the app shut.'
          : prompt
            ? 'This browser can install it in one tap — no browser menu needed.'
            : isIOS()
              ? 'iPhone has no install button a site can press: Share → Add to Home Screen is the route.'
              : 'This browser is not offering a one-tap prompt right now — the browser menu is the route.'}
      </div>
      {msg ? <div className="mnote">{msg}</div> : null}
    </div>
  );
}
