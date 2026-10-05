// Service worker: precache the app shell so a run works with no signal,
// and opportunistically cache map tiles you have already viewed.
// __BUILD__ is replaced with the commit SHA by the deploy workflow so every
// deploy gets a fresh cache.
const BUILD = '__BUILD__';
const SHELL_CACHE = `landnav-shell-${BUILD}`;
const TILE_CACHE = 'landnav-tiles';
const MAX_TILES = 800;

const SHELL = [
  './', 'index.html', 'setup.html', 'run.html', 'score.html', 'card.html', 'manifest.webmanifest',
  'css/style.css',
  'js/basemaps.js', 'js/card.js', 'js/checkin.js', 'js/course.js', 'js/dem.js', 'js/generate.js', 'js/geo.js', 'js/gpx.js',
  'js/grid.js', 'js/osm.js', 'js/results.js', 'js/run.js', 'js/score.js', 'js/setup.js', 'js/store.js',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/mgrs.js', 'vendor/proj4.js',
  'vendor/images/layers.png', 'vendor/images/layers-2x.png', 'vendor/images/marker-icon.png', 'vendor/images/marker-shadow.png',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];
const TILE_HOSTS = /(^|\.)(opentopomap\.org|tile\.openstreetmap\.org|nationalmap\.gov|elevation-tiles-prod\.s3\.amazonaws\.com)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('landnav-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req)
          .then((res) => {
            if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()).then(() => trim(cache)); }
            return res;
          })
          .catch(() => hit);
        return hit || net;
      }),
    );
    return;
  }

  if (url.origin === location.origin) {
    // Network first, so a deploy never leaves the page running a mix of old and new files.
    // The cache is only the fallback when offline or the signal is too slow (3 s).
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const net = fetch(req.url, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      const hit = await caches.match(req, { ignoreSearch: true });
      if (!hit) return net;
      return Promise.race([net.catch(() => hit), new Promise((r) => setTimeout(() => r(hit), 3000))]);
    })());
  }
  // everything else (Overpass, Nominatim) goes straight to the network
});
