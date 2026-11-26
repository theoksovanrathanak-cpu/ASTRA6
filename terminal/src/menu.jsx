/* The drawer: navigation and the Google door, on the terminal itself.

   The menu is the same idea as the one on the signals page - one hamburger, a short
   list, and the owner's Google sign-in - but it lives here so the front page is not a
   dead end. Sign-in uses Google Identity Services against /api/owner/login, exactly the
   endpoint the other page uses, so one cookie covers both. */

import React, { useCallback, useEffect, useRef, useState } from 'react';

export function useOwner() {
  const [me, setMe] = useState({ ready: false, signed_in: false, email: null,
    client_id: null, google_ready: false });

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/owner/me', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('http ' + r.status);
      const d = await r.json();
      setMe({ ready: true, signed_in: !!d.signed_in, owner: !!d.owner,
        email: d.email || null, client_id: d.client_id || null,
        google_ready: !!d.google_ready, error: null });
    } catch (e) {
      setMe((m) => ({ ...m, ready: true, error: 'could not reach the server' }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return [me, refresh];
}

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      return resolve(window.google.accounts.id);
    }
    const existing = document.querySelector('script[data-gsi]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google.accounts.id));
      existing.addEventListener('error', () => reject(new Error('blocked')));
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.dataset.gsi = '1';
    s.onload = () => resolve(window.google.accounts.id);
    s.onerror = () => reject(new Error('blocked'));
    document.head.appendChild(s);
  });
}

export default function Menu({ open, onClose, me, refreshOwner }) {
  const btn = useRef(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setMsg(''); return; }
    if (me.signed_in || !me.google_ready || !me.client_id) return;
    let dead = false;
    loadGis().then((id) => {
      if (dead || !btn.current) return;
      id.initialize({
        client_id: me.client_id,
        callback: async (resp) => {
          if (!resp || !resp.credential) { setMsg('Google returned nothing.'); return; }
          setBusy(true);
          setMsg('checking with Google…');
          try {
            const r = await fetch('/api/owner/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ credential: resp.credential }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) {
              const why = (d && d.detail) || {};
              setMsg(why.error === 'not_the_owner'
                ? 'That Google account is not the owner of this site.'
                : (why.error ? String(why.error).replace(/_/g, ' ') : 'Sign-in failed.'));
              return;
            }
            setMsg('');
            await refreshOwner();
            onClose();
          } catch (e) {
            setMsg('Network error: ' + e.message);
          } finally {
            setBusy(false);
          }
        },
      });
      id.renderButton(btn.current, {
        theme: 'filled_black', size: 'large', shape: 'rect', text: 'signin_with',
        logo_alignment: 'left', width: 240,
      });
      // Google fails quietly when the origin is not authorised: the button simply never
      // appears. Say so, and offer the page that has the same door.
      setTimeout(() => {
        if (dead || !btn.current) return;
        if (!btn.current.childElementCount) {
          setMsg('Google did not render its button — this origin may not be authorised ' +
                 'for the client id. The same sign-in is on the signals page (/app).');
        }
      }, 2600);
    }).catch(() => setMsg('accounts.google.com is blocked here.'));
    return () => { dead = true; };
  }, [open, me.signed_in, me.google_ready, me.client_id, refreshOwner, onClose]);

  const signOut = async () => {
    setBusy(true);
    try {
      await fetch('/api/owner/logout', { method: 'POST', credentials: 'same-origin' });
      await refreshOwner();
      setMsg('Signed out.');
    } catch (e) { setMsg('Could not sign out.'); }
    setBusy(false);
  };

  if (!open) return null;
  return (
    <div className="sheetwrap" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-label="Menu">
        <div className="sheet-h">
          <span>Menu</span>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <a className="mi on" href="/" onClick={onClose}>
          <span className="mi-t">Order flow</span>
          <span className="mi-s">footprint · delta · profile</span>
        </a>
        <a className="mi" href="/app">
          <span className="mi-t">Signals &amp; news</span>
          <span className="mi-s">the gold page, alerts and lessons</span>
        </a>

        <div className="sheet-sep" />
        <div className="sheet-note">
          Volumes here are counted quotes, not reported traded volume. The estimate badge
          in the header stays visible for that reason.
        </div>
        <div className="sheet-sep" />

        {me.signed_in ? (
          <div className="acct">
            <div className="acct-e">{me.email}</div>
            <div className="acct-s">{me.owner ? 'owner — publishing enabled' : 'signed in'}</div>
            <button className="ghost" disabled={busy} onClick={signOut}>Sign out</button>
          </div>
        ) : (
          <div className="acct">
            <div className="acct-t">Owner sign-in</div>
            {me.google_ready ? (
              <div ref={btn} className="gbtn" />
            ) : (
              <div className="acct-s">Google sign-in is not configured on this server.</div>
            )}
            {msg ? <div className="acct-s" style={{ color: '#ffb4b9' }}>{msg}</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}
