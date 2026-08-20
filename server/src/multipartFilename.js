/**
 * Recovers a UTF-8 filename that arrived mojibaked from a multipart upload.
 *
 * busboy (under multer) decodes the multipart `filename` parameter as latin-1, so any non-ASCII
 * character reaches the application as its UTF-8 bytes reinterpreted one byte per character. A file
 * called
 *
 *     California - Oct 1 – 10, 2023 Trip.mov        (U+2009 U+2013 U+2009)
 *
 * becomes `California - Oct 1â<80><89>â<80><93>â<80><89>10, 2023 Trip.mov`.
 *
 * Left alone this corrupts every accented, dashed or non-Latin title in the library. Worse, it
 * corrupts them *inconsistently*: the media row was written from the name as received, while a
 * direct-to-node upload forwarded that same mangled string on to the node, whose own busboy mangled it
 * a second time on the way to disk. The row and the file on disk then differ, so the node cannot find
 * its own file — a real case here left a row stuck in remote_processing retrying every 30 seconds,
 * because the in-place transcode was looking for a name that did not exist.
 *
 * The reinterpretation is guarded rather than applied blindly, because it is not idempotent: run
 * against a filename that is already correct UTF-8 it would produce nonsense. Two checks make it safe.
 * A name with no bytes in the latin-1 high range cannot be mojibake, so it is returned untouched. And a
 * reinterpretation that yields U+FFFD was not valid UTF-8 to begin with — meaning the name really was
 * latin-1 — so the original is kept.
 */
export const decodeMultipartFilename = (name) => {
    if (typeof name !== 'string' || name === '') return name;

    // No high-range characters: pure ASCII, nothing to recover.
    if (!/[\u0080-\u00ff]/.test(name)) return name;

    const reinterpreted = Buffer.from(name, 'latin1').toString('utf8');

    // U+FFFD means those bytes were not UTF-8, so the name was genuinely latin-1 text.
    if (reinterpreted.includes('\ufffd')) return name;

    return reinterpreted;
};
