import { existsSync, mkdirSync, createWriteStream, unlink } from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { PassThrough } from 'stream';
import multer from 'multer';
import { TEMP_DIR } from './paths.js';
import { KNOWN_NAS_NODES } from './state.js';

if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

// Streams a file straight into a NAS node's own /archive endpoint — same pattern as
// telegramService.js's streamTelegramToNode, just fed by the incoming upload's file
// stream instead of a Telegram download. Never touches this server's disk. Node.js's
// .pipe() already handles backpressure between the source and the passthrough, so this
// doesn't need Telegram's manual write/drain loop (that's only needed there because
// iterDownload's chunks aren't themselves a pipeable stream).
const streamToNode = (nasNode, nodeId, file, cb) => {
    const passthrough = new PassThrough();
    const form = new FormData();
    form.append('file', passthrough, { filename: file.originalname });

    let size = 0;
    file.stream.on('data', (chunk) => { size += chunk.length; });
    file.stream.pipe(passthrough);

    axios.post(`${nasNode.url}/archive`, form, {
        headers: { ...form.getHeaders(), 'Authorization': `Bearer ${nasNode.apiKey}` },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 4 * 60 * 60 * 1000
    })
        .then(() => cb(null, { size, isDirectToNode: true, nodeId }))
        .catch((err) => { passthrough.destroy(); cb(new Error(`Failed to stream to node: ${err.message}`)); });
};

// Branches per file on req.body.destination — 'nas' streams straight to the chosen node
// (never touches local disk); anything else (including unset — the default) keeps
// today's behavior: write to TEMP_DIR, same as the plain multer({ dest: TEMP_DIR }) this
// replaces. destination/nodeId MUST arrive in the multipart body before the files field —
// busboy/multer populate req.body progressively as it parses, so a field placed after the
// file that needs it won't be there yet when _handleFile runs.
class HybridStorage {
    _handleFile(req, file, cb) {
        if (req.body?.destination === 'nas' && req.body?.nodeId) {
            const nasNode = KNOWN_NAS_NODES.get(req.body.nodeId);
            if (!nasNode || !nasNode.isReachable) {
                return cb(new Error("Selected node is no longer reachable — pick another destination and try again."));
            }
            return streamToNode(nasNode, req.body.nodeId, file, cb);
        }

        const filename = crypto.randomBytes(16).toString('hex');
        const finalPath = path.join(TEMP_DIR, filename);
        const outStream = createWriteStream(finalPath);
        let size = 0;
        file.stream.on('data', (chunk) => { size += chunk.length; });
        file.stream.pipe(outStream);
        outStream.on('error', cb);
        outStream.on('finish', () => cb(null, { path: finalPath, size }));
    }

    _removeFile(req, file, cb) {
        if (file.isDirectToNode || !file.path) return cb(null); // nothing local to remove
        unlink(file.path, () => cb(null));
    }
}

export const upload = multer({ storage: new HybridStorage() });

/**
 * The same storage engine for user-file uploads, but with limits — which the media upload above has
 * never had, leaving the 413 branch in routes/misc.js unreachable.
 *
 * These are a protocol backstop against a runaway request, not the policy: the per-user quota is
 * settings-driven and checked in the handler, because multer needs its limits at construction time
 * and cannot consult the database per request.
 *
 * `files: 1` because the file route deliberately takes one file per request — that keeps per-file
 * progress and per-file retry, which a batch destroys, and means the server never parses a
 * client-supplied directory path.
 */
export const MAX_USER_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const uploadUserFile = multer({
    storage: new HybridStorage(),
    limits: { fileSize: MAX_USER_FILE_BYTES, files: 1, fields: 20, parts: 25 },
});
