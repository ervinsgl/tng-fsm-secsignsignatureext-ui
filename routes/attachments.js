/**
 * routes/attachments.js
 *
 * All attachment-related API routes.
 *
 * Routes (mounted at /api):
 *   GET  /api/attachments/:objectId       ← list attachments for an FSM object
 *   GET  /api/attachment-pdf/:id          ← pipe raw PDF binary (for PDFViewer)
 *   POST /api/attachments/finalize-signed ← confirm completion, then update signed docs
 */
const express            = require('express');
const FSMService         = require('../utils/fsm/FSMService');
const SecSignService     = require('../utils/signing/SecSignService');
const ZipExtractor       = require('../utils/signing/SignedZipExtractor');

const router = express.Router();

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/attachments/:objectId
 * Returns all attachments linked to a given FSM object ID.
 * Response: [{ id, fileName, type, description, signed }]
 */
router.get('/attachments/:objectId', async (req, res) => {
    const { objectId } = req.params;

    if (!objectId) {
        return res.status(400).json({ message: 'objectId is required' });
    }

    try {
        console.log(`[Attachments] GET list | objectId: ${objectId}`);
        const attachments = await FSMService.getAttachmentsForObject(objectId);
        console.log(`[Attachments] Returning ${attachments.length} item(s)`);
        return res.json(attachments);
    } catch (error) {
        console.error(`[Attachments] List error:`, error.message);
        return res.status(500).json({ message: 'Failed to fetch attachments', error: error.message });
    }
});

/**
 * GET /api/attachment-pdf/:attachmentId
 * Pipes raw PDF binary directly to the browser.
 * Used as PDFViewer source – avoids Blob URL iframe security issues.
 */
router.get('/attachment-pdf/:attachmentId', async (req, res) => {
    const { attachmentId } = req.params;

    try {
        console.log(`[Attachments] GET pdf | id: ${attachmentId}`);
        const buffer = await FSMService.getAttachmentBuffer(attachmentId);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline');
        res.send(buffer);
    } catch (error) {
        console.error(`[Attachments] PDF error:`, error.message);
        return res.status(500).json({ message: 'Failed to fetch PDF', error: error.message });
    }
});

/**
 * POST /api/attachments/finalize-signed
 *
 * Called when the signer returns from the SecSign portal. This route is the
 * single source of truth for "was it actually signed?":
 *
 *   1. Poll SecSign until the portfolio reaches the finished state (3).
 *      If it never finishes (user went back / declined) → nothing is changed.
 *   2. Download the signed portfolio (a ZIP for multi-doc; PDF for single).
 *   3. Map every requested document to exactly one signed PDF by name.
 *      If any document cannot be matched unambiguously → nothing is changed
 *      (SIGNED_MAPPING_FAILED). FSM is only written after ALL documents match.
 *   4. For each mapped attachment: overwrite content + set Z_Attachment_PDFSigned.
 *
 * Body:    { portfolioId, documents: [{ attachmentId, fileName }] }
 * Returns: { signed: boolean, signedAttachmentIds: [...], state }
 */
router.post('/attachments/finalize-signed', async (req, res) => {
    const { portfolioId, documents } = req.body;

    if (!portfolioId || !Array.isArray(documents) || documents.length === 0) {
        return res.status(400).json({ message: 'portfolioId and documents[] are required' });
    }

    console.log(`[Attachments] POST finalize-signed | portfolioId: ${portfolioId} | docs: ${documents.length} (${documents.map(d => d.fileName).join(', ')})`);

    try {
        // 1. Confirm the portfolio actually finished before touching anything.
        const { signed, status } = await SecSignService.waitForCompletion(portfolioId);

        if (!signed) {
            console.log(`[Attachments] Portfolio ${portfolioId} not signed (state: ${status?.portfoliostate}) — leaving attachments unchanged`);
            return res.json({
                signed:              false,
                signedAttachmentIds: [],
                state:               status?.portfoliostate ?? null
            });
        }

        // 2. Download the signed portfolio.
        const { buffer, contentType } = await SecSignService.downloadSigned(portfolioId);

        // 3. Extract + map. Throws SIGNED_MAPPING_FAILED before any FSM write
        //    if a single document cannot be matched unambiguously.
        const signedPdfs = ZipExtractor.extractSignedPdfs(buffer, contentType);
        const mapped     = ZipExtractor.mapToAttachments(signedPdfs, documents);
        console.log(`[Attachments] Extracted ${signedPdfs.length} PDF(s), mapped ${mapped.length}/${documents.length} to attachments`);

        // 4. Update each attachment content + mark signed via UDF.
        const signedAttachmentIds = [];
        for (const m of mapped) {
            await FSMService.updateAttachmentContent(m.attachmentId, m.buffer);
            await FSMService.markAttachmentSigned(m.attachmentId);
            signedAttachmentIds.push(m.attachmentId);
            console.log(`[Attachments] Attachment signed + marked | id: ${m.attachmentId} | file: ${m.fileName}`);
        }

        return res.json({
            signed:              true,
            signedAttachmentIds,
            state:               status?.portfoliostate ?? null
        });

    } catch (error) {
        if (error.code === ZipExtractor.MAPPING_FAILED) {
            // Signature exists on SecSign, but we could not tell which signed PDF
            // belongs to which attachment. Nothing was written to FSM.
            console.error(`[Attachments] finalize-signed MAPPING FAILED | portfolioId: ${portfolioId} | ${error.message}` +
                ` | missing: [${(error.missing || []).join(', ')}]` +
                ` | ambiguous: [${(error.ambiguous || []).join(', ')}]` +
                ` | available: [${(error.available || []).join(', ')}]` +
                ` | no attachments were changed`);
            return res.status(500).json({
                errorCode: ZipExtractor.MAPPING_FAILED,
                message:   'The signed documents could not be matched to the attachments. No attachments were changed.'
            });
        }

        console.error(`[Attachments] finalize-signed failed:`, error.message);
        return res.status(500).json({ message: 'Failed to finalize signed documents', error: error.message });
    }
});

module.exports = router;
