import { describe, it, expect } from 'vitest';
import { decodeMultipartFilename as fix } from './multipartFilename.js';

/**
 * The real case: a .mov whose name contains U+2009 U+2013 U+2009 arrived latin-1-decoded, was stored
 * that way in the media row, then forwarded to a node whose busboy mangled it a second time on the way
 * to disk. Row and file then named different things, so an in-place transcode could not find the file
 * and the row sat in remote_processing retrying every 30 seconds.
 *
 * The guards matter as much as the conversion: applied blindly this would corrupt names that are
 * already correct.
 */

const asBusboySeesIt = (real) => Buffer.from(real, 'utf8').toString('latin1');

describe('decodeMultipartFilename', () => {
    it('recovers the exact filename from the real case', () => {
        const real = 'California - Oct 1  –  10, 2023 Trip.mov';
        expect(fix(asBusboySeesIt(real))).toBe(real);
    });

    it('recovers accented titles', () => {
        for (const real of ['Amélie.mp4', 'Das Boot – Directors Cut.mkv', 'Мосфильм.mp4', '千と千尋.mkv']) {
            expect(fix(asBusboySeesIt(real)), real).toBe(real);
        }
    });

    it('leaves pure ASCII completely alone', () => {
        // The common case, and it must not pay for any of this.
        expect(fix('Plain Movie (2024).mp4')).toBe('Plain Movie (2024).mp4');
    });

    it('leaves a name that is genuinely latin-1 text alone', () => {
        // Reinterpreting 'é' as UTF-8 yields U+FFFD, which is the signal that these bytes were never
        // UTF-8 — so the original is right and must survive.
        expect(fix('Café.mp4')).toBe('Café.mp4');
    });

    it('leaves an already-correct non-Latin name alone', () => {
        // Guards against the conversion being applied twice, which would destroy it.
        expect(fix('日本語.mkv')).toBe('日本語.mkv');
    });

    it('is idempotent on its own output, which is what makes it safe at several boundaries', () => {
        // The server corrects the name and the node corrects again on receipt; the second pass must be
        // a no-op rather than a second mangling.
        const real = 'Das Boot – Cut.mkv';
        const once = fix(asBusboySeesIt(real));
        expect(fix(once)).toBe(real);
    });

    it('passes through empty and non-string input', () => {
        expect(fix('')).toBe('');
        expect(fix(undefined)).toBeUndefined();
        expect(fix(null)).toBeNull();
    });
});
