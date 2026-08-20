import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';

/**
 * Only the publicUrl knob, and only because its failure mode is silent on both sides: the server
 * discards a url it cannot parse and has nothing left to try, while the node still logs a successful
 * registration. A typo would be indistinguishable from a broken tunnel, so it has to be caught here.
 */

let files = {};
let executables = new Set();
vi.mock('fs', () => {
    const api = {
        constants: { X_OK: 1 },
        existsSync: (p) => p in files,
        readFileSync: (p) => {
            if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return files[p];
        },
        accessSync: (p) => {
            if (!executables.has(p)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
        mkdirSync: () => {},
    };
    return { default: api, ...api };
});

const BASE = { id: 'n1', apiKey: 'k1', roles: ['nas'] };

let exitCode;
let errors;
beforeEach(() => {
    exitCode = undefined;
    errors = [];
    executables = new Set();
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    vi.spyOn(process, 'exit').mockImplementation((c) => { exitCode = c; throw new Error('__exit__'); });
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
});
afterEach(() => vi.restoreAllMocks());

// config.js reads and validates its file at import time, so each case needs a fresh module.
const load = async () => {
    vi.resetModules();
    return import('./config.js');
};

// config.js resolves node_config.json relative to its own module directory, which is this one.
const CONFIG_PATH = fileURLToPath(new URL('./node_config.json', import.meta.url));
const seed = (cfg) => {
    files = { [CONFIG_PATH]: JSON.stringify({ ...BASE, ...cfg }) };
};

describe('publicUrl', () => {
    it('is null when unset, leaving the node advertising its own address', async () => {
        seed({});
        const { ADVERTISED_URL } = await load();
        expect(ADVERTISED_URL).toBeNull();
    });

    it('is accepted for an http URL', async () => {
        seed({ publicUrl: 'http://127.0.0.1:14500' });
        const { ADVERTISED_URL } = await load();
        expect(ADVERTISED_URL).toBe('http://127.0.0.1:14500');
    });

    it('is accepted for https', async () => {
        seed({ publicUrl: 'https://node.example.com' });
        const { ADVERTISED_URL } = await load();
        expect(ADVERTISED_URL).toBe('https://node.example.com');
    });

    it('drops a trailing slash, since every consumer appends its own path', async () => {
        // `${node.url}/file/x` would otherwise build a double slash, and the node's router does not
        // match it.
        seed({ publicUrl: 'http://127.0.0.1:14500/' });
        const { ADVERTISED_URL } = await load();
        expect(ADVERTISED_URL).toBe('http://127.0.0.1:14500');
    });

    it('refuses to start on a bare host:port, which is the likely typo', async () => {
        seed({ publicUrl: '127.0.0.1:14500' });
        await expect(load()).rejects.toThrow('__exit__');
        expect(exitCode).toBe(1);
        expect(errors.join(' ')).toMatch(/publicUrl is not a valid http\(s\) URL/);
    });

    it('refuses a non-http scheme', async () => {
        seed({ publicUrl: 'ssh://127.0.0.1:14500' });
        await expect(load()).rejects.toThrow('__exit__');
        expect(exitCode).toBe(1);
    });
});

describe('ffmpegPath / ffprobePath', () => {
    const FFMPEG = '/opt/homebrew/bin/ffmpeg';

    it('is null when unset, leaving fluent-ffmpeg to search PATH as before', async () => {
        seed({});
        const { FFMPEG_PATH, FFPROBE_PATH } = await load();
        expect(FFMPEG_PATH).toBeNull();
        expect(FFPROBE_PATH).toBeNull();
    });

    it('takes an executable path from the config file', async () => {
        executables.add(FFMPEG);
        seed({ ffmpegPath: FFMPEG });
        expect((await load()).FFMPEG_PATH).toBe(FFMPEG);
    });

    it('falls back to the environment, which is what fluent-ffmpeg reads natively', async () => {
        executables.add(FFMPEG);
        process.env.FFMPEG_PATH = FFMPEG;
        seed({});
        expect((await load()).FFMPEG_PATH).toBe(FFMPEG);
    });

    it('prefers the config file over the environment', async () => {
        // The config file is the thing a node operator edits; an inherited environment variable is
        // the thing that surprises them.
        executables.add(FFMPEG);
        executables.add('/usr/bin/ffmpeg');
        process.env.FFMPEG_PATH = '/usr/bin/ffmpeg';
        seed({ ffmpegPath: FFMPEG });
        expect((await load()).FFMPEG_PATH).toBe(FFMPEG);
    });

    it('complains about a path that is not executable, but keeps the node running', async () => {
        // Unlike publicUrl, this has a meaningful partial outcome: a node holding the nas role still
        // serves and stores files without ffmpeg, and killing it over a mistyped transcoder path
        // would make every file already archived on it unplayable.
        seed({ ffmpegPath: '/opt/homebrew/bin/ffmpeg-typo' });
        const { FFMPEG_PATH } = await load();
        expect(FFMPEG_PATH).toBeNull();
        expect(exitCode).toBeUndefined();
        expect(errors.join(' ')).toMatch(/node_config.json ffmpegPath is .*not an executable file/);
    });

    it('names the environment as the source when that is where the bad value came from', async () => {
        process.env.FFPROBE_PATH = '/nope/ffprobe';
        seed({});
        const { FFPROBE_PATH } = await load();
        expect(FFPROBE_PATH).toBeNull();
        expect(errors.join(' ')).toMatch(/FFPROBE_PATH in the environment/);
    });
});
