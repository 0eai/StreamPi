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

const axios = (await import('axios')).default;
const { initNodeDiscoveryListener, getBestNasNode, getNasNodeById, checkSingleNode } = await import('./nodeDiscovery.js');

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

/**
 * Choosing a destination by hand and letting the server choose have to agree about what "fits",
 * otherwise a hand-picked node silently accepts a file the automatic path would have refused — and
 * the refusals have to stay distinguishable, since each one asks something different of the user.
 */
const GB = 1024 ** 3;
const nasNode = (id, freeGb, isReachable = true) => [id, {
    id, isReachable, stats: { disk: { free: freeGb * GB } },
}];

describe('NAS node selection', () => {
    beforeEach(() => {
        KNOWN_NAS_NODES.clear();
        KNOWN_NAS_NODES.set(...nasNode('orin2', 150));
        KNOWN_NAS_NODES.set(...nasNode('pi', 9));
    });

    it('picks the emptiest node when none is named', () => {
        expect(getBestNasNode(1 * GB).id).toBe('orin2');
    });

    it('returns the node that was named, not the emptiest one', () => {
        // The whole point: a 5GB file fits on the Pi, so it must go there when asked, even though
        // orin2 has far more room.
        expect(getNasNodeById('pi', 5 * GB).node.id).toBe('pi');
    });

    it('holds a named node to the same headroom as the automatic pick', () => {
        // 9GB free, 8.5GB file: fits on disk, fails the 1GB headroom. getBestNasNode would skip it,
        // so an explicit choice must be refused too.
        const size = 8.5 * GB;
        expect(getBestNasNode(size).id).toBe('orin2');
        expect(getNasNodeById('pi', size).error).toBe('full');
    });

    it('reports how much room a full node actually had', () => {
        const refusal = getNasNodeById('pi', 8.5 * GB);
        expect(refusal.free).toBe(9 * GB);
        expect(refusal.headroom).toBe(GB);
    });

    it('distinguishes unreachable from full', () => {
        KNOWN_NAS_NODES.set(...nasNode('offline', 500, false));
        expect(getNasNodeById('offline', 1 * GB).error).toBe('unreachable');
    });

    it('distinguishes an id that is not a NAS node at all', () => {
        expect(getNasNodeById('never-existed', 1 * GB).error).toBe('unknown');
    });

    it('treats a node with no stats as full rather than assuming room', () => {
        // checkNasHealth nulls stats the moment a probe fails, and `|| 0` must not become "unknown,
        // so allow it".
        KNOWN_NAS_NODES.set('nostats', { id: 'nostats', isReachable: true, stats: null });
        expect(getNasNodeById('nostats', 1).error).toBe('full');
    });
});

/**
 * The stats copy is a whitelist while checkNasHealth's is a wholesale assignment, so a field can be
 * correct at the node and correct in the dashboard payload and still never arrive. That is exactly
 * what happened to `work`, which is why this is pinned rather than left to the two ends agreeing.
 */
describe('checkSingleNode stats', () => {
    const PAYLOAD = {
        hardware: 'Apple (VideoToolbox)',
        cpu: 3, ram: { percent: 94 }, network: { up: 0, down: 0 }, uptime: 72,
        work: { path: '/Users/monus/.../transcoder_work', free: 48318382080, total: 245111386112, staged: 0 },
        busy: false,
    };

    beforeEach(() => {
        axios.get.mockReset();
        axios.get.mockResolvedValue({ data: PAYLOAD });
    });

    it('carries scratch-space stats through to the node entry', async () => {
        const node = { id: 'mac', apiKey: 'k', url: 'http://127.0.0.1:14501' };
        await checkSingleNode(node);
        expect(node.stats.work).toEqual(PAYLOAD.work);
    });

    it('still carries the fields it always did', async () => {
        const node = { id: 'mac', apiKey: 'k', url: 'http://127.0.0.1:14501' };
        await checkSingleNode(node);
        expect(node.stats).toMatchObject({ cpu: 3, uptime: 72, ram: { percent: 94 } });
        expect(node.hardware).toBe('Apple (VideoToolbox)');
    });

    it('leaves work undefined for a node that reports none, rather than inventing zeroes', async () => {
        // A node with no transcoder role sends no `work`, and the dashboard renders an em dash for it.
        axios.get.mockResolvedValue({ data: { ...PAYLOAD, work: undefined } });
        const node = { id: 'nas-only', apiKey: 'k', url: 'http://nas:4500' };
        await checkSingleNode(node);
        expect(node.stats.work).toBeUndefined();
    });

    it('reaches a tunnelled node through its url when there is no direct address', async () => {
        const node = { id: 'mac', apiKey: 'k', url: 'http://127.0.0.1:14501' };
        await checkSingleNode(node);
        expect(axios.get).toHaveBeenCalledWith('http://127.0.0.1:14501/stats', expect.anything());
        expect(node.isReachable).toBe(true);
        expect(node.statusTunnel).toBe(true);
    });

    it('marks a node unreachable when both paths fail, without stale stats surviving', async () => {
        axios.get.mockRejectedValue(new Error('ETIMEDOUT'));
        const node = { id: 'mac', apiKey: 'k', url: 'http://127.0.0.1:14501', failedStrikes: 0 };
        await checkSingleNode(node);
        expect(node.isReachable).toBe(false);
        expect(node.failedStrikes).toBe(1);
    });
});
