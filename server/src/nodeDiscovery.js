import axios from 'axios';
import admin from 'firebase-admin';
import { KNOWN_NODES, KNOWN_NAS_NODES } from './state.js';
import { db } from './db.js';
import { isFirebaseActive } from './firebaseBootstrap.js';

// A node's *identity* (its id + registered api_key) is checked below before it's trusted at
// all, but its *url* is whatever it last reported to Firebase — accepted here with no
// validation would let a garbage/non-http(s) value (or, before the exec() calls elsewhere
// were hardened to use argv arrays, a shell-metacharacter-laced one) flow straight into
// outbound requests carrying the real API key. This doesn't stop a URL pointed at a genuine
// attacker-controlled http(s) host — closing that fully would mean not trusting Firebase's
// transport fields at all, a bigger change than this guard — but it does reject the
// malformed/non-http(s) cases outright.
const isValidNodeUrl = (url) => {
    if (typeof url !== 'string' || !url) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
        return false;
    }
};

export const checkNasHealth = async () => {
    if (KNOWN_NAS_NODES.size === 0) return;

    const checks = Array.from(KNOWN_NAS_NODES.values()).map(async (node) => {
        try {
            const res = await axios.get(`${node.url}/stats`, {
                timeout: 2000,
                headers: { 'Authorization': `Bearer ${node.apiKey}` }
            });

            node.stats = res.data;
            node.isReachable = true;
            node.lastSeen = Date.now();
        } catch (e) {
            node.isReachable = false;
            node.stats = null;
        }
    });

    await Promise.all(checks);
};

// Headroom kept free on a NAS node beyond the file itself. Named rather than inlined because an
// explicitly chosen node has to clear exactly the same bar as an automatically chosen one — a hand
// picked destination that quietly accepts a file the automatic path would have refused is worse than
// no choice at all.
const NAS_HEADROOM_BYTES = 1024 * 1024 * 1024;

export const getBestNasNode = (requiredBytes) => {
    const nodes = Array.from(KNOWN_NAS_NODES.values());

    const candidates = nodes.filter(n => {
        const free = n.stats?.disk?.free || 0;
        return free > requiredBytes + NAS_HEADROOM_BYTES;
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.stats.disk.free - a.stats.disk.free);

    return candidates[0];
};

/**
 * The same admission check as getBestNasNode, for one node the caller named.
 *
 * Returns `{ node }` or `{ error }` rather than just null, because the three ways a chosen node can
 * be refused need different things said about them: an id that isn't a NAS node at all is a stale
 * client, one that is unreachable may well work in a minute, and one that is full never will. A bare
 * null would collapse all three into "couldn't do it", and the destination was the user's decision —
 * they are owed the reason it didn't hold.
 */
export const getNasNodeById = (id, requiredBytes) => {
    const node = KNOWN_NAS_NODES.get(id);
    if (!node) return { error: 'unknown' };
    if (!node.isReachable) return { error: 'unreachable' };
    const free = node.stats?.disk?.free || 0;
    if (free <= requiredBytes + NAS_HEADROOM_BYTES) return { error: 'full', free, headroom: NAS_HEADROOM_BYTES };
    return { node };
};

// A node that's both a reachable NAS (with room) AND a reachable, idle transcoder can
// receive a Telegram download straight into its own storage and transcode it in place —
// no local disk on the main server, no extra network hop for the transcode step.
export const getNodeForDirectDownload = (requiredBytes) => {
    const candidates = [];
    for (const [id, nasNode] of KNOWN_NAS_NODES.entries()) {
        const transcoderNode = KNOWN_NODES.get(id);
        if (!transcoderNode || !transcoderNode.isReachable || transcoderNode.activeJob !== null) continue;
        const free = nasNode.stats?.disk?.free || 0;
        if (free <= requiredBytes + NAS_HEADROOM_BYTES) continue;
        candidates.push({ id, nasNode, transcoderNode, free });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.free - a.free);
    return candidates[0];
};

export const checkSingleNode = async (node) => {
    node.statusDirect = false;
    node.statusTunnel = false;

    const updateStats = (data) => {
        node.hardware = data.hardware;
        node.stats = {
            cpu: data.cpu,
            ram: data.ram,
            network: data.network,
            uptime: data.uptime
        };
        if (data.busy) {
            // If worker is busy but server doesn't know why, mark as External
            if (!node.activeJob) node.activeJob = "External Job";
        } else {
            // FIX: If worker reports NOT busy, clear the job immediately
            // regardless of what the server thought it was doing.
            node.activeJob = null;
        }
    };

    if (node.directIp && node.directPort) {
        try {
            const res = await axios.get(`http://${node.directIp}:${node.directPort}/stats`, {
                timeout: 2000,
                headers: { 'Authorization': `Bearer ${node.apiKey}` }
            });

            updateStats(res.data);
            node.activeUrl = `http://${node.directIp}:${node.directPort}`;
            node.statusDirect = true;
            node.isReachable = true;
            node.failedStrikes = 0;
            return;
        } catch (e) {/*console.log(`${node.directIp}: ${e.message}`);*/}
    }

    if (node.url) {
        try {
            const res = await axios.get(`${node.url}/stats`, {
                timeout: 4000,
                headers: { 'Authorization': `Bearer ${node.apiKey}` }
            });

            updateStats(res.data);
            node.activeUrl = node.url;
            node.statusTunnel = true;
            node.isReachable = true;
            node.failedStrikes = 0;
            return;
        } catch (e) {/*console.log(e.message);*/}
    }

    node.isReachable = false;
    node.failedStrikes++;
};

// 👇 Single discovery listener for merged nodes (roles: transcoder / nas / both).
// Nodes write once to Firebase `nodes/<id>`; this fans that out into whichever
// of KNOWN_NODES / KNOWN_NAS_NODES apply, so the existing job-allocation and
// NAS-archival logic (which read those two maps separately) needs no changes.
export const initNodeDiscoveryListener = () => {
    if (!isFirebaseActive) return;
    const fbDb = admin.database();
    const ref = fbDb.ref('nodes');

    ref.on('value', async (snapshot) => {
        const data = snapshot.val() || {};
        const presentIds = new Set(Object.keys(data));

        for (const node of Object.values(data)) {
            const roles = Array.isArray(node.roles) ? node.roles : String(node.roles || '').split(',').filter(Boolean);
            const isTranscoder = roles.includes('transcoder');
            const isNas = roles.includes('nas');

            // A node that *drops* a role has to leave that role's map here. The sweep at the bottom
            // only removes nodes missing from the snapshot entirely, so one that merely narrowed its
            // roles stayed listed as a transcoder forever — and kept being handed jobs, because it
            // still answers /stats (a core route) and so still looks reachable and idle, while the
            // /job and /status routes it needs are mounted only `if (IS_TRANSCODER)` on its side.
            // The result was a job assigned to a node that answers 404, until the server restarted.
            if (!isTranscoder) KNOWN_NODES.delete(node.id);
            if (!isNas) KNOWN_NAS_NODES.delete(node.id);
            if (!isTranscoder && !isNas) continue;

            let apiKey = KNOWN_NODES.get(node.id)?.apiKey || KNOWN_NAS_NODES.get(node.id)?.apiKey;
            if (!apiKey) {
                if (!db) continue;
                const row = await db.get("SELECT api_key FROM nodes WHERE id = ? AND revoked = 0", node.id);
                if (!row) continue; // Not an admin-registered (or revoked) node — don't trust it.
                apiKey = row.api_key;
            }

            const safeUrl = isValidNodeUrl(node.url) ? node.url : null;
            if (node.url && !safeUrl) console.warn(`⚠️ Ignoring invalid url reported by node ${node.id}: ${node.url}`);

            if (isTranscoder) {
                if (!KNOWN_NODES.has(node.id)) {
                    KNOWN_NODES.set(node.id, {
                        id: node.id, url: safeUrl, directIp: node.directIp, directPort: node.directPort,
                        lastUpdated: node.lastUpdated, hardware: node.hardware, apiKey,
                        isReachable: false, activeUrl: null, failedStrikes: 0, activeJob: null,
                        statusDirect: false, statusTunnel: false
                    });
                    console.log(`🆕 Found New Worker: ${node.id}`);
                    checkSingleNode(KNOWN_NODES.get(node.id));
                } else {
                    const existing = KNOWN_NODES.get(node.id);
                    existing.url = safeUrl; existing.directIp = node.directIp; existing.directPort = node.directPort;
                    existing.lastUpdated = node.lastUpdated; existing.hardware = node.hardware; existing.apiKey = apiKey;
                }
            }

            if (isNas) {
                if (!KNOWN_NAS_NODES.has(node.id)) {
                    console.log(`🆕 Found NAS Node: ${node.id} at ${node.ip}`);
                    KNOWN_NAS_NODES.set(node.id, { ...node, url: safeUrl, apiKey, stats: null, isReachable: false });
                } else {
                    const existing = KNOWN_NAS_NODES.get(node.id);
                    existing.url = safeUrl; existing.ip = node.ip; existing.port = node.port; existing.apiKey = apiKey;
                }
            }
        }

        // A node that disappears from this snapshot (deregistered, revoked, re-flashed with a
        // new id) previously stayed in these maps forever, still getting probed by the 2s
        // health-check interval indefinitely.
        for (const id of KNOWN_NODES.keys()) if (!presentIds.has(id)) KNOWN_NODES.delete(id);
        for (const id of KNOWN_NAS_NODES.keys()) if (!presentIds.has(id)) KNOWN_NAS_NODES.delete(id);
    }, (error) => {
        // Without this second callback, an error on this listener (permission change, auth
        // expiry) failed completely silently — node discovery would just stop updating with
        // zero log output anywhere explaining why nodes stopped showing as reachable.
        console.error("❌ Node discovery listener error:", error.message);
    });
};

export const startNodeHealthCheck = () => {
    setInterval(async () => {
        if (KNOWN_NODES.size === 0) return;
        const checks = Array.from(KNOWN_NODES.values()).map(node => checkSingleNode(node));
        await Promise.all(checks);
    }, 2000);
};
