import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { SERVER_ROOT } from './paths.js';

export let externalConfig = {};
const configPath = path.join(SERVER_ROOT, 'config.json');

try {
    if (existsSync(configPath)) {
        const rawData = readFileSync(configPath, 'utf-8');
        externalConfig = JSON.parse(rawData);
        console.log("📄 Loaded config.json successfully");
    } else {
        console.log("⚠️ config.json not found, using hardcoded defaults");
    }
} catch (error) {
    console.error("❌ Error reading config.json:", error.message);
}

const tgConfig = externalConfig.telegram || {};

export const DEFAULT_CONFIG = {
    TG_API_ID: tgConfig.api_id ? Number(tgConfig.api_id) : 10000000,
    TG_API_HASH: tgConfig.api_hash || "",
    TG_SESSION: tgConfig.session || "",
    TARGET_CHANNEL_ID: tgConfig.channel_id || ""
};

// Mutable — initSecretsManager() (firebaseBootstrap.js) replaces this once Firebase-stored
// secrets are loaded, hence the exported setter rather than a plain const.
export let CONFIG = { ...DEFAULT_CONFIG };
export function setConfig(next) { CONFIG = next; }

export const FIREBASE_DB_URL = externalConfig.firebase_db_url || "";

// Previously hardcoded in paths.js with no technical reason for the split from every other
// piece of runtime config, which already lives in config.json — same override pattern as
// FIREBASE_DB_URL/telegram above, defaulting to the original hardcoded values when absent.
export const PORT = externalConfig.port ? Number(externalConfig.port) : 3005;
export const HTTPS_PORT = externalConfig.https_port ? Number(externalConfig.https_port) : 3006;
export const MANUAL_PUBLIC_URL = externalConfig.public_url || "";
