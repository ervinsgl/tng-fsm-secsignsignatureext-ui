/**
 * routes/context.js
 *
 * Web Container session management.
 * Handles FSM Mobile POST context, stores it per-user session,
 * and serves it back to the frontend on request.
 *
 * Inbound auth (mobile):
 *   - Entry POST validates the FSM Authentication Key (Tier 1).
 *   - On success, an HttpOnly session cookie is issued (Tier 3).
 *   - /web-container-context requires that cookie, and only returns the
 *     context the cookie's session is bound to.
 * See SECURITY.md.
 *
 * The Authentication Key is a shared secret. It is validated on entry and
 * then discarded — it is never stored and never returned to the browser.
 * The FSM user token (authToken) in the same POST is discarded too.
 *
 * Routes:
 *   POST /web-container-access-point  ← FSM Mobile entry point
 *   POST /                            ← Fallback for older FSM versions
 *   GET  /web-container-context       ← Frontend fetches its session context (protected)
 *   GET  /api/user/:name              ← Resolve FSM user profile for the header (protected)
 */
const express = require('express');
const router  = express.Router();
const FSMService     = require('../utils/fsm/FSMService');
const SessionStore   = require('../utils/auth/SessionStore');
const requireSession = require('../utils/auth/requireSession');

// ── Session storage ────────────────────────────────────────────────────────

/**
 * Map of sessionKey → { ...fsmContext (without authenticationKey / authToken), _timestamp }
 * Key format: "<userName>-<cloudId>"
 */
const sessions       = {};

/**
 * How long a launch context is kept after entry.
 * Deliberately much longer than the 60-minute sliding session in SessionStore:
 * access is controlled by the session cookie, so the context only has to
 * outlive it. With 60 minutes here, a technician active for more than an hour
 * kept a valid session but lost the context, and the page failed on reload
 * (e.g. on return from SecSign). Contexts are tiny; 12 hours costs nothing.
 */
const CONTEXT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Remove contexts older than CONTEXT_TTL_MS. Runs every 10 minutes. */
setInterval(() => {
    const cutoff  = Date.now() - CONTEXT_TTL_MS;
    let   removed = 0;
    Object.keys(sessions).forEach(key => {
        if (sessions[key]._timestamp < cutoff) {
            delete sessions[key];
            removed++;
        }
    });
    if (removed > 0) {
        console.log(`[Context] Session cleanup: removed ${removed} | active: ${Object.keys(sessions).length}`);
    }
}, 10 * 60 * 1000);

// ── Helpers ────────────────────────────────────────────────────────────────

function handleMobilePost(body, res) {
    // ── Tier 1: validate the FSM Authentication Key ─────────────────────────
    if (!SessionStore.isValidAuthKey(body?.authenticationKey)) {
        console.warn(`[Context] WC-ACCESS-POINT: rejected POST — authenticationKey invalid or missing | user: ${body?.userName || 'unknown'}`);
        return res.status(401).send('Unauthorized');
    }

    const userName = body?.userName || 'unknown';
    const cloudId  = body?.cloudId  || 'unknown';
    const key      = `${userName}-${cloudId}`;

    // Never persist credentials from the entry POST; storing them would return
    // them to the browser via GET /web-container-context:
    //   - authenticationKey: the shared Web Container secret (validated above)
    //   - authToken:         the technician's own FSM user token (JWT) that FSM
    //                        Mobile includes. The backend calls FSM with its own
    //                        OAuth client (FSM_OAUTH_CONNECT) and never uses it.
    // eslint-disable-next-line no-unused-vars
    const { authenticationKey, authToken, ...contextData } = body;
    sessions[key] = { ...contextData, _timestamp: Date.now() };

    console.log(`[Context] Web container opened | user: ${userName} | objectType: ${body?.objectType} | session: ${key}`);

    // ── Tier 3: issue the session cookie ────────────────────────────────────
    const token = SessionStore.issue(key);
    res.cookie(requireSession.COOKIE_NAME, token, requireSession.cookieOptions(SessionStore.ttlMs));
    console.log(`[Context] WC-ACCESS-POINT: context stored, session issued | session: ${key}`);

    const host = res.req.protocol + '://' + res.req.get('host');
    res.redirect(`${host}/?session=${encodeURIComponent(key)}`);
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /web-container-access-point
 * FSM Mobile posts here when the technician opens the web container.
 * Configure this URL in FSM Admin → Company → Web Containers.
 */
router.post('/web-container-access-point', (req, res) => {
    handleMobilePost(req.body || {}, res);
});

/** Fallback: older FSM versions POST directly to root. */
router.post('/', (req, res) => {
    handleMobilePost(req.body || {}, res);
});

/**
 * GET /web-container-context?session=<key>
 * Frontend calls this on load to retrieve its stored context.
 * Protected: requires the session cookie issued on entry, and the requested
 * key must be the one that cookie's session is bound to — a caller can only
 * read their own launch context.
 */
router.get('/web-container-context', requireSession, (req, res) => {
    const key = req.query.session;

    if (!key) {
        return res.status(404).json({ message: 'No session key provided. Open from FSM Mobile.' });
    }

    if (key !== req.sessionContextKey) {
        console.warn(`[Context] GET context: rejected — requested '${key}' does not match session '${req.sessionContextKey}'`);
        return res.status(403).json({ message: 'Forbidden' });
    }

    const context = sessions[key];
    if (!context) {
        return res.status(404).json({ message: `Session '${key}' not found or expired.` });
    }

    const { _timestamp, ...contextData } = context;
    return res.json(contextData);
});

/**
 * GET /api/user/:name
 * Resolves an FSM user's profile (email, first/last name, roles) by login name.
 * Used to enrich the header with details for the logged-in user.
 * Protected: requires the session cookie.
 */
router.get('/api/user/:name', requireSession, async (req, res) => {
    const { name } = req.params;

    if (!name) {
        return res.status(400).json({ message: 'user name is required' });
    }

    try {
        console.log(`[Context] GET user | name: ${name}`);
        const user = await FSMService.getUserByName(name);
        if (!user) {
            return res.status(404).json({ message: `User '${name}' not found` });
        }
        return res.json(user);
    } catch (error) {
        console.error(`[Context] User lookup error:`, error.message);
        return res.status(500).json({ message: 'Failed to fetch user', error: error.message });
    }
});

module.exports = router;
