import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import https from 'https';

import { TEMP_DIR, EXTERNAL_ROOT, CLIENT_BUILD_PATH, SSL_KEY_PATH, SSL_CERT_PATH } from './src/paths.js';
import { PORT, HTTPS_PORT, FILES_PORT, FILES_HTTPS_PORT } from './src/config.js';
import { createFileServer } from './src/fileServer.js';
import { initDB, db, logActivity } from './src/db.js';
import { initializeFirebaseAdmin, updateServerLocation } from './src/firebaseBootstrap.js';
import { initTelegramListener } from './src/telegramService.js';
import { restoreTorrents } from './src/torrentService.js';
import { cleanOldTempFiles } from './src/logger.js';
import { checkTranscodeQueue } from './src/transcodeQueue.js';
import { initNodeDiscoveryListener, startNodeHealthCheck, checkNasHealth } from './src/nodeDiscovery.js';
import { scanLibrary } from './src/mediaPipeline.js';
import { startSystemStatsSampling } from './src/systemStats.js';
import { startAutoArchiver } from './src/autoArchiver.js';
import { startPosterHealer } from './src/posterHealer.js';
import { startFileReaper } from './src/fileReaper.js';

import internalRoutes from './src/routes/internal.js';
import adminRoutes from './src/routes/admin.js';
import nodeOwnerRoutes from './src/routes/nodeOwner.js';
import authRoutes from './src/routes/auth.js';
import statusRoutes from './src/routes/status.js';
import mediaRoutes from './src/routes/media.js';
import shareRoutes from './src/routes/share.js';
import fileRoutes from './src/routes/files.js';
import remoteRoutes from './src/routes/remote.js';
import streamingRoutes, { startStreamStalenessSweep } from './src/routes/streaming.js';
import torrentsRoutes from './src/routes/torrents.js';
import telegramRoutes from './src/routes/telegram.js';
import miscRoutes from './src/routes/misc.js';

// Without these, an unhandled rejection or uncaught throw anywhere in the app — including
// bugs unrelated to what actually triggered them (a missing try/catch three files away, a
// stream with no 'error' listener) — kills the entire process by Node's default behavior,
// taking down every connected user's stream at once. This converts that into "log it and
// keep running" for everything that isn't otherwise handled.
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
});

// ==========================================
// EXPRESS APP & ROUTES
// ==========================================

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Locks down script execution specifically (the actual XSS-escalation vector) while leaving
// every other directive unrestricted — this app never had a CSP before, and connect-src/
// img-src/style-src/frame-src all have paths (the Kunji login widget, NAS media, dynamically-
// set inline styles) that aren't fully enumerable here to restrict safely without risking
// breakage. Set as a real header rather than an index.html <meta> tag specifically so
// frame-ancestors takes effect — browsers silently ignore that directive when it only arrives
// via <meta>.
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "script-src 'self' https://kunji.cc; object-src 'none'; base-uri 'self'; frame-ancestors 'self';");
    // Nothing that serves a file declares a Content-Type for it, which leaves the browser free to
    // guess one from the bytes — and a guess of text/html on a response the user believed was a
    // download is how stored bytes become script on this origin, which the CSP's `script-src 'self'`
    // would then allow. Set once here so no future route can forget it.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
if (!existsSync(EXTERNAL_ROOT)) mkdirSync(EXTERNAL_ROOT, { recursive: true });

if (existsSync(CLIENT_BUILD_PATH)) app.use(express.static(CLIENT_BUILD_PATH));

// Mount order only matters for misc.js's wildcard catch-all + error handler, which must
// be mounted last — every other route in the app is a distinct path+method (the one
// intentional exception, /api/media/info's byte-identical duplicate, lives entirely
// inside routes/media.js), so the rest can mount in any order.
app.use(internalRoutes);
app.use(adminRoutes);
app.use(nodeOwnerRoutes);
app.use(authRoutes);
app.use(statusRoutes);
app.use(mediaRoutes);
app.use(shareRoutes);
app.use(fileRoutes);
app.use(remoteRoutes);
app.use(streamingRoutes);
app.use(torrentsRoutes);
app.use(telegramRoutes);
app.use(miscRoutes);

// Referenced by gracefulShutdown() below — assigned once startServer() actually creates them.
let httpServer, httpsServer, filesServer, filesHttpsServer;

const startServer = async () => {
    try {
        if (existsSync(TEMP_DIR)) {
            console.log("🧹 Cleaning Temp Directory on Startup...");
            const files = await fs.readdir(TEMP_DIR);
            for (const file of files) {
                await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
            }
        }
    } catch (e) {
        console.error("Warning: Could not clean temp dir:", e.message);
    }

    await initDB();
    try {
        const stuck = await db.run("UPDATE telegram_files SET status = 'queued' WHERE status = 'downloading'");
        if (stuck.changes > 0) {
            console.log(`🔄 Rescheduled ${stuck.changes} interrupted Telegram downloads.`);
        }

        // Self-heals rows left over from before downloaded_size was reset alongside
        // status on cancel/failure (see telegramService.js) — the partial file itself was
        // already deleted when these were stopped, but the stale byte count made the UI
        // show a "still downloaded" progress bar for a file that has zero bytes on disk.
        await db.run("UPDATE telegram_files SET downloaded_size = 0 WHERE status IN ('stopped', 'failed') AND downloaded_size > 0");
    } catch (e) {
        console.error("Failed to reset Telegram queue:", e.message);
    }

    // The HTTP/HTTPS servers now come up before any external-dependency bootstrapping
    // (Firebase, Telegram, torrents) below — previously those were awaited first, so a
    // Firebase project that's unreachable at boot (DNS hiccup, revoked credentials) could
    // hang app.listen() forever, making the whole server look dead even for purely local
    // features (streaming, login) that have nothing to do with Firebase.
    httpServer = app.listen(PORT, '0.0.0.0', () => console.log(`🚀 HTTP Server running on port ${PORT}`));
    httpServer.setTimeout(28800000);
    httpServer.keepAliveTimeout = 28800000;
    httpServer.headersTimeout = 28800001;

    if (existsSync(SSL_KEY_PATH) && existsSync(SSL_CERT_PATH)) {
        try {
            httpsServer = https.createServer({ key: await fs.readFile(SSL_KEY_PATH), cert: await fs.readFile(SSL_CERT_PATH) }, app).listen(HTTPS_PORT, '0.0.0.0', () => console.log(`🔒 HTTPS Server running on port ${HTTPS_PORT}`));

            httpsServer.setTimeout(28800000);
            httpsServer.keepAliveTimeout = 28800000;
            httpsServer.headersTimeout = 28800001;
        } catch(e) {}
    }

    // A separate app on a separate port for uploaded file bytes — see fileServer.js for why the
    // origin has to be different from the app's. Failing to bind must not take the server down with
    // it: the whole media side works without this, and a port collision here should degrade to "file
    // downloads are unavailable", not "StreamPi is dead".
    const filesApp = createFileServer();
    filesServer = filesApp.listen(FILES_PORT, '0.0.0.0', () => console.log(`📦 Files origin running on port ${FILES_PORT}`));
    filesServer.on('error', (e) => console.error(`❌ Files origin failed to bind port ${FILES_PORT}: ${e.message}`));
    // Large downloads over slow links need the same patience the media routes get.
    filesServer.setTimeout(28800000);
    filesServer.keepAliveTimeout = 28800000;
    filesServer.headersTimeout = 28800001;

    if (existsSync(SSL_KEY_PATH) && existsSync(SSL_CERT_PATH)) {
        try {
            filesHttpsServer = https.createServer({ key: await fs.readFile(SSL_KEY_PATH), cert: await fs.readFile(SSL_CERT_PATH) }, filesApp)
                .listen(FILES_HTTPS_PORT, '0.0.0.0', () => console.log(`🔒 Files origin (HTTPS) running on port ${FILES_HTTPS_PORT}`));
            filesHttpsServer.on('error', (e) => console.error(`❌ Files HTTPS origin failed to bind: ${e.message}`));
            filesHttpsServer.setTimeout(28800000);
            filesHttpsServer.keepAliveTimeout = 28800000;
            filesHttpsServer.headersTimeout = 28800001;
        } catch(e) {}
    }

    await initializeFirebaseAdmin();

    await initTelegramListener();
    await restoreTorrents();

    await startBackgroundJobs();
    scanLibrary().catch(e => console.error("❌ Library scan failed:", e.message));
};

// Every recurring job the server runs, named and registered in one visible place — these
// previously started as either bare imports for their side effects (systemStats.js,
// autoArchiver.js each self-started via a module-scope setInterval) or interspersed directly
// in startServer(), so the full set of background work only existed implicitly, spread across
// several files and import order.
const startBackgroundJobs = async () => {
    startSystemStatsSampling();
    startAutoArchiver();
    startPosterHealer();

    setInterval(cleanOldTempFiles, 60 * 60 * 1000);
    // Auto-delete and the trash: expires what is due, purges what has sat in the trash past the
    // grace period, and collects bytes with no row. Same hourly cadence as the temp sweep above.
    startFileReaper();
    startStreamStalenessSweep();

    setInterval(checkTranscodeQueue, 30000);
    checkTranscodeQueue();

    initNodeDiscoveryListener();
    startNodeHealthCheck();
    setInterval(checkNasHealth, 2000);

    await updateServerLocation();
    setInterval(updateServerLocation, 5 * 60 * 1000);

    setInterval(async () => {
        if (!db) return;
        const timeoutThreshold = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 Days Inactivity

        try {
            const expiredSessions = await db.all("SELECT * FROM sessions WHERE last_active < ?", timeoutThreshold);

            for (const session of expiredSessions) {
                console.log(`💤 Session timed out: ${session.username}`);
                await logActivity(
                    session.username,
                    "OFFLINE",
                    "Session expired (Inactivity)",
                    session.ip
                );
            }

            if (expiredSessions.length > 0) {
                await db.run("DELETE FROM sessions WHERE last_active < ?", timeoutThreshold);
            }
        } catch (e) {
            console.error("Session cleanup error:", e);
        }

        // remote_commands is a tiny, short-lived polling queue (see routes/remote.js) — a
        // command is only ever honored within COMMAND_MAX_AGE_MS of being sent, so anything
        // older than a day is just accumulated dead weight, delivered or not.
        try {
            await db.run("DELETE FROM remote_commands WHERE created_at < ?", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        } catch (e) {
            console.error("Remote command cleanup error:", e);
        }
    }, 60 * 60000);
};

startServer();

// A pm2 restart/deploy sends SIGTERM — with no handler, Node's default is to terminate
// immediately, killing any in-flight ffmpeg remux/transcode, upload, or Telegram download
// mid-write. This stops accepting new connections and gives existing ones a window to
// finish before the process actually exits.
const gracefulShutdown = (signal) => {
    console.log(`\n${signal} received — closing server...`);
    if (httpServer) httpServer.close(() => console.log("HTTP server closed."));
    if (httpsServer) httpsServer.close();
    // The files origin has to close too, or a restart leaves its port bound by the dying process
    // long enough for the new one to fail to bind it — which would silently mean "file downloads
    // don't work" from the first restart onwards.
    if (filesServer) filesServer.close(() => console.log("Files origin closed."));
    if (filesHttpsServer) filesHttpsServer.close();
    setTimeout(() => process.exit(0), 10000);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
