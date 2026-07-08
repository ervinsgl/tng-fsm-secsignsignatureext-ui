/**
 * SigningService.js
 *
 * Frontend service for document signing operations.
 * Calls the backend signing route which forwards to SecSign.
 *
 * @file webapp/utils/services/SigningService.js
 * @module com/tns/fsm/secsignsignatureext/app/utils/services/SigningService
 */
sap.ui.define([], () => {
    "use strict";

    return {

        /**
         * Trigger the signing workflow for one or more attachments.
         * Backend fetches each PDF binary from FSM and starts a single SecSign
         * workflow containing all documents (signer signs them all in one pass).
         *
         * @param {Array}  documents   - [{ id, fileName }] attachments to sign
         * @param {Object} context     - FSM context { cloudId, authToken }
         * @param {string} signerEmail - Signer email resolved from the FSM User API
         * @returns {Promise<Object>} { success, workflowstepurl, portfolioid, documents }
         */
        triggerSigning(documents, context, signerEmail) {
            const payload = {
                documents:   documents.map(d => ({ attachmentId: d.id, fileName: d.fileName })),
                signerEmail: signerEmail,
                authToken:   context.authToken,
                // Full current URL (including ?session=) so the portal redirects back correctly
                returnUrl:   window.location.href
            };

            console.log("[SigningService] Triggering signing | docs:", payload.documents.length, "| signer:", payload.signerEmail);

            return fetch("/api/signing/trigger", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify(payload)
            })
            .then(response => {
                console.log("[SigningService] Response status:", response.status);
                if (!response.ok) {
                    return response.json().then(err => {
                        throw new Error(err.message || `HTTP ${response.status}`);
                    });
                }
                return response.json();
            })
            .then(result => {
                console.log("[SigningService] Success | portfolioid:", result.portfolioid);
                return result;
            })
            .catch(error => {
                console.error("[SigningService] Error:", error.message);
                throw error;
            });
        }
    };
});