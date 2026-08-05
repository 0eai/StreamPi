import os from 'os';
import { ref, set } from 'firebase/database';
import { ID, ROLES, PORT, IS_TRANSCODER } from './config.js';
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
        for (const iface of interfaces[name]) if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
    return '127.0.0.1';
};

let lastReportedIp = null;
export const registerWithFirebase = async () => {
    const ip = getLocalIp();
    if (ip === lastReportedIp) return;
    try {
        await set(ref(fbDb, `nodes/${ID}`), {
            id: ID, roles: ROLES, url: `http://${ip}:${PORT}`,
            ip, port: PORT, directIp: ip, directPort: PORT,
            hardware: IS_TRANSCODER ? HW_CONFIG.description : null,
            lastUpdated: Date.now(), apiKeyHash: API_KEY_HASH
        });
        lastReportedIp = ip;
        console.log(`📡 Registered with Firebase. IP: ${ip}`);
    } catch (e) { console.error("Firebase registration failed:", e.message); }
};
