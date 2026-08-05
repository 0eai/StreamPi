// ACTIVE_UPLOADS isn't populated until deep inside multer's filename callback, which only
// runs after an intervening await (pickPlacementLocation) — so checking its size for a
// concurrency limit left a window where concurrent /archive requests could all observe the
// same pre-increment count and all pass the gate. This reserves a slot synchronously, with no
// await between the check and the increment, so the gate can't be raced. Pulled into its own
// module (rather than living inline in routes/nas.js) so the counter logic is cheap to
// unit-test in isolation, per the original audit's own suggestion ("the concurrency-gate math").
export const createConcurrencyGate = (getMax) => {
    let reservedSlots = 0;

    const middleware = (req, res, next) => {
        if (reservedSlots >= getMax()) return res.status(503).json({ error: "NAS Busy: Too many concurrent transfers." });
        reservedSlots++;
        let released = false;
        const release = () => { if (!released) { released = true; reservedSlots--; } };
        res.on('finish', release);
        res.on('close', release);
        next();
    };

    middleware.getReservedSlots = () => reservedSlots;
    return middleware;
};
