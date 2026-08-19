import { describe, it, expect, beforeEach } from 'vitest';
import { FILE_TOKENS } from './state.js';
import { parseRange, contentTypeFor, canRenderInline, mintFileToken } from './fileServer.js';

describe('parseRange', () => {
    const SIZE = 1000;

    it('returns null with no usable header, so the caller sends the whole file', () => {
        for (const h of [undefined, null, '', 'bytes=', 'items=0-1', 'bytes=0-1,5-6', 'garbage', 42]) {
            expect(parseRange(h, SIZE), String(h)).toBeNull();
        }
    });

    it('parses an explicit range', () => {
        expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
        expect(parseRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999 });
    });

    it('treats an open end as "to the end of the file"', () => {
        expect(parseRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
    });

    it('reads a suffix range as the LAST n bytes, not the first n', () => {
        // "bytes=-500" is the tail. Reading it as 0-500 would silently serve the wrong half of a
        // resumed download, which is the kind of corruption nobody notices until the file is opened.
        expect(parseRange('bytes=-500', SIZE)).toEqual({ start: 500, end: 999 });
        expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
    });

    it('clamps an end past the file rather than reading off the end', () => {
        expect(parseRange('bytes=900-99999', SIZE)).toEqual({ start: 900, end: 999 });
    });

    it('reports a range outside the file as unsatisfiable, not as a full response', () => {
        // Silently sending everything for an out-of-range request makes a resume produce a corrupt
        // file; 416 is the answer that lets a client notice.
        expect(parseRange('bytes=1000-1200', SIZE)).toEqual({ unsatisfiable: true });
        expect(parseRange('bytes=600-500', SIZE)).toEqual({ unsatisfiable: true });
        expect(parseRange('bytes=-0', SIZE)).toEqual({ unsatisfiable: true });
    });

    it('tolerates surrounding whitespace', () => {
        expect(parseRange('  bytes=0-9  ', SIZE)).toEqual({ start: 0, end: 9 });
    });
});

describe('contentTypeFor', () => {
    it('is octet-stream for anything not being rendered', () => {
        expect(contentTypeFor('photo.png', false)).toBe('application/octet-stream');
        expect(contentTypeFor('archive.zip', false)).toBe('application/octet-stream');
    });

    it('maps only the allowlisted extensions when rendering', () => {
        expect(contentTypeFor('photo.PNG', true)).toBe('image/png');
        expect(contentTypeFor('doc.pdf', true)).toBe('application/pdf');
        expect(contentTypeFor('notes.txt', true)).toBe('text/plain; charset=utf-8');
    });

    it('never derives a renderable type for the dangerous ones', () => {
        // The point of the allowlist. An uploader who declares text/html gets octet-stream, because
        // the type comes from the stored extension and this list, never from what they sent.
        for (const n of ['evil.html', 'evil.svg', 'evil.js', 'evil.xhtml', 'noext']) {
            expect(contentTypeFor(n, true), n).toBe('application/octet-stream');
            expect(canRenderInline(n), n).toBe(false);
        }
    });
});

describe('mintFileToken', () => {
    beforeEach(() => FILE_TOKENS.clear());

    it('registers a grant carrying a resolved path, so the files origin needs no database', () => {
        const token = mintFileToken({ absPath: '/data/ab/abcdef', name: 'report.pdf', size: 12 });
        const grant = FILE_TOKENS.get(token);
        expect(grant.absPath).toBe('/data/ab/abcdef');
        expect(grant.name).toBe('report.pdf');
        expect(grant.expiresAt).toBeGreaterThan(Date.now());
    });

    it('refuses to honour inline for a type that must never render', () => {
        // A caller asking for inline on an .html must not get it — the decision belongs to the
        // allowlist, not to whoever mints the token.
        const html = mintFileToken({ absPath: '/x', name: 'page.html', size: 1, inline: true });
        expect(FILE_TOKENS.get(html).inline).toBe(false);

        const png = mintFileToken({ absPath: '/x', name: 'ok.png', size: 1, inline: true });
        expect(FILE_TOKENS.get(png).inline).toBe(true);
    });

    it('gives every grant a distinct token', () => {
        const tokens = new Set(
            Array.from({ length: 50 }, () => mintFileToken({ absPath: '/x', name: 'a', size: 1 }))
        );
        expect(tokens.size).toBe(50);
    });
});
