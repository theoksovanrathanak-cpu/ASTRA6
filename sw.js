/* ASTRA6 offline shell.
 *
 * The rule that matters: this app never shows a fake price. So the service worker
 * caches only the shell (the page itself, the chart library, the icons and the lesson
 * clips) and never touches /api/. When the network is gone the page opens instantly
 * from cache and marks itself offline; every number on it is still the last real one,
 * and the existing staleness pill says how old it is.
 */
const VERSION = 'astra6-v2';
const SHELL = [
  '/',
  '/manifest.json',
  '/static/vendor/lightweight-charts.js',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // one bad entry must not fail the whole install
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (!same) return;

  // live data is never cached: a cached quote would be a lie
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/events')) return;

  // the lesson clips are big and never change: serve from cache, fill in the background
  if (/\.mp4$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // the page and the library: network first, so a deploy is picked up at once,
  // with the cached copy as the offline floor
  const isDoc = req.mode === 'navigate' || req.destination === 'document';
  if (isDoc || url.pathname.startsWith('/static/') || /\.(png|json|svg|css|js)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
  }
});

/* ---------------------------------------------------------------- push card
 * The card the phone shows when a rule fires while the app is shut. Every
 * number in it was computed on the server from the same candles the chart
 * draws; this worker only draws what it is given, it never invents a price.
 */
function cardOptions(d) {
  const kind = d.kind || 'alert';
  const accent = kind === 'test' ? 'test' : kind;
  return {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'astra6-' + kind,
    renotify: true,
    requireInteraction: kind === 'read' ? false : true,
    silent: false,
    vibrate: kind === 'alert' ? [80, 40, 80] : [40],
    timestamp: (d.ts || Math.floor(Date.now() / 1000)) * 1000,
    data: { url: d.url || '/#chart', sym: d.sym || '', kind: accent, ts: d.ts || 0 },
    actions: [
      { action: 'open', title: 'Open the chart' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'ASTRA6', body: String(e.data && e.data.text ? e.data.text() : '') }; }
  const title = d.title || 'ASTRA6 alert';
  e.waitUntil(self.registration.showNotification(title, cardOptions(d)));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const data = e.notification.data || {};
  const url = data.url || '/#chart';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.indexOf(location.origin) === 0) {
        try { c.postMessage({ type: 'astra6-notify-click', sym: data.sym, url: url }); } catch (err) {}
        await c.focus();
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

// a browser may rotate a push endpoint; re-subscribe quietly so the phone keeps working
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    try {
      const r = await fetch('/api/push/vapid');
      const j = await r.json();
      if (!j || !j.publicKey) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToBytes(j.publicKey)
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub, rules: [], readCard: { on: false, syms: [] } })
      });
    } catch (err) {}
  })());
});

function b64ToBytes(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
