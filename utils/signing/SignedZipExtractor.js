/**
 * SignedZipExtractor.js
 *
 * A SecSign portfolio download is a ZIP that contains the signed PDFs plus
 * a signature protocol / audit report. This helper extracts the PDFs and maps
 * each requested document back to exactly one signed PDF by file name.
 *
 * Matching rules (all-or-nothing):
 *   - Only entries whose name matches a REQUESTED document are used. Anything
 *     else in the archive (protocol, audit report, …) is ignored by definition,
 *     whatever it is called. No name-based exclusion list.
 *   - Every requested document must match exactly one entry. If any document
 *     has no match, or more than one, a SIGNED_MAPPING_FAILED error is thrown
 *     and the caller must not write anything to FSM.
 *   - No positional fallback: bytes are never assigned by guesswork.
 *   - Name comparison ignores folder prefix, letter case and Unicode
 *     normalisation form (NFC), so "Prüfbericht.pdf" matches regardless of
 *     how the archive encodes the umlaut.
 *   - SecSign's portfolio download replaces "unsafe" file name characters
 *     with "_" by default (SignaturePortal REST API, "Download all PDF
 *     documents in a workflow"): / # % & { } \ < > * ? $ ! ' " : + ` | = @
 *     and the space character. The same replacement is applied to both the
 *     requested name and the archive name before comparing, so
 *     "Prüfbericht 4711.pdf" matches "Prüfbericht_4711.pdf". It is harmless
 *     if SecSign does not replace: both sides are normalised the same way.
 *   - SecSign appends "-signed" to each signed document in the ZIP
 *     ("TEST_1.pdf" → "TEST_1-signed.pdf", observed on portfolio 4621).
 *     The suffix is removed from both sides before comparing. If the ZIP
 *     ever holds both "X.pdf" and "X-signed.pdf", the "-signed" one is used.
 *
 * Single-PDF edge case: if SecSign returns a raw PDF instead of a ZIP and
 * exactly one document was requested, that PDF is the document.
 *
 * @file utils/signing/SignedZipExtractor.js
 * @requires adm-zip
 */
const AdmZip = require('adm-zip');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const PDF_MAGIC = Buffer.from('%PDF');

const MAPPING_FAILED = 'SIGNED_MAPPING_FAILED';

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
 * Characters SecSign replaces with "_" in download file names by default
 * (incl. space). Same list as the SignaturePortal REST API documentation.
 */
const SECSIGN_UNSAFE_CHARS = /[\/#%&{}\\<>*?$!'":+`|=@ ]/g;

/**
 * Canonical form of a file name for matching:
 * Unicode NFC, SecSign-unsafe characters → "_", lower case.
 * Callers pass base names (extractSignedPdfs strips folder prefixes).
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
    return String(name || '')
        .normalize('NFC')
        .replace(SECSIGN_UNSAFE_CHARS, '_')
        .toLowerCase()
        .replace(SIGNED_SUFFIX, '$1');
}

/** "-signed" before the extension, as SecSign names signed documents. */
const SIGNED_SUFFIX = /(?:-signed)+(\.[^.]*)?$/;

/** True when an archive entry carries SecSign's "-signed" suffix. */
function hasSignedSuffix(fileName) {
    return SIGNED_SUFFIX.test(String(fileName || '').toLowerCase());
}

/**
 * Find requested file names that collide after normalisation.
 * Two documents with the same name cannot be told apart in a portfolio
 * (SecSign references documents by name), so they must not be signed together.
 *
 * @param {Array<{ fileName: string }>} documents
 * @returns {string[]} the colliding names (original spelling, one per collision); empty if none
 */
function findDuplicateNames(documents) {
    const seen = new Map();
    const dups = new Set();
    for (const doc of documents) {
        const n = normalizeName(doc.fileName);
        if (seen.has(n)) dups.add(seen.get(n));
        else seen.set(n, doc.fileName);
    }
    return [...dups];
}

/**
 * Extract all PDFs from a portfolio download.
 * Does NOT decide which PDFs are the signed documents — mapToAttachments
 * does that, against the requested names.
 *
 * @param {Buffer} buffer      - the raw download (zip or, rarely, a single pdf)
 * @param {string} contentType - response content-type, used as a hint
 * @returns {Array<{ fileName: string|null, buffer: Buffer }>} fileName is null for a raw PDF
 */
function extractSignedPdfs(buffer, contentType = '') {
    // Rare single-doc case: server returned the PDF directly.
    if (!isZip(buffer, contentType) && isPdf(buffer, contentType)) {
        console.log('[SignedZipExtractor] Download is a raw PDF (no ZIP)');
        return [{ fileName: null, buffer }];
    }

    const zip     = new AdmZip(buffer);
    const entries = zip.getEntries().filter(e => !e.isDirectory);

    // Log the full archive listing — this is what to look at when a mapping fails.
    console.log(`[SignedZipExtractor] ZIP entries (${entries.length}): ${entries.map(e => e.entryName).join(' | ')}`);

    return entries
        .filter(e => /\.pdf$/i.test(e.entryName))
        .map(e => ({ fileName: e.entryName.split('/').pop(), buffer: e.getData() }));
}

/**
 * Map each requested document to exactly one extracted PDF, by name.
 * Throws SIGNED_MAPPING_FAILED unless every requested document matches
 * exactly one PDF — the caller must then leave FSM untouched.
 *
 * @param {Array} signedPdfs    - [{ fileName, buffer }] from extractSignedPdfs
 * @param {Array} requestedDocs - [{ attachmentId, fileName }]
 * @returns {Array<{ attachmentId, fileName, buffer }>} same length and order as requestedDocs
 * @throws {Error} code = 'SIGNED_MAPPING_FAILED', with .missing, .ambiguous, .available
 */
function mapToAttachments(signedPdfs, requestedDocs) {
    // Raw-PDF case: only valid for a single requested document.
    if (signedPdfs.length === 1 && signedPdfs[0].fileName === null) {
        if (requestedDocs.length === 1) {
            return [{
                attachmentId: requestedDocs[0].attachmentId,
                fileName:     requestedDocs[0].fileName,
                buffer:       signedPdfs[0].buffer
            }];
        }
        throw mappingError(
            `SecSign returned a single PDF but ${requestedDocs.length} documents were requested`,
            requestedDocs.map(d => d.fileName), [], []
        );
    }

    // Index extracted PDFs by normalised name (array, to detect duplicates).
    const index = new Map();
    for (const pdf of signedPdfs) {
        const n = normalizeName(pdf.fileName);
        if (!index.has(n)) index.set(n, []);
        index.get(n).push(pdf);
    }

    const mapped    = [];
    const missing   = [];
    const ambiguous = [];

    for (const doc of requestedDocs) {
        let hits = index.get(normalizeName(doc.fileName)) || [];
        // "X.pdf" and "X-signed.pdf" both present → the signed one is the document.
        if (hits.length > 1) {
            const signedHits = hits.filter(h => hasSignedSuffix(h.fileName));
            if (signedHits.length === 1) hits = signedHits;
        }
        if (hits.length === 0)      missing.push(doc.fileName);
        else if (hits.length > 1)   ambiguous.push(doc.fileName);
        else mapped.push({ attachmentId: doc.attachmentId, fileName: doc.fileName, buffer: hits[0].buffer });
    }

    if (missing.length > 0 || ambiguous.length > 0) {
        throw mappingError(
            'Signed documents could not be matched to the requested attachments',
            missing, ambiguous, signedPdfs.map(p => p.fileName)
        );
    }

    console.log(`[SignedZipExtractor] Mapped ${mapped.length}/${requestedDocs.length} document(s) by name`);
    return mapped;
}

function mappingError(message, missing, ambiguous, available) {
    const e = new Error(message);
    e.code      = MAPPING_FAILED;
    e.missing   = missing;
    e.ambiguous = ambiguous;
    e.available = available;
    return e;
}

module.exports = {
    isZip,
    isPdf,
    normalizeName,
    findDuplicateNames,
    extractSignedPdfs,
    mapToAttachments,
    MAPPING_FAILED
};