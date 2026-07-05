/**
 * SignedZipExtractor.js
 *
 * A SecSign portfolio download is a ZIP that contains the signed PDFs plus
 * a signature protocol and audit report. This helper extracts only the signed
 * PDFs and maps each back to its document name so callers can match them to
 * the originating FSM attachment.
 *
 * @file utils/signing/SignedZipExtractor.js
 * @requires adm-zip
 */
const AdmZip = require('adm-zip');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const PDF_MAGIC = Buffer.from('%PDF');

/**
 * True when the downloaded buffer is a ZIP archive.
 */
function isZip(buffer, contentType = '') {
    if (/zip/i.test(contentType)) return true;
    return buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC);
}

/**
 * True when the buffer is a raw PDF (single-document portfolio edge case).
 */
function isPdf(buffer, contentType = '') {
    if (/pdf/i.test(contentType)) return true;
    return buffer.length >= 4 && buffer.subarray(0, 4).equals(PDF_MAGIC);
}

/**
 * Extract signed PDFs from a portfolio download.
 *
 * @param {Buffer} buffer      - the raw download (zip or, rarely, a single pdf)
 * @param {string} contentType - response content-type, used as a hint
 * @returns {Array<{ fileName: string, buffer: Buffer }>} signed PDFs only
 */
function extractSignedPdfs(buffer, contentType = '') {
    // Rare single-doc case: server returned the PDF directly.
    if (!isZip(buffer, contentType) && isPdf(buffer, contentType)) {
        return [{ fileName: null, buffer }];
    }

    const zip     = new AdmZip(buffer);
    const entries = zip.getEntries();
    const pdfs    = [];

    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const name = entry.entryName;

        // Only keep PDFs; skip protocol/audit files that are not the signed docs.
        // The signed documents are PDFs; protocol/report files are typically PDFs
        // too, so we additionally exclude by conventional naming.
        if (!/\.pdf$/i.test(name)) continue;
        if (/protocol|protokoll|audit|report/i.test(name)) continue;

        // Flatten any folder prefix to the base file name for matching.
        const baseName = name.split('/').pop();
        pdfs.push({ fileName: baseName, buffer: entry.getData() });
    }

    return pdfs;
}

/**
 * Match extracted signed PDFs back to the requested documents by file name.
 * Falls back to positional matching when names don't line up (or single doc).
 *
 * @param {Array} signedPdfs   - [{ fileName, buffer }]
 * @param {Array} requestedDocs- [{ attachmentId, fileName }]
 * @returns {Array<{ attachmentId, fileName, buffer }>}
 */
function mapToAttachments(signedPdfs, requestedDocs) {
    // Single doc on both sides: trivial 1:1.
    if (requestedDocs.length === 1 && signedPdfs.length >= 1) {
        return [{
            attachmentId: requestedDocs[0].attachmentId,
            fileName:     requestedDocs[0].fileName,
            buffer:       signedPdfs[0].buffer
        }];
    }

    const byName = new Map(signedPdfs.map(p => [p.fileName, p.buffer]));
    const mapped = [];

    requestedDocs.forEach((doc, idx) => {
        let buf = byName.get(doc.fileName);
        if (!buf && signedPdfs[idx]) buf = signedPdfs[idx].buffer; // positional fallback
        if (buf) {
            mapped.push({ attachmentId: doc.attachmentId, fileName: doc.fileName, buffer: buf });
        } else {
            console.warn(`[SignedZipExtractor] No signed PDF matched for ${doc.fileName} (${doc.attachmentId})`);
        }
    });

    return mapped;
}

module.exports = { isZip, isPdf, extractSignedPdfs, mapToAttachments };