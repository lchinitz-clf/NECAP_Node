/**
 * Splits text into overlapping chunks — structure-aware, not a blind
 * word-count sliding window.
 *
 * History worth knowing: the original version of this function was
 * exactly that sliding window, with a comment acknowledging it "would
 * be nice to improve later (e.g. splitting on paragraph breaks first,
 * then packing paragraphs into chunks up to maxWords)." That gap
 * turned out to be a real, observed problem, not a hypothetical one:
 * a numbered/lettered list item ("c. Identify geographically isolated
 * communities due to limited ingress/egress resulting from coastal
 * and inland flooding events...") landed in its own chunk with zero
 * visibility into which list — or which list's own heading — it was
 * item c of, purely because a maxWords boundary happened to fall
 * between the heading and the list. A chat model reading that chunk
 * in isolation had no way to know what it was looking at.
 *
 * This version fixes that with two changes, both built on
 * structuredText.js's parseBlocks():
 *
 *   1. Chunks are packed from whole BLOCKS (headings, list items,
 *      paragraphs), never cut mid-block unless a single block alone
 *      exceeds the size limit (same maxWords/maxChars backstop as
 *      before, just applied per-block instead of globally). A chunk
 *      boundary can now only fall BETWEEN two blocks, never through
 *      the middle of a sentence or list item.
 *   2. Every chunk that doesn't itself open with a heading gets a
 *      synthesized "[Context: ...]" line prepended, built from
 *      whichever heading(s) are in effect at that point in the
 *      document (see headingStack below). A chunk starting mid-list,
 *      like the "c. Identify..." example above, now always carries
 *      something like "[Context: Task 3: Prioritizing Resiliency
 *      Actions]" ahead of it — so the model knows what section it's
 *      reading even when the chunk boundary landed somewhere awkward.
 *
 * What this does NOT fix: heading/list-item DETECTION itself is only
 * reliable for text that went through extractDocxText()'s real
 * Markdown conversion (see extract.js and structuredText.js's module
 * comment); for PDF/.txt sources it's a heuristic over plain lines of
 * text, since pdf-parse throws away real layout information before
 * this code ever sees it. A heuristic can miss a real heading or
 * misfire on an ordinary short sentence — see
 * structuredText.js's looksLikeHeuristicHeading() for exactly what it
 * looks for. This is a deliberate, documented tradeoff: a genuinely
 * layout-aware PDF parser (Unstructured.io, Docling) would do better,
 * but both are Python libraries, and this app is intentionally
 * Node-only — see the README's "Retrieval" section for that
 * discussion.
 *
 * Default size (300 words, ~40 overlap, 1800-char ceiling) is
 * unchanged from before, for the same reason as before: Ollama's
 * embedding endpoint has a hard, non-overridable 512-token context
 * limit for nomic-embed-text (see ollamaClient.js), and this leaves
 * comfortable headroom even for dense technical text.
 *
 * IMPORTANT CAVEAT this ran into in practice, also unchanged: "words"
 * just means "things separated by whitespace." Most real prose
 * averages ~5-6 characters per word, which is where the "300 words ~=
 * 450 tokens" estimate comes from — but some text (long unbroken
 * identifiers, URLs, glued-together table cells) can produce
 * individual whitespace-split "words" that are 50-100+ characters
 * long. extract.js strips the worst offender (table-of-contents dot-
 * leaders) at the source; maxChars below is the backstop that doesn't
 * depend on that cleanup catching everything.
 *
 * @param {string} text - Extracted text (either real Markdown from
 *   extractDocxText(), or plain text from a PDF/.txt source).
 * @param {object} opts
 * @param {number} opts.maxWords - Target chunk size, in words.
 * @param {number} opts.overlapWords - Roughly how many trailing words
 *   of one chunk get repeated at the start of the next — carried
 *   forward as whole blocks (never a mid-block fragment), so this is
 *   an approximate target, not an exact word count.
 * @param {number} opts.maxChars - Hard character-length ceiling per
 *   chunk (see the caveat above) — whichever limit (maxWords or
 *   maxChars) is hit first ends the chunk.
 * @returns {string[]} Array of chunk strings.
 */
const { parseBlocks } = require('./structuredText');

function wordCount(str) {
  return str ? str.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * The old word-count sliding window, kept as a backstop for the one
 * case block-packing can't avoid: a SINGLE block (one paragraph, or
 * one list item) whose own text already exceeds maxWords/maxChars on
 * its own. Rare — most paragraphs and list items are nowhere near 300
 * words — but not impossible, and this guarantees forward progress
 * either way, same guarantee the original all-word-count version made
 * for every chunk.
 * @param {string} text
 * @param {number} maxWords
 * @param {number} maxChars
 * @returns {string[]}
 */
function wordSplit(text, maxWords, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const pieces = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let charCount = 0;
    while (end < words.length && end - start < maxWords) {
      const nextLen = words[end].length + (end > start ? 1 : 0);
      if (end > start && charCount + nextLen > maxChars) break;
      charCount += nextLen;
      end++;
    }
    if (end === start) end = start + 1; // guarantee forward progress
    pieces.push(words.slice(start, end).join(' '));
    start = end;
  }
  return pieces;
}

/**
 * Formats the headings currently "in effect" (headingStack, indexed
 * by level - 1, sparse) into one human-readable trail, e.g.
 * "Chapter 4: Resiliency Planning > Task 3: Prioritizing Actions" for
 * real nested Markdown headings, or just "Task 3: Prioritizing
 * Actions" for the flat, single-level headings PDF/.txt heuristic
 * detection produces (see structuredText.js).
 * @param {Array<string|undefined>} stack
 * @returns {string}
 */
function formatHeadingPath(stack) {
  return stack.filter(Boolean).join(' > ');
}

// A fixed cushion (characters) reserved out of the overlap budget
// below for a possible synthesized "[Context: ...]" line — a
// generous over-estimate of how long one normally runs, so reserving
// this much up front means a context line added after the overlap
// carry-forward can never itself push a chunk past maxChars.
const CONTEXT_LINE_RESERVE_CHARS = 120;

function chunkText(text, { maxWords = 300, overlapWords = 40, maxChars = 1800 } = {}) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return [];

  const chunks = [];
  let currentBlocks = []; // { type, text } pieces actually going into the chunk being built
  let currentWords = 0;
  let currentChars = 0;
  const headingStack = []; // index = level - 1; set by every heading seen so far, cleared below it

  const closeChunk = () => {
    if (currentBlocks.length === 0) return;
    chunks.push(currentBlocks.map((b) => b.text).join('\n\n'));
  };

  // Carries forward whole trailing blocks from the chunk just closed
  // into the start of the next one, up to ~overlapWords — the block-
  // level equivalent of the original word-based overlap, so content
  // straddling a chunk boundary still shows up on both sides, without
  // ever re-splitting a block to do it.
  //
  // budgetWords/budgetChars cap how much can be carried, leaving room
  // for the piece that's about to be added right after this returns
  // (see the call site below). This matters specifically for the
  // oversized-single-block fallback: wordSplit() deliberately fills
  // each of its pieces up to just under maxChars, so a "normal"
  // ~overlapWords carry-forward — sized without knowing anything about
  // the next piece — could leave a chunk with almost no room left once
  // that next (already-near-the-ceiling) piece gets added, blowing
  // well past maxChars. Bounding the carry by what's actually left
  // after reserving space for the incoming piece prevents that; for
  // ordinary small blocks (the common case) this budget is rarely
  // tight enough to matter, so overlap still behaves as before.
  const overlapBlocks = (budgetWords, budgetChars) => {
    const carried = [];
    let words = 0;
    let chars = 0;
    for (let i = currentBlocks.length - 1; i >= 0 && words < overlapWords; i--) {
      const b = currentBlocks[i];
      const bWords = wordCount(b.text);
      const bChars = b.text.length;
      if (words + bWords > budgetWords || chars + 2 + bChars > budgetChars) break;
      carried.unshift(b);
      words += bWords;
      chars += bChars + 2;
    }
    return carried;
  };

  // Prepends a synthesized "[Context: ...]" line to the chunk being
  // opened, UNLESS: there's nothing on headingStack yet (document
  // hasn't reached a heading at all — nothing to prepend), or the
  // chunk already CONTAINS its own governing heading — either because
  // it's about to open with one (handled by the two call sites below
  // never calling this for a heading piece), or because overlap
  // carried the heading itself forward from the previous chunk.
  //
  // Checking "does currentBlocks contain a heading block" specifically
  // — not just "is currentBlocks non-empty" — matters: overlap only
  // carries forward whatever fits in ~overlapWords, which is often
  // just the last paragraph or list item before the cut, NOT the
  // section heading itself (that could be many blocks further back).
  // An earlier version of this function treated any carried-over
  // content as "context already covered," which meant a chunk two or
  // three hops past a heading — with each hop's overlap carrying only
  // ordinary body text forward, never the heading — silently lost its
  // section context entirely. Checking for an actual heading block
  // fixes that: every chunk that doesn't itself carry the heading
  // forward gets its own "[Context: ...]" line, however many chunks
  // away from the real heading it's drifted.
  const addContextLineIfNeeded = () => {
    if (currentBlocks.some((b) => b.type === 'heading')) return;
    const path = formatHeadingPath(headingStack);
    if (!path) return;
    const contextLine = `[Context: ${path}]`;
    currentBlocks.push({ type: 'context', text: contextLine });
    currentWords += wordCount(contextLine);
    currentChars += contextLine.length;
  };

  for (const block of blocks) {
    if (block.type === 'heading') {
      headingStack[block.level - 1] = block.text;
      headingStack.length = block.level; // drop any deeper levels below this heading
    }

    const blockWords = wordCount(block.text);
    const blockChars = block.text.length;

    // A single block bigger than the whole per-chunk budget still
    // needs the old word-level fallback — split IT alone, and treat
    // each resulting piece as its own unit for packing below, so one
    // oversized paragraph can never block forward progress or blow
    // past the size ceiling by itself.
    const pieces =
      blockWords > maxWords || blockChars > maxChars
        ? wordSplit(block.text, maxWords, maxChars).map((t) => ({ type: block.type, text: t }))
        : [block];

    for (const piece of pieces) {
      const pieceWords = wordCount(piece.text);
      const pieceChars = piece.text.length;

      const wouldOverflow =
        currentBlocks.length > 0 &&
        (currentWords + pieceWords > maxWords || currentChars + 2 + pieceChars > maxChars);

      if (wouldOverflow) {
        closeChunk();
        currentBlocks = overlapBlocks(
          Math.max(maxWords - pieceWords, 0),
          Math.max(maxChars - pieceChars - 2 - CONTEXT_LINE_RESERVE_CHARS, 0)
        );
        currentWords = currentBlocks.reduce((sum, b) => sum + wordCount(b.text), 0);
        currentChars = currentBlocks.reduce((sum, b) => sum + b.text.length, 0);
        if (piece.type !== 'heading') addContextLineIfNeeded();
      } else if (currentBlocks.length === 0 && piece.type !== 'heading') {
        // Only reachable for the very first piece of the very first
        // chunk in the whole document — every later chunk's start is
        // already handled by the branch above.
        addContextLineIfNeeded();
      }

      currentBlocks.push(piece);
      currentWords += pieceWords;
      currentChars += pieceChars + 2; // +2 for the '\n\n' join between blocks
    }
  }
  closeChunk();

  return chunks;
}

module.exports = { chunkText };
