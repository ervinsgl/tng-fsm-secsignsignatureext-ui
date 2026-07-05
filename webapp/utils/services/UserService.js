/**
 * UserService.js
 *
 * Frontend service for FSM user lookups.
 * Resolves profile details (email, first/last name) for a given user name.
 *
 * @file webapp/utils/services/UserService.js
 * @module com/tng/fsm/secsignsignatureext/app/utils/services/UserService
 */
sap.ui.define([], () => {
    "use strict";

    return {

        /**
         * Fetch an FSM user's profile by login name.
         * @param {string} name - user login name (e.g. "EGLEIZDS")
         * @returns {Promise<Object|null>} { name, email, firstName, lastName, active, roles } or null
         */
        async getUserByName(name) {
            if (!name) return null;

            console.log("[UserService] Fetching user | name:", name);

            const response = await fetch(`/api/user/${encodeURIComponent(name)}`);

            if (response.status === 404) {
                console.warn("[UserService] User not found:", name);
                return null;
            }
            if (!response.ok) {
                const err = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
                throw new Error(err.message || `User lookup failed: HTTP ${response.status}`);
            }

            const user = await response.json();
            console.log("[UserService] User resolved | email:", user.email);
            return user;
        }
    };
});