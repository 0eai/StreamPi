import { describe, it, expect, vi } from 'vitest';
import { isTransientNetworkError, withTransientRetry } from './retry.js';

describe('isTransientNetworkError', () => {
    it('treats common network error codes as transient', () => {
        for (const code of ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN']) {
            expect(isTransientNetworkError({ code })).toBe(true);
        }
    });

    it('treats a 5xx HTTP response as transient', () => {
        expect(isTransientNetworkError({ response: { status: 503 } })).toBe(true);
        expect(isTransientNetworkError({ response: { status: 500 } })).toBe(true);
    });

    it('does not treat a 4xx HTTP response as transient', () => {
        expect(isTransientNetworkError({ response: { status: 404 } })).toBe(false);
    });

    it('treats transient curl exit codes as transient', () => {
        for (const code of [6, 7, 28, 52, 56]) {
            expect(isTransientNetworkError({ message: `cURL upload failed with code ${code}` })).toBe(true);
        }
    });

    it('does not treat a non-transient curl exit code as transient', () => {
        // e.g. 1 = unsupported protocol, 3 = malformed URL — config problems, not network blips
        expect(isTransientNetworkError({ message: 'cURL upload failed with code 1' })).toBe(false);
    });

    it('does not treat a missing-binary (ENOENT) error as transient', () => {
        expect(isTransientNetworkError({ code: 'ENOENT', message: 'spawn curl ENOENT' })).toBe(false);
    });

    it('does not treat a generic/corrupt-input error as transient', () => {
        expect(isTransientNetworkError(new Error('ffmpeg produced an empty output file'))).toBe(false);
    });
});

describe('withTransientRetry', () => {
    it('returns the result immediately on success with no retries', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await withTransientRetry(fn, { attempts: 3, baseDelayMs: 1 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries a transient failure and eventually succeeds', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce({ code: 'ECONNRESET' })
            .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
            .mockResolvedValueOnce('ok');
        const result = await withTransientRetry(fn, { attempts: 3, baseDelayMs: 1 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('gives up after the configured attempt cap and throws the last error', async () => {
        const fn = vi.fn().mockRejectedValue({ code: 'ECONNRESET' });
        await expect(withTransientRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toEqual({ code: 'ECONNRESET' });
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('does not retry a permanent (non-transient) failure — fails on the first attempt', async () => {
        const permanentError = new Error('ffmpeg produced an empty output file');
        const fn = vi.fn().mockRejectedValue(permanentError);
        await expect(withTransientRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow(permanentError);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
