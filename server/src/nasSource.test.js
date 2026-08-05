import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KNOWN_NAS_NODES } from './state.js';
import {
    parseNasPath,
    isNasPath,
    isNasNodeAvailable,
    resolveNasFile,
    withNasAvailability,
    NAS_AVAILABILITY_GRACE_MS,
} from './nasSource.js';

const node = (over = {}) => ({ id: 'n1', url: 'http://n1:4500', apiKey: 'k1', isReachable: true, lastSeen: 0, ...over });

describe('parseNasPath', () => {
    it('splits a well-formed path', () => {
        expect(parseNasPath('nas://n1/Movie.mp4')).toEqual({ nodeId: 'n1', filename: 'Movie.mp4' });
    });

    it('keeps interior slashes in the filename', () => {
        expect(parseNasPath('nas://n1/Show/S01E01.mp4')).toEqual({ nodeId: 'n1', filename: 'Show/S01E01.mp4' });
    });

    it('keeps a filename that itself contains "nas://"', () => {
        // Pinned because the implementation strips a fixed-length prefix where the call sites
        // it replaced used .replace('nas://',''). Both are correct here — replace only takes
        // the first occurrence — so this is a guard against a future "tidy-up" to a global
        // replace or a regex, which would eat the second one and corrupt the name.
        expect(parseNasPath('nas://n1/about nas:// scheme.mp4'))
            .toEqual({ nodeId: 'n1', filename: 'about nas:// scheme.mp4' });
    });

    it.each([
        ['not a nas path', '/mnt/media/Movie.mp4'],
        ['no filename', 'nas://n1/'],
        ['no filename, no slash', 'nas://n1'],
        ['no node id', 'nas:///Movie.mp4'],
        ['empty', ''],
        ['null', null],
        ['undefined', undefined],
    ])('returns null for %s', (_label, input) => {
        expect(parseNasPath(input)).toBeNull();
    });

    it('agrees with isNasPath on the prefix', () => {
        expect(isNasPath('nas://n1/a.mp4')).toBe(true);
        expect(isNasPath('/mnt/a.mp4')).toBe(false);
        expect(isNasPath(null)).toBe(false);
    });
});

describe('isNasNodeAvailable', () => {
    const NOW = 1_700_000_000_000;

    it('is true while the node is reachable', () => {
        expect(isNasNodeAvailable(node({ isReachable: true }), NOW)).toBe(true);
    });

    it('is false for a missing node', () => {
        expect(isNasNodeAvailable(undefined, NOW)).toBe(false);
    });

    it('tolerates a node that just missed a probe', () => {
        // checkNasHealth polls every 2s with a 2s timeout, so a node busy serving streams can
        // miss a tick while still serving files. Refusing playback on one miss would be worse
        // than the 502 this whole change removes.
        const justMissed = node({ isReachable: false, lastSeen: NOW - (NAS_AVAILABILITY_GRACE_MS - 1) });
        expect(isNasNodeAvailable(justMissed, NOW)).toBe(true);
    });

    it('gives up once the last success falls outside the grace window', () => {
        const stale = node({ isReachable: false, lastSeen: NOW - (NAS_AVAILABILITY_GRACE_MS + 1) });
        expect(isNasNodeAvailable(stale, NOW)).toBe(false);
    });

    it('is false for a node registered but never yet probed', () => {
        // nodeDiscovery.js seeds new entries with isReachable:false and no lastSeen; an
        // absent lastSeen must not read as "seen at epoch 0, therefore ancient but truthy".
        expect(isNasNodeAvailable(node({ isReachable: false, lastSeen: undefined }), NOW)).toBe(false);
        expect(isNasNodeAvailable(node({ isReachable: false, lastSeen: 0 }), NOW)).toBe(false);
    });
});

describe('resolveNasFile', () => {
    beforeEach(() => KNOWN_NAS_NODES.clear());
    afterEach(() => KNOWN_NAS_NODES.clear());

    it('resolves a reachable node to a fetchable url', () => {
        KNOWN_NAS_NODES.set('n1', node());
        expect(resolveNasFile('nas://n1/My Movie.mp4')).toMatchObject({
            ok: true,
            nodeId: 'n1',
            filename: 'My Movie.mp4',
            url: 'http://n1:4500/file/My%20Movie.mp4',
            apiKey: 'k1',
        });
    });

    it('503s an offline node instead of letting it through to a 502', () => {
        // The regression this guards: the old `if (!nasNode)` passed a registered-but-offline
        // node straight through to axios/ffmpeg, so the client saw 502 "NAS Proxy Error"
        // after the player had already opened.
        KNOWN_NAS_NODES.set('n1', node({ isReachable: false, lastSeen: 0 }));
        const r = resolveNasFile('nas://n1/Movie.mp4');
        expect(r.ok).toBe(false);
        expect(r.status).toBe(503);
        expect(r.error).toMatch(/offline/i);
    });

    it('distinguishes an unregistered node from an offline one', () => {
        const r = resolveNasFile('nas://ghost/Movie.mp4');
        expect(r).toMatchObject({ ok: false, status: 503 });
        expect(r.error).toMatch(/not registered/i);
    });

    it('404s a malformed stored path rather than building a broken url', () => {
        KNOWN_NAS_NODES.set('n1', node());
        expect(resolveNasFile('nas://n1/')).toMatchObject({ ok: false, status: 404 });
    });

    it('percent-encodes the filename but not the node url', () => {
        KNOWN_NAS_NODES.set('n1', node({ url: 'http://n1:4500' }));
        expect(resolveNasFile('nas://n1/a b&c#d.mp4').url)
            .toBe('http://n1:4500/file/a%20b%26c%23d.mp4');
    });
});

describe('withNasAvailability', () => {
    beforeEach(() => KNOWN_NAS_NODES.clear());
    afterEach(() => KNOWN_NAS_NODES.clear());

    it('leaves a local row untouched, with no availability fields at all', () => {
        // Absent rather than true, so a client can tell "not archived" from "archived and up".
        const row = { path: '/mnt/media/Movie.mp4', title: 'Movie' };
        const out = withNasAvailability(row);
        expect(out).toBe(row);
        expect(out).not.toHaveProperty('nas_available');
        expect(out).not.toHaveProperty('nas_node_id');
    });

    it('stamps an archived row on a reachable node as available', () => {
        KNOWN_NAS_NODES.set('n1', node());
        expect(withNasAvailability({ path: 'nas://n1/Movie.mp4' }))
            .toMatchObject({ nas_node_id: 'n1', nas_available: true });
    });

    it('stamps an archived row on an offline node as unavailable', () => {
        KNOWN_NAS_NODES.set('n1', node({ isReachable: false, lastSeen: 0 }));
        expect(withNasAvailability({ path: 'nas://n1/Movie.mp4' }))
            .toMatchObject({ nas_node_id: 'n1', nas_available: false });
    });

    it('stamps an unregistered node as unavailable, still reporting the id', () => {
        expect(withNasAvailability({ path: 'nas://ghost/Movie.mp4' }))
            .toMatchObject({ nas_node_id: 'ghost', nas_available: false });
    });

    it('does not mutate the row it is given', () => {
        KNOWN_NAS_NODES.set('n1', node());
        const row = { path: 'nas://n1/Movie.mp4' };
        withNasAvailability(row);
        expect(row).toEqual({ path: 'nas://n1/Movie.mp4' });
    });

    it('preserves every other column', () => {
        KNOWN_NAS_NODES.set('n1', node());
        const row = { path: 'nas://n1/M.mp4', title: 'M', is_archived: 1, is_private: 0, duration: 42 };
        expect(withNasAvailability(row)).toMatchObject(row);
    });
});
