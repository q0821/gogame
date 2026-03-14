const CACHE_NAME = 'gogame-v2';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './gnugo-loader.js',
  './gnugo-service.js',
  './rules.js',
  './game-state.js',
  './ui.js',
  './gnugo.wasm',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  const isNavigation = e.request.mode === 'navigate';
  const isCoreAsset = url.origin === self.location.origin && (
    url.pathname === '/' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/ui.js') ||
    url.pathname.endsWith('/game-state.js') ||
    url.pathname.endsWith('/rules.js') ||
    url.pathname.endsWith('/gnugo-service.js') ||
    url.pathname.endsWith('/gnugo-loader.js') ||
    url.pathname.endsWith('/sw.js')
  );

  if (isNavigation || isCoreAsset) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return response;
      });
    })
  );
});
