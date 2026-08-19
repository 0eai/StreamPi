import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Detection is a one-shot boot-time decision that every later job depends on, and it now has real
 * branching: a pin, a device-gated VAAPI entry, and options that have to reach the probe. These pin
 * the decisions rather than the ffmpeg invocation — the invocation itself was verified by hand
 * against real ffmpeg, which a unit test cannot do.
 */

// A fake fluent-ffmpeg that records what a probe was built with and answers from a lookup.
let probeResults = {};
let probeCalls = [];
const chain = () => {
    const spec = { encoder: null, inputOptions: [], outputOptions: [] };
    const self = {
        input: () => self,
        inputFormat: () => self,
        inputOptions: (o) => { spec.inputOptions.push(...o); return self; },
        noAudio: () => self,
        videoCodec: (c) => { spec.encoder = c; return self; },
        outputOptions: (o) => { spec.outputOptions.push(...o); return self; },
        outputFormat: () => self,
        output: () => self,
        on: (event, cb) => {
            if (event === 'end') self._end = cb;
            if (event === 'error') self._error = cb;
            return self;
        },
        run: () => {
            probeCalls.push(spec);
            // Deliberately async, matching a real probe, so a test cannot pass by accident on
            // synchronous resolution ordering.
            setImmediate(() => (probeResults[spec.encoder] ? self._end() : self._error(new Error('nope'))));
        },
    };
    return self;
};
vi.mock('fluent-ffmpeg', () => ({ default: chain }));

let deviceExists = true;
vi.mock('fs', () => ({ default: { existsSync: () => deviceExists }, existsSync: () => deviceExists }));

let cfg = {};
// state.js imports IS_NAS and normalizeStorageLocations from here as well, so the mock has to cover
// all three or its module evaluation throws. IS_NAS false also keeps state.js's boot-time mkdirSync
// out of the way — a unit test has no business creating storage directories.
vi.mock('./config.js', () => ({
    get CFG() { return cfg; },
    IS_NAS: false,
    normalizeStorageLocations: () => [],
}));

const { HW_CONFIG } = await import('./state.js');
const { detectHardware } = await import('./hardware.js');

const CPU_DEFAULT = { encoder: 'libx264', description: 'CPU Software Encoding' };

beforeEach(() => {
    probeResults = {};
    probeCalls = [];
    deviceExists = true;
    cfg = {};
    // HW_CONFIG is a shared mutable object by design, so it has to be reset between tests.
    Object.assign(HW_CONFIG, {
        encoder: 'libx264',
        inputOptions: [],
        options: ['-preset ultrafast', '-crf 23', '-pix_fmt yuv420p', '-movflags +faststart'],
        description: 'CPU Software Encoding',
    });
});

describe('detectHardware', () => {
    it('falls back to CPU when nothing works, which is this machine without a pin', async () => {
        await detectHardware();
        expect(HW_CONFIG).toMatchObject(CPU_DEFAULT);
        expect(HW_CONFIG.inputOptions).toEqual([]);
        expect(probeCalls).toHaveLength(5);
    });

    it('probes with the options a real job would use, not the bare codec name', async () => {
        // The reason the old probe reported VAAPI as unavailable on hardware where it works: it
        // passed only the encoder name, and VAAPI needs its device and its upload filter.
        await detectHardware();
        const vaapi = probeCalls.find((c) => c.encoder === 'h264_vaapi');
        expect(vaapi.inputOptions).toEqual(['-vaapi_device /dev/dri/renderD128']);
        expect(vaapi.outputOptions).toContain('-vf format=nv12,hwupload');
    });

    it('omits the VAAPI device where there is no render node, so the Pi is unaffected', async () => {
        deviceExists = false;
        await detectHardware();
        expect(probeCalls.find((c) => c.encoder === 'h264_vaapi').inputOptions).toEqual([]);
    });

    it('carries input options through to HW_CONFIG when VAAPI wins', async () => {
        probeResults = { h264_vaapi: true };
        await detectHardware();
        expect(HW_CONFIG.encoder).toBe('h264_vaapi');
        expect(HW_CONFIG.inputOptions).toEqual(['-vaapi_device /dev/dri/renderD128']);
        expect(HW_CONFIG.description).toBe('Intel/AMD VAAPI');
    });

    it('leaves inputOptions empty for an encoder that needs none', async () => {
        // Otherwise a previous VAAPI pick could leak its device onto an nvenc job.
        probeResults = { h264_nvenc: true };
        await detectHardware();
        expect(HW_CONFIG.encoder).toBe('h264_nvenc');
        expect(HW_CONFIG.inputOptions).toEqual([]);
    });

    it('stops at the first encoder that works', async () => {
        probeResults = { h264_v4l2m2m: true, h264_vaapi: true };
        await detectHardware();
        expect(HW_CONFIG.encoder).toBe('h264_v4l2m2m');
        expect(probeCalls.map((c) => c.encoder)).toEqual(['h264_nvenc', 'h264_nvv4l2enc', 'h264_v4l2m2m']);
    });

    describe('the encoder pin', () => {
        it('tries the pinned encoder first, skipping the ones ahead of it', async () => {
            cfg = { encoder: 'h264_vaapi' };
            probeResults = { h264_vaapi: true };
            await detectHardware();
            expect(HW_CONFIG.encoder).toBe('h264_vaapi');
            expect(probeCalls).toHaveLength(1);
        });

        it('still probes the pin, so a pin that cannot work is caught at boot not per job', async () => {
            cfg = { encoder: 'h264_vaapi' };
            probeResults = { h264_v4l2m2m: true };
            await detectHardware();
            // Pin failed, so detection ran and found what actually works.
            expect(HW_CONFIG.encoder).toBe('h264_v4l2m2m');
            expect(probeCalls[0].encoder).toBe('h264_vaapi');
        });

        it('pins CPU without running ffmpeg at all', async () => {
            cfg = { encoder: 'libx264' };
            await detectHardware();
            expect(HW_CONFIG).toMatchObject(CPU_DEFAULT);
            expect(probeCalls).toHaveLength(0);
        });

        it('treats "auto" and an unknown name as no pin', async () => {
            for (const encoder of ['auto', 'h264_nonsense']) {
                probeCalls = [];
                cfg = { encoder };
                probeResults = { h264_vaapi: true };
                await detectHardware();
                expect(HW_CONFIG.encoder, encoder).toBe('h264_vaapi');
                // Full detection ran rather than nothing happening.
                expect(probeCalls.length, encoder).toBe(5);
            }
        });
    });
});
