/**
 * routes/context.js
 *
 * Web Container session management.
 * Handles FSM Mobile POST context, stores it per-user session,
 * and serves it back to the frontend on request.
 *
 * Routes:
 *   POST /web-container-access-point  ← FSM Mobile entry point
 *   POST /                            ← Fallback for older FSM versions
 *   GET  /web-container-context       ← Frontend fetches its session context
 *   GET  /api/user/:name              ← Resolve FSM user profile for the header
 */
const express = require('express');
const router  = express.Router();
const FSMService = require('../utils/fsm/FSMService');

// ── Session storage ────────────────────────────────────────────────────────

/**
 * Map of sessionKey → { ...fsmContext, _timestamp }
 * Key format: "<userName>-<cloudId>"
 */
const sessions       = {};
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Remove sessions older than SESSION_TTL_MS. Runs every 10 minutes. */
setInterval(() => {
    const cutoff  = Date.now() - SESSION_TTL_MS;
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
    const userName = body?.userName || 'unknown';
    const cloudId  = body?.cloudId  || 'unknown';
    const key      = `${userName}-${cloudId}`;

    sessions[key] = { ...body, _timestamp: Date.now() };

    console.log(`[Context] Web container opened | user: ${userName} | objectType: ${body?.objectType} | session: ${key}`);

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
 */
router.get('/web-container-context', (req, res) => {
    const key = req.query.session;

    if (!key) {
        return res.status(404).json({ message: 'No session key provided. Open from FSM Mobile.' });
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
 */
router.get('/api/user/:name', async (req, res) => {
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