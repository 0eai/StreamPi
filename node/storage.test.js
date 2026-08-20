import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isSafeFilename, getWorkDirStats } from './storage.js';
import { normalizeStorageLocations } from './config.js';

describe('isSafeFilename', () => {
    it('accepts a plain flat filename', () => {
        expect(isSafeFilename('movie.mp4')).toBe(true);
    });

    it('rejects path traversal attempts', () => {
        expect(isSafeFilename('../etc/passwd')).toBe(false);
        expect(isSafeFilename('..')).toBe(false);
        expect(isSafeFilename('.')).toBe(false);
    });

    it('rejects anything containing a path separator', () => {
        expect(isSafeFilename('sub/dir/file.mp4')).toBe(false);
    });

    it('rejects non-string or empty input', () => {
        expect(isSafeFilename('')).toBe(false);
        expect(isSafeFilename(null)).toBe(false);
        expect(isSafeFilename(undefined)).toBe(false);
    });
});

describe('normalizeStorageLocations', () => {
    it('passes through an already-shaped nasStorageLocations array untouched', () => {
        const cfg = { nasStorageLocations: [{ id: 'a', path: '/data/a', limitBytes: 100 }] };
        expect(normalizeStorageLocations(cfg)).toBe(cfg.nasStorageLocations);
    });

    it('reshapes a legacy single-path config into a one-entry array, preserving the path/limit', () => {
        const cfg = { nasStorageRoot: '/data/legacy', nasStorageLimitBytes: 5000 };
        const result = normalizeStorageLocations(cfg);
        expect(result).toEqual([{ id: 'default', path: '/data/legacy', limitBytes: 5000 }]);
    });

    it('falls back to a default path/limit when neither is configured', () => {
        const result = normalizeStorageLocations({});
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('default');
        expect(result[0].limitBytes).toBe(10 * 1024 * 1024 * 1024);
    });
});

describe('getWorkDirStats', () => {
    /**
     * Real directories rather than a mocked fs: what this reports is a filesystem fact, and a fake
     * statfs would only be asserting that the code calls the function I told it to call.
     */
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-stats-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('reports real filesystem space, not a quota', async () => {
        // The distinction that matters against getLocationStats: nothing here is reserved for this
        // node, so `total` is the disk and running out fails a job rather than declining one.
        const s = await getWorkDirStats(dir);
        expect(s.path).toBe(dir);
        expect(s.total).toBeGreaterThan(0);
        expect(s.free).toBeGreaterThan(0);
        expect(s.free).toBeLessThanOrEqual(s.total);
    });

    it('counts only this node\'s own staged files, and only files', async () => {
        fs.writeFileSync(path.join(dir, 'input_1.mp4'), Buffer.alloc(4096));
        fs.writeFileSync(path.join(dir, 'output_1.mp4'), Buffer.alloc(2048));
        fs.mkdirSync(path.join(dir, 'a-directory'));
        expect((await getWorkDirStats(dir)).staged).toBe(6144);
    });

    it('reports nothing staged for an empty work dir', async () => {
        expect((await getWorkDirStats(dir)).staged).toBe(0);
    });

    it('returns zeroes rather than throwing when the path is gone', async () => {
        // A removable disk unmounted under a configured workDir. Zeroes render as "0 B free", which
        // reads as a problem; null would render as a blank cell, indistinguishable from a node that
        // has no scratch space to report at all.
        const s = await getWorkDirStats(path.join(dir, 'no', 'such', 'place'));
        expect(s).toEqual({ path: path.join(dir, 'no', 'such', 'place'), free: 0, total: 0, staged: 0 });
    });
});
