import React from 'react';
import ReactDOM from 'react-dom/client';
import AppWrapper from './StreamApp'; // This is your existing App export
import DownloadsPage from './components/DownloadsPage';
import SharePlayerPage from './components/SharePlayerPage';
import FileSharePage from './components/files/FileSharePage';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/ui/toast';
import { DialogProvider } from './components/ui/dialogs';
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

// /share/<token> is the second unauthenticated page, and the first with a parameter — same
// "check pathname before StreamApp's token gate" approach, just split on '/' since there's no
// router to extract path segments for us.
const pathParts = window.location.pathname.split('/').filter(Boolean);
const isSharePage = pathParts[0] === 'share' && !!pathParts[1];
const shareToken = isSharePage ? decodeURIComponent(pathParts[1]) : null;

// /f/<token> is the third, for a shared file or folder. Kept short because it is meant to be pasted
// into a message; kept separate from /share/<token> because the two resolve against different tables
// and a viewer of one must never be handed the other's resolver.
const isFileSharePage = pathParts[0] === 'f' && !!pathParts[1];
const fileShareToken = isFileSharePage ? decodeURIComponent(pathParts[1]) : null;

// Top-level backstop — a second, more targeted boundary sits inside StreamApp itself around
// just the active tab's content, so this one should only ever be reached by a crash outside
// that (nav chrome, modals). Reloading is the only real recovery at this level since state
// above the crash point may itself be inconsistent.
root.render(
    <React.StrictMode>
        <ErrorBoundary label="StreamPi" onReset={() => window.location.reload()}>
            {/* Inside the boundary, not around it: a crash in a page still has to be caught, and
                the providers are what the page reaches for to report failures. Both wrap every
                entry point, including the two unauthenticated pages. */}
            <ToastProvider>
                <DialogProvider>
                    {isDownloadsPage ? <DownloadsPage />
                        : isSharePage ? <SharePlayerPage token={shareToken} />
                        : isFileSharePage ? <FileSharePage token={fileShareToken} />
                        : <AppWrapper />}
                </DialogProvider>
            </ToastProvider>
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
