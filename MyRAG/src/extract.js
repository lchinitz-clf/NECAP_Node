const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const TurndownService = require('turndown');

// Converts mammoth's HTML output to Markdown — real "#"/"##" headings
// and "-"/"1." list items, driven by Word's own paragraph styles, not
// a heuristic. This is what lets structuredText.js (chunker.js's
// block parser) know for certain where a .docx's sections and lists
// actually are, instead of guessing from plain text the way it has to
// for PDFs — see that module's doc comment for the full contrast.
// headingStyle: 'atx' picks "#"/"##" markers (what structuredText.js's
// MD_HEADING_RE expects) over the alternative "underline" style;
// bulletListMarker: '-' just picks one consistent bullet character
// (turndown's own default) so parseBlocks()'s LIST_ITEM_RE has one
// predictable shape to match rather than several.
const turndownService = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

// Minimum fraction of the document's pages a short, repeated line must
// appear on before it's treated as a running header/footer/watermark
// and stripped — see stripRepeatingHeaderFooterLines()'s own doc
// comment below for the full reasoning. Deliberately very high (not
// just "repeats a few times"): a real running header/footer/watermark
// is stamped on nearly every page by the document's own page
// template, so it should clear a 90% bar easily, while a short line
// that happens to recur in the body text for an unrelated reason would
// have to be deliberately repeated across almost the entire document
// to be mistaken for one.
const HEADER_FOOTER_MIN_PAGE_FRACTION = 0.9;

// A candidate line's word-count ceiling — ordinary sentences and
// paragraphs essentially never land on their own line this short
// (that only happens by coincidence at an exact word-wrap boundary,
// and the 90%-of-pages requirement above rules that out anyway: a
// coincidental wrap doesn't reproduce the SAME words identically on
// nearly every page), while a watermark ("DRAFT") or a running footer
// ("4-90 City of Boston Natural Hazard Mitigation Plan") comfortably
// fits under it.
const HEADER_FOOTER_MAX_WORDS = 12;

// Matches a page-number-shaped token — a run of digits, optionally
// hyphenated/dotted ("4-90", "4.90", "123"), optionally preceded by
// "Page"/"p." — at the very start or end of a candidate line. Only
// used to build the REPEAT-COUNTING KEY below, never to change what
// actually gets deleted from the text: a running footer's only
// per-page variation is usually its own page number ("4-89 City of
// Boston..." on one page, "4-90 City of Boston..." on the next), so
// without normalizing that away first, every single occurrence would
// look like a distinct, never-repeating line and this whole mechanism
// would never catch the single most common footer shape there is.
//
// `\s*` between the hyphen/dot and the second digit group (not `\d+`
// directly) for the same reason responseParser.js's quote matcher
// strips hyphens unconditionally: pdf-parse's own page-number
// extraction routinely inserts a stray space right after the hyphen
// ("4- 90", not "4-90" — the exact same artifact class as "sto- ries"
// documented in resolveCitation()'s hyphen-stripping comment). Without
// tolerating that space here, "4- 90 City of Boston..." and "4- 91
// City of Boston..." would each only have their leading "4" consumed,
// leaving "- 90 city of boston..." / "- 91 city of boston..." behind —
// which still differ from each other and would never be recognized as
// the same recurring footer at all.
const PAGE_NUMBER_TOKEN = '(?:page\\s+|p\\.?\\s*)?\\d+(?:[.\\-\\u2013]\\s*\\d+)?';
const LEADING_PAGE_NUMBER_RE = new RegExp(`^${PAGE_NUMBER_TOKEN}\\s*`, 'i');
const TRAILING_PAGE_NUMBER_RE = new RegExp(`\\s*${PAGE_NUMBER_TOKEN}$`, 'i');

/**
 * Builds the key stripRepeatingHeaderFooterLines() counts occurrences
 * of — the candidate line's own text, lowercased, with one leading
 * and/or trailing page-number-shaped token stripped off (see
 * PAGE_NUMBER_TOKEN above). Two lines whose only difference is the
 * page number embedded in them collapse to the same key; a line with
 * no such token is otherwise unchanged apart from trimming/casing.
 * @param {string} line - already trimmed by the caller.
 * @returns {string}
 */
function headerFooterKey(line) {
  return line
    .replace(LEADING_PAGE_NUMBER_RE, '')
    .replace(TRAILING_PAGE_NUMBER_RE, '')
    .trim()
    .toLowerCase();
}

/**
 * Strips running headers, footers, and watermarks (a page number plus
 * document title repeated at the bottom of every page, a "DRAFT"
 * stamp, etc.) from PDF-extracted text before it ever reaches the
 * chunker — same "clean up pdf-parse's known junk" philosophy as
 * cleanExtractedText()'s table-of-contents dot-leader cleanup just
 * below, for a different failure: pdf-parse has no concept of pages
 * at all (extractPdfText() below gets back one flat string for the
 * whole document), so when a sentence happens to straddle a page
 * break in the source PDF, whatever sits in that page's header/footer
 * gets extracted as if it were ordinary body text, landing mid-
 * sentence. A real, observed example: "...provide important
 * flood-storage, water-quality,\nDRAFT\n4-90 City of Boston Natural
 * Hazard Mitigation Plan\nerosion-control..." — a single, genuinely
 * contiguous sentence in the source document, with a watermark and a
 * page footer physically injected into the middle of it by extraction
 * alone. That broke verbatim quote matching the same way a few other
 * PDF-extraction artifacts already fixed elsewhere in this app did
 * (see resolveCitation() in responseParser.js for the whitespace/
 * hyphen/"[Context: ...]" fixes) — but unlike those, THIS fix belongs
 * here, at extraction time, rather than in the quote matcher: a page
 * header's actual text ("City of Boston Natural Hazard Mitigation
 * Plan") is specific to this one document, with no fixed, safely-
 * recognizable shape the way this app's own synthesized
 * "[Context: ...]" marker has — so there's no way to safely strip it
 * from inside a shared, cross-document quote-matching function.
 * Removing it here instead, before it ever becomes part of a chunk,
 * fixes it for retrieval and on-screen chunk display too, not just
 * quote verification.
 *
 * The heuristic: a line qualifies ONLY if it's short (see
 * HEADER_FOOTER_MAX_WORDS) AND its key (see headerFooterKey() above)
 * recurs on at least HEADER_FOOTER_MIN_PAGE_FRACTION of the document's
 * pages. Every matching line is deleted outright — not replaced with
 * a placeholder — these lines carry no content worth keeping, the
 * same judgment call cleanExtractedText() already makes for
 * dot-leaders. Accepted false-positive risk, same category as the
 * whitespace-/hyphen-blind matching accepted in responseParser.js: a
 * short line that's genuinely part of the body text, repeated often
 * enough by coincidence to clear the 90% bar, would also get removed.
 * Judged acceptable given how high that bar is.
 *
 * Only ever reached from extractPdfText() below, with a real
 * `numPages` from pdf-parse — this is deliberately a no-op (`text`
 * returned unchanged) whenever `numPages` isn't a positive number,
 * which also means it's automatically skipped for the .docx/.txt
 * extractors further down this file: neither has a meaningful "page"
 * concept (see extractDocxText()'s own doc comment) or this failure
 * mode to begin with, so neither needs this threading through its own
 * signature at all.
 *
 * @param {string} text - raw pdf-parse output, BEFORE any whitespace
 *   collapsing — this needs pdf-parse's own one-line-per-visual-line
 *   structure intact (see structuredText.js's module comment) to tell
 *   candidate lines apart, so this runs first, ahead of
 *   cleanExtractedText()'s own dot-leader/whitespace cleanup.
 * @param {number|null} numPages - from pdf-parse's own page count.
 * @returns {string}
 */
function stripRepeatingHeaderFooterLines(text, numPages) {
  if (!numPages || numPages < 1) return text;

  const lines = text.split('\n');
  const counts = new Map(); // header/footer key -> occurrence count

  const isCandidate = (trimmed) => {
    if (!trimmed) return false;
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    return words > 0 && words <= HEADER_FOOTER_MAX_WORDS;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!isCandidate(line)) continue;
    const key = headerFooterKey(line);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  // A floor of 3 regardless of the 90% fraction: for a 1- or 2-page
  // document, 90% rounds down to a number a line can't possibly repeat
  // across in the first place (nothing to repeat against), so this
  // mechanism naturally never fires for documents that short — exactly
  // the right outcome, since "running header/footer" isn't a
  // meaningful concept for a document with barely any pages to run
  // across.
  const threshold = Math.max(3, Math.ceil(numPages * HEADER_FOOTER_MIN_PAGE_FRACTION));
  const keysToStrip = new Set();
  for (const [key, count] of counts) {
    if (count >= threshold) keysToStrip.add(key);
  }
  if (keysToStrip.size === 0) return text;

  return lines
    .filter((rawLine) => {
      const line = rawLine.trim();
      if (!isCandidate(line)) return true; // never a candidate -- always kept
      return !keysToStrip.has(headerFooterKey(line));
    })
    .join('\n');
}

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
  // Runs BEFORE cleanExtractedText() -- see
  // stripRepeatingHeaderFooterLines()'s own doc comment above for why
  // it needs pdf-parse's original one-line-per-visual-line structure
  // intact.
  const withoutHeaderFooter = stripRepeatingHeaderFooterLines(data.text, data.numpages);
  return { text: cleanExtractedText(withoutHeaderFooter), numPages: data.numpages };
}

/**
 * Reads a .docx (Word, OOXML format — NOT the old binary .doc) from
 * disk and returns its extracted, cleaned text — as Markdown, not
 * plain text, so headings and lists survive as real structure rather
 * than being flattened away. This used to call mammoth's
 * extractRawText(), which discards Word's paragraph styles entirely
 * (a "Heading 2" and a body paragraph came out looking identical).
 * Going through convertToHtml() instead, then converting THAT to
 * Markdown with turndown, keeps those styles as genuine "#"/"##"
 * headings and "-"/"1." list items — which is what lets chunker.js
 * pack whole sections/list items together and prepend the right
 * section heading to a chunk that starts mid-list, instead of cutting
 * blindly by word count with no idea a list (or its heading) was ever
 * there. See structuredText.js's module comment for the fuller
 * picture, including why PDFs (no comparable structure to recover)
 * don't get this same treatment.
 *
 * There's no equivalent of a PDF "page" in a .docx file — Word only
 * knows about pages once it lays the document out for a specific
 * paper size and font, which isn't something we do here — so
 * numPages is always null for this type, same convention as the "no
 * page count available" case everywhere else in this app (the
 * documents list already shows "—" for that).
 * @param {string} filePath
 * @returns {Promise<{text: string, numPages: null}>}
 */
async function extractDocxText(filePath) {
  const result = await mammoth.convertToHtml({ path: filePath });
  const markdown = turndownService.turndown(result.value);
  return { text: cleanExtractedText(markdown), numPages: null };
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
  stripRepeatingHeaderFooterLines,
  SUPPORTED_EXTENSIONS,
};
