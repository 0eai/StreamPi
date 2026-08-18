// Bump VERSION to invalidate everything this worker has cached. Because Vite fingerprints
// its output (/assets/index-<hash>.js), a new build produces new URLs anyway — the version
// bump is what reclaims the space the superseded ones were using.
// Bump VERSION to invalidate everything this worker has cached. Because Vite fingerprints
// its output (/assets/index-<hash>.js), a new build produces new URLs anyway — the version
// bump is what reclaims the space the superseded ones were using.
//
// v6 also evicts the /icons/ entries left behind by v5, which no longer belong in any cache
// (see below).
const VERSION = 'v6';
const SHELL_CACHE = `streampi-shell-${VERSION}`;
const ASSET_CACHE = `streampi-assets-${VERSION}`;

// IMPORTANT: this worker uses a strict ALLOWLIST, never a denylist. In production the
// client is served by the same Express server that serves the API, so /api/* is
// same-origin — a catch-all handler would sit in front of login, playback progress and
// especially /api/stream (ranged video). Anything not matched below is left entirely
// alone: no interception, no caching, identical to having no service worker at all.
//
// Only genuinely content-addressed paths belong here — meaning the URL changes when the
// bytes do. Artwork at a fixed URL does not qualify, so /logo.png, /favicon.png AND
// /icons/* are all left on the network: a rebrand would otherwise keep serving the old
// images to anyone with a warm cache until someone remembered to bump VERSION.
//
// /icons/* used to be on this list, justified as "only ever replaced alongside a VERSION
// bump" — a rule enforced by nothing but that comment, and precisely the stale-branding
// footgun the paragraph above rejects for its two sibling files. They are a few KB and are
// fetched when the manifest is parsed rather than per navigation, so the network is the
// cheaper trade.
//
// Note for anyone changing the app icon: this only fixes the browser's half. iOS snapshots
// the home-screen icon when "Add to Home Screen" is tapped and never re-reads
// apple-touch-icon, so an already-installed shortcut has to be deleted and re-added.
// /manifest.json is off the list for the same reason, and more sharply: it is the file that
// declares which icons exist, so caching it would pin the icon *set* as well as the images.
// It is a few hundred bytes, and an installed app has already had its manifest processed at
// install time — nothing about running offline depends on re-fetching it.
const isCacheableAsset = (url) =>
    url.pathname.startsWith('/assets/');   // Vite build output — content-hashed, immutable

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
