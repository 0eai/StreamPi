import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The behaviour worth pinning is the *selection*, not the ffmpeg invocation: that a blank first
 * candidate does not become the poster when a later offset has content, that a good first candidate
 * costs no extra network seeks, and that a film which is dark throughout still gets its best frame
 * rather than nothing. Assi (2026) is the real case — 1,248 bytes at 10%, 8,162 at 25%.
 */

let attempts = [];
let sizeFor = () => 5000;
vi.mock('fluent-ffmpeg', () => {
    const chain = (source) => {
        const spec = { source, seek: null, out: [] };
        const self = {
            inputOptions: (o) => { spec.inputOptions = o; return self; },
            seekInput: (s) => { spec.seek = s; return self; },
            outputOptions: (o) => { spec.out.push(...o); return self; },
            on: (ev, cb) => { self[`_${ev}`] = cb; return self; },
            kill: () => {},
            save: (p) => {
                attempts.push({ ...spec, outPath: p });
                setImmediate(() => {
                    const size = sizeFor(spec.seek);
                    if (size === null) return self._error(new Error('nope'));
                    fs.writeFileSync(p, Buffer.alloc(size));
                    self._end();
                });
            },
        };
        return self;
    };
    return { default: chain };
});

const { extractPosterFrame } = await import('./posterFrame.js');

let dir;
beforeEach(() => {
    attempts = [];
    sizeFor = () => 5000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posterframe-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (duration) => extractPosterFrame({ source: 'http://node/file.mp4', duration, thumbFolder: dir, thumbName: 'out.jpg' });

describe('extractPosterFrame', () => {
    it('stops at the first candidate that has content', async () => {
        expect(await run(1000)).toBe(true);
        expect(attempts).toHaveLength(1);
        expect(fs.existsSync(path.join(dir, 'out.jpg'))).toBe(true);
    });

    it('seeks to 10% first, preserving the original intent', async () => {
        await run(1000);
        expect(attempts[0].seek).toBe(100);
    });

    it('moves on from a blank frame and keeps the one with content', async () => {
        // Exactly Assi: near-black at 10%, a real scene at 25%.
        sizeFor = (s) => (s === 100 ? 1248 : 8162);
        expect(await run(1000)).toBe(true);
        expect(attempts.map((a) => a.seek)).toEqual([100, 250]);
        expect(fs.statSync(path.join(dir, 'out.jpg')).size).toBe(8162);
    });

    it('keeps the best available frame when every candidate is dark', async () => {
        // A film that is dark throughout should still get a poster, just its least-bad frame.
        sizeFor = (s) => ({ 100: 900, 250: 1500, 500: 1100 })[s];
        expect(await run(1000)).toBe(true);
        expect(attempts).toHaveLength(3);
        expect(fs.statSync(path.join(dir, 'out.jpg')).size).toBe(1500);
    });

    it('leaves no .try files behind', async () => {
        sizeFor = (s) => ({ 100: 900, 250: 1500, 500: 1100 })[s];
        await run(1000);
        expect(fs.readdirSync(dir)).toEqual(['out.jpg']);
    });

    it('uses the thumbnail filter, which is what avoids blanks within a candidate', async () => {
        await run(1000);
        expect(attempts[0].out.join(' ')).toContain('thumbnail=100');
    });

    it('seeks before the input, so a network source is not decoded from the start', async () => {
        // seekInput, not an output seek — the difference between a byte-range jump and minutes.
        await run(1000);
        expect(attempts[0].seek).toBeGreaterThan(0);
    });

    it('falls back to a fixed offset when the duration is unknown', async () => {
        await run(0);
        expect(attempts.map((a) => a.seek)).toEqual([5]);
    });

    it('reports failure when no candidate produces anything', async () => {
        sizeFor = () => null;
        expect(await run(1000)).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('passes auth input options through for a NAS source', async () => {
        await extractPosterFrame({
            source: 'http://node/f.mp4', duration: 1000, thumbFolder: dir, thumbName: 'o.jpg',
            inputOptions: ['-headers', 'Authorization: Bearer k'],
        });
        expect(attempts[0].inputOptions).toEqual(['-headers', 'Authorization: Bearer k']);
    });
});
