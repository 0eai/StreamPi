import fs from 'fs';
import { CFG, IS_NAS, normalizeStorageLocations } from './config.js';

// Shared mutable state touched by many otherwise-unrelated modules — mirrors the convention
// already established in server/src/state.js: Maps mutated only via .set/.get/.delete (never
// reassigned), and plain objects mutated only via in-place property assignment. So every
// export here is a `const`, and every importer always shares the exact same reference.

export const HW_CONFIG = { encoder: 'libx264', options: ['-preset ultrafast', '-crf 23', '-pix_fmt yuv420p', '-movflags +faststart'], description: 'CPU Software Encoding' };

export const JOB_STATE = { isTranscoding: false, currentJobId: null };

export const ACTIVE_UPLOADS = new Map();
export const ACTIVE_DOWNLOADS = new Map();
export const ACTIVE_MIGRATIONS = new Map(); // id -> { fromPath, toPath, filesTotal, filesMoved, bytesTotal, bytesMoved, status, conflicts }

// Tracks bytes committed to uploads that have been routed to a location but haven't finished
// writing (or even started) yet — see storage.js's pickPlacementLocation for why this exists.
export const RESERVED_BYTES_BY_LOCATION = new Map(); // locationId -> bytes reserved

export const RUNTIME = {
    nasStorageLocations: normalizeStorageLocations(CFG),
    maxConcurrentNasJobs: CFG.maxConcurrentNasJobs || 1,
    /**
     * Deliberately separate from maxConcurrentNasJobs, which bounds heavy transfer *jobs* (an
     * /archive write, a restore download) and is sensibly 1. Reads are a different shape of
     * work: a browser's <video> element opens several parallel range requests for one file, so
     * a shared bound of 1 admitted one and 503'd the rest — which the main server relabelled
     * as 502 "NAS Proxy Error", making an archived file unplayable on the web while Android
     * TV, whose player uses a single sequential connection, worked fine.
     *
     * Still bounded rather than unlimited, so one client can't exhaust the node's file handles.
     */
    maxConcurrentFileReads: CFG.maxConcurrentFileReads || 12
};

if (IS_NAS) for (const loc of RUNTIME.nasStorageLocations) fs.mkdirSync(loc.path, { recursive: true });

export const STATS = { cpu: 0, ram: { total: 0, used: 0, free: 0, percent: 0 }, network: { up: 0, down: 0 }, uptime: 0 };
