import express from 'express';
import { createReadStream, existsSync } from 'fs';
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { FILE_TOKENS } from './state.js';
import { contentDispositionFor } from './contentDisposition.js';

/**
 * A second, deliberately tiny origin whose only job is handing over the bytes of one stored file.
 *
 * Why a separate port rather than another route on the main app: localStorage is keyed by origin, and
 * the app keeps a non-expiring session token in it. Anything the browser ever *renders* from a
 * user-uploaded file — an HTML page, an SVG, a script pulled in by either — would otherwise run on
 * the same origin as that token, and the app's CSP (`script-src 'self'`) explicitly permits
 * same-origin script. Serving those bytes from here means the worst case is a script with access to
 * an origin that stores nothing.
 *
 * It deliberately does NOT mount the SPA, the API, cors, or express.json. Nothing here reads the
 * database or knows what a user or a share is; a request either carries a live FILE_TOKENS grant or
 * it gets 404. Every access decision was already made on the app origin before the token existed.
 */

/** Long enough to survive a slow click-to-request, short enough that a leaked URL is worthless. */
const TOKEN_TTL_MS = 60 * 1000;

/**
 * Content-Type is derived from the stored extension, never from the uploader's declared mime —
 * multer takes that verbatim from the client's multipart headers, so echoing it back would let the
 * uploader choose the response's type. Anything not on this list is octet-stream, and only these can
 * ever be shown inline.
 */
const INLINE_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
};

export const contentTypeFor = (name, inline) => {
    if (!inline) return 'application/octet-stream';
    return INLINE_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
};

/** Whether this name may be rendered in the browser at all. Notably: never .html and never .svg. */
export const canRenderInline = (name) =>
    Object.prototype.hasOwnProperty.call(INLINE_TYPES, path.extname(String(name)).toLowerCase());

/**
 * Registers a one-file grant and returns its token. Callers on the app origin must have already
 * established that the requester may read this file — this function asks no questions.
 */
export const mintFileToken = ({ absPath, name, size, inline = false }) => {
    const token = crypto.randomUUID();
    FILE_TOKENS.set(token, {
        absPath,
        name,
        size,
        // Inline is only ever honoured for types we chose; a caller cannot opt a .html into rendering.
        inline: inline && canRenderInline(name),
        expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    return token;
};

/**
 * Parses a single-range `Range` header against a known size.
 *
 * Returns null when there is no usable range (absent header, multi-range, or unparseable) so the
 * caller sends the whole file, and `{ unsatisfiable: true }` when the range is syntactically fine
 * but outside the file, which has to be a 416 rather than a silent full response.
 */
export const parseRange = (header, size) => {
    if (!header || typeof header !== 'string') return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;

    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') return null;

    // "bytes=-500" means the last 500 bytes, not "from 0 to 500".
    let start, end;
    if (rawStart === '') {
        const tail = Number(rawEnd);
        if (tail <= 0) return { unsatisfiable: true };
        start = Math.max(0, size - tail);
        end = size - 1;
    } else {
        start = Number(rawStart);
        end = rawEnd === '' ? size - 1 : Number(rawEnd);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start > end || start >= size) return { unsatisfiable: true };

    return { start, end: Math.min(end, size - 1) };
};

export const createFileServer = () => {
    const app = express();

    app.get('/f/:token', async (req, res) => {
        const grant = FILE_TOKENS.get(req.params.token);
        // One answer for expired, unknown and already-swept, matching how a dead share link reads.
        if (!grant || grant.expiresAt < Date.now()) {
            FILE_TOKENS.delete(req.params.token);
            return res.status(404).type('text/plain').send('Not found');
        }

        if (!existsSync(grant.absPath)) return res.status(404).type('text/plain').send('Not found');

        try {
            const stat = await fs.stat(grant.absPath);
            const size = stat.size;

            res.setHeader('Content-Type', contentTypeFor(grant.name, grant.inline));
            res.setHeader('Content-Disposition', contentDispositionFor(grant.name, { inline: grant.inline }));
            res.setHeader('X-Content-Type-Options', 'nosniff');
            // This origin serves nothing but bytes, so no script from here should ever run anywhere.
            res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('Accept-Ranges', 'bytes');

            const range = parseRange(req.headers.range, size);
            if (range?.unsatisfiable) {
                res.setHeader('Content-Range', `bytes */${size}`);
                return res.status(416).end();
            }

            const { start, end } = range || { start: 0, end: size - 1 };
            if (range) {
                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
            }
            res.setHeader('Content-Length', end - start + 1);

            if (req.method === 'HEAD') return res.end();

            createReadStream(grant.absPath, { start, end })
                .on('error', (err) => {
                    console.error('File read error:', err.message);
                    try { res.destroy(); } catch (e) { /* already tearing down */ }
                })
                .pipe(res);
        } catch (e) {
            console.error('File serve failed:', e.message);
            if (!res.headersSent) res.status(500).type('text/plain').send('Failed');
            else try { res.destroy(); } catch (_) { /* already tearing down */ }
        }
    });

    // Anything else on this origin is not a mistake worth explaining.
    app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

    return app;
};
