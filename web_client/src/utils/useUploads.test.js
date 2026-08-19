import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useUploads } from './useUploads';

/**
 * jsdom's XMLHttpRequest will not emit upload progress for a stubbed request, so this replaces it
 * wholesale and drives the lifecycle by hand. That also makes the concurrency cap observable: the
 * number of instances that exist at a given moment IS the number of uploads in flight.
 */
const instances = [];
class FakeXhr {
    constructor() {
        this.upload = {};
        this.status = 0;
        this.responseText = '';
        this.headers = {};
        this.sent = null;
        this.aborted = false;
        instances.push(this);
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) { this.sent = body; }
    abort() { this.aborted = true; this.onabort?.(); }

    /** Test helpers, not part of the XHR surface. */
    succeed(body = '{}') { this.status = 200; this.responseText = body; this.onload?.(); }
    fail(status, body) { this.status = status; this.responseText = body ?? ''; this.onload?.(); }
    progress(loaded, total) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }); }
}

const inFlight = () => instances.filter((x) => !x.aborted && x.status === 0).length;
const fieldsOf = (formData) => Array.from(formData.keys());
const valueOf = (formData, key) => formData.get(key);

const fileItem = (name, over = {}) => ({
    kind: 'file',
    file: new File(['x'], name, { type: 'text/plain' }),
    name,
    parentId: 'parent-1',
    ...over,
});

const render = (onComplete) => renderHook(() => useUploads('tok', 'http://pi:3005', onComplete));

describe('useUploads', () => {
    beforeEach(() => { instances.length = 0; vi.stubGlobal('XMLHttpRequest', FakeXhr); });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('runs at most three at a time, starting the next as each finishes', async () => {
        // The behaviour folder upload depends on: 400 files must not open 400 requests.
        const { result } = render();
        act(() => {
            result.current.handleStartUpload(
                ['a', 'b', 'c', 'd', 'e'].map((n) => fileItem(`${n}.txt`))
            );
        });

        expect(instances).toHaveLength(3);
        expect(inFlight()).toBe(3);

        act(() => instances[0].succeed());
        expect(instances).toHaveLength(4);   // the fourth started only once a slot freed

        act(() => instances[1].succeed());
        act(() => instances[2].succeed());
        expect(instances).toHaveLength(5);
        await waitFor(() => expect(result.current.uploads.filter((u) => u.status === 'done')).toHaveLength(3));
    });

    it('posts a user file to the files endpoint with only a parentId', async () => {
        const { result } = render();
        act(() => { result.current.handleStartUpload([fileItem('report.pdf')]); });

        const xhr = instances[0];
        expect(xhr.url).toBe('http://pi:3005/api/files/upload');
        expect(xhr.headers.Authorization).toBe('Bearer tok');
        expect(fieldsOf(xhr.sent).sort()).toEqual(['file', 'name', 'parentId']);
        expect(valueOf(xhr.sent, 'parentId')).toBe('parent-1');
    });

    it('still posts media uploads in the order multer depends on', async () => {
        // The media storage engine reads destination/nodeId mid-parse, so those fields must precede
        // the file part. Asserting the order because nothing else in the code says so out loud.
        const { result } = render();
        act(() => {
            result.current.handleStartUpload([{
                file: new File(['x'], 'movie.mp4'), type: 'movie', isPrivate: false,
                destination: 'nas', nodeId: 'node-1', title: 'Movie',
            }]);
        });

        const fields = fieldsOf(instances[0].sent);
        expect(instances[0].url).toBe('http://pi:3005/api/upload');
        expect(fields.indexOf('destination')).toBeLessThan(fields.indexOf('files'));
        expect(fields.indexOf('nodeId')).toBeLessThan(fields.indexOf('files'));
    });

    it('surfaces what the server said instead of a bare failure', async () => {
        // A quota rejection or a 413 is actionable; "error" is not.
        const { result } = render();
        act(() => { result.current.handleStartUpload([fileItem('big.bin')]); });
        act(() => instances[0].fail(507, JSON.stringify({ error: 'That would exceed your 20 GB of storage.' })));

        await waitFor(() => {
            expect(result.current.uploads[0].status).toBe('error');
            expect(result.current.uploads[0].error).toMatch(/exceed your 20 GB/);
        });
    });

    it('falls back to a readable message for a non-JSON body', async () => {
        const { result } = render();
        act(() => { result.current.handleStartUpload([fileItem('a.txt')]); });
        act(() => instances[0].fail(413, 'File too large'));
        await waitFor(() => expect(result.current.uploads[0].error).toBe('File too large'));
    });

    it('reports progress', async () => {
        const { result } = render();
        act(() => { result.current.handleStartUpload([fileItem('a.txt')]); });
        act(() => instances[0].progress(50, 200));
        await waitFor(() => expect(result.current.uploads[0].progress).toBe(25));
    });

    it('tells the caller about each success, so a listing can refresh', async () => {
        const onComplete = vi.fn();
        const { result } = render(onComplete);
        act(() => { result.current.handleStartUpload([fileItem('a.txt')]); });
        act(() => instances[0].succeed());
        await waitFor(() => expect(onComplete).toHaveBeenCalledWith('tok', expect.objectContaining({ name: 'a.txt' })));
    });

    it('cancels one queued upload without starting it', async () => {
        const { result } = render();
        act(() => {
            result.current.handleStartUpload(['a', 'b', 'c', 'd'].map((n) => fileItem(`${n}.txt`)));
        });
        const queued = result.current.uploads[3];
        expect(instances).toHaveLength(3); // the fourth is only queued

        act(() => result.current.cancelUpload(queued.id));
        act(() => instances[0].succeed());
        // The freed slot must not resurrect the cancelled item.
        expect(instances).toHaveLength(3);
        await waitFor(() => expect(result.current.uploads.find((u) => u.id === queued.id)).toBeUndefined());
    });

    it('aborts everything in flight and drops the queue on logout', async () => {
        const { result } = render();
        act(() => {
            result.current.handleStartUpload(['a', 'b', 'c', 'd', 'e'].map((n) => fileItem(`${n}.txt`)));
        });
        act(() => result.current.abortAll());

        expect(instances.slice(0, 3).every((x) => x.aborted)).toBe(true);
        // And the two that were still queued never start, even though slots are now free.
        expect(instances).toHaveLength(3);
    });

    it('retries a failed upload', async () => {
        const { result } = render();
        act(() => { result.current.handleStartUpload([fileItem('a.txt')]); });
        act(() => instances[0].fail(500));
        await waitFor(() => expect(result.current.uploads[0].status).toBe('error'));

        const id = result.current.uploads[0].id;
        await act(async () => { result.current.retryUpload(id); });
        await waitFor(() => expect(instances).toHaveLength(2));
        act(() => instances[1].succeed());
        await waitFor(() => expect(result.current.uploads[0].status).toBe('done'));
    });

    it('gives every queued item a distinct id from the shared helper', () => {
        // Previously Math.random().toString(36).substr(2, 9), which is both the app's only remaining
        // hand-rolled id and 9 characters of collidable base36.
        const { result } = render();
        act(() => {
            result.current.handleStartUpload(Array.from({ length: 30 }, (_, i) => fileItem(`f${i}.txt`)));
        });
        expect(new Set(result.current.uploads.map((u) => u.id)).size).toBe(30);
    });
});
