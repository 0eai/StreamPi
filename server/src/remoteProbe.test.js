import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The cache is the load-bearing part. A <video> element opens several range requests to start playback
 * and another on every seek, and each enters the stream handler — so an uncached probe would mean a
 * fistful of round trips to the node per play, which is why streamCore never probed NAS files in the
 * first place.
 */

let probeCalls = [];
let probeResult = { streams: [{ codec_type: 'video', codec_name: 'h264' }], format: {} };
vi.mock('child_process', () => ({
    execFile: (bin, args, opts, cb) => {
        probeCalls.push({ bin, args });
        setImmediate(() => (probeResult
            ? cb(null, JSON.stringify(probeResult), '')
            : cb(new Error('ffprobe failed'), '', '')));
    },
}));

let resolvable = true;
vi.mock('./nasSource.js', () => ({
    resolveNasFile: (p) => (resolvable
        ? { ok: true, url: `http://node/file/${encodeURIComponent(p)}`, apiKey: 'k', nodeId: 'n1', filename: 'f.mp4' }
        : { ok: false, status: 503, error: 'node offline' }),
}));

const { probeNasFile, forgetNasProbe } = await import('./remoteProbe.js');

const PATH_A = 'nas://n1/A.mp4';

beforeEach(() => {
    probeCalls = [];
    resolvable = true;
    probeResult = { streams: [{ codec_type: 'video', codec_name: 'h264' }], format: {} };
    forgetNasProbe(PATH_A);
    forgetNasProbe('nas://n1/B.mp4');
});

describe('probeNasFile', () => {
    it('probes the node with an auth header', async () => {
        const meta = await probeNasFile(PATH_A);
        expect(meta.streams[0].codec_name).toBe('h264');
        expect(probeCalls[0].args).toContain('-headers');
        expect(probeCalls[0].args.join(' ')).toContain('Authorization: Bearer k');
    });

    it('probes once and serves every later request from cache', async () => {
        // This is what makes probing per-stream affordable at all.
        await probeNasFile(PATH_A);
        await probeNasFile(PATH_A);
        await probeNasFile(PATH_A);
        expect(probeCalls).toHaveLength(1);
    });

    it('caches per path, not globally', async () => {
        await probeNasFile(PATH_A);
        await probeNasFile('nas://n1/B.mp4');
        expect(probeCalls).toHaveLength(2);
    });

    it('re-probes after the path is explicitly forgotten', async () => {
        // An in-place transcode retires the old path; a later file reusing the name must not inherit
        // this one's streams.
        await probeNasFile(PATH_A);
        forgetNasProbe(PATH_A);
        await probeNasFile(PATH_A);
        expect(probeCalls).toHaveLength(2);
    });

    it('returns null when the node cannot be resolved, without probing', async () => {
        resolvable = false;
        expect(await probeNasFile(PATH_A)).toBeNull();
        expect(probeCalls).toHaveLength(0);
    });

    it('returns null when ffprobe fails', async () => {
        probeResult = null;
        expect(await probeNasFile(PATH_A)).toBeNull();
    });

    it('does not retry a failure on every request', async () => {
        // Otherwise a file on a downed node would be probed once per range request.
        probeResult = null;
        await probeNasFile(PATH_A);
        await probeNasFile(PATH_A);
        await probeNasFile(PATH_A);
        expect(probeCalls).toHaveLength(1);
    });

    it('treats a result with no streams as a failure, so it is retried later', async () => {
        // Indistinguishable from a successful probe of an empty file, and useless to the caller.
        probeResult = { streams: [], format: {} };
        expect(await probeNasFile(PATH_A)).toBeNull();
    });

    it('caches a success over a previous failure once the node returns', async () => {
        probeResult = null;
        await probeNasFile(PATH_A);
        forgetNasProbe(PATH_A);           // stands in for the failure TTL expiring
        probeResult = { streams: [{ codec_type: 'video', codec_name: 'hevc' }], format: {} };
        const meta = await probeNasFile(PATH_A);
        expect(meta.streams[0].codec_name).toBe('hevc');
    });
});
