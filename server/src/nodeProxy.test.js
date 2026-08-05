import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { KNOWN_NODES, KNOWN_NAS_NODES } from './state.js';
import { resolveLiveNode, proxyToNode } from './nodeProxy.js';

vi.mock('axios');

const mockReqRes = (params, body) => {
    const req = { params, body };
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    return { req, res };
};

describe('resolveLiveNode', () => {
    beforeEach(() => { KNOWN_NODES.clear(); KNOWN_NAS_NODES.clear(); });

    it('resolves from KNOWN_NODES (transcoder) when present', () => {
        KNOWN_NODES.set('n1', { apiKey: 'k1', activeUrl: 'http://n1:4500' });
        expect(resolveLiveNode('n1')).toEqual({ apiKey: 'k1', url: 'http://n1:4500' });
    });

    it('resolves from KNOWN_NAS_NODES when not a transcoder', () => {
        KNOWN_NAS_NODES.set('n2', { apiKey: 'k2', url: 'http://n2:4500' });
        expect(resolveLiveNode('n2')).toEqual({ apiKey: 'k2', url: 'http://n2:4500' });
    });

    it('returns undefined apiKey/url for an unknown node id', () => {
        expect(resolveLiveNode('missing')).toEqual({ apiKey: undefined, url: undefined });
    });
});

describe('proxyToNode', () => {
    beforeEach(() => { KNOWN_NODES.clear(); KNOWN_NAS_NODES.clear(); vi.clearAllMocks(); });

    it('responds 404 without calling the node when it is not currently reachable', async () => {
        const handler = proxyToNode('get', '/stats');
        const { req, res } = mockReqRes({ id: 'ghost' });
        await handler(req, res);
        expect(res.statusCode).toBe(404);
        expect(axios).not.toHaveBeenCalled();
    });

    it('forwards a GET to the resolved node URL with the Bearer header and returns its response body', async () => {
        KNOWN_NODES.set('n1', { apiKey: 'secret-key', activeUrl: 'http://n1:4500' });
        axios.mockResolvedValue({ data: { online: true } });

        const handler = proxyToNode('get', '/stats');
        const { req, res } = mockReqRes({ id: 'n1' });
        await handler(req, res);

        expect(axios).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: 'http://n1:4500/stats',
            headers: { 'Authorization': 'Bearer secret-key' },
            timeout: 3000
        }));
        expect(res.body).toEqual({ online: true });
    });

    it('passes the request body through for a POST when getData is provided', async () => {
        KNOWN_NODES.set('n1', { apiKey: 'k', activeUrl: 'http://n1:4500' });
        axios.mockResolvedValue({ data: { success: true } });

        const handler = proxyToNode('post', '/api/config', req => req.body);
        const { req, res } = mockReqRes({ id: 'n1' }, { maxConcurrentNasJobs: 2 });
        await handler(req, res);

        expect(axios).toHaveBeenCalledWith(expect.objectContaining({ data: { maxConcurrentNasJobs: 2 } }));
    });

    it('responds 502 when the node is known but unreachable', async () => {
        KNOWN_NODES.set('n1', { apiKey: 'k', activeUrl: 'http://n1:4500' });
        axios.mockRejectedValue(new Error('connect ECONNREFUSED'));

        const handler = proxyToNode('get', '/stats');
        const { req, res } = mockReqRes({ id: 'n1' });
        await handler(req, res);

        expect(res.statusCode).toBe(502);
        expect(res.body).toEqual({ error: 'Could not reach node' });
    });
});
