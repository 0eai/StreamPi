import React from 'react';
import ReactDOM from 'react-dom/client';
import AppWrapper from './StreamApp'; // This is your existing App export
import DownloadsPage from './components/DownloadsPage';
import ErrorBoundary from './components/ErrorBoundary';
// Imported directly (not via @import in index.css) so Vite resolves its relative
// woff2 url()s itself, instead of Tailwind's PostCSS import-inlining losing that context.
import '@fontsource-variable/archivo';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root'));

// /download is the one page in this app reachable without logging in — checked here, before
// StreamApp's own token gate, rather than pulling in a full router for a single extra path.
// The Express side already falls back to index.html for any unmatched non-API route (see
// server/src/routes/misc.js), so a direct browser navigation to /download works with no
// server changes.
const isDownloadsPage = window.location.pathname === '/download';

// Top-level backstop — a second, more targeted boundary sits inside StreamApp itself around
// just the active tab's content, so this one should only ever be reached by a crash outside
// that (nav chrome, modals). Reloading is the only real recovery at this level since state
// above the crash point may itself be inconsistent.
root.render(
    <React.StrictMode>
        <ErrorBoundary label="StreamPi" onReset={() => window.location.reload()}>
            {isDownloadsPage ? <DownloadsPage /> : <AppWrapper />}
        </ErrorBoundary>
    </React.StrictMode>
);

// PWA service worker. Production only — in dev it would serve cached build output over
// Vite's HMR. Registration is unavailable outside a secure context (so plain http://<lan-ip>
// simply skips it and the app runs exactly as before), and the catch is required because
// index.html turns any unhandled rejection into an alert() popup.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((e) => {
            console.warn('Service worker registration failed:', e.message);
        });
    });
}
