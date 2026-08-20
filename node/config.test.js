import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';

/**
 * Only the publicUrl knob, and only because its failure mode is silent on both sides: the server
 * discards a url it cannot parse and has nothing left to try, while the node still logs a successful
 * registration. A typo would be indistinguishable from a broken tunnel, so it has to be caught here.
 */

let files = {};
vi.mock('fs', () => {
    const api = {
        existsSync: (p) => p in files,
        readFileSync: (p) => {
            if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return files[p];
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
