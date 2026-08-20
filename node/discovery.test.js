import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What this node writes to `nodes/<id>` is the *only* thing telling the main server how to reach it,
 * and the server's data plane — health checks, archive uploads, playback of archived media — all key
 * off those few fields. A wrong value here doesn't fail loudly; the node reports a successful
 * registration and simply never becomes reachable, which is what these tests exist to prevent.
 */

let writes = [];
let writeError = null;
vi.mock('firebase/database', () => ({
    ref: (_db, path) => ({ path }),
    set: async (r, value) => {
        if (writeError) throw new Error(writeError);
        writes.push({ path: r.path, value });
    },
}));

vi.mock('./firebase.js', () => ({ fbDb: {}, API_KEY_HASH: 'hash-of-the-api-key' }));

// state.js reaches for config and creates storage directories on import; the description is all
// discovery.js actually reads from it.
let hwDescription = 'Intel/AMD VAAPI';
vi.mock('./state.js', () => ({ HW_CONFIG: { get description() { return hwDescription; } } }));

let cfg;
vi.mock('./config.js', () => ({
    get ID() { return cfg.ID; },
    get ROLES() { return cfg.ROLES; },
    get PORT() { return cfg.PORT; },
    get IS_TRANSCODER() { return cfg.IS_TRANSCODER; },
    get ADVERTISED_URL() { return cfg.ADVERTISED_URL; },
}));

let ifaces = {};
vi.mock('os', () => ({ default: { networkInterfaces: () => ifaces } }));

const ONE_IFACE = { enp0s31f6: [{ family: 'IPv4', internal: false, address: '203.253.25.77' }] };

// registerWithFirebase remembers the last IP it reported in module scope, so each test gets a fresh
// module rather than sharing that state.
const load = async () => {
    vi.resetModules();
    return import('./discovery.js');
};

beforeEach(() => {
    writes = [];
    writeError = null;
    hwDescription = 'Intel/AMD VAAPI';
    ifaces = ONE_IFACE;
    cfg = { ID: 'orin2_97f9ba', ROLES: ['transcoder', 'nas'], PORT: 4500, IS_TRANSCODER: true, ADVERTISED_URL: null };
});

describe('getLocalIp', () => {
    it('skips tunnel interfaces, which would publish an address nothing can route', async () => {
        ifaces = {
            wg0: [{ family: 'IPv4', internal: false, address: '10.8.0.2' }],
            tun0: [{ family: 'IPv4', internal: false, address: '10.9.0.2' }],
            enp0s31f6: [{ family: 'IPv4', internal: false, address: '203.253.25.77' }],
        };
        const { getLocalIp } = await load();
        expect(getLocalIp()).toBe('203.253.25.77');
    });

    it('skips loopback', async () => {
        ifaces = {
            lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
            eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }],
        };
        const { getLocalIp } = await load();
        expect(getLocalIp()).toBe('192.168.1.5');
    });

    it('falls back to loopback when there is nothing else', async () => {
        ifaces = { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] };
        const { getLocalIp } = await load();
        expect(getLocalIp()).toBe('127.0.0.1');
    });
});

describe('registerWithFirebase', () => {
    it('advertises its own address when there is no tunnel', async () => {
        const { registerWithFirebase } = await load();
        await registerWithFirebase();
        expect(writes).toHaveLength(1);
        expect(writes[0].path).toBe('nodes/orin2_97f9ba');
        expect(writes[0].value).toMatchObject({
            id: 'orin2_97f9ba',
            url: 'http://203.253.25.77:4500',
            ip: '203.253.25.77',
            port: 4500,
            directIp: '203.253.25.77',
            directPort: 4500,
            hardware: 'Intel/AMD VAAPI',
            apiKeyHash: 'hash-of-the-api-key',
        });
    });

    it('advertises the tunnel URL when one is configured', async () => {
        cfg.ADVERTISED_URL = 'http://127.0.0.1:14500';
        const { registerWithFirebase } = await load();
        await registerWithFirebase();
        expect(writes[0].value.url).toBe('http://127.0.0.1:14500');
    });

    it('omits the direct address entirely on a tunnelled node', async () => {
        // Not null, not undefined — absent. The server tries directIp first and only falls back to
        // url after it times out, so leaving an unreachable address here costs 2s before every
        // check that can actually succeed, on a 2s interval.
        cfg.ADVERTISED_URL = 'http://127.0.0.1:14500';
        const { registerWithFirebase } = await load();
        await registerWithFirebase();
        expect('directIp' in writes[0].value).toBe(false);
        expect('directPort' in writes[0].value).toBe(false);
    });

    it('still reports ip and port on a tunnelled node', async () => {
        // The server logs these when it discovers a NAS node; dropping them would make the log line
        // read "at undefined".
        cfg.ADVERTISED_URL = 'http://127.0.0.1:14500';
        const { registerWithFirebase } = await load();
        await registerWithFirebase();
        expect(writes[0].value).toMatchObject({ ip: '203.253.25.77', port: 4500 });
    });

    it('reports no hardware when it is not a transcoder', async () => {
        cfg.IS_TRANSCODER = false;
        const { registerWithFirebase } = await load();
        await registerWithFirebase();
        expect(writes[0].value.hardware).toBeNull();
    });

    it('does not rewrite when nothing has changed', async () => {
        const { registerWithFirebase } = await load();
        await registerWithFirebase();
        await registerWithFirebase();
        expect(writes).toHaveLength(1);
    });

    it('rewrites when the local IP changes', async () => {
        const { registerWithFirebase } = await load();
        await registerWithFirebase();
        ifaces = { enp0s31f6: [{ family: 'IPv4', internal: false, address: '203.253.25.90' }] };
        await registerWithFirebase();
        expect(writes).toHaveLength(2);
        expect(writes[1].value.url).toBe('http://203.253.25.90:4500');
    });

    it('survives a write that fails, and retries on the next call', async () => {
        // The write is rejected outright if apiKeyHash stops matching a revoked or re-issued key,
        // and this runs on an interval — throwing here would take the process down. It must also
        // not mark the IP as reported, or one rejected write would silence every later attempt.
        writeError = 'PERMISSION_DENIED';
        const { registerWithFirebase } = await load();
        await expect(registerWithFirebase()).resolves.toBeUndefined();
        expect(writes).toHaveLength(0);

        writeError = null;
        await registerWithFirebase();
        expect(writes).toHaveLength(1);
    });
});
