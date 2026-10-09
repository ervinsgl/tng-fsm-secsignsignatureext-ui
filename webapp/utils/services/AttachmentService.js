/**
 * AttachmentService.js
 *
 * All attachment data operations for the signing app:
 *   - Load the attachment list for an FSM object (metadata + signed status only)
 *   - Get the backend URL for serving a single PDF (for PDFViewer)
 *   - Finalize a signing batch after the SecSign portal returns
 *
 * PDF content is NOT downloaded for the list. A document is fetched only when
 * the technician opens it in the viewer (getPdfUrl) or signs it (backend).
 *
 * @file webapp/utils/services/AttachmentService.js
 * @module com/tns/fsm/secsignsignatureext/app/utils/services/AttachmentService
 */
sap.ui.define([], () => {
    "use strict";

    return {

        /**
         * Load all attachments for an FSM object.
         * @param {string} objectId - FSM cloudId from context
         * @returns {Promise<Array>} [{ id, fileName, type, description, signed }]
         * @throws {Error} with error.status = HTTP status (401 = session expired),
         *   or error.status = 0 when the request got no response at all
         */
        async loadAttachments(objectId) {
            console.log("[AttachmentService] Loading attachments | objectId:", objectId);

            let response;
            try {
                response = await fetch(`/api/attachments/${encodeURIComponent(objectId)}`);
            } catch (networkError) {
                const e = new Error(`Attachments fetch failed: ${networkError.message}`);
                e.status = 0;
                throw e;
            }

            if (!response.ok) {
                const e = new Error(`Attachments fetch failed: HTTP ${response.status}`);
                e.status = response.status;
                throw e;
            }

            const attachments = await response.json();
            console.log("[AttachmentService] Received:", attachments.length, "attachment(s)");
            return attachments;
        },

        /**
         * Returns the backend URL to stream a single PDF directly.
         * Use this as the PDFViewer source — plain HTTP, no blob URLs.
         * @param {string} attachmentId
         * @returns {string} e.g. "/api/attachment-pdf/<id>"
         */
        getPdfUrl(attachmentId) {
            return `/api/attachment-pdf/${encodeURIComponent(attachmentId)}`;
        },

        /**
         * Finalize signing after returning from the SecSign portal.
         * The backend confirms the portfolio actually finished before it
         * downloads, updates and marks any attachment as signed.
         *
         * @param {string} portfolioId - from the trigger response
         * @param {Array}  documents   - [{ attachmentId, fileName }] the signed batch
         * @returns {Promise<{ signed: boolean, signedAttachmentIds: string[], state: number }>}
         * @throws {Error} On failure. If the session expired (HTTP 401), the
         *   thrown error carries `error.sessionExpired === true` so the caller
         *   can prompt the technician to re-open from FSM Mobile rather than
         *   showing a generic failure.
         */
        async finalizeSigned(portfolioId, documents) {
            console.log("[AttachmentService] finalizeSigned | portfolioId:", portfolioId, "| docs:", documents.length);

            const response = await fetch("/api/attachments/finalize-signed", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ portfolioId, documents })
            });

            if (!response.ok) {
                // Session expired while the technician was on the SecSign portal
                // (e.g. server restart wiped the in-memory session). The signature
                // itself already succeeded on SecSign — only the FSM write-back is
                // blocked. Surface this distinctly so the UI can guide re-launch.
                if (response.status === 401) {
                    const expiredErr = new Error("Session expired during signing");
                    expiredErr.sessionExpired = true;
                    throw expiredErr;
                }

                const err = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
                throw new Error(err.message || `Finalize failed: HTTP ${response.status}`);
            }

            const result = await response.json();
            console.log("[AttachmentService] finalizeSigned result | signed:", result.signed,
                "| count:", result.signedAttachmentIds?.length);
            return result;
        }
    };
});
