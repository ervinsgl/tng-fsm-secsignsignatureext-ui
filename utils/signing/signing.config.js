/**
 * signing.config.js
 *
 * Single place to control SecSign signature behaviour.
 * Signing always goes directly to SecSign (no CI, no alternate targets).
 *
 * SIGNATURE_ACTION options (SecSign signature strength, ascending assurance):
 *   'view-and-check'
 *   'simple-signature'
 *   'advanced-signature'   ← current default (AdES; signer must have a cert on SecSign)
 *   'qualified-signature'
 *
 * SIG_POSITION: fixed on-page position applied to every document so the signer
 * does NOT have to position anything (sigposbysigner = false). Keeps signer
 * effort to a minimum — they only confirm.
 *
 * COMPLETION_POLL: after the signer returns, we confirm the portfolio actually
 * reached the finished state (portfoliostate === 3) before marking anything
 * signed. A short bounded poll absorbs the finalize race on the SecSign server.
 *
 * To change behaviour: edit the values below and redeploy. No other files change.
 */

const SIGNATURE_ACTION = 'advanced-signature'; // see options above

// Fixed signature annotation position (points from top-left of page 0).
const SIG_POSITION = {
    page:    0,
    top:     750,
    left:    370,
    width:   200,
    height:  50,
    sigtype: 'manual'
};

// SecSign portfolio state codes (from Signature Portal REST API docs).
const PORTFOLIO_STATE = {
    CREATED:  1,
    FINISHED: 3, // successfully signed → safe to download + mark signed
    PENDING:  6  // workflow not yet completed
};

// Bounded completion poll on return from the signing portal.
const COMPLETION_POLL = {
    attempts:   6,    // total status checks
    intervalMs: 1500  // wait between checks
};

// Redirect UX shown by the SecSign portal when the step completes.
const REDIRECT_UX = {
    name:       'FSM Signing',
    message:    'Signing finished — returning to FSM.',
    timeoutSec: 3
};

module.exports = {
    SIGNATURE_ACTION,
    SIG_POSITION,
    PORTFOLIO_STATE,
    COMPLETION_POLL,
    REDIRECT_UX
};