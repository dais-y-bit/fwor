/* ==========================================================================
   GEPT 單字卡 — Service Worker
   負責把 App 的所有檔案快取起來，讓「加入主畫面」之後完全不需要網路。

   快取策略：
     - 本機檔案(HTML/CSS/JS/圖示/資料) → Cache First
       只要快取裡有，就直接回應，不等網路；沒有才去抓一次並存起來。
     - 其他外部資源(例如 Google Fonts) → Network First，失敗時退回快取
       第一次安裝需要連網一次把字型抓下來，之後就算離線，字型仍會從
       瀏覽器/快取讀到；就算真的完全沒抓到，畫面會退回系統預設字型，
       不影響功能只影響美觀。

   版本號(CACHE_NAME)：以後只要有任何檔案內容更新(例如換了新的 words.js)，
   把版本號往上加一，使用者下次打開 App 時就會自動抓新版本、清掉舊快取。
   ========================================================================== */

const CACHE_NAME = "gept-cache-v1";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./words.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // 本機檔案：Cache First
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        });
      })
    );
  } else {
    // 外部資源(例如字型)：Network First，離線時退回快取
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
