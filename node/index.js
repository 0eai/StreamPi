import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { ID, API_KEY, ROLES, PORT, DATABASE_URL, IS_TRANSCODER, IS_NAS, __dirname, sweepWorkDir } from './config.js';
import { detectHardware } from './hardware.js';
import { startStatsSampling } from './stats.js';
import { resumePendingMigrationsOnBoot } from './migration.js';
import { registerWithFirebase } from './discovery.js';
import coreRoutes from './routes/core.js';
import transcoderRoutes from './routes/transcoder.js';
import nasRoutes from './routes/nas.js';

// ==========================================
// HTTP SERVER
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());

// The node-owner page shell itself carries no secrets — it prompts for the API key in
// the browser and sends it as a Bearer token on every actual data/action call below.
app.use(express.static(path.join(__dirname, 'public')));

// Unauthenticated on purpose — neither the id nor the databaseURL is secret (only the
// apiKey is), and a kunji-login visitor needs both before they have any credential:
// the id to address the /api/node-owner/:id/* proxy, and the databaseURL to discover
// the main server's current address via the public serverConfig RTDB read.
app.get('/api/self/id', (req, res) => res.json({ id: ID, databaseURL: DATABASE_URL }));

// A plain !== comparison is technically vulnerable to a timing attack (early-exits on the
// first mismatched byte) — low priority on a LAN-scoped app, but cheap to close properly.
const timingSafeEqual = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
};

const requireAuth = (req, res, next) => {
    const auth = req.headers['authorization'] || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.secret || req.body?.secret);
    if (!timingSafeEqual(provided, API_KEY)) return res.status(403).json({ error: "Unauthorized" });
    next();
};
app.use(requireAuth);

app.use(coreRoutes);
if (IS_TRANSCODER) app.use(transcoderRoutes);
if (IS_NAS) app.use(nasRoutes);

// Catches anything passed to next(err) upstream (e.g. the upload storage engine rejecting an
// unsafe filename) — without this it falls through to Express's default handler, which
// includes a stack trace with local file paths in the response body.
app.use((err, req, res, next) => {
    console.error(`❌ [${ID}] Request error:`, err.message);
    res.status(400).json({ error: err.message || "Bad request" });
});

// ==========================================
// START
// ==========================================
const start = async () => {
    console.log(`🏁 Node "${ID}" — roles: ${ROLES.join(', ')}`);
    startStatsSampling();
    if (IS_TRANSCODER) { await detectHardware(); sweepWorkDir(); setInterval(sweepWorkDir, 60 * 60 * 1000); }
    if (IS_NAS) resumePendingMigrationsOnBoot();

    await registerWithFirebase();
    setInterval(registerWithFirebase, 30000);

    const server = app.listen(PORT, '0.0.0.0', () => console.log(`🔥 Node listening on port ${PORT}`));
    server.keepAliveTimeout = 2 * 60 * 60 * 1000;
    server.headersTimeout = 2 * 60 * 60 * 1000 + 1000;
    server.requestTimeout = 2 * 60 * 60 * 1000;
    server.timeout = 2 * 60 * 60 * 1000;
};

start();
