/**
 * CIService.js
 *
 * Backend service for SAP Integration Suite (Cloud Integration) calls.
 * Uses the CI_BASIC_CONNECT BTP destination (BasicAuthentication).
 *
 * Sends a multipart/form-data request to the SAP CI iFlow which proxies
 * to SecSign Signature Portal POST /rest/signatureportal/v1/SPWorkflow/Start
 *
 * SecSign API fields (ad-hoc workflow, no template):
 *   filenames      – file array  – PDF binary
 *   steps          – JSON array  – SPWorkflowStep with signers + action
 *   workflowname   – string      – name of the created portfolio
 *   sigposbysigner – boolean     – signer can choose signature position
 *
 * NOTE: 'informsignertosign' is only valid for the template-based endpoint
 * /SPWorkflow/{templateId}/Start — it is NOT a valid field here.
 *
 * Expected response from SecSign (returned by CI):
 * {
 *   portfolioid:      4100,
 *   workflowid:       3880,
 *   workflowstepid:   103420,
 *   workflowstepurl:  "https://.../SignatureEditor/Portfolio/4100/WorkflowStep/103420",
 *   portfoliostate:   6,
 *   isended:          false,
 *   iserror:          false
 * }
 *
 * @file utils/CIService.js
 * @requires axios
 * @requires form-data
 * @requires ./DestinationService
 */
const axios              = require('axios');
const FormData           = require('form-data');
const DestinationService = require('../fsm/DestinationService');

class CIService {

    // =========================================================================
    // SIGNING
    // =========================================================================

    /**
     * Trigger the signing iFlow on SAP Integration Suite.
     * SAP CI forwards this as multipart/form-data to SecSign SPWorkflow/Start.
     *
     * @param {Object} params
     * @param {Buffer} params.pdfBuffer    - Raw PDF binary fetched from FSM
     * @param {string} params.fileName     - PDF file name (e.g. "TEST.pdf")
     * @param {string} params.userName     - FSM user name – used as SecSign signer
     * @param {string} params.attachmentId - FSM attachment ID (for logging)
     * @returns {Promise<Object>} SecSign response: { portfolioid, workflowstepid, workflowstepurl, ... }
     */
    async triggerSigning({ pdfBuffer, fileName, userName, attachmentId, returnUrl }) {
        const dest       = await this._getDestConfig();
        const authHeader = this._basicAuth(dest.User, dest.Password);

        const steps = JSON.stringify([{
            action:  "simple-signature",
            signers: [{ name: userName, signer_type: "user" }]
        }]);

        // Redirect back to the app after signing completes in SecSign portal
        // returnUrl is always supplied by SigningService (window.location.href); fail loudly if missing.
        if (!returnUrl) {
            throw new Error('returnUrl is required for signing');
        }
        const redirectUrl = returnUrl;

        const form = new FormData();
        form.append('filenames',       pdfBuffer, { filename: fileName, contentType: 'application/pdf' });
        form.append('steps',           steps);
        form.append('sigposbysigner',  'true');
        form.append('redirecturl',     redirectUrl);
        form.append('redirecttimeout', '3');

        console.log(`[CIService] ── Signing trigger ──────────────────────────`);
        console.log(`[CIService] URL:             ${dest.URL}`);
        console.log(`[CIService] CI User:         ${dest.User}`);
        console.log(`[CIService] File:            ${fileName}`);
        console.log(`[CIService] AttachmentId:    ${attachmentId}`);
        console.log(`[CIService] Signer:          ${userName}`);
        console.log(`[CIService] Steps:           ${steps}`);
        console.log(`[CIService] PDF size:        ${pdfBuffer.length} bytes`);
        console.log(`[CIService] Redirect URL:    ${redirectUrl}`);
        console.log(`[CIService] Redirect timeout: 3s`);

        const response = await axios.post(dest.URL, form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': authHeader
            }
        });

        console.log(`[CIService] ── Response ─────────────────────────────────`);
        console.log(`[CIService] HTTP status:        ${response.status}`);
        console.log(`[CIService] Full response:      ${JSON.stringify(response.data, null, 2)}`);
        console.log(`[CIService] portfolioid:        ${response.data?.portfolioid}`);
        console.log(`[CIService] workflowid:         ${response.data?.workflowid}`);
        console.log(`[CIService] workflowstepid:     ${response.data?.workflowstepid}`);
        console.log(`[CIService] workflowstepurl:    ${response.data?.workflowstepurl}`);
        console.log(`[CIService] portfoliostate:     ${response.data?.portfoliostate}`);
        console.log(`[CIService] portfoliostatename: ${response.data?.portfoliostatename}`);
        console.log(`[CIService] isended:            ${response.data?.isended}`);
        console.log(`[CIService] iserror:            ${response.data?.iserror}`);
        console.log(`[CIService] ────────────────────────────────────────────`);

        return response.data;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    async _getDestConfig() {
        const destination = await DestinationService.getDestination('CI_BASIC_CONNECT');
        const config      = destination.destinationConfiguration;
        console.log(`[CIService] Destination resolved | URL: ${config.URL} | User: ${config.User}`);
        return config;
    }

    _basicAuth(user, password) {
        return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    }
}

module.exports = new CIService();