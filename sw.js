// DCCS SOS - service worker
// Caches only the local app shell so the app still opens offline / on a weak signal.
// Never touches the Apps Script API calls or CDN scripts - those always go to the network.
const CACHE = 'dccs-sos-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ---- Web Push: show a notification even if the app/tab isn't open ----
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'DCCS SOS', body: (event.data && event.data.text()) || 'New alert' }; }
  const title = data.title || 'DCCS SOS';
  const options = {
    body: data.body || 'Someone in your network needs help.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    vibrate: [300, 100, 300, 100, 300, 100, 300],
    tag: data.tag || 'dccs-sos-alarm',
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests for the app shell.
  // Everything else (Apps Script POSTs, Google Fonts, Tailwind CDN, Leaflet, map tiles)
  // is left completely alone and goes straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      // Stale-while-revalidate: show cache instantly if we have it, refresh in background.
      return cached || network;
    })
  );
});
