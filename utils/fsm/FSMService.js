/**
 * FSMService.js
 *
 * Backend service for SAP FSM API integration.
 * Scoped to the document signing app:
 *
 *   - Core HTTP helpers  (GET, PATCH via Data API; Query API)
 *   - Activity           (read + update)
 *   - UDF Meta           (resolve UDF external IDs)
 *   - Attachments        (list, content, binary buffer, create with content)
 *
 * @file utils/fsm/FSMService.js
 * @requires axios
 * @requires ./DestinationService
 * @requires ./TokenCache
 */
const axios              = require('axios');
const DestinationService = require('./DestinationService');
const TokenCache         = require('./TokenCache');

// ── Destination ────────────────────────────────────────────────────────────
// BTP destination name for the FSM OAuth connection.
// Change here if the destination is renamed in the BTP cockpit.
const FSM_DESTINATION = 'FSM_OAUTH_CONNECT';


class FSMService {

    constructor() {
        this.config = {
            account: 'tuev-nord_t1',
            company: 'TUEV-NORD_S4E'
        };
    }

    // =========================================================================
    // CORE HTTP HELPERS
    // =========================================================================

    async makeRequest(path, params = {}) {
        try {
            const { dest, token } = await this._auth();
            const response = await axios.get(
                `${dest.URL}/api/data/v4${path}`,
                { params: { ...params, ...this._accountParams(dest) }, headers: this._headers(dest, token) }
            );
            return response.data;
        } catch (error) {
            console.error('[FSMService] GET error:', error.response?.data || error.message);
            throw error;
        }
    }

    async patchRequest(path, data, params = {}) {
        try {
            const { dest, token } = await this._auth();
            const response = await axios.patch(
                `${dest.URL}/api/data/v4${path}`,
                data,
                { params: { forceUpdate: true, ...params, ...this._accountParams(dest) }, headers: this._headers(dest, token) }
            );
            return response.data;
        } catch (error) {
            console.error('[FSMService] PATCH error:', error.response?.data || error.message);
            throw error;
        }
    }

    async makeQueryRequest(query, dtos) {
        try {
            const { dest, token } = await this._auth();
            const response = await axios.get(
                `${dest.URL}/api/query/v1`,
                { params: { query, dtos, ...this._accountParams(dest) }, headers: this._headers(dest, token) }
            );
            return response.data;
        } catch (error) {
            console.error('[FSMService] Query error:', error.response?.data || error.message);
            throw error;
        }
    }

    // =========================================================================
    // ACTIVITY
    // =========================================================================

    async getActivityById(activityId) {
        return this.makeRequest(`/Activity/${activityId}`, { dtos: 'Activity.40' });
    }

    async updateActivity(activityId, updateData) {
        const { dest, token } = await this._auth();
        const response = await axios.put(
            `${dest.URL}/api/data/v4/Activity/${activityId}`,
            updateData,
            { params: { dtos: 'Activity.40', ...this._accountParams(dest) }, headers: this._headers(dest, token) }
        );
        return response.data;
    }

    // =========================================================================
    // UDF META
    // =========================================================================

    async getUdfMetaById(udfMetaId) {
        try {
            const query = `SELECT w.externalId FROM UdfMeta w WHERE w.id = '${udfMetaId}'`;
            const data  = await this.makeQueryRequest(query, 'UdfMeta.20');
            if (!data.data || data.data.length === 0) return null;
            return data.data[0]?.w?.externalId || null;
        } catch (error) {
            console.error('[FSMService] UDF meta error:', error.message);
            return null;
        }
    }

    // =========================================================================
    // USER
    // =========================================================================

    /**
     * Look up an FSM user by their login name.
     * GET /api/user/v1/users/?name=<name>&account=<account>
     *
     * Uses the same bearer token + X-Client-ID / X-Client-Version headers as
     * the data API, but a different base path (/api/user/v1).
     *
     * @param {string} name - FSM user login name (e.g. "EGLEIZDS")
     * @returns {Promise<Object|null>} { email, firstName, lastName, name, active, roles } or null
     */
    async getUserByName(name) {
        try {
            const { dest, token } = await this._auth();
            const account = dest.account || this.config.account;

            const response = await axios.get(
                `${dest.URL}/api/user/v1/users/`,
                {
                    params:  { name, account },
                    headers: this._headers(dest, token)
                }
            );

            const user = response.data?.content?.[0] || null;
            if (!user) {
                console.warn(`[FSMService] User not found | name: ${name}`);
                return null;
            }

            console.log(`[FSMService] User resolved | name: ${name} | email: ${user.email}`);
            return {
                name:      user.name,
                email:     user.email     || '',
                firstName: user.firstName || '',
                lastName:  user.lastName  || '',
                active:    user.active,
                roles:     user.roles     || []
            };
        } catch (error) {
            console.error(`[FSMService] User lookup error for ${name}:`, error.response?.data || error.message);
            throw error;
        }
    }

    // =========================================================================
    // ATTACHMENTS
    // =========================================================================

    async getAttachmentsForObject(objectId) {
        try {
            const query = `SELECT w FROM Attachment w WHERE w.object.objectId = '${objectId}'`;
            console.log(`[FSMService] Fetching attachments | objectId: ${objectId}`);
            const data = await this.makeQueryRequest(query, 'Attachment.8');

            if (!data.data || data.data.length === 0) return [];

            // Per-request UDF meta cache — avoids repeat API calls for the same UUID
            // across multiple attachments (all share the same Z_Attachment_PDFSigned UUID)
            const udfMetaCache = {};

            const attachments = await Promise.all(data.data.map(async item => {
                const w      = item.w;
                let   signed = false;

                // Check udfValues for Z_Attachment_PDFSigned
                if (Array.isArray(w.udfValues) && w.udfValues.length > 0) {
                    for (const udf of w.udfValues) {
                        if (!udf.meta) continue;

                        // Resolve meta UUID → externalId (cached)
                        if (!(udf.meta in udfMetaCache)) {
                            udfMetaCache[udf.meta] = await this.getUdfMetaById(udf.meta);
                        }

                        if (udfMetaCache[udf.meta] === 'Z_Attachment_PDFSigned') {
                            signed = udf.value === 'true';
                            console.log(`[FSMService] UDF Z_Attachment_PDFSigned | id: ${w.id} | value: ${udf.value} | signed: ${signed}`);
                            break;
                        }
                    }
                }

                return {
                    id:       w.id       || 'N/A',
                    fileName: w.fileName || 'N/A',
                    type:     w.type     || 'N/A',
                    description: w.description  || '',
                    signed
                };
            }));

            console.log(`[FSMService] Attachments loaded | objectId: ${objectId} | count: ${attachments.length}`);
            return attachments;

        } catch (error) {
            console.error('[FSMService] Attachments error:', error.response?.data || error.message);
            throw error;
        }
    }

    async getAttachmentContent(attachmentId) {
        try {
            const { dest, token } = await this._auth();
            const response = await axios.get(
                `${dest.URL}/api/data/v4/Attachment/${attachmentId}/content`,
                { params: this._accountParams(dest), headers: this._headers(dest, token), responseType: 'arraybuffer' }
            );
            const base64      = Buffer.from(response.data).toString('base64');
            const contentType = response.headers['content-type'] || 'application/pdf';
            console.log(`[FSMService] Attachment content | id: ${attachmentId} | size: ${response.data.byteLength} bytes`);
            return { base64, contentType };
        } catch (error) {
            console.error(`[FSMService] Attachment content error for ${attachmentId}:`, error.response?.data || error.message);
            throw error;
        }
    }

    async getAttachmentBuffer(attachmentId) {
        try {
            const { dest, token } = await this._auth();
            const response = await axios.get(
                `${dest.URL}/api/data/v4/Attachment/${attachmentId}/content`,
                { params: this._accountParams(dest), headers: this._headers(dest, token), responseType: 'arraybuffer' }
            );
            console.log(`[FSMService] Attachment buffer | id: ${attachmentId} | size: ${response.data.byteLength} bytes`);
            return Buffer.from(response.data);
        } catch (error) {
            console.error(`[FSMService] Attachment buffer error for ${attachmentId}:`, error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Mark an FSM Attachment as signed via UDF Z_Attachment_PDFSigned = true.
     * Uses externalId reference so no UUID lookup needed.
     *
     * @param {string} attachmentId - FSM attachment ID
     */
    async markAttachmentSigned(attachmentId) {
        try {
            const response = await this.patchRequest(
                `/Attachment/${attachmentId}`,
                {
                    udfValues: [{
                        meta:  { externalId: 'Z_Attachment_PDFSigned' },
                        value: 'true'
                    }]
                },
                { dtos: 'Attachment.8' }
            );
            console.log(`[FSMService] Attachment marked signed | id: ${attachmentId}`);
            return response;
        } catch (error) {
            console.error('[FSMService] Mark signed error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Update an existing FSM Attachment with new binary content.
     * PATCH with fileContent as base64 + forceUpdate=true.
     *
     * @param {string} attachmentId - existing FSM attachment ID to overwrite
     * @param {Buffer} buffer       - signed PDF binary
     * @returns {Promise<void>}
     */
    async updateAttachmentContent(attachmentId, buffer) {
        try {
            const response = await this.patchRequest(
                `/Attachment/${attachmentId}`,
                { fileContent: buffer.toString('base64') },
                { dtos: 'Attachment.8' }
            );
            console.log(`[FSMService] Attachment updated | id: ${attachmentId} | size: ${buffer.length} bytes`);
            return response;
        } catch (error) {
            console.error('[FSMService] Update attachment error:', error.response?.data || error.message);
            throw error;
        }
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    async _auth() {
        const destination = await DestinationService.getDestination(FSM_DESTINATION);
        const token       = await TokenCache.getToken(destination);
        return { dest: destination.destinationConfiguration, token };
    }

    _accountParams(dest) {
        return {
            account: dest.account || this.config.account,
            company: dest.company || this.config.company
        };
    }

    _headers(dest, token) {
        return {
            'Content-Type':     'application/json',
            'Authorization':    `Bearer ${token}`,
            'X-Account-ID':     dest['URL.headers.X-Account-ID'],
            'X-Company-ID':     dest['URL.headers.X-Company-ID'],
            'X-Client-ID':      dest['URL.headers.X-Client-ID'],
            'X-Client-Version': dest['URL.headers.X-Client-Version']
        };
    }
}

module.exports = new FSMService();