const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

/**
 * Cleans up raw extracted text before it ever reaches the chunker.
 *
 * PDF text extraction is dumb about layout: it doesn't know what's a
 * sentence versus a table-of-contents dot-leader versus a table cell.
 * The specific problem this fixes: lines like
 *   "Executive Summary .......................................... xi"
 * extract as text containing a run of 100+ periods with NO whitespace
 * in it, which our whitespace-based chunker then treats as a single
 * "word" — one word by count, but well over 100 characters of actual
 * content. That silently breaks the "300 words ~= safely under 512
 * tokens" assumption for any chunk that happens to contain one (the
 * table of contents is the worst offender, but appendices/indexes can
 * have the same pattern), which is exactly what was causing Ollama's
 * "input length exceeds the context length" error even after the
 * chunk size was reduced.
 *
 * These dot-leaders also carry zero semantic value for retrieval — a
 * chunk full of "..........." doesn't help answer any question — so
 * stripping them is a pure win, not just a workaround. Applied to
 * every file type here, not just PDFs — harmless no-op on text that
 * never had this pattern to begin with (plain .txt, most .docx).
 *
 * @param {string} text
 * @returns {string}
 */
function cleanExtractedText(text) {
  return text
    // Runs of 4+ periods (with optional spaces between them, since some
    // PDFs render leaders as ". . . . ." rather than "....."), collapse
    // to a single space.
    .replace(/(?:\.[ \t]?){4,}/g, ' ')
    // Collapse any run of whitespace (including the spaces just
    // introduced above) down to a single space, but preserve paragraph
    // breaks (double newlines) since those are useful structure.
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/**
 * Reads a PDF from disk and returns its extracted, cleaned plain text.
 * @param {string} filePath - Absolute or relative path to a .pdf file.
 * @returns {Promise<{text: string, numPages: number}>}
 */
async function extractPdfText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  return { text: cleanExtractedText(data.text), numPages: data.numpages };
}

/**
 * Reads a .docx (Word, OOXML format — NOT the old binary .doc) from
 * disk and returns its extracted, cleaned plain text. There's no
 * equivalent of a PDF "page" in a .docx file — Word only knows about
 * pages once it lays the document out for a specific paper size and
 * font, which isn't something we do here — so numPages is always null
 * for this type, same convention as the "no page count available" case
 * everywhere else in this app (the documents list already shows "—"
 * for that).
 * @param {string} filePath
 * @returns {Promise<{text: string, numPages: null}>}
 */
async function extractDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return { text: cleanExtractedText(result.value), numPages: null };
}

/**
 * Reads a plain .txt file from disk. Assumes UTF-8 (the overwhelmingly
 * common case); a file saved in some other encoding may extract with
 * garbled characters, which isn't specifically detected or handled.
 * @param {string} filePath
 * @returns {Promise<{text: string, numPages: null}>}
 */
async function extractTxtText(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return { text: cleanExtractedText(raw), numPages: null };
}

const EXTRACTORS = {
  '.pdf': extractPdfText,
  '.docx': extractDocxText,
  '.txt': extractTxtText,
};

const SUPPORTED_EXTENSIONS = Object.keys(EXTRACTORS);

/**
 * Extracts text from a document, picking the right extractor by file
 * extension. This is what /ingest, /embed, and the upload route all
 * actually call — extractPdfText/extractDocxText/extractTxtText are
 * exported individually too, mostly so each can be tested or reused on
 * its own, but extractText is the one entry point that knows about all
 * supported types.
 * @param {string} filePath
 * @returns {Promise<{text: string, numPages: number|null}>}
 */
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const extractor = EXTRACTORS[ext];
  if (!extractor) {
    throw new Error(`Unsupported file type "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
  return extractor(filePath);
}

module.exports = {
  extractText,
  extractPdfText,
  extractDocxText,
  extractTxtText,
  cleanExtractedText,
  SUPPORTED_EXTENSIONS,
};
