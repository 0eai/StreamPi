import path from 'path';

/**
 * Builds a Content-Disposition header value that cannot throw and that browsers decode correctly.
 *
 * The naive version — `attachment; filename="${name.replace(/"/g, '')}"` — has two problems, one
 * cosmetic and one that takes the request down:
 *
 *   1. res.setHeader rejects anything outside latin1 with ERR_INVALID_CHAR. A file named
 *      "photo😀.jpg" therefore *throws* while building the response. Both callers await
 *      downloadMediaFile without a try/catch, and on Express 4 an unhandled rejection means the
 *      response is never sent at all — so the client hangs until the server's 8-hour socket
 *      timeout rather than getting an error.
 *   2. Even inside latin1, a bare filename= is decoded inconsistently, so "café.mkv" arrives
 *      mangled.
 *
 * RFC 6266 solves both: an ASCII-only `filename` that any client can parse, plus a `filename*` in
 * RFC 5987 form carrying the real UTF-8 name. Clients that understand the second prefer it and the
 * rest fall back to the first.
 */

/** Latin1-printable, minus the characters that would break out of the quoted-string. */
const ASCII_SAFE = /[^\x20-\x7e]|["\\]/g;

/**
 * A filename every HTTP client can parse. Non-ASCII becomes '_' rather than being dropped, so a
 * name that is entirely non-ASCII still has a body — and it keeps the extension recognisable, which
 * is what decides whether the download opens in anything.
 */
export const asciiFallbackName = (name) => {
    const flattened = String(name).replace(ASCII_SAFE, '_').trim();
    // Never return something a client would read as "no filename", and never a path.
    return path.basename(flattened) || 'download';
};

/**
 * `attachment` unless told otherwise. Inline is opt-in per call and should stay that way: serving
 * user-supplied bytes inline on an origin that holds a session token is how an uploaded file
 * becomes script execution.
 */
export const contentDispositionFor = (name, { inline = false } = {}) => {
    const disposition = inline ? 'inline' : 'attachment';
    const fallback = asciiFallbackName(name);
    // encodeURIComponent leaves !'()* alone; RFC 5987 wants those percent-encoded too.
    const encoded = encodeURIComponent(String(name)).replace(/['()!*]/g, (c) =>
        '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );

    // Only add filename* when it says something the fallback didn't, to keep the common case short.
    return encoded === fallback
        ? `${disposition}; filename="${fallback}"`
        : `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
