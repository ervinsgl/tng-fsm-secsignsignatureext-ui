/**
 * routes/signing.js
 *
 * Signing workflow routes. Signing goes directly to SecSign.
 *
 * Routes:
 *   POST /api/signing/trigger  ← called when user presses "Sign PDF" / "Sign Selected"
 */
const express        = require('express');
const FSMService     = require('../utils/fsm/FSMService');
const SecSignService = require('../utils/signing/SecSignService');

const router = express.Router();

/**
 * POST /api/signing/trigger
 *
 * 1. Fetches the PDF binary for each requested attachment from FSM
 * 2. Starts ONE SecSign workflow containing all documents (single step, N sigpos)
 * 3. Returns workflowstepurl for browser navigation to the signing portal
 *
 * Body: { documents: [{ attachmentId, fileName }], signerEmail, returnUrl }
 * (A single-document sign is just a one-element documents array.)
 */
router.post('/trigger', async (req, res) => {
    const { documents, signerEmail, returnUrl } = req.body;

    if (!Array.isArray(documents) || documents.length === 0) {
        return res.status(400).json({ success: false, message: 'documents[] is required' });
    }
    if (!returnUrl) {
        return res.status(400).json({ success: false, message: 'returnUrl is required' });
    }
    if (!signerEmail) {
        return res.status(400).json({ success: false, message: 'signerEmail is required' });
    }

    console.log(`[Signing] POST trigger | docs: ${documents.length} | signer: ${signerEmail}`);

    try {
        // Fetch every PDF binary from FSM in parallel.
        const withBuffers = await Promise.all(
            documents.map(async doc => ({
                attachmentId: doc.attachmentId,
                fileName:     doc.fileName,
                buffer:       await FSMService.getAttachmentBuffer(doc.attachmentId)
            }))
        );

        const result = await SecSignService.triggerSigning({
            documents: withBuffers.map(d => ({ buffer: d.buffer, fileName: d.fileName })),
            signerEmail,
            returnUrl
        });

        const workflowstepurl = result?.workflowstepurl;
        const portfolioid     = result?.portfolioid;

        if (!workflowstepurl) {
            console.error(`[Signing] No workflowstepurl in response:`, JSON.stringify(result));
            return res.status(500).json({ success: false, message: 'No workflowstepurl returned by SecSign' });
        }

        console.log(`[Signing] Trigger OK | portfolioid: ${portfolioid} | url: ${workflowstepurl}`);

        return res.json({
            success:         true,
            workflowstepurl: workflowstepurl,
            portfolioid:     portfolioid || null,
            // Echo the documents so the client can persist the batch for the return trip.
            documents:       documents.map(d => ({ attachmentId: d.attachmentId, fileName: d.fileName })),
            data:            result
        });

    } catch (error) {
        console.error(`[Signing] Trigger failed:`, error.message);

        if (error.code === 'SIGNER_NOT_REGISTERED') {
            return res.status(422).json({
                success:    false,
                errorCode:  'SIGNER_NOT_REGISTERED',
                signerName: error.signerName,
                message:    error.message
            });
        }

        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;