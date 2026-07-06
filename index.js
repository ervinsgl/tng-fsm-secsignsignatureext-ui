/**
 * index.js
 *
 * Server entry point.
 * Registers middleware, mounts route files, serves static frontend, starts server.
 * All business logic lives in /routes and /utils.
 *
 * @file index.js
 */
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');

const contextRouter     = require('./routes/context');
const attachmentsRouter = require('./routes/attachments');
const signingRouter     = require('./routes/signing');
const requireSession    = require('./utils/auth/requireSession');

const app = express();

// ── Startup guard ──────────────────────────────────────────────────────────
// Fail fast if the shared secret is not configured — the app must not run
// with inbound auth disabled. See SECURITY.md.
if (!process.env.FSM_WEBCONTAINER_AUTH_KEY) {
    console.error('[Server] FATAL: FSM_WEBCONTAINER_AUTH_KEY is not set. Refusing to start.');
    process.exit(1);
}

// ── Middleware ─────────────────────────────────────────────────────────────

app.use((req, res, next) => {
    // Required: allows FSM Mobile WebView and FSM Shell iframe to embed this app
    res.removeHeader('X-Frame-Options');
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.enable('trust proxy');

// ── Routes ─────────────────────────────────────────────────────────────────

app.use('/',    contextRouter);      // POST /web-container-access-point, GET /web-container-context (protected internally)
app.use('/api', requireSession, attachmentsRouter);  // GET /api/attachments/*, /api/attachment-pdf/*, etc. — protected
app.use('/api/signing', requireSession, signingRouter); // POST /api/signing/trigger — protected

// ── Static files (UI5 frontend) ────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'webapp')));

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] FSM Signing app running on port ${PORT}`);
    console.log(`[Server] Web container entry:  POST /web-container-access-point`);
    console.log(`[Server] Inbound auth:          Auth Key + session cookie (mobile)`);
});