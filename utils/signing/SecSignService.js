/**
 * SecSignService.js
 *
 * Backend service for SecSign Signature Portal calls.
 * Uses SECSIGN_CONNECT BTP destination (BasicAuthentication).
 *
 * TLS note: rejectUnauthorized:false + keepAlive:false required for CF → SecSign.
 *
 * @file utils/signing/SecSignService.js
 */
const axios              = require('axios');
const https              = require('https');
const FormData           = require('form-data');
const DestinationService = require('../fsm/DestinationService');

class SecSignService {

    /**
     * Trigger a signing workflow on SecSign.
     * Returns response including workflowstepurl for browser navigation.
     */
    async triggerSigning({ pdfBuffer, fileName, userName, attachmentId, returnUrl }) {
        const dest       = await this._getDestConfig();
        const authHeader = this._basicAuth(dest.User, dest.Password);

        const steps = JSON.stringify([{
            action:  'simple-signature',
            signers: [{ name: userName, signer_type: 'user' }]
        }]);

        const redirectUrl = returnUrl || 'https://mobileappsignport-webcontainer-test-op.cfapps.eu10.hana.ondemand.com/';

        // Signature position — bottom right corner, signstack covers all pages
        // sigposbysigner: false = position is fixed, signer cannot move it
        const sigpos = JSON.stringify([{
            docname: fileName,
            top:     750,
            left:    370,
            width:   200,
            height:  50,
            sigtype: 'manual'
        }]);

        const form = new FormData();
        form.append('filenames',       pdfBuffer, { filename: fileName, contentType: 'application/pdf' });
        form.append('steps',           steps);
        form.append('sigpos',          sigpos);
        form.append('sigposbysigner',  'false');
        form.append('redirecturl',     redirectUrl);
        form.append('redirecttimeout', '3');

        console.log(`[SecSignService] Trigger | file: ${fileName} | signer: ${userName} | size: ${pdfBuffer.length} bytes`);

        let response;
        try {
            response = await axios.post(dest.URL, form, {
                headers:    { ...form.getHeaders(), 'Authorization': authHeader },
                httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: false }),
                timeout:    30000
            });
        } catch (error) {
            console.error(`[SecSignService] Trigger error: ${error.response?.status} ${error.message}`);
            console.error(`[SecSignService] Error body:`, error.response?.data);
            throw error;
        }

        console.log(`[SecSignService] Trigger OK | portfolioid: ${response.data?.portfolioid} | workflowstepurl: ${response.data?.workflowstepurl}`);
        return response.data;
    }

    /**
     * Download the signed PDF from SecSign after signing is complete.
     * Returns { buffer, contentType }.
     */
    async downloadSigned(portfolioId) {
        const dest        = await this._getDestConfig();
        const authHeader  = this._basicAuth(dest.User, dest.Password);
        const downloadUrl = `${dest.URL.replace('/SPWorkflow/Start', '')}/SPPortfolio/${portfolioId}/Download`;

        console.log(`[SecSignService] Download | portfolioId: ${portfolioId} | url: ${downloadUrl}`);

        let response;
        try {
            response = await axios.get(downloadUrl, {
                headers:      { 'Authorization': authHeader, 'Accept': 'application/octet-stream' },
                httpsAgent:   new https.Agent({ rejectUnauthorized: false, keepAlive: false }),
                responseType: 'arraybuffer',
                timeout:      30000
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
        const destination = await DestinationService.getDestination('SECSIGN_CONNECT');
        return destination.destinationConfiguration;
    }

    _basicAuth(user, password) {
        return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    }
}

module.exports = new SecSignService();