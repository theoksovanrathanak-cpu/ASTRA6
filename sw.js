/* ASTRA6 offline shell.
 *
 * The rule that matters: this app never shows a fake price. So the service worker
 * caches only the shell (the page itself, the chart library, the icons and the lesson
 * clips) and never touches /api/. When the network is gone the page opens instantly
 * from cache and marks itself offline; every number on it is still the last real one,
 * and the existing staleness pill says how old it is.
 */
const VERSION = 'astra6-v1';
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
