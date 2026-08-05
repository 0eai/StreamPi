import fs from 'fs/promises';
import { existsSync } from 'fs';
import admin from 'firebase-admin';
import { SERVICE_ACCOUNT_PATH } from './paths.js';
import { FIREBASE_DB_URL, DEFAULT_CONFIG, setConfig, PORT, MANUAL_PUBLIC_URL } from './config.js';
import { getLocalIp } from './systemStats.js';
import { log } from './logger.js';

// Reassigned only inside initializeFirebaseAdmin() below.
export let isFirebaseActive = false;
// Reassigned only inside updateServerLocation() below.
export let lastKnownConfig = null;

const initSecretsManager = async () => {
    if (!isFirebaseActive) return;
    const dbRef = admin.database().ref('server_secrets');

    const snapshot = await dbRef.once('value');
    if (!snapshot.exists()) {
        console.log("🔒 Secrets not found in DB. Uploading defaults...");
        await dbRef.set(DEFAULT_CONFIG);
        setConfig({ ...DEFAULT_CONFIG });
    } else {
        console.log("🔓 Secrets loaded from Firebase.");
        const data = snapshot.val();
        setConfig({ ...DEFAULT_CONFIG, ...data });
    }
};

export const initializeFirebaseAdmin = async () => {
    if (existsSync(SERVICE_ACCOUNT_PATH)) {
        try {
            const serviceAccount = JSON.parse(await fs.readFile(SERVICE_ACCOUNT_PATH, 'utf8'));
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: FIREBASE_DB_URL });
            isFirebaseActive = true;
            console.log("🔒 Security: Firebase Admin initialized.");

            await initSecretsManager();
        } catch (e) { console.error("Firebase Init Failed:", e); }
    }
};

export const updateServerLocation = async (protocol = 'http', port = PORT) => {
    if (!isFirebaseActive) return;
    const url = MANUAL_PUBLIC_URL || `${protocol}://${getLocalIp()}:${port}`;
    const newConfig = { url: url, ip: getLocalIp(), port: port, protocol: protocol };
    const hasChanged = !lastKnownConfig || lastKnownConfig.url !== newConfig.url;
    if (!hasChanged) return;
    try {
        const fbDb = admin.database(); const ref = fbDb.ref('serverConfig');
        await ref.set({ ...newConfig, lastUpdated: Date.now() });
        lastKnownConfig = newConfig;
        await log(`📡 Server location updated: ${url}`);
    } catch (e) { await log(`Failed to update server location in Firebase: ${e.message}`, 'ERROR'); }
};
