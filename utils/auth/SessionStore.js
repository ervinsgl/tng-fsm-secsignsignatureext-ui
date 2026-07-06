/**
 * SessionStore.js
 *
 * In-memory inbound session management for the FSM Mobile WebContainer flow.
 *
 * Two responsibilities:
 *   1. Validate the FSM Authentication Key on WebContainer entry (Tier 1).
 *   2. Issue and validate opaque session tokens with a sliding 60-minute TTL
 *      (Tier 3). Every successful validation extends the expiry.
 *
 * State is in-memory only and resets on container restart. Active sessions
 * become invalid on restart; the technician re-launches from FSM Mobile.
 * See SECURITY.md.
 *
 * Note: this is INBOUND auth (browser → app). It is unrelated to
 * utils/fsm/TokenCache.js, which handles OUTBOUND FSM OAuth tokens.
 *
 * @file utils/auth/SessionStore.js
 */
const crypto = require('crypto');

const SESSION_TTL_MS   = 60 * 60 * 1000; // 60 minutes, sliding
const CLEANUP_EVERY_MS = 10 * 60 * 1000; // sweep expired sessions every 10 min

class SessionStore {

    constructor() {
        /** Map<token, { contextKey, expiresAt }> */
        this._sessions = new Map();

        // Periodically evict expired sessions so the map doesn't grow unbounded.
        setInterval(() => this._sweep(), CLEANUP_EVERY_MS).unref?.();
    }

    // ── Tier 1: Authentication Key ──────────────────────────────────────────

    /**
     * Constant-time comparison of the presented Authentication Key against the
     * configured secret. Returns false (never throws) on any mismatch or when
     * the server secret is not configured.
     * @param {string} presentedKey - authenticationKey field from the POST body
     * @returns {boolean}
     */
    isValidAuthKey(presentedKey) {
        const expected = process.env.FSM_WEBCONTAINER_AUTH_KEY;

        if (!expected) {
            console.error('[SessionStore] FSM_WEBCONTAINER_AUTH_KEY not set — rejecting all entry POSTs');
            return false;
        }
        if (typeof presentedKey !== 'string' || presentedKey.length === 0) {
            return false;
        }

        const a = Buffer.from(presentedKey);
        const b = Buffer.from(expected);

        // timingSafeEqual requires equal-length buffers; length mismatch is an
        // immediate (constant-ish) reject.
        if (a.length !== b.length) return false;

        try {
            return crypto.timingSafeEqual(a, b);
        } catch {
            return false;
        }
    }

    // ── Tier 3: Session tokens ──────────────────────────────────────────────

    /**
     * Issue a new session token bound to a context key.
     * @param {string} contextKey - e.g. "<userName>-<cloudId>"
     * @returns {string} opaque session token
     */
    issue(contextKey) {
        const token = crypto.randomBytes(32).toString('base64url');
        this._sessions.set(token, {
            contextKey,
            expiresAt: Date.now() + SESSION_TTL_MS
        });
        console.log(`[SessionStore] Session issued | contextKey: ${contextKey} | active: ${this._sessions.size}`);
        return token;
    }

    /**
     * Validate a token and, on success, slide its TTL forward.
     * @param {string} token
     * @returns {{ contextKey: string } | null} session info, or null if invalid/expired
     */
    validateAndTouch(token) {
        if (!token) return null;

        const entry = this._sessions.get(token);
        if (!entry) return null;

        if (Date.now() > entry.expiresAt) {
            this._sessions.delete(token);
            return null;
        }

        // Sliding TTL: extend on every authenticated request.
        entry.expiresAt = Date.now() + SESSION_TTL_MS;
        return { contextKey: entry.contextKey };
    }

    /** Remaining TTL in milliseconds, for refreshing the cookie Max-Age. */
    get ttlMs() {
        return SESSION_TTL_MS;
    }

    _sweep() {
        const now = Date.now();
        let removed = 0;
        for (const [token, entry] of this._sessions) {
            if (now > entry.expiresAt) {
                this._sessions.delete(token);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`[SessionStore] Swept ${removed} expired | active: ${this._sessions.size}`);
        }
    }
}

module.exports = new SessionStore();