// Service worker: precache the app shell and the N5 data so the app works
// offline. Bump VERSION when the list of files changes.
const VERSION = 'v4';
const CACHE = `jlpt-prep-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/engine.js', 'js/srs.js', 'js/session.js', 'js/kana.js', 'js/store.js', 'js/ui.js', 'js/analytics.js', 'js/charts.js', 'js/play.js',
  'data/n5/characters.json', 'data/n5/words.json', 'data/n5/sentences.json',
  'data/n5/grammar.json', 'data/n5/kana.json', 'data/n5/meta.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jlpt-prep-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so a new deploy shows up on the next load), falling back to
// the cache when offline or when the network is slow.
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    network.catch(() => {}); // a late failure after the timeout is not an error
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch { /* offline: fall through to the cache */ }
    const cached = await cache.match(req, { ignoreSearch: true });
    return cached || network;
  })());
});
