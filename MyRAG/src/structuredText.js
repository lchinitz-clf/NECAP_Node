/**
 * Turns extracted document text into a sequence of structural
 * "blocks" — headings, list items, and paragraphs — instead of a flat
 * blob of characters. This is what lets chunker.js pack whole
 * paragraphs/list items into a chunk rather than cutting blindly by
 * word count, and lets it prepend a chunk's governing heading when a
 * size-based boundary would otherwise orphan a chunk from the section
 * it belongs to. That's not a hypothetical: it's exactly what was
 * observed in practice — a chunk that started at
 * "c. Identify geographically isolated communities due to limited
 * ingress/egress resulting from coastal and inland flooding events
 * ..." with no visibility into which numbered task list that was item
 * c of, because the word-count chunker had no idea a list — let alone
 * that list's own heading — was there at all.
 *
 * Two different kinds of input text reach this parser, and it treats
 * them differently:
 *
 *   - Real Markdown, produced by extractDocxText() in extract.js (via
 *     mammoth's convertToHtml() + turndown) from a .docx's own
 *     paragraph styles. "#"/"##"/etc. headings and "-"/"1."/etc. list
 *     items here are genuine, reliable signals straight from Word's
 *     own document structure — not a guess.
 *
 *   - Plain extracted text from a PDF or .txt file, which has NO
 *     structural markup at all: pdf-parse and a raw .txt read both
 *     just hand back characters, with page layout, font size, and
 *     indentation already gone by the time this module ever sees it.
 *     For this case, heading and list-item detection below are
 *     HEURISTICS over plain lines of text, not a real structural
 *     signal — see looksLikeHeuristicHeading()'s own doc comment for
 *     exactly what it looks for and its known false-positive/false-
 *     negative shapes. This is a genuine, honest limitation: a
 *     heuristic over already-flattened text can't do what a real
 *     layout-aware PDF parser (e.g. Unstructured.io, Docling) does —
 *     it can only approximate it. Both of those are Python libraries;
 *     this app is deliberately Node-only (no Python subprocess/
 *     microservice), so this heuristic approach is the practical
 *     option that stays within that constraint. See the README's
 *     "Retrieval" section for the fuller tradeoff discussion.
 */

// Bullet, numbered ("1." / "1)"), and lettered ("c." / "c)") list
// markers — the last of these is what a line like "c. Identify
// geographically isolated communities..." matches. A single capital
// letter abbreviation at the start of a standalone line ("A. Smith
// wrote...") can false-positive here, since there's no way to tell
// the two apart from the text alone once it's just a bare line — an
// accepted, documented limitation rather than a bug.
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)]|[a-zA-Z][.)])\s+(.+)$/;

// An explicit Markdown heading — real, not heuristic, when this text
// came from turndown's docx output.
const MD_HEADING_RE = /^(#{1,6})\s+(.+)$/;

// Heuristic signals that a plain-text line (no Markdown markup at
// all — the PDF/.txt case) is a heading rather than an ordinary
// sentence. Deliberately conservative-ish but not perfect. All of
// these require the line to already be its own line (not merely a
// line-wrapped sentence) per the extractor's own newlines — the best
// signal available without real page-layout information — and short
// enough that a real heading is plausible.
const SECTION_WORD_RE = /^(?:section|chapter|task|appendix|part|priority|goal|objective|strategy|action)\s+[0-9ivxlc]+\b/i;
const NUMBERED_HEADING_RE = /^\d+(?:\.\d+)*\.?\s+\S/; // "3.", "4.2", "12.1.3 Title"

/**
 * @param {string} line - already trimmed, already confirmed non-blank
 *   and not a list item.
 * @returns {boolean}
 */
// Matches a line ending in terminal punctuation -- a period, question
// mark, exclamation point, or colon -- allowing a trailing closing
// quote or parenthesis (e.g. "...report)." or "...done.\""). A list
// item whose own text ends in one of these is a grammatically
// complete clause, so whatever comes after it is genuinely NEW
// content, not a continuation of that same sentence.
const TERMINAL_PUNCTUATION_RE = /[.!?:][)'"”’]*$/;

/**
 * Decides whether `line` is the wrapped continuation of the sentence
 * in `precedingText` (the text of the block immediately before it),
 * rather than the start of a new one. This only gets called for a
 * line that didn't itself match a heading or list-item pattern -- see
 * the call site in parseBlocks() below.
 *
 * Two signals, either one sufficient:
 *   1. `line` starts with a lowercase letter. In ordinary English
 *      prose this is a strong, simple tell: a genuinely new sentence
 *      or paragraph is capitalized; a line starting lowercase is
 *      continuing whatever came before it.
 *   2. `precedingText` doesn't end in terminal punctuation at all --
 *      if the preceding block's own sentence isn't even finished,
 *      whatever comes next has to be its continuation, regardless of
 *      how the next line itself starts (e.g. it could open with a
 *      capitalized proper noun mid-sentence).
 *
 * This exists because of a real, observed failure: pdf-parse (see
 * extract.js) preserves the PDF's own visual line breaks as literal
 * "\n" characters in extracted text -- including the completely
 * ordinary case of a long list item simply running past the width of
 * one line on the page and wrapping onto the next, with NO blank line,
 * no page break, nothing marking it as a continuation rather than a
 * new line of content. Before this function existed, a list item like
 * "c. Identify geographically isolated communities due to limited
 * ingress/egress resulting from coastal and inland flooding events
 * using 2050 SLR, storm surge and inland\nflooding predictions." would
 * get split at that "\n" into a `listItem` block ending "...inland"
 * and a completely separate `paragraph` block starting "flooding
 * predictions." -- two blocks that could then land in different
 * chunks, or have a synthesized "[Context: ...]" line inserted between
 * them by chunker.js, breaking the sentence's literal contiguity in
 * the chunk text. That in turn made an accurate, verbatim quote from
 * that sentence impossible to verify against any single chunk, since
 * no chunk actually contained it as one unbroken string anymore.
 *
 * Known false-positive risk, same tradeoff class as
 * looksLikeHeuristicHeading() below: a list item written in a
 * title/fragment style with no ending punctuation (e.g. "Review annual
 * budget" as its own complete item), immediately followed by an
 * unrelated new paragraph with no blank line between them, would get
 * incorrectly merged. This is judged less common in practice than an
 * ordinary sentence-style list item wrapping across a line, and PDF
 * text with no real structural markup can't be parsed with certainty
 * either way -- see this file's module comment.
 * @param {string} line - already trimmed
 * @param {string} precedingText - already trimmed
 * @returns {boolean}
 */
function looksLikeContinuation(line, precedingText) {
  if (/^[a-z]/.test(line)) return true;
  return !TERMINAL_PUNCTUATION_RE.test(precedingText);
}

function looksLikeHeuristicHeading(line) {
  if (line.length > 90) return false; // real headings are short; a 90+ char line is a sentence
  if (/[.,;]$/.test(line)) return false; // headings rarely end mid-sentence like this (a trailing ":" is still fine)

  if (SECTION_WORD_RE.test(line)) return true;
  if (NUMBERED_HEADING_RE.test(line)) return true;

  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) return true; // ALL CAPS, e.g. "EXECUTIVE SUMMARY"

  // Title Case heuristic: among the "significant" words (4+ letters,
  // so short connectors like "of"/"and"/"the" don't count against
  // it), essentially all of them start with a capital letter.
  const words = line.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  const significant = words.filter((w) => w.replace(/[^A-Za-z]/g, '').length >= 4);
  if (significant.length >= 2 && significant.every((w) => /^[A-Z]/.test(w))) return true;

  return false;
}

/**
 * Parses text into an ordered array of blocks:
 *   { type: 'heading', level: 1-6, text }
 *   { type: 'listItem', text }   (text includes its own marker, e.g. "c. Identify...")
 *   { type: 'paragraph', text }
 * Blank lines separate blocks; consecutive non-blank lines that are
 * neither a heading nor a list item are joined (space-separated) into
 * one paragraph block, the same grouping a person reading the raw
 * text would infer. A line that looks like neither, but appears to be
 * the wrapped continuation of the immediately preceding list item's
 * own sentence (see looksLikeContinuation() above), is appended onto
 * that list item's text instead of starting a new paragraph block.
 * @param {string} text
 * @returns {Array<{type: string, level?: number, text: string}>}
 */
function parseBlocks(text) {
  const lines = (text || '').split('\n');
  const blocks = [];
  let paragraphLines = [];

  const flushParagraph = () => {
    if (paragraphLines.length) {
      blocks.push({ type: 'paragraph', text: paragraphLines.join(' ').trim() });
      paragraphLines = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    const mdHeading = line.match(MD_HEADING_RE);
    if (mdHeading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: mdHeading[1].length, text: mdHeading[2].trim() });
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      flushParagraph();
      blocks.push({ type: 'listItem', text: line });
      continue;
    }

    if (looksLikeHeuristicHeading(line)) {
      flushParagraph();
      // Heuristically detected headings (no real "#" markup to say
      // otherwise) are always treated as flat, single-level headings —
      // plain text gives no reliable way to tell a top-level heading
      // from a sub-heading the way real Markdown levels or Word
      // paragraph styles do.
      blocks.push({ type: 'heading', level: 1, text: line });
      continue;
    }

    // Before treating this as the start of a new paragraph, check
    // whether it's actually the wrapped continuation of the list item
    // that immediately precedes it -- see looksLikeContinuation()'s
    // doc comment above for why this check exists and what it's
    // guarding against. Scoped narrowly on purpose: only fires when
    // nothing has been accumulated into paragraphLines yet (i.e. this
    // is the very next line right after that list item, not several
    // lines into an unrelated paragraph) and the immediately preceding
    // block is a listItem at all. Appending onto that block's own
    // `.text` (rather than starting a fresh paragraph block) is what
    // keeps the two physical lines as one unbroken block of text all
    // the way through chunker.js -- a multi-line wrap handles itself
    // naturally this way too, since each further wrapped line finds
    // the same (now longer) listItem block still sitting at the end of
    // `blocks` and paragraphLines still empty.
    const precedingBlock = blocks[blocks.length - 1];
    if (
      paragraphLines.length === 0 &&
      precedingBlock &&
      precedingBlock.type === 'listItem' &&
      looksLikeContinuation(line, precedingBlock.text)
    ) {
      precedingBlock.text += ' ' + line;
      continue;
    }

    paragraphLines.push(line);
  }
  flushParagraph();

  return blocks.filter((b) => b.text);
}

module.exports = { parseBlocks, LIST_ITEM_RE, MD_HEADING_RE, looksLikeHeuristicHeading, looksLikeContinuation };
