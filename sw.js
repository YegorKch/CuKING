// Кеширует оболочку приложения. Запросы к Apps Script не трогает — ими управляет app.js.
// При любом изменении файлов оболочки поднять VERSION, иначе телефоны останутся на старой версии.
//
// Файлы версии попадают в кеш только все вместе при установке и только из сети (cache: 'reload'):
// GitHub Pages отдаёт max-age=600, и без этого новая страница могла встретиться со старым app.js.
const VERSION = 'v0.3.2';
const CACHE = 'cuking-' + VERSION;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Сначала кеш своей версии — мгновенный и согласованный запуск; чего нет в кеше — из сети.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      return cached || fetch(e.request);
    })
  );
});
