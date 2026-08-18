import { db, logActivity } from './db.js';
import { sendServerError } from './logger.js';

/**
 * Self-service node ownership: a logged-in user who can prove they hold a node's API key becomes its
 * owner, which is what unlocks /api/node-owner/:id/* for a non-admin.
 *
 * Why this exists: the node's own dashboard already has an account mode, but that mode calls through
 * the node-owner proxy, which requires ownership — so it could never bootstrap the ownership it
 * needed. An admin had to set it from the main dashboard first, guessing which human owns which box.
 *
 * Why the API key is the proof and merely being signed in is not: the dashboard is served
 * unauthenticated (node/index.js), so reaching it is not a credential — anyone on the LAN can load
 * that page. The key is the thing that means "I control this machine", and it already grants
 * root-equivalent access to the node (node/index.js requireAuth), so a claim grants strictly less
 * than the claimant already had. All it adds is the row in the admin Owner column.
 *
 * Claiming is only possible while a node is unowned; transfer stays an admin action. Note this does
 * NOT make the key one-shot proof: the node's own /api/config returns its raw apiKey, so a past owner
 * keeps a copy and can re-claim the moment ownership is cleared. Real dispossession is clearing the
 * owner *and* regenerating the key, which is why the admin UI offers those together.
 *
 * Lives in its own module rather than inline in routes/nodeOwner.js so it can be unit-tested with a
 * mocked db — the server has no route harness, and every hazard here is in the SQL and the ordering
 * rather than in the decision, so the handler itself is what needs covering.
 */
export const claimNode = async (req, res) => {
    // Before the write, not after. verifyToken resolves req.user.id indirectly (session.username ->
    // users.id) and yields null when that lookup fails, and `owner_user_id IS NULL` below would
    // happily match an unowned node, write NULL over NULL, report one changed row and return success
    // for a claim that claimed nothing.
    if (!req.user?.id) return res.status(403).json({ error: "Access Denied" });

    const { apiKey } = req.body || {};
    // express.json() gives {} for a request with no body, and binding undefined to a ? parameter
    // makes the sqlite3 driver throw — which would surface as a 500 rather than a 400.
    if (typeof apiKey !== 'string' || !apiKey) return res.status(400).json({ error: "apiKey required" });

    try {
        // One atomic conditional write instead of read-then-write: two people racing a claim on the
        // same unowned node would both pass a prior read. `revoked = 0` matches the two existing key
        // checks (db.verifyNodeKey, nodeDiscovery) — omitting it would leave this route quietly
        // disagreeing with them.
        //
        // Matching only `owner_user_id IS NULL`, rather than also the caller's own id, is what keeps
        // the log honest: re-claiming a node you already own changes nothing, so it must not write a
        // second "Claimed ownership" line that reads like ownership moved again. That case is handled
        // as an idempotent success below, off the classification read.
        const result = await db.run(
            `UPDATE nodes SET owner_user_id = ?
              WHERE id = ? AND api_key = ? AND revoked = 0 AND owner_user_id IS NULL`,
            [req.user.id, req.params.id, apiKey]
        );

        if (result.changes === 1) {
            const node = await db.get("SELECT name FROM nodes WHERE id = ?", req.params.id);
            await logActivity(
                req.user.username,
                "NODE_CLAIM",
                `Claimed ownership of node "${node?.name || req.params.id}"`,
                req.ip
            );
            return res.json({ success: true });
        }

        // Nothing changed, so work out which of the three reasons it was. The key is checked before
        // ownership deliberately: the other order would turn this endpoint into an ownership oracle
        // for any logged-in user, whereas this way a 409 is only reachable by someone holding the
        // node's key.
        const node = await db.get("SELECT name, api_key, revoked, owner_user_id FROM nodes WHERE id = ?", req.params.id);
        if (!node) return res.status(404).json({ error: "Node not found" });
        if (node.revoked || node.api_key !== apiKey) return res.status(403).json({ error: "Access Denied" });

        // Already yours. A success, because the caller asked for a state that holds — and silent,
        // because nothing changed.
        if (node.owner_user_id === req.user.id) return res.json({ success: true });

        // Naming the owner is deliberate. The 409 itself already discloses that the node has one, so
        // withholding the username protects nothing while making the message unactionable — and the
        // only people who can get here hold the node's key, i.e. can read node_config.json directly.
        const owner = await db.get("SELECT username FROM users WHERE id = ?", node.owner_user_id);
        return res.status(409).json({
            error: owner?.username
                ? `This node is already owned by ${owner.username} — ask an admin to transfer it.`
                : "This node already has an owner — ask an admin to transfer it."
        });
    } catch (e) { sendServerError(res, e); }
};
