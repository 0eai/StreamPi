import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { createConcurrencyGate } from './concurrencyGate.js';

const makeRes = () => {
    const res = new EventEmitter();
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

describe('createConcurrencyGate', () => {
    it('allows a request through when under the limit', () => {
        const gate = createConcurrencyGate(() => 2);
        const next = () => {};
        gate({}, makeRes(), next);
        expect(gate.getReservedSlots()).toBe(1);
    });

    it('blocks a request with 503 once the limit is reached', () => {
        const gate = createConcurrencyGate(() => 1);
        gate({}, makeRes(), () => {}); // consumes the only slot, never released

        const res2 = makeRes();
        let nextCalled = false;
        gate({}, res2, () => { nextCalled = true; });

        expect(nextCalled).toBe(false);
        expect(res2.statusCode).toBe(503);
        expect(gate.getReservedSlots()).toBe(1); // rejected request never increments
    });

    it('releases the slot when the response finishes, allowing a subsequent request through', () => {
        const gate = createConcurrencyGate(() => 1);
        const res1 = makeRes();
        gate({}, res1, () => {});
        expect(gate.getReservedSlots()).toBe(1);

        res1.emit('finish');
        expect(gate.getReservedSlots()).toBe(0);

        const res2 = makeRes();
        let nextCalled = false;
        gate({}, res2, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
    });

    it('releases the slot on close too, and only once even if both finish and close fire', () => {
        const gate = createConcurrencyGate(() => 5);
        const res = makeRes();
        gate({}, res, () => {});
        expect(gate.getReservedSlots()).toBe(1);

        res.emit('close');
        res.emit('finish'); // already released — must not double-decrement below 0
        expect(gate.getReservedSlots()).toBe(0);
    });

    it('keeps a separate count per instance, so a read gate cannot be starved by transfers', () => {
        // routes/nas.js relies on this: /archive and GET /file each get their own gate, because
        // a browser's <video> opens several parallel range requests and used to be capped by
        // the transfer limit (maxConcurrentNasJobs, normally 1) — one range request was admitted
        // and the rest got 503, which the main server reported as 502 "NAS Proxy Error". Sharing
        // one counter is exactly the bug; these must not see each other's reservations.
        const transfers = createConcurrencyGate(() => 1);
        const reads = createConcurrencyGate(() => 12);

        transfers({}, makeRes(), () => {});          // an archive is in flight, slot exhausted
        expect(transfers.getReservedSlots()).toBe(1);

        const admitted = [];
        for (let i = 0; i < 6; i++) {
            const res = makeRes();
            reads({}, res, () => admitted.push(i));  // a browser's parallel range requests
        }

        expect(admitted).toEqual([0, 1, 2, 3, 4, 5]);
        expect(reads.getReservedSlots()).toBe(6);
        expect(transfers.getReservedSlots()).toBe(1); // reads never touched the transfer count
    });

    it('still bounds reads, so one client cannot exhaust the node', () => {
        const reads = createConcurrencyGate(() => 2);
        reads({}, makeRes(), () => {});
        reads({}, makeRes(), () => {});

        const third = makeRes();
        let nextCalled = false;
        reads({}, third, () => { nextCalled = true; });
        expect(nextCalled).toBe(false);
        expect(third.statusCode).toBe(503);
    });

    it('this is exactly the double-count bug that was fixed: a download must consume only ONE slot, not two', () => {
        // Before the fix, a route that both passed through this gate AND separately tracked
        // itself in another counter (ACTIVE_DOWNLOADS) contributed 2 to the effective total.
        // The gate itself must always account for exactly 1 slot per in-flight request.
        const gate = createConcurrencyGate(() => 2);
        gate({}, makeRes(), () => {});
        gate({}, makeRes(), () => {});
        expect(gate.getReservedSlots()).toBe(2); // two requests -> two slots, not four
    });
});
