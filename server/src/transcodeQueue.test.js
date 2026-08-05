import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { KNOWN_NODES } from './state.js';
import { getAvailableTranscoder } from './transcodeQueue.js';

vi.mock('axios');

const makeNode = (overrides) => ({
    id: 'node-1', isReachable: true, activeUrl: 'http://node-1:4500', activeJob: null, apiKey: 'key', ...overrides
});

describe('getAvailableTranscoder', () => {
    beforeEach(() => {
        KNOWN_NODES.clear();
        vi.clearAllMocks();
    });

    it('returns null when no nodes are known at all', async () => {
        expect(await getAvailableTranscoder()).toBeNull();
    });

    it('returns null when no known node passes the local readiness filter', async () => {
        KNOWN_NODES.set('a', makeNode({ id: 'a', isReachable: false }));
        KNOWN_NODES.set('b', makeNode({ id: 'b', activeJob: 'some-other-job' }));
        expect(await getAvailableTranscoder()).toBeNull();
        expect(axios.get).not.toHaveBeenCalled(); // never even probes an already-known-bad node
    });

    it('selects a ready node that probes online and not busy', async () => {
        const node = makeNode();
        KNOWN_NODES.set('node-1', node);
        axios.get.mockResolvedValue({ data: { online: true, busy: false } });

        const result = await getAvailableTranscoder();
        expect(result).toBe(node);
        expect(axios.get).toHaveBeenCalledWith('http://node-1:4500/status', expect.objectContaining({ timeout: 2000 }));
    });

    it('skips a candidate that probes as busy and tries the next one', async () => {
        KNOWN_NODES.set('busy', makeNode({ id: 'busy', activeUrl: 'http://busy:4500' }));
        KNOWN_NODES.set('free', makeNode({ id: 'free', activeUrl: 'http://free:4500' }));
        axios.get.mockImplementation((url) =>
            url.startsWith('http://busy')
                ? Promise.resolve({ data: { online: true, busy: true } })
                : Promise.resolve({ data: { online: true, busy: false } })
        );

        const result = await getAvailableTranscoder();
        expect(result.id).toBe('free');
    });

    it('falls through a candidate whose probe request fails (network error) to the next one', async () => {
        KNOWN_NODES.set('unreachable', makeNode({ id: 'unreachable', activeUrl: 'http://unreachable:4500' }));
        KNOWN_NODES.set('ok', makeNode({ id: 'ok', activeUrl: 'http://ok:4500' }));
        axios.get.mockImplementation((url) =>
            url.startsWith('http://unreachable')
                ? Promise.reject(new Error('connect ECONNREFUSED'))
                : Promise.resolve({ data: { online: true, busy: false } })
        );

        const result = await getAvailableTranscoder();
        expect(result.id).toBe('ok');
    });

    it('returns null when every ready candidate fails its probe', async () => {
        KNOWN_NODES.set('a', makeNode({ id: 'a' }));
        axios.get.mockRejectedValue(new Error('timeout'));
        expect(await getAvailableTranscoder()).toBeNull();
    });
});
