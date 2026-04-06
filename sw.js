// Cerebro service worker — enables PWA install prompt on Android
// Caches the app shell for offline load; API calls always go to the network.

const CACHE = 'cerebro-v1';
const SHELL = [
  '/',
  '/index.html',
  '/tasks.html',
  '/calendar.html',
  '/notes.html',
  '/saves.html',
  '/style.css',
  '/api.js',
  '/nav.js',
  '/dashboard.js',
  '/tasks.js',
  '/calendar.js',
  '/notes.js',
  '/saves.js',
  '/icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always hit the network for API calls and external resources
  if (url.hostname !== self.location.hostname || url.pathname.startsWith('/api/')) return;

  // Cache-first for app shell assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
