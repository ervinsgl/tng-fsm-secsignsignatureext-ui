/**
 * SigningService.js
 *
 * Frontend service for document signing operations.
 * Calls the backend signing route which forwards to SAP CI or SecSign.
 *
 * @file webapp/utils/services/SigningService.js
 * @module com/tng/fsm/secsignsignatureext/app/utils/services/SigningService
 */
sap.ui.define([], () => {
    "use strict";

    return {

        /**
         * Trigger the signing workflow for an attachment.
         * Backend fetches the PDF binary from FSM and forwards to the configured target.
         *
         * @param {Object} attachment       - Attachment row from model { id, fileName }
         * @param {Object} context          - FSM context { cloudId, userName, authToken }
         * @returns {Promise<Object>}       - { success, workflowstepurl, portfolioid, data }
         */
        triggerSigning(attachment, context) {
            const payload = {
                attachmentId: attachment.id,
                fileName:     attachment.fileName,
                objectId:     context.cloudId,
                userName:     context.userName,
                authToken:    context.authToken,
                // Full current URL (including ?session=) so the portal redirects back correctly
                returnUrl:    window.location.href
            };

            console.log("[SigningService] Triggering signing new | payload:", payload);

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
                console.log("[SigningService] Success | result:", result);
                return result;
            })
            .catch(error => {
                console.error("[SigningService] Error:", error.message);
                throw error;
            });
        }
    };
});