const VERSION = 'dev';
const CACHE_NAME = `gogame-${VERSION}`;
const PRECACHE_ASSETS = [
  './',
  `./index.html?v=${VERSION}`,
  './index.html',
  `./gnugo-loader.js?v=${VERSION}`,
  `./gnugo-service.js?v=${VERSION}`,
  `./rules.js?v=${VERSION}`,
  `./game-state.js?v=${VERSION}`,
  `./ui.js?v=${VERSION}`,
  `./manifest.json?v=${VERSION}`,
  `./icon-192.png?v=${VERSION}`,
  `./icon-512.png?v=${VERSION}`,
  `./version.json?v=${VERSION}`,
  './gnugo.wasm'
];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function shouldBypassCache(url) {
  return url.pathname.endsWith('/version.json') || url.pathname.endsWith('/version.json/');
}

function shouldRefreshFirst(request, url) {
  return request.mode === 'navigate' || (
    isSameOrigin(url) && (
      url.pathname === '/' ||
      url.pathname.endsWith('/index.html') ||
      url.pathname.endsWith('/ui.js') ||
      url.pathname.endsWith('/game-state.js') ||
      url.pathname.endsWith('/rules.js') ||
      url.pathname.endsWith('/gnugo-service.js') ||
      url.pathname.endsWith('/gnugo-loader.js') ||
      url.pathname.endsWith('/manifest.json') ||
      url.pathname.endsWith('/sw.js')
    )
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (shouldBypassCache(url)) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  if (shouldRefreshFirst(event.request, url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok && isSameOrigin(url)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && isSameOrigin(url)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
