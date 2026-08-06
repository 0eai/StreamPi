import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Deliberately NOT the `dotenv` package. What this needs to parse is a couple of dozen flat
// KEY=VALUE lines, and the Pi this runs on can't reliably take a fresh `npm install` (its
// node_modules is ARM and is usually only reachable over an sshfs mount from an x86 box), so
// a new runtime dependency is a real cost here for no real benefit.
//
// Also self-contained on purpose — it derives server/ itself rather than importing SERVER_ROOT
// from paths.js, so gen_session.js can load the same .env without dragging in paths.js and its
// mkdir-on-import side effect.
const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

// Supported: blank lines, whole-line `#` comments, optional matched quotes around a value,
// and `=` inside values (only the first one splits). NOT supported: inline trailing comments,
// multi-line values, or `${VAR}` interpolation — a `#` mid-value is kept verbatim, since
// silently truncating a secret at a `#` is far worse than not offering the feature.
export const parseEnvFile = (raw) => {
    const out = {};
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;

        const key = trimmed.slice(0, eq).trim();
        if (!key) continue;

        let value = trimmed.slice(eq + 1).trim();
        // Quotes are optional and stripped only when matched. The Telegram session string is
        // base64 (`+`, `/`, `=`) and needs no quoting, but quoting it is the natural instinct
        // and keeping the quotes would corrupt the auth key into a confusing auth failure.
        const quoted = value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
        if (quoted) value = value.slice(1, -1);

        out[key] = value;
    }
    return out;
};

let fileEnv = {};
try {
    if (existsSync(ENV_PATH)) {
        fileEnv = parseEnvFile(readFileSync(ENV_PATH, 'utf-8'));
        console.log('📄 Loaded .env');
    } else {
        console.log('⚠️  No server/.env found — copy .env.example to .env and fill it in.');
    }
} catch (error) {
    console.error('❌ Error reading .env:', error.message);
}

/**
 * Reads a setting, preferring a real environment variable over the .env file so that a
 * systemd/pm2 unit or a one-off `TG_SESSION=... npm start` can override the file without
 * editing it. An empty value counts as absent at both layers, so a key left blank in
 * .env.example falls through to `fallback` rather than overriding it with "".
 */
export const env = (key, fallback = '') => {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess;

    const fromFile = fileEnv[key];
    if (fromFile !== undefined && fromFile !== '') return fromFile;

    return fallback;
};
