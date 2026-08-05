import axios from 'axios';
import { KNOWN_NODES, KNOWN_NAS_NODES } from './state.js';

// Every "reach into a node and forward its response" route (admin's /live, and all six
// node-owner proxy routes in nodeOwner.js) resolved the node's apiKey/url and built an axios
// call with the exact same shape — timeout, Bearer header, 502-on-failure — independently.
// Collapsing that here makes timeout/error handling consistent by construction instead of by
// copy-paste, and is the single place to change if that shape ever needs to change.
export const resolveLiveNode = (id) => {
    const t = KNOWN_NODES.get(id);
    const n = KNOWN_NAS_NODES.get(id);
    return { apiKey: t?.apiKey || n?.apiKey, url: t?.activeUrl || n?.url };
};

// `path` may be a plain string or a (req) => string, for the rare route that needs something
// from the request to build the node-side path. `getData(req)` supplies a POST body.
export const proxyToNode = (method, path, getData) => async (req, res) => {
    const { apiKey, url } = resolveLiveNode(req.params.id);
    if (!apiKey || !url) return res.status(404).json({ error: "Node not reachable" });
    try {
        const response = await axios({
            method,
            url: `${url}${typeof path === 'function' ? path(req) : path}`,
            data: getData ? getData(req) : undefined,
            timeout: 3000,
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        res.json(response.data);
    } catch (e) {
        res.status(502).json({ error: "Could not reach node" });
    }
};
