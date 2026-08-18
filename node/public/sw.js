// Bump this whenever a shell asset below changes — activate() evicts every older cache,
// so this is the only thing that invalidates a stale cached copy of style.css/app.js/etc.
const CACHE_NAME = 'streampi-node-shell-v2';

const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/dialogs.js',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
    );
    self.clients.claim();
});

// Only ever intercept the static shell assets listed above. Every other request — /stats,
// /api/*, /file/*, kunji auth calls, etc. — is left completely alone (no caching, no
// interception): this dashboard's entire purpose is showing this machine's LIVE state, and
// a cache hit for something like /stats would present stale hardware data as current, which
// is actively misleading rather than just a minor staleness inconvenience.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL_ASSETS.includes(url.pathname)) {
        return;
    }
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
