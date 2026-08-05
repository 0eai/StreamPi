import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { ID, API_KEY, ROLES, PORT, DATABASE_URL, IS_NAS, CONFIG_FILE_PATH, CFG, __dirname, loadJobHistory } from '../config.js';
import { RUNTIME, ACTIVE_MIGRATIONS } from '../state.js';
import { getPhysicalDiskCapacity, getLocationStats, invalidateDiskStatsCache } from '../storage.js';
import { startMigration } from '../migration.js';
import { buildStatsPayload } from '../stats.js';

const router = express.Router();

router.get('/stats', async (req, res) => res.json(await buildStatsPayload()));

// The resolved identity this process actually booted with — including defaults applied
// for anything left out of node_config.json (e.g. databaseURL, port). Comparing against
// this instead of the raw file avoids a spurious "restart needed" when a field was never
// explicitly set but the UI re-submits the same resolved value it was shown.
const CURRENT_IDENTITY = { id: ID, apiKey: API_KEY, roles: ROLES, port: PORT, databaseURL: DATABASE_URL };

router.get('/api/config', async (req, res) => {
    const nasStorageLocations = IS_NAS
        ? await Promise.all(RUNTIME.nasStorageLocations.map(async loc => ({ ...loc, diskCapacityBytes: await getPhysicalDiskCapacity(loc.path) })))
        : [];
    res.json({ ...CURRENT_IDENTITY, nasStorageLocations, maxConcurrentNasJobs: RUNTIME.maxConcurrentNasJobs });
});

// Boot-time validation (config.js) hard-requires a non-empty apiKey and a non-empty roles
// array — this endpoint used to accept anything for those same fields with no equivalent
// check, so posting e.g. {"roles":[]} wrote a config that would fail that exact boot check on
// the next restart, bricking the node until someone edited the file by hand.
const isValidConfigPatch = (body) => {
    if ('apiKey' in body && (typeof body.apiKey !== 'string' || !body.apiKey)) return "apiKey must be a non-empty string";
    if ('id' in body && (typeof body.id !== 'string' || !body.id)) return "id must be a non-empty string";
    if ('roles' in body && (!Array.isArray(body.roles) || !body.roles.length || !body.roles.every(r => typeof r === 'string'))) return "roles must be a non-empty array of strings";
    if ('port' in body && (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535)) return "port must be an integer between 1 and 65535";
    if ('databaseURL' in body && (typeof body.databaseURL !== 'string' || !body.databaseURL)) return "databaseURL must be a non-empty string";
    if ('maxConcurrentNasJobs' in body && (!Number.isInteger(body.maxConcurrentNasJobs) || body.maxConcurrentNasJobs < 1)) return "maxConcurrentNasJobs must be a positive integer";
    // Path safety for nasStorageLocations is checked separately (isSafeStoragePath, below) —
    // this covers the rest of each entry's shape. Previously nothing rejected a location
    // missing an id, a non-numeric/NaN limitBytes, or duplicate ids — a malformed limitBytes
    // flowed straight into the free-space calculation as NaN, silently making that location
    // permanently unselectable with no error surfaced anywhere.
    if ('nasStorageLocations' in body) {
        if (!Array.isArray(body.nasStorageLocations) || !body.nasStorageLocations.length) return "nasStorageLocations must be a non-empty array";
        const seenIds = new Set();
        for (const loc of body.nasStorageLocations) {
            if (!loc || typeof loc.id !== 'string' || !loc.id) return "Each storage location needs a non-empty id";
            if (seenIds.has(loc.id)) return `Duplicate storage location id: ${loc.id}`;
            seenIds.add(loc.id);
            if (!Number.isFinite(loc.limitBytes) || loc.limitBytes <= 0) return `Storage location "${loc.id}" needs a positive limitBytes`;
        }
    }
    return null;
};

// Any path string was previously accepted as a storage root — including core system
// directories — giving full read/write/delete capability over them to anyone holding the key,
// independent of (and in addition to) any filename-level traversal guard.
const UNSAFE_STORAGE_ROOTS = ['/etc', '/bin', '/sbin', '/usr', '/var', '/boot', '/sys', '/proc', '/root', '/lib', '/lib64', '/dev'];
const isSafeStoragePath = (p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
    const resolved = path.resolve(p);
    if (resolved === path.parse(resolved).root) return false;
    return !UNSAFE_STORAGE_ROOTS.some(root => resolved === root || resolved.startsWith(root + path.sep));
};

router.post('/api/config', async (req, res) => {
    const configError = isValidConfigPatch(req.body);
    if (configError) return res.status(400).json({ error: configError });

    if ('nasStorageLocations' in req.body) {
        const badPath = (req.body.nasStorageLocations || []).find(l => !isSafeStoragePath(l?.path));
        if (badPath) return res.status(400).json({ error: `Unsafe or invalid storage path: ${badPath?.path}` });
    }

    const identityKeys = ['id', 'apiKey', 'roles', 'port', 'databaseURL'];
    const requiresRestart = identityKeys.some(k => k in req.body && JSON.stringify(req.body[k]) !== JSON.stringify(CURRENT_IDENTITY[k]));

    let migrationsStarted = [];
    if ('nasStorageLocations' in req.body) {
        if (ACTIVE_MIGRATIONS.size > 0) {
            return res.status(409).json({ error: "A storage migration is already in progress — wait for it to finish before changing locations again." });
        }

        const incoming = req.body.nasStorageLocations;
        if (!Array.isArray(incoming) || !incoming.length) {
            return res.status(400).json({ error: "At least one storage location is required." });
        }

        const current = RUNTIME.nasStorageLocations;
        const currentById = new Map(current.map(l => [l.id, l]));
        const incomingById = new Map(incoming.map(l => [l.id, l]));

        for (const loc of incoming) fs.mkdirSync(loc.path, { recursive: true });

        // Removed locations: fold their contents into whichever remaining location currently
        // has the most free space.
        const removed = current.filter(l => !incomingById.has(l.id));
        if (removed.length) {
            const stats = await Promise.all(incoming.map(async l => ({ loc: l, disk: await getLocationStats(l) })));
            stats.sort((a, b) => b.disk.free - a.disk.free);
            const target = stats[0].loc;
            for (const oldLoc of removed) {
                migrationsStarted.push(startMigration(oldLoc.id, oldLoc.path, target.path, 'location_removed'));
            }
        }

        // Path changes for locations that still exist (same id, different path).
        for (const newLoc of incoming) {
            const oldLoc = currentById.get(newLoc.id);
            if (oldLoc && oldLoc.path !== newLoc.path) {
                migrationsStarted.push(startMigration(newLoc.id, oldLoc.path, newLoc.path, 'path_changed'));
            }
        }

        RUNTIME.nasStorageLocations = incoming;
        invalidateDiskStatsCache();
    }
    if ('maxConcurrentNasJobs' in req.body) RUNTIME.maxConcurrentNasJobs = req.body.maxConcurrentNasJobs;

    const merged = { ...CFG, ...req.body, nasStorageLocations: RUNTIME.nasStorageLocations, maxConcurrentNasJobs: RUNTIME.maxConcurrentNasJobs };
    delete merged.nasStorageRoot;
    delete merged.nasStorageLimitBytes;
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(merged, null, 2));
    res.json({ success: true, requiresRestart, migrationsStarted });
});

router.post('/api/self/restart', (req, res) => {
    res.json({ success: true });
    setTimeout(() => {
        spawn(process.execPath, process.argv.slice(1), { cwd: __dirname, detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
    }, 300);
});

router.get('/api/history', (req, res) => res.json(loadJobHistory()));

router.get('/api/files', async (req, res) => {
    if (!IS_NAS) return res.json([]);
    try {
        const files = [];
        for (const loc of RUNTIME.nasStorageLocations) {
            const entries = await fsp.readdir(loc.path);
            for (const name of entries) {
                if (name.startsWith('.migrate_')) continue; // our own in-flight migration temp files
                try {
                    const s = await fsp.stat(path.join(loc.path, name));
                    if (s.isFile()) files.push({ name, size: s.size, modifiedAt: s.mtime.toISOString(), locationId: loc.id });
                } catch (e) {}
            }
        }
        files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
        res.json(files);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
