/**
 * DestinationService.js
 *
 * SAP BTP Destination Service integration.
 * Fetches destination configuration from BTP.
 *
 * Caching: a destination is static configuration (it changes only when a BTP
 * administrator edits it), but resolving it costs two outbound HTTPS calls
 * (BTP OAuth token + destination lookup). Every FSM and SecSign call needs one,
 * so resolved destinations are cached per destination name for
 * DESTINATION_CACHE_TTL_MS. Concurrent callers share one in-flight lookup.
 * A failed lookup is never cached.
 *
 * Consequence: a change to a destination in the BTP cockpit (e.g. a rotated
 * SecSign password) is picked up within DESTINATION_CACHE_TTL_MS, or
 * immediately after an app restart.
 *
 * Methods:
 *   getDestination(name)   – returns full destination config (cached)
 *   getConnectivityProxy() – connectivity proxy details (currently unused)
 *
 * @file utils/fsm/DestinationService.js
 * @requires axios
 */
const axios = require('axios');

const DESTINATION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

class DestinationService {

    constructor() {
        /** Map<destinationName, { promise: Promise<Object>, expiresAt: number }> */
        this._cache = new Map();
    }

    /**
     * Get Destination Service credentials from VCAP_SERVICES.
     * @returns {Object}
     */
    getCredentials() {
        const vcapServices      = JSON.parse(process.env.VCAP_SERVICES || '{}');
        const destinationService = vcapServices.destination?.[0];

        if (!destinationService) {
            throw new Error('Destination service not bound to application');
        }

        return destinationService.credentials;
    }

    /**
     * Get destination configuration from BTP (cached per name).
     * Returns destinationConfiguration + authTokens if available.
     * Callers must treat the returned object as read-only — it is shared.
     *
     * @param {string} destinationName
     * @returns {Promise<Object>}
     */
    async getDestination(destinationName) {
        const hit = this._cache.get(destinationName);
        if (hit && Date.now() < hit.expiresAt) {
            return hit.promise;
        }

        const promise = this._fetchDestination(destinationName);
        this._cache.set(destinationName, { promise, expiresAt: Date.now() + DESTINATION_CACHE_TTL_MS });

        // Never keep a failure: the next call retries.
        promise.catch(() => {
            if (this._cache.get(destinationName)?.promise === promise) {
                this._cache.delete(destinationName);
            }
        });

        return promise;
    }

    /**
     * Get the connectivity proxy details for making calls THROUGH BTP to
     * internet destinations. Returns the proxy host/port from VCAP_SERVICES
     * connectivity binding so axios can route via SAP's outbound proxy.
     *
     * @returns {{ proxyHost: string, proxyPort: number, proxyToken: string } | null}
     */
    async getConnectivityProxy() {
        try {
            const vcapServices = JSON.parse(process.env.VCAP_SERVICES || '{}');
            const connectivity = vcapServices.connectivity?.[0];

            if (!connectivity) {
                console.warn('[DestinationService] No connectivity service bound – direct axios call will be used');
                return null;
            }

            const creds = connectivity.credentials;

            // Get proxy token from connectivity service
            const tokenResponse = await axios.post(
                creds.token_service_uri + '/oauth/token',
                new URLSearchParams({
                    grant_type:    'client_credentials',
                    client_id:     creds.clientid,
                    client_secret: creds.clientsecret
                }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );

            console.log(`[DestinationService] Connectivity proxy token obtained`);

            return {
                proxyHost:  creds['onpremise_proxy_host'],
                proxyPort:  parseInt(creds['onpremise_proxy_port'], 10),
                proxyToken: tokenResponse.data.access_token
            };

        } catch (error) {
            console.warn('[DestinationService] Connectivity proxy unavailable:', error.message);
            return null;
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────

    /** Uncached lookup: BTP token + destination configuration. */
    async _fetchDestination(destinationName) {
        try {
            const { accessToken, credentials } = await this._getBtpToken();

            const destinationResponse = await axios.get(
                `${credentials.uri}/destination-configuration/v1/destinations/${destinationName}`,
                { headers: { 'Authorization': `Bearer ${accessToken}` } }
            );

            console.log(`[DestinationService] Loaded: ${destinationName} (cached for ${DESTINATION_CACHE_TTL_MS / 60000} min)`);
            return destinationResponse.data;

        } catch (error) {
            console.error(`[DestinationService] Error loading ${destinationName}:`, error.response?.data || error.message);
            throw new Error(`Failed to load destination: ${destinationName}`);
        }
    }

    async _getBtpToken() {
        const credentials = this.getCredentials();

        const tokenResponse = await axios.post(
            credentials.url + '/oauth/token',
            new URLSearchParams({
                grant_type:    'client_credentials',
                client_id:     credentials.clientid,
                client_secret: credentials.clientsecret
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        return { accessToken: tokenResponse.data.access_token, credentials };
    }
}

module.exports = new DestinationService();
