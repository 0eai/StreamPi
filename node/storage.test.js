import { describe, it, expect } from 'vitest';
import { isSafeFilename } from './storage.js';
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
