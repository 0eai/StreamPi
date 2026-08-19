/**
 * The part of "is this share still usable" that has nothing to do with what is being shared.
 *
 * shareResolver.js had these three rungs inline, which was fine while media shares were the only
 * kind. They're generic — missing, revoked, expired — so they live here to be shared with the file
 * share resolver rather than copied into it.
 *
 * Three exports rather than one, because the callers need different shapes: a resolver holds a row
 * and wants a predicate, a list query needs a SQL fragment over rows it hasn't fetched, and a
 * create/update route needs to turn user input into a stored value.
 */

/** A year. Long enough for any real "permanent-ish" link, short enough that a typo can't outlive the server. */
export const MAX_EXPIRY_HOURS = 24 * 365;

/**
 * Is this share row still usable? A missing row, a revoked one and an expired one are all simply
 * "no" — the caller collapses them into one 404, because confirming that a token *used to* work is
 * its own small leak. See the reasoning comment in shareResolver.js.
 *
 * `now` is injectable so tests don't have to construct dates relative to the wall clock.
 */
export const isShareLive = (row, now = Date.now()) => {
    if (!row) return false;
    if (row.revoked) return false;
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) return false;
    return true;
};

/**
 * The same three rungs as a SQL predicate, for queries that filter rows rather than test one. Bind
 * `new Date().toISOString()` as the single parameter.
 *
 * Takes a table alias because file shares are read through a JOIN, where bare column names are
 * ambiguous. Built here rather than by rewriting a constant at the call site — a regex over SQL is
 * the kind of thing that keeps working right up until a column is renamed.
 *
 * The string comparison is only equivalent to a date comparison for canonical ISO-8601-with-Z,
 * which is exactly what toISOString() produces and what expiryFromHours below stores. Nothing must
 * ever write a non-canonical timestamp into expires_at, or this predicate and isShareLive above
 * will quietly disagree.
 */
export const liveShareSql = (alias = '') => {
    const col = alias ? `${alias}.` : '';
    return `${col}revoked = 0 AND (${col}expires_at IS NULL OR ${col}expires_at > ?)`;
};

/**
 * Turns an `expiresInHours` from a request body into a stored value.
 *
 * Absent/null/'' means "never expires", which is what every share created before this existed
 * already is — so omitting the field keeps the old behaviour exactly.
 *
 * Returns the house `{ ok, ... }` shape (same convention as resolveShare and resolveNasFile) so a
 * route can hand the error straight back.
 */
export const expiryFromHours = (hours, now = Date.now()) => {
    if (hours === undefined || hours === null || hours === '') return { ok: true, expiresAt: null };

    const n = Number(hours);
    if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: "expiresInHours must be a positive number of hours, or omitted for no expiry" };
    }
    if (n > MAX_EXPIRY_HOURS) {
        return { ok: false, error: `expiresInHours cannot exceed ${MAX_EXPIRY_HOURS} (one year)` };
    }

    return { ok: true, expiresAt: new Date(now + n * 3600_000).toISOString() };
};
