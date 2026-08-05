import fsp from 'fs/promises';
import path from 'path';
import { RUNTIME, ACTIVE_MIGRATIONS, RESERVED_BYTES_BY_LOCATION } from './state.js';

// Every filename this app deals with is supposed to be a bare, flat name (no directories) —
// enforced here rather than sanitized-and-continued, since silently rewriting an attacker's
// path to something else is more confusing than just refusing it outright. Rejects anything
// containing a path separator plus the two traversal segments that survive a bare basename().
export const isSafeFilename = (filename) =>
    typeof filename === 'string' && filename.length > 0 && filename !== '.' && filename !== '..' &&
    path.basename(filename) === filename;

// Per-location disk stats: statfs for physical free space, plus a shallow directory-size sum
// against the location's own configured quota (files are stored flat, no subfolders, so a
// shallow listing is enough — no recursive walk needed).
export const getLocationStats = async (loc) => {
    try {
        const stat = await fsp.statfs(loc.path);
        const physicalFree = stat.bavail * stat.bsize;

        let used = 0;
        const entries = await fsp.readdir(loc.path);
        for (const entry of entries) {
            // .migrate_* are our own in-flight (or, if a migration crashed mid-copy, orphaned)
            // temp files — counting them against usable free space double-counts the same
            // bytes as both "in transit" and "already used," and an orphan left behind by a
            // crash would otherwise permanently eat into this location's reported capacity.
            if (entry.startsWith('.migrate_')) continue;
            try {
                const s = await fsp.stat(path.join(loc.path, entry));
                if (s.isFile()) used += s.size;
            } catch (e) {}
        }

        return {
            id: loc.id,
            path: loc.path,
            free: Math.max(0, Math.min(physicalFree, loc.limitBytes - used)),
            total: loc.limitBytes,
            used,
            percent: loc.limitBytes > 0 ? (used / loc.limitBytes) * 100 : 0
        };
    } catch (e) { return { id: loc.id, path: loc.path, free: 0, total: 0, used: 0, percent: 0 }; }
};

// Aggregate across all locations. `free` is deliberately the MAX of any single location, not
// the sum — a file can't span two disks, and the main server's node-picking logic (which only
// ever reads this one number) needs to know what actually fits somewhere, not total headroom.
// `total`/`used`/`percent` stay sums, matching what a human expects on the dashboard.
let diskStatsCache = null;
let diskStatsCacheAt = 0;
const DISK_STATS_TTL_MS = 1500;

export const getAllDiskStats = async () => {
    const now = Date.now();
    if (diskStatsCache && (now - diskStatsCacheAt) < DISK_STATS_TTL_MS) return diskStatsCache;

    const locations = await Promise.all(RUNTIME.nasStorageLocations.map(getLocationStats));
    const total = locations.reduce((s, l) => s + l.total, 0);
    const used = locations.reduce((s, l) => s + l.used, 0);
    const result = {
        free: locations.length ? Math.max(...locations.map(l => l.free)) : 0,
        total,
        used,
        percent: total > 0 ? (used / total) * 100 : 0,
        locations
    };
    diskStatsCache = result;
    diskStatsCacheAt = now;
    return result;
};

// Invalidated by routes/core.js whenever RUNTIME.nasStorageLocations changes, so a location
// add/remove/path-change is reflected immediately instead of waiting out the TTL above.
export const invalidateDiskStatsCache = () => { diskStatsCache = null; };

// The actual physical capacity of the filesystem backing a path — used by the settings UI to
// cap each location's storage-limit slider at what that disk can actually hold.
export const getPhysicalDiskCapacity = async (root) => {
    try {
        const stat = await fsp.statfs(root);
        return stat.blocks * stat.bsize;
    } catch (e) { return 0; }
};

// Resolves a bare filename to whichever location currently holds it — probed fresh each call
// rather than kept in a persistent index, since with a handful of locations and flat
// directories this is simpler and self-healing (never goes stale). Also checks any
// in-flight migration's source path, so a file not yet moved stays reachable mid-migration.
export const findFileLocation = async (filename) => {
    if (!isSafeFilename(filename)) return null;
    for (const loc of RUNTIME.nasStorageLocations) {
        const p = path.join(loc.path, filename);
        try { if ((await fsp.stat(p)).isFile()) return { locationPath: loc.path, filePath: p }; } catch (e) {}
    }
    for (const info of ACTIVE_MIGRATIONS.values()) {
        const p = path.join(info.fromPath, filename);
        try { if ((await fsp.stat(p)).isFile()) return { locationPath: info.fromPath, filePath: p }; } catch (e) {}
    }
    return null;
};

// "Most free space that can fit it" — the same idea the main server already uses one level up
// to pick a NAS node in the first place, applied here to picking a location within this node.
//
// RESERVED_BYTES_BY_LOCATION tracks bytes committed to uploads that have been routed to a
// location but haven't finished writing (or even started) yet. getAllDiskStats' free figure
// only reflects bytes already on disk, refreshed at most every DISK_STATS_TTL_MS — without
// this, two uploads arriving within that window both see the same cached free space and can
// both be routed to a location that can't actually fit their combined size, one or both then
// hitting ENOSPC mid-stream.
export const pickPlacementLocation = async (requiredBytes) => {
    const { locations } = await getAllDiskStats();
    const candidates = locations
        .map(l => ({ ...l, free: l.free - (RESERVED_BYTES_BY_LOCATION.get(l.id) || 0) }))
        .filter(l => l.free >= requiredBytes);
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.free - a.free);
    return RUNTIME.nasStorageLocations.find(loc => loc.id === candidates[0].id);
};
