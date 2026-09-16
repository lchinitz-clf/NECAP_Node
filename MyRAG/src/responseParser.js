/**
 * Best-effort parsing of a chat model's ideal-proposal comparison
 * answer into structured per-attribute records: { name, proposal,
 * resultText, category }. This is what feeds both the on-screen
 * per-attribute results table and the CSV export in the browser UI.
 *
 * IMPORTANT CAVEAT — read before trusting this for anything important:
 * nothing forces a local chat model to actually follow the
 * "<name>: <category> — <reason>" format asked for in
 * compareInstruction (see idealProposals.js / idealProposals.json).
 * Smaller/weaker models in particular have, in real use with this
 * app, sometimes echoed the instruction back, looped, or blended the
 * rubric text into their answer instead of following the format
 * cleanly. This parser is a heuristic on top of that unreliable
 * output, not a guarantee: a batch whose answer isn't one clean list
 * item per attribute (see splitIntoListItems() below — the primary
 * splitting strategy) AND whose attribute names the model didn't
 * repeat recognizably (splitByAttributeNames() — the fallback) can
 * still come back with an empty/inaccurate category. The raw answer
 * text is always shown on screen too (and included in each batch's
 * "batch-done" event) specifically so a low-confidence parse is never
 * the only place the actual answer lives — always spot-check the
 * per-attribute table against the raw text for anything you're about
 * to act on. Batching into smaller calls (see batchAttributes() in
 * idealProposals.js) makes this parser meaningfully more reliable,
 * since a 1-attribute batch has nothing else in its answer to
 * misattribute.
 */

// Checked longest/most-specific phrase first so e.g. "not addressed"
// isn't missed in favor of a shorter, later-listed word, and so a
// plural or minor variant ("matched", "exceeded") still counts.
const CATEGORY_PATTERNS = [
  { label: 'Not addressed', re: /not\s+(?:be\s+)?addressed/i },
  { label: 'Falls short', re: /falls?\s+short/i },
  { label: 'Exceeds', re: /exceeds?|exceeded/i },
  { label: 'Matches', re: /matche?s|matched/i },
];

/**
 * Finds an attribute name inside `text`, tolerating a common real-world
 * mismatch: a combined name built by joining several spreadsheet
 * columns with " - " (see excel_to_json.py's JOIN_SEPARATOR) is
 * frequently NOT echoed back with that exact separator — a model
 * asked to discuss "IF1 - Vulnerability and Risk Assessment -
 * Definitions" has, in practice, written "IF1: Vulnerability and Risk
 * Assessment - Definitions" instead (colon in place of just the FIRST
 * " - "). A plain case-insensitive substring search would miss that
 * entirely. This instead builds a regex from the name that accepts a
 * colon, dash, en dash, or em dash (with optional surrounding
 * whitespace) anywhere the stored name has " - ", while still
 * matching every other character literally.
 *
 * @param {string} haystack
 * @param {string} needle
 * @param {number} fromIndex
 * @returns {{index: number, length: number}|null}
 */
function findNameFlexible(haystack, needle, fromIndex) {
  if (!needle) return null;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/ - /g, '\\s*[:\\-–—]\\s*');
  const re = new RegExp(pattern, 'ig');
  re.lastIndex = fromIndex;
  const m = re.exec(haystack);
  return m ? { index: m.index, length: m[0].length } : null;
}

/**
 * Splits one batch's raw answer text into one chunk per list item.
 * Tried BEFORE name-based splitting (below) because it doesn't depend
 * on the model repeating an attribute's exact stored name at all,
 * which in practice it often doesn't — especially for a long or
 * combined name (e.g. "IF1 - Vulnerability and Risk Assessment -
 * Definitions" from a spreadsheet import), which real models tend to
 * paraphrase, abbreviate, or render with a different separator than
 * the one actually stored (a colon instead of the original " - ",
 * say — very common in practice).
 *
 * Recognizes three "item start" styles, in this priority order, and
 * uses whichever one is actually present:
 *   1. A literal bullet or number: "- ", "* ", "• ", "1.", "2)".
 *   2. A short label followed by a colon or dash near the start of
 *      the line — "IF1: ...", "Funding plan - ...", "1) Foo: ..." —
 *      the single most common way a local model marks "here's the
 *      next attribute" when it isn't using a real bullet character.
 *      Capped at 80 characters so an ordinary sentence that happens
 *      to contain a colon much later isn't mistaken for a label.
 *   3. Neither of the above shows up anywhere: every non-blank line
 *      is treated as its own item (one attribute per line, no
 *      markers at all).
 * Whichever style is detected, any text before the first recognized
 * item-start (a preamble sentence like "Here is my comparison:") is
 * discarded rather than counted as an item of its own, so it doesn't
 * throw off the count callers compare against attributes.length.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoListItems(text) {
  const lines = text.split(/\r?\n/);
  const bulletRe = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const labelLineRe = /^\s*[^\n:\-–—]{1,80}?\s*[:\-–—]\s/;

  let startRe = null;
  if (lines.some((l) => bulletRe.test(l))) {
    startRe = bulletRe;
  } else if (lines.some((l) => labelLineRe.test(l))) {
    startRe = labelLineRe;
  }

  const items = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (startRe) {
      if (startRe.test(line)) {
        if (current !== null) items.push(current.trim());
        current = line;
      } else if (current !== null) {
        current += '\n' + line; // continuation of the current item
      }
      // else: text before the first recognized item start — discarded as preamble
    } else {
      // No recognizable item-start marker anywhere — assume one attribute per line.
      items.push(line.trim());
    }
  }
  if (startRe && current !== null) items.push(current.trim());
  return items;
}

/**
 * Splits one batch's raw answer text into a segment per attribute, by
 * finding where (if anywhere) each attribute's name is first
 * mentioned and slicing the text between consecutive mentions. This
 * only works as well as the model's own tendency to repeat each
 * attribute's name before discussing it — see the module-level
 * caveat above. An attribute whose name isn't found anywhere in the
 * text gets `null` back, which callers treat as "could not
 * automatically separate this attribute's portion of the answer."
 * Used as a fallback when splitIntoListItems() above doesn't produce
 * exactly one item per attribute.
 *
 * @param {string} text
 * @param {Array<{name: string}>} attributes
 * @returns {Array<string|null>} parallel to `attributes`
 */
function splitByAttributeNames(text, attributes) {
  const found = []; // { attrIndex, start }
  let searchFrom = 0;
  for (let i = 0; i < attributes.length; i++) {
    const name = attributes[i].name;
    const match = findNameFlexible(text, name, searchFrom);
    if (match) {
      found.push({ attrIndex: i, start: match.index });
      searchFrom = match.index + match.length;
    }
  }

  const segments = new Array(attributes.length).fill(null);
  const byStart = [...found].sort((a, b) => a.start - b.start);
  for (let j = 0; j < byStart.length; j++) {
    const { attrIndex, start } = byStart[j];
    const end = j + 1 < byStart.length ? byStart[j + 1].start : text.length;
    segments[attrIndex] = text.slice(start, end).trim();
  }

  // A batch of exactly one attribute has nothing else the answer could
  // possibly be about, so even if the model never repeated the
  // attribute's name verbatim, the whole answer is still safely that
  // attribute's segment. This is the case batching down to 1 makes
  // most reliable, per the module-level caveat.
  if (attributes.length === 1 && segments[0] === null) {
    segments[0] = text.trim();
  }

  return segments;
}

/**
 * Pulls the category word and the reasoning text out of one
 * attribute's segment. Strips a leading repeat of the attribute's own
 * name (and any bullet/dash marker in front of it) first, so neither
 * leaks into `resultText`.
 *
 * @param {string|null} segment
 * @param {string} attributeName
 * @returns {{category: string, resultText: string}} `category` is one
 *   of "Exceeds"/"Matches"/"Falls short"/"Not addressed", or '' if no
 *   category word could be found at all (treat as unparsed, not as a
 *   real answer of "no category").
 */
function extractCategoryAndResult(segment, attributeName) {
  if (!segment) return { category: '', resultText: '' };

  let text = segment.replace(/^[\s\-*•]+/, '').replace(/^\d+[.)]\s*/, '');
  const nameMatch = findNameFlexible(text, attributeName, 0);
  if (nameMatch && nameMatch.index === 0) {
    text = text.slice(nameMatch.length);
  }
  text = text.replace(/^[\s:\-–—]+/, '');

  let best = null;
  for (const { label, re } of CATEGORY_PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) {
      best = { label, index: m.index, matchedText: m[0] };
    }
  }

  // A multi-attribute batch's segment is sliced right up to (but not
  // including) the next attribute's name — see splitByAttributeNames()
  // above — which leaves that next entry's own leading bullet marker
  // ("\n- ", "\n* ", etc.) dangling on the end of THIS segment. Stripped
  // here rather than at slice time, since it only ever shows up at the
  // very end and is otherwise indistinguishable from a bullet marker
  // that's actually part of this segment's own text.
  const stripTrailingBulletArtifact = (s) => s.replace(/[\s\-*•]+$/, '').trim();

  if (!best) {
    return { category: '', resultText: stripTrailingBulletArtifact(text) };
  }

  // Whether to treat the category word as a clean "Category: reason"
  // or "Category — reason" LABEL — safe to cut everything up to and
  // including it, since whatever came before (an attribute name, a
  // bullet marker, however long) is just a repeated label, not
  // reasoning — is decided by what comes right AFTER it, not by how
  // much text came before it: a colon or dash immediately following
  // (allowing whitespace) is the actual signal of a label, regardless
  // of the label's own length. Without that separator, the category
  // word is most likely being used as an ordinary verb inside a
  // free-form sentence ("the plan exceeds expectations because...");
  // cutting there would silently discard reasoning that came before
  // it, which is worse than the mild redundancy of leaving the
  // category word inside resultText too.
  const afterRaw = text.slice(best.index + best.matchedText.length);
  const looksLikeLabel = /^\s*[:\-–—]/.test(afterRaw);

  let resultText;
  if (looksLikeLabel) {
    const afterCategory = stripTrailingBulletArtifact(afterRaw.replace(/^[\s:\-–—]+/, ''));
    // Falls back to the whole segment on the rare chance the category
    // word was the very last thing in the segment, so resultText is
    // never left empty just because there was nothing after it.
    resultText = afterCategory || stripTrailingBulletArtifact(text);
  } else {
    resultText = stripTrailingBulletArtifact(text);
  }

  return { category: best.label, resultText };
}

/**
 * Parses one batch's chat answer into a structured record per
 * attribute in that batch — the input to both the on-screen
 * per-attribute table and the CSV export in the browser UI. Always
 * returns exactly one record per attribute passed in, in the same
 * order. `category` comes back empty ('') when parsing that
 * attribute's portion of the text failed — see the module-level
 * caveat — but `resultText` is never left blank in that case: it
 * falls back to this batch's ENTIRE raw answer text, so an unparsed
 * row still carries the real answer for someone to read (in the
 * on-screen table and in the CSV's "LLM result" column) instead of a
 * silent gap. An empty `category` is what marks a row as this
 * fallback rather than a normal one-attribute answer.
 *
 * @param {string} answerText - the chat model's raw answer for this batch
 * @param {Array<{name: string, proposal: string}>} attributes - the
 *   attributes that were actually asked about in this batch (i.e. one
 *   element of batchAttributes()'s return value)
 * @returns {Array<{name: string, proposal: string, resultText: string, category: string}>}
 */
function parseComparisonAnswer(answerText, attributes) {
  const text = answerText || '';
  let segments;

  // Preferred strategy: one list item per attribute, in the same
  // order they were asked about — this is the common shape for a
  // model following compareInstruction's "note each attribute"
  // request, and unlike name-matching below, doesn't depend on the
  // model repeating any attribute's exact stored name. Only trusted
  // when the item count lines up exactly with the attribute count;
  // otherwise there's no reliable way to know which item is which.
  const listItems = attributes.length > 1 ? splitIntoListItems(text) : [];
  if (listItems.length === attributes.length) {
    segments = listItems;
  } else {
    segments = splitByAttributeNames(text, attributes);
    if (attributes.length === 1 && segments[0] === null) {
      segments[0] = text.trim();
    }
  }

  return attributes.map((attr, i) => {
    let { category, resultText } = extractCategoryAndResult(segments[i], attr.name);
    if (!category && !resultText.trim()) {
      // Nothing could be isolated or categorized for this attribute at
      // all (segments[i] was null and there was no whole-text fallback
      // to fall back to) — rather than leave the row blank, hand over
      // the complete batch answer so the row is still useful, just
      // clearly unparsed.
      resultText = text.trim();
    }
    return {
      name: attr.name,
      proposal: attr.proposal,
      resultText,
      category,
    };
  });
}

module.exports = { parseComparisonAnswer };
