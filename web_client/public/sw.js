// Bump VERSION to invalidate everything this worker has cached. Because Vite fingerprints
// its output (/assets/index-<hash>.js), a new build produces new URLs anyway — the version
// bump is what reclaims the space the superseded ones were using.
const VERSION = 'v5';
const SHELL_CACHE = `streampi-shell-${VERSION}`;
const ASSET_CACHE = `streampi-assets-${VERSION}`;

// IMPORTANT: this worker uses a strict ALLOWLIST, never a denylist. In production the
// client is served by the same Express server that serves the API, so /api/* is
// same-origin — a catch-all handler would sit in front of login, playback progress and
// especially /api/stream (ranged video). Anything not matched below is left entirely
// alone: no interception, no caching, identical to having no service worker at all.
// Only content-addressed or effectively-immutable paths belong here. /logo.png and
// /favicon.png are deliberately NOT cached: their URLs never change, so a rebrand would
// keep serving the old artwork to anyone with a warm cache until VERSION was bumped.
// They're small and fetched once a session, so leaving them on the network is the cheaper
// trade than a stale-branding footgun.
const isCacheableAsset = (url) =>
    url.pathname.startsWith('/assets/') ||   // Vite build output — content-hashed, immutable
    url.pathname.startsWith('/icons/') ||    // only ever replaced alongside a VERSION bump
    url.pathname === '/manifest.json';

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.add('/')));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // App shell: always try the network first so a new deploy is picked up immediately;
    // the cached copy exists purely so the app still opens with no connection.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy));
                    return response;
                })
                .catch(() => caches.match('/'))
        );
        return;
    }

    if (!isCacheableAsset(url)) return;

    // Hashed/static assets: cache-first is safe because the URL changes when content does.
    event.respondWith(
        caches.match(request).then((cached) => cached || fetch(request).then((response) => {
            if (response.ok) {
                const copy = response.clone();
                caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
        }))
    );
});
