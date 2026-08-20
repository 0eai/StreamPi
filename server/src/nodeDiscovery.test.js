import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KNOWN_NODES, KNOWN_NAS_NODES } from './state.js';

/**
 * The discovery listener is the only thing that decides which nodes exist and how to reach them, and
 * it runs on a Firebase snapshot the nodes themselves write. Getting membership wrong here doesn't
 * throw — it hands jobs to a node that cannot run them, or keeps polling one that is gone.
 */

let listener = null;
vi.mock('firebase-admin', () => ({
    default: {
        database: () => ({
            ref: () => ({
                on: (event, cb) => { if (event === 'value') listener = cb; },
            }),
        }),
    },
}));

vi.mock('./firebaseBootstrap.js', () => ({ isFirebaseActive: true }));

// Registered nodes, by id — the SQLite trust check the listener makes before believing anything a
// node reported about itself.
let registered = {};
vi.mock('./db.js', () => ({
    db: { get: async (_sql, id) => (registered[id] ? { api_key: registered[id] } : undefined) },
}));

// checkSingleNode fires for each newly discovered transcoder; the auto-mock makes it a no-op that
// fails inside its own try/catch rather than reaching the network.
vi.mock('axios');

const { initNodeDiscoveryListener } = await import('./nodeDiscovery.js');

const snapshot = async (nodes) => listener({ val: () => nodes });

const NODE = {
    id: 'orin2', roles: ['transcoder', 'nas'], url: 'http://127.0.0.1:14500',
    ip: '203.253.25.77', port: 4500,
};

beforeEach(async () => {
    KNOWN_NODES.clear();
    KNOWN_NAS_NODES.clear();
    registered = { orin2: 'key-orin2', pi: 'key-pi' };
    listener = null;
    initNodeDiscoveryListener();
});

describe('initNodeDiscoveryListener', () => {
    it('fans a both-roles node into both maps', async () => {
        await snapshot({ orin2: NODE });
        expect(KNOWN_NODES.has('orin2')).toBe(true);
        expect(KNOWN_NAS_NODES.has('orin2')).toBe(true);
        expect(KNOWN_NODES.get('orin2').apiKey).toBe('key-orin2');
    });

    it('will not trust a node with no registered row', async () => {
        // The silent case that looks identical to a network problem from the dashboard.
        registered = {};
        await snapshot({ orin2: NODE });
        expect(KNOWN_NODES.size).toBe(0);
        expect(KNOWN_NAS_NODES.size).toBe(0);
    });

    it('drops a node from the role it gave up, keeping the one it kept', async () => {
        // Moving transcoding to another machine is exactly this: the Pi keeps `nas` and loses
        // `transcoder`. It stays present in the snapshot, so the absent-node sweep never touches it.
        await snapshot({ pi: { ...NODE, id: 'pi' } });
        expect(KNOWN_NODES.has('pi')).toBe(true);

        await snapshot({ pi: { ...NODE, id: 'pi', roles: ['nas'] } });
        expect(KNOWN_NODES.has('pi')).toBe(false);
        expect(KNOWN_NAS_NODES.has('pi')).toBe(true);
    });

    it('drops a node that gives up every role', async () => {
        await snapshot({ orin2: NODE });
        await snapshot({ orin2: { ...NODE, roles: [] } });
        expect(KNOWN_NODES.has('orin2')).toBe(false);
        expect(KNOWN_NAS_NODES.has('orin2')).toBe(false);
    });

    it('drops a node that disappears from the snapshot', async () => {
        await snapshot({ orin2: NODE, pi: { ...NODE, id: 'pi' } });
        await snapshot({ orin2: NODE });
        expect(KNOWN_NODES.has('pi')).toBe(false);
        expect(KNOWN_NAS_NODES.has('pi')).toBe(false);
    });

    it('accepts a comma-separated roles string as well as an array', async () => {
        await snapshot({ orin2: { ...NODE, roles: 'transcoder,nas' } });
        expect(KNOWN_NODES.has('orin2')).toBe(true);
        expect(KNOWN_NAS_NODES.has('orin2')).toBe(true);
    });

    it('keeps a tunnel url, which is a loopback address on the server host', async () => {
        // The whole point of publicUrl: http://127.0.0.1:14500 is a legitimate node url here,
        // meaning "the near end of the tunnel", and must survive validation.
        await snapshot({ orin2: NODE });
        expect(KNOWN_NODES.get('orin2').url).toBe('http://127.0.0.1:14500');
    });

    it('nulls a url it cannot parse rather than passing it to an outbound request', async () => {
        await snapshot({ orin2: { ...NODE, url: 'not-a-url', directIp: '203.253.25.77', directPort: 4500 } });
        expect(KNOWN_NODES.get('orin2').url).toBeNull();
        // Still discovered — the direct address is independent of the url.
        expect(KNOWN_NODES.get('orin2').directIp).toBe('203.253.25.77');
    });

    it('leaves the direct address undefined when a node stops advertising one', async () => {
        // A tunnelled node omits directIp/directPort so the health check goes straight to the url
        // instead of burning its 2s timeout on an address that cannot work.
        await snapshot({ orin2: NODE });
        const entry = KNOWN_NODES.get('orin2');
        expect(entry.directIp).toBeUndefined();
        expect(entry.directPort).toBeUndefined();
    });

    it('updates transport fields on a node it already knows', async () => {
        await snapshot({ orin2: { ...NODE, url: 'http://203.253.25.77:4500', directIp: '203.253.25.77', directPort: 4500 } });
        await snapshot({ orin2: NODE });
        const entry = KNOWN_NODES.get('orin2');
        expect(entry.url).toBe('http://127.0.0.1:14500');
        expect(entry.directIp).toBeUndefined();
    });
});
