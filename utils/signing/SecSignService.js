/**
 * SecSignService.js
 *
 * Backend service for SecSign Signature Portal calls.
 * Uses SECSIGN_CONNECT BTP destination (BasicAuthentication).
 *
 * TLS note: rejectUnauthorized:false + keepAlive:false required for CF → SecSign.
 *
 * Supports one OR many documents in a single workflow:
 *   - all documents attached to a single portfolio
 *   - a single step with one sigpos per document → signer signs everything in one pass
 *
 * @file utils/signing/SecSignService.js
 */
const axios              = require('axios');
const https              = require('https');
const FormData           = require('form-data');
const DestinationService = require('../fsm/DestinationService');
const {
    SIGNATURE_ACTION,
    SIG_POSITION,
    PORTFOLIO_STATE,
    COMPLETION_POLL,
    REDIRECT_UX
} = require('./signing.config');

// ── Destination ────────────────────────────────────────────────────────────
// BTP destination name for the SecSign Signature Portal (BasicAuthentication).
// Change here if the destination is renamed in the BTP cockpit.
const SECSIGN_DESTINATION = 'SECSIGN_CONNECT';

class SecSignService {

    /**
     * Trigger a signing workflow on SecSign for one or more documents.
     *
     * @param {Object}   params
     * @param {Array}    params.documents - [{ buffer, fileName }] one entry per PDF
     * @param {string}   params.userName  - SecSign signer name
     * @param {string}   params.returnUrl - URL to return to after signing
     * @returns {Promise<Object>} SecSign response incl. portfolioid + workflowstepurl
     */
    async triggerSigning({ documents, userName, returnUrl }) {
        if (!Array.isArray(documents) || documents.length === 0) {
            throw new Error('At least one document is required for signing');
        }
        if (!returnUrl) {
            throw new Error('returnUrl is required for signing');
        }

        const dest       = await this._getDestConfig();
        const authHeader = this._basicAuth(dest.User, dest.Password);

        // ONE step, ONE signer, ONE action, N sigpos (one per document).
        // This is what makes the signer sign all documents in a single pass.
        const step = {
            action:  SIGNATURE_ACTION,
            signers: [{ name: userName, signer_type: 'user' }],
            sigpos:  documents.map(doc => ({
                docname: doc.fileName,
                page:    SIG_POSITION.page,
                top:     SIG_POSITION.top,
                left:    SIG_POSITION.left,
                width:   SIG_POSITION.width,
                height:  SIG_POSITION.height,
                sigtype: SIG_POSITION.sigtype
            }))
        };
        const steps = JSON.stringify([step]);

        const form = new FormData();
        // Append each PDF under the repeated 'filenames' field.
        documents.forEach(doc => {
            form.append('filenames', doc.buffer, {
                filename:    doc.fileName,
                contentType: 'application/pdf'
            });
        });
        form.append('steps',           steps);
        form.append('sigposbysigner',  'false');                 // fixed position → signer positions nothing
        form.append('redirecturl',     returnUrl);
        form.append('redirectname',    REDIRECT_UX.name);
        form.append('redirectmessage', REDIRECT_UX.message);
        form.append('redirecttimeout', String(REDIRECT_UX.timeoutSec));

        console.log(`[SecSignService] Trigger | action: ${SIGNATURE_ACTION} | signer: ${userName} | docs: ${documents.length} (${documents.map(d => d.fileName).join(', ')})`);

        let response;
        try {
            response = await axios.post(dest.URL, form, {
                headers: { ...form.getHeaders(), 'Authorization': authHeader },
                httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: false }),
                timeout: 30000
            });
        } catch (error) {
            console.error(`[SecSignService] Trigger error: ${error.response?.status} ${error.message}`);
            console.error(`[SecSignService] Error body:`, error.response?.data);
            throw error;
        }

        console.log(`[SecSignService] Trigger OK | portfolioid: ${response.data?.portfolioid} | state: ${response.data?.portfoliostate} | url: ${response.data?.workflowstepurl}`);
        return response.data;
    }

    /**
     * Query the current status of a portfolio.
     * GET /SPPortfolioStatus/{portfolioId}
     * Returns { portfolioid, portfoliostate, isended, iserror, ... }.
     */
    async getPortfolioStatus(portfolioId) {
        const dest       = await this._getDestConfig();
        const authHeader = this._basicAuth(dest.User, dest.Password);
        const base       = this._apiBase(dest.URL);
        const statusUrl  = `${base}/SPPortfolioStatus/${portfolioId}`;

        const response = await axios.get(statusUrl, {
            headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: false }),
            timeout: 15000
        });

        const s = response.data || {};
        console.log(`[SecSignService] Status | portfolioId: ${portfolioId} | state: ${s.portfoliostate} (${s.portfoliostatename}) | ended: ${s.isended} | error: ${s.iserror}`);
        return s;
    }

    /**
     * Wait (bounded poll) until the portfolio reaches the finished state.
     * Absorbs the finalize race after the signer returns from the portal.
     *
     * @returns {Promise<{ signed: boolean, status: Object }>}
     */
    async waitForCompletion(portfolioId) {
        let status = null;

        for (let attempt = 1; attempt <= COMPLETION_POLL.attempts; attempt++) {
            try {
                status = await this.getPortfolioStatus(portfolioId);
            } catch (error) {
                console.warn(`[SecSignService] Status check ${attempt} failed: ${error.message}`);
            }

            if (status) {
                if (status.iserror) {
                    console.warn(`[SecSignService] Portfolio ${portfolioId} reported error: ${status.portfolioerrormsg || 'unknown'}`);
                    return { signed: false, status };
                }
                if (status.portfoliostate === PORTFOLIO_STATE.FINISHED) {
                    console.log(`[SecSignService] Portfolio ${portfolioId} finished after ${attempt} check(s)`);
                    return { signed: true, status };
                }
            }

            if (attempt < COMPLETION_POLL.attempts) {
                await this._sleep(COMPLETION_POLL.intervalMs);
            }
        }

        console.log(`[SecSignService] Portfolio ${portfolioId} not finished after ${COMPLETION_POLL.attempts} checks (state: ${status?.portfoliostate})`);
        return { signed: false, status };
    }

    /**
     * Download the signed portfolio after completion.
     * A portfolio can contain multiple documents, so SecSign returns a ZIP.
     * Returns { buffer, contentType } — caller unzips when contentType is zip.
     */
    async downloadSigned(portfolioId) {
        const dest        = await this._getDestConfig();
        const authHeader  = this._basicAuth(dest.User, dest.Password);
        const base        = this._apiBase(dest.URL);
        const downloadUrl = `${base}/SPPortfolio/${portfolioId}/Download`;

        console.log(`[SecSignService] Download | portfolioId: ${portfolioId} | url: ${downloadUrl}`);

        let response;
        try {
            response = await axios.get(downloadUrl, {
                headers: { 'Authorization': authHeader, 'Accept': 'application/zip, application/octet-stream' },
                httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: false }),
                responseType: 'arraybuffer',
                timeout: 30000
            });
        } catch (error) {
            console.error(`[SecSignService] Download error: ${error.response?.status} ${error.message}`);
            throw error;
        }

        const buffer      = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';
        console.log(`[SecSignService] Download OK | size: ${buffer.length} bytes | contentType: ${contentType}`);
        return { buffer, contentType };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    async _getDestConfig() {
        const destination = await DestinationService.getDestination(SECSIGN_DESTINATION);
        return destination.destinationConfiguration;
    }

    /**
     * Derive the REST API base (…/rest/signatureportal/v1) from the configured
     * trigger URL, which may end in /SPWorkflow/Start. Robust to either form.
     */
    _apiBase(url) {
        return url
            .replace(/\/SPWorkflow\/Start\/?$/, '')
            .replace(/\/$/, '');
    }

    _basicAuth(user, password) {
        return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new SecSignService();