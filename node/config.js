import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================
// CONFIG — admin-issued identity, required
// ==========================================
const CONFIG_PATH = path.join(__dirname, 'node_config.json');
if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`❌ Missing ${CONFIG_PATH}. Copy node_config.json.example, fill in the id/apiKey the dashboard gave you, and try again.`);
    process.exit(1);
}
export const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
if (!CFG.id || !CFG.apiKey || !Array.isArray(CFG.roles) || !CFG.roles.length) {
    console.error(`❌ node_config.json is missing id / apiKey / roles. Create this node from the dashboard first.`);
    process.exit(1);
}

const DEFAULT_DATABASE_URL = 'https://aks-streampi-default-rtdb.asia-southeast1.firebasedatabase.app';

export const ID = CFG.id;
export const API_KEY = CFG.apiKey;
export const ROLES = CFG.roles;
export const IS_TRANSCODER = ROLES.includes('transcoder');
export const IS_NAS = ROLES.includes('nas');
export const PORT = CFG.port || 4500;
export const DATABASE_URL = CFG.databaseURL || DEFAULT_DATABASE_URL;
export const CONFIG_FILE_PATH = CONFIG_PATH;

/**
 * Scratch space for download → transcode → upload jobs, which hold the input and the output at the
 * same time — roughly twice the source size, per job.
 *
 * Overridable because the default sits inside the checkout, and a checkout is often on the smallest
 * filesystem a machine has. A symlink would be the obvious alternative and is a trap: mkdirSync does
 * not follow a final symlink, so a dangling one throws here at import and the node never starts.
 */
export const WORK_DIR = CFG.workDir || path.join(__dirname, 'transcoder_work');

/**
 * Absolute paths to the ffmpeg/ffprobe binaries, for machines where they are not on the PATH this
 * process was launched with.
 *
 * fluent-ffmpeg already reads the FFMPEG_PATH/FFPROBE_PATH environment variables, so this exists for
 * a different reason: a node is deployed by unzipping a package onto someone else's machine, and
 * "set an environment variable in whatever launches it" is a much worse contract than "put it in the
 * config file you already had to edit". The launcher is the part that varies — launchd, systemd, pm2,
 * a terminal — and it is exactly where a PATH goes missing.
 *
 * That is not hypothetical. The Mac node could encode with h264_videotoolbox from a shell and failed
 * every probe as a service, because Homebrew installs to /opt/homebrew/bin, which is on a login
 * shell's PATH and not on the PATH of a launched process.
 *
 * Verified executable at boot rather than trusted, whichever source it came from, because an unusable
 * path fails misleadingly: every encoder probe fails, and the node used to report that as "CPU
 * Software Encoding" and carry on accepting jobs.
 *
 * A bad path complains and is then *ignored*, rather than stopping the node the way a bad publicUrl
 * does. The difference is that this one has a meaningful partial outcome: most nodes hold the `nas`
 * role too, serving and storing files without touching ffmpeg at all, and taking that down over a
 * mistyped transcoder path would turn a degraded node into an offline one — including making every
 * already-archived file on it unplayable. The remaining failure is not silent either: the boot log
 * says so here, and detectHardware then reports "ffmpeg unavailable" in the hardware column.
 */
const resolveBinary = (cfgKey, envKey) => {
    const fromCfg = CFG[cfgKey];
    const value = fromCfg || process.env[envKey];
    if (!value) return null;
    try {
        fs.accessSync(value, fs.constants.X_OK);
        return value;
    } catch (e) {
        const source = fromCfg ? `node_config.json ${cfgKey}` : `${envKey} in the environment`;
        console.error(`❌ ${source} is ${JSON.stringify(value)}, which is not an executable file — ignoring it and searching PATH instead.`);
        return null;
    }
};
export const FFMPEG_PATH = resolveBinary('ffmpegPath', 'FFMPEG_PATH');
export const FFPROBE_PATH = resolveBinary('ffprobePath', 'FFPROBE_PATH');

/**
 * The URL the main server should use to reach this node, when that is not simply this machine's own
 * address and port.
 *
 * Needed wherever the node can dial out but nothing can dial in — a NAT with no port forward, or a
 * network that filters inbound, which is the case on the campus link this was written for: the node
 * answers perfectly on its own public IP from the machine itself, and every packet from outside is
 * dropped in transit. The fix is a tunnel the node's side establishes, and this is how the node tells
 * the server where the far end of it is.
 *
 * Validated here rather than trusted, because the failure is otherwise invisible in both directions:
 * the server drops a non-http(s) url on the floor with one warning (nodeDiscovery's isValidNodeUrl)
 * and then has nothing left to try, while the node goes on reporting a successful registration. A
 * typo would look exactly like a broken tunnel.
 */
export const ADVERTISED_URL = (() => {
    if (!CFG.publicUrl) return null;
    try {
        const parsed = new URL(CFG.publicUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)');
        return CFG.publicUrl.replace(/\/+$/, '');
    } catch (e) {
        console.error(`❌ node_config.json publicUrl is not a valid http(s) URL: ${JSON.stringify(CFG.publicUrl)}`);
        process.exit(1);
    }
})();

// Any failure past a successful transcode — a one-off network blip on the final delivery
// upload, or the caller simply never retrying — previously left a fully-transcoded
// output_<id>.mp4 (or a half-downloaded input_<id>.temp) in WORK_DIR forever, with no
// periodic sweep unlike job_history.json (capped at 100 entries above).
// Deliberately generous — the job handler itself skips redundant download/transcode work by
// checking whether input_<id>.mp4 / output_<id>.mp4 already exist, so a retried job shortly
// after a failure benefits from these files sticking around. This only reaps files old
// enough that they're clearly abandoned rather than "waiting for the caller to retry."
const WORK_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const sweepWorkDir = () => {
    try {
        for (const name of fs.readdirSync(WORK_DIR)) {
            const filePath = path.join(WORK_DIR, name);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile() && Date.now() - stat.mtimeMs > WORK_DIR_MAX_AGE_MS) fs.unlinkSync(filePath);
            } catch (e) {}
        }
    } catch (e) {}
};

// Job history — a plain capped JSON file, not a database, matching this app's no-DB philosophy.
const HISTORY_PATH = path.join(__dirname, 'job_history.json');
const MAX_HISTORY = 100;

// A crash mid-write here previously left invalid JSON that the loaders below silently reset
// to empty — writing to a temp file first and renaming over the target (atomic on the same
// filesystem, and both paths are in __dirname) means a crash can only lose the write in
// flight, never corrupt what was already on disk.
export const writeJsonAtomic = (filePath, data) => {
    const tempPath = `${filePath}.tmp`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        // Was silent — a persistence failure here (disk full, permissions) had zero
        // diagnostic trace anywhere, which would make debugging a symptom like "why does
        // this migration replay every boot" much harder in practice.
        console.error(`❌ Failed to persist ${filePath}:`, e.message);
    }
};

export const loadJobHistory = () => {
    try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch (e) { return []; }
};

export const recordJobHistory = (entry) => {
    const history = loadJobHistory();
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    writeJsonAtomic(HISTORY_PATH, history);
};

// Pending cross-location storage migrations — same plain-JSON-file philosophy as job history
// above. Only the routing fact (from/to/reason) is persisted; live progress counters are
// in-memory only (see ACTIVE_MIGRATIONS in state.js) since losing those on a restart just
// means recomputing them, not losing track of which files still need to move.
const MIGRATIONS_PATH = path.join(__dirname, 'migrations.json');

export const loadPendingMigrations = () => {
    try { return JSON.parse(fs.readFileSync(MIGRATIONS_PATH, 'utf8')); } catch (e) { return []; }
};

export const savePendingMigrations = (list) => {
    writeJsonAtomic(MIGRATIONS_PATH, list);
};

// Hot-reloadable settings — changed via the node-owner UI (POST /api/config) without a
// restart, unlike id/apiKey/roles/port which are frozen for the process lifetime above.
// nasStorageLocations replaces the old single nasStorageRoot/nasStorageLimitBytes — reshaped
// here (not migrated on disk) so a pre-existing single-path node keeps using the exact same
// directory under the new shape, with zero file movement.
export const normalizeStorageLocations = (cfg) =>
    Array.isArray(cfg.nasStorageLocations) && cfg.nasStorageLocations.length
        ? cfg.nasStorageLocations
        : [{
            id: 'default',
            path: cfg.nasStorageRoot || path.join(os.homedir(), '.streampi'),
            limitBytes: cfg.nasStorageLimitBytes || (10 * 1024 * 1024 * 1024)
        }];

if (IS_TRANSCODER) fs.mkdirSync(WORK_DIR, { recursive: true });
