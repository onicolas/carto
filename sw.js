// Service worker : met l'application en cache pour qu'elle démarre sans réseau.
// Les tuiles de carte ne passent pas par ici, elles sont stockées dans IndexedDB.
const CACHE = 'balise-shell-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'js/app.js',
  'js/store.js',
  'js/geo.js',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    // Rafraîchit le cache en arrière-plan : la nouvelle version sert au lancement suivant.
    const refresh = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }
    const res = await refresh;
    if (res) return res;
    if (req.mode === 'navigate') {
      const index = await cache.match('index.html');
      if (index) return index;
    }
    return new Response('Hors ligne', { status: 503, statusText: 'Hors ligne' });
  })());
});
