const VERSION = 'v2026.09.06-1ac2a31';
const CACHE_NAME = `gogame-${VERSION}`;
// 預快取只列「build 產物中必定存在的穩定路徑」。
// ⚠️ 歷史教訓（2026-07）：舊清單列了 rules.js/game-state.js/ui.js 等原始檔路徑，
// Vite build 後它們被打包進 assets/main-<hash>.js 而不存在 → cache.addAll 全有全無
// → SW 在正式站從未安裝成功，離線快取與舊版清理全部失效。
// hash 檔名的 assets 不在此列——由 fetch handler 的 runtime 快取於首次造訪時自然補上。
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function shouldBypassCache(url) {
  return url.pathname.endsWith('/version.json') || url.pathname.endsWith('/version.json/');
}

function shouldRefreshFirst(request, url) {
  // 舊清單的 ui.js/game-state.js/rules.js 是 dev 原始檔路徑，build 後不存在，已移除。
  return request.mode === 'navigate' || (
    isSameOrigin(url) && (
      url.pathname === '/' ||
      url.pathname.endsWith('/index.html') ||
      url.pathname.endsWith('/manifest.json') ||
      url.pathname.endsWith('/sw.js')
    )
  );
}

self.addEventListener('install', (event) => {
  // 逐檔容錯（非 addAll 全有全無）：單一路徑 404 不可讓整個 SW 安裝失敗——
  // 安裝失敗的代價是「舊版快取永不清理、離線完全失效」，遠大於少快取一個檔案。
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(PRECACHE_ASSETS.map((asset) => cache.add(asset)))
    )
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
