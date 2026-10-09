/**
 * TokenCache.js
 *
 * Backend service for FSM OAuth token management.
 * Caches access tokens to minimize authentication requests.
 *
 * Key Features:
 * - Cache OAuth tokens for reuse
 * - Automatic token refresh before expiry (5 minute buffer)
 * - Concurrent requests that find the token expired share ONE refresh
 *   (no burst of token requests against FSM's rate-limited endpoint)
 * - Handle rate limiting errors gracefully
 *
 * Token Flow:
 * 1. Check if cached token is still valid
 * 2. If expired or missing, fetch new token from FSM (or join a fetch in progress)
 * 3. Cache token with expiry timestamp
 *
 * Rate Limiting:
 * FSM may return 'too_many_requests' error if token requests are excessive.
 * Service throws descriptive error with retry-after time.
 *
 * Note: one cache slot — correct while FSM_OAUTH_CONNECT is the only OAuth
 * destination using it. Key it by destination name before adding a second one.
 *
 * @file TokenCache.js
 * @module utils/TokenCache
 * @requires axios
 */
const axios = require('axios');

class TokenCache {
    constructor() {
        /**
         * Cached OAuth access token.
         * @type {string|null}
         * @private
         */
        this.cachedToken = null;

        /**
         * Token expiry timestamp in milliseconds.
         * @type {number|null}
         * @private
         */
        this.tokenExpiry = null;

        /**
         * Token request currently in progress, shared by concurrent callers.
         * @type {Promise<string>|null}
         * @private
         */
        this._inFlight = null;
    }

    /**
     * Get FSM OAuth token (cached).
     * Returns cached token if still valid, otherwise fetches new one.
     * @param {Object} destination - Destination configuration from BTP
     * @returns {Promise<string>} Access token
     */
    async getToken(destination) {
        // Return cached token if still valid (with 5 minute buffer)
        if (this.cachedToken && this.tokenExpiry && Date.now() < this.tokenExpiry - 300000) {
            return this.cachedToken;
        }

        // Join a refresh already in progress instead of starting another.
        if (this._inFlight) {
            return this._inFlight;
        }

        this._inFlight = this._fetchNewToken(destination)
            .finally(() => { this._inFlight = null; });
        return this._inFlight;
    }

    /**
     * Fetch new FSM OAuth token.
     * @param {Object} destination - Destination configuration from BTP
     * @returns {Promise<string>} Access token
     * @throws {Error} If authentication fails or rate limited
     * @private
     */
    async _fetchNewToken(destination) {
        try {
            const config = destination.destinationConfiguration;
            const tokenServiceUrl = config.tokenServiceURL;
            const clientId = config.clientId;
            const clientSecret = config.clientSecret;

            if (!clientId || !clientSecret) {
                throw new Error('Client credentials not found in destination configuration');
            }

            const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            const authHeader = `Basic ${credentials}`;

            const response = await axios.post(
                tokenServiceUrl,
                'grant_type=client_credentials',
                {
                    headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            this.cachedToken = response.data.access_token;
            const expiresIn = response.data.expires_in || 3600;
            this.tokenExpiry = Date.now() + (expiresIn * 1000);

            return this.cachedToken;

        } catch (error) {
            if (error.response?.data?.error === 'too_many_requests') {
                const retryAfter = error.response.headers['retry-after'] || 900;
                throw new Error(`Rate limited. Retry after ${Math.ceil(retryAfter / 60)} minutes.`);
            }
            throw error;
        }
    }
}

module.exports = new TokenCache();
