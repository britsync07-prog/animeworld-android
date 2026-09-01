// public/sw.js -- AnimeWorld offline cache.
// Every /api/v1/hls (and /api/v1/hls.m3u8) request goes through the in-app
// proxy. We cache the responses so downloaded episodes can play with no
// network. Network-first: online plays normally and refreshes the cache;
// offline falls back to whatever was downloaded.
const CACHE = 'animeworld-hls-offline';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === '/api/v1/hls' || url.pathname === '/api/v1/hls.m3u8') {
    e.respondWith((async () => {
      try {
        const net = await fetch(e.request);
        const c = await caches.open(CACHE);
        c.put(e.request, net.clone());
        return net;
      } catch (_) {
        const c = await caches.open(CACHE);
        const hit = await c.match(e.request);
        if (hit) return hit;
        return new Response('offline', { status: 504, statusText: 'offline' });
      }
    })());
  }
});

self.__WB_MANIFEST;
