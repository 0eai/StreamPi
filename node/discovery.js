import os from 'os';
import { ref, set } from 'firebase/database';
import { ID, ROLES, PORT, IS_TRANSCODER, ADVERTISED_URL } from './config.js';
import { HW_CONFIG } from './state.js';
import { fbDb, API_KEY_HASH } from './firebase.js';

// ==========================================
// DISCOVERY — write straight to Firebase RTDB with the client SDK.
// Security comes from database.rules.json cross-checking apiKeyHash against
// node_keys/<id>/hash (set by the main server when the node was created) —
// no service-account.json needed here at all.
// ==========================================
export const getLocalIp = () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        if (name.startsWith('tun') || name.startsWith('tap') || name.startsWith('ppp') || name.startsWith('wg')) continue;
        // Link-local (169.254.0.0/16) means the interface never got a DHCP lease — an unplugged
        // Thunderbolt Bridge or a dormant iPhone-USB interface on a Mac, both of which sort ahead of
        // the real Wi-Fi interface here. It is not internal, so the check above admits it, and the
        // node then publishes an address nothing can route with no error anywhere to say so.
        // Found in practice on the Mac node, which advertised one of these instead of its LAN address.
        const usable = interfaces[name].find((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
        if (usable) return usable.address;
    }
    return '127.0.0.1';
};

let lastReportedIp = null;
export const registerWithFirebase = async () => {
    const ip = getLocalIp();
    if (ip === lastReportedIp) return;
    try {
        const record = {
            id: ID, roles: ROLES, url: ADVERTISED_URL || `http://${ip}:${PORT}`,
            ip, port: PORT,
            hardware: IS_TRANSCODER ? HW_CONFIG.description : null,
            lastUpdated: Date.now(), apiKeyHash: API_KEY_HASH
        };
        /**
         * `directIp`/`directPort` are what the server tries *first*, and only falls back to `url`
         * once that attempt has failed. On a tunnelled node the direct address is unreachable by
         * definition, so advertising it costs a guaranteed 2s timeout before each 4s attempt that
         * can actually succeed — on a 2s health-check interval, that leaves three overlapping
         * checks per node in flight permanently, and makes an offline node take 6s to notice.
         *
         * The keys are left out rather than set to null because the Firebase client SDK rejects an
         * undefined value outright, and the server's guard is a plain truthiness check either way.
         */
        if (!ADVERTISED_URL) { record.directIp = ip; record.directPort = PORT; }
        await set(ref(fbDb, `nodes/${ID}`), record);
        lastReportedIp = ip;
        console.log(ADVERTISED_URL
            ? `📡 Registered with Firebase. Reachable via tunnel at ${ADVERTISED_URL} (local IP ${ip} not advertised)`
            : `📡 Registered with Firebase. IP: ${ip}`);
    } catch (e) { console.error("Firebase registration failed:", e.message); }
};
