import { describe, it, expect } from 'vitest';
import { ffmpegAuthHeader } from './ffmpegAuth.js';

/**
 * A one-line function with a test, because the bug it encodes was invisible: two of the six
 * hand-written copies of this string ended in \r\n, ffmpeg turned that into a bare CR inside the
 * header value, and the node answered 400 before serving a byte. ffmpeg reported only "Server returned
 * 400 Bad Request", which reads like a bad key or URL. Every NAS poster extraction failed that way.
 */
describe('ffmpegAuthHeader', () => {
    it('carries no CR or LF — the whole point', () => {
        const h = ffmpegAuthHeader('abc123');
        expect(h).not.toMatch(/[\r\n]/);
    });

    it('is the header line ffmpeg and ffprobe both accept', () => {
        expect(ffmpegAuthHeader('abc123')).toBe('Authorization: Bearer abc123');
    });

    it('stays clean for a key that is not a simple token', () => {
        // Node keys are 32-byte hex today, but nothing here should reintroduce a newline if that
        // changes.
        expect(ffmpegAuthHeader('a-b_c.d~e')).not.toMatch(/[\r\n]/);
    });
});
