/**
 * requireSession.js
 *
 * Express middleware enforcing a valid inbound session on protected routes.
 *
 * Reads the session token from the `fsm_session` HttpOnly cookie, validates it
 * against the SessionStore, slides its TTL, and refreshes the cookie Max-Age so
 * browser-side and server-side expiry stay in sync. Missing or expired sessions
 * get a 401.
 *
 * Mobile-only: this app validates the cookie source only. (The Web UI Bearer
 * flow from SECURITY.md Tier 2 is not implemented here.)
 *
 * @file utils/auth/requireSession.js
 */
const SessionStore = require('./SessionStore');

const COOKIE_NAME = 'fsm_session';

/**
 * Cookie attributes for the Mobile WebView (first-party context).
 * @param {number} maxAgeMs
 * @returns {Object} express res.cookie options
 */
function cookieOptions(maxAgeMs) {
    return {
        httpOnly: true,
        secure:   true,        // CF enforces HTTPS
        sameSite: 'lax',       // first-party WebView context
        path:     '/',
        maxAge:   maxAgeMs
    };
}

function requireSession(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    const session = SessionStore.validateAndTouch(token);

    if (!session) {
        const source = token ? 'invalid-or-expired' : 'missing-credential';
        console.warn(`[AUTH] rejected ${req.method} ${req.originalUrl} | ${source} | source=${token ? 'cookie' : 'none'}`);
        return res.status(401).json({ message: 'Session required. Open from FSM Mobile.' });
    }

    // Refresh the cookie Max-Age so browser expiry tracks the slid server TTL.
    res.cookie(COOKIE_NAME, token, cookieOptions(SessionStore.ttlMs));

    // Make the context key available to downstream handlers if needed.
    req.sessionContextKey = session.contextKey;
    next();
}

module.exports = requireSession;
module.exports.COOKIE_NAME    = COOKIE_NAME;
module.exports.cookieOptions  = cookieOptions;