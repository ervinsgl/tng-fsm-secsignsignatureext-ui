/**
 * AttachmentService.js
 *
 * All attachment data operations for the signing app:
 *   - Load attachment list for an FSM object
 *   - Enrich each attachment with PDF content (preview + full base64)
 *   - Get the backend URL for serving a single PDF (for PDFViewer)
 *   - Merge multiple PDFs via the backend and return a viewer URL
 *
 * @file webapp/utils/services/AttachmentService.js
 * @module com/tng/fsm/secsignsignatureext/app/utils/services/AttachmentService
 */
sap.ui.define([], () => {
    "use strict";

    return {

        /**
         * Load all attachments for an FSM object and enrich each with PDF content.
         * @param {string} objectId - FSM cloudId from context
         * @returns {Promise<Array>} Enriched attachment objects:
         *   { id, fileName, type, description, content, contentFull, contentType, signed }
         */
        async loadAttachments(objectId) {
            console.log("[AttachmentService] Loading attachments | objectId:", objectId);

            const response = await fetch(`/api/attachments/${encodeURIComponent(objectId)}`);
            if (!response.ok) throw new Error(`Attachments fetch failed: HTTP ${response.status}`);

            const attachments = await response.json();
            console.log("[AttachmentService] Received:", attachments.length, "attachment(s)");

            const enriched = await Promise.all(
                attachments.map(att => this._fetchContent(att))
            );

            console.log("[AttachmentService] Enriched:", enriched.length, "attachment(s)");
            return enriched;
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
         */
        async finalizeSigned(portfolioId, documents) {
            console.log("[AttachmentService] finalizeSigned | portfolioId:", portfolioId, "| docs:", documents.length);

            const response = await fetch("/api/attachments/finalize-signed", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ portfolioId, documents })
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
                throw new Error(err.message || `Finalize failed: HTTP ${response.status}`);
            }

            const result = await response.json();
            console.log("[AttachmentService] finalizeSigned result | signed:", result.signed,
                "| count:", result.signedAttachmentIds?.length);
            return result;
        },

        // ── Private ───────────────────────────────────────────────────────

        /**
         * Fetch PDF binary content for a single attachment.
         * Returns the attachment extended with content fields.
         * Never throws — returns safe fallback values on error.
         * @private
         */
        async _fetchContent(attachment) {
            try {
                const response = await fetch(`/api/attachment-content/${encodeURIComponent(attachment.id)}`);

                if (!response.ok) {
                    console.warn(`[AttachmentService] Content fetch failed for ${attachment.id}: HTTP ${response.status}`);
                    return { ...attachment, content: "N/A", contentFull: null, contentType: "application/pdf" };
                }

                const result  = await response.json();
                const preview = result.base64 ? result.base64.substring(0, 60) + "..." : "N/A";

                console.log(`[AttachmentService] Content fetched | id: ${attachment.id} | size: ${result.base64?.length} chars`);

                return {
                    ...attachment,
                    content:     preview,
                    contentFull: result.base64,
                    contentType: result.contentType || "application/pdf"
                    // signed + description preserved from attachment (set by FSMService)
                };

            } catch (error) {
                console.error(`[AttachmentService] Content error for ${attachment.id}:`, error.message);
                return { ...attachment, content: "Error", contentFull: null, contentType: "application/pdf" };
            }
        }
    };
});