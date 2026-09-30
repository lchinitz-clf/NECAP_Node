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
 *
 * A second, separate best-effort layer sits on top of the above: when
 * compareInstruction asks for a quote + citation
 * (`Quote: "..." [file, chunk N]`, or a model's own inline variant —
 * see extractQuotesAndCitations() below), each one found in an
 * already-isolated attribute's text is pulled out and resolveCitation()
 * looks up the REAL [file, chunk] it came from by searching for the
 * quote's actual text among this batch's retrieved chunks — never by
 * trusting whatever citation the model itself wrote next to it. Two
 * real failure modes made that trust unworkable: a small model
 * inventing a non-integer "chunk 6b" that doesn't exist, and a model
 * citing this app's own "PROPOSAL START"/"PROPOSAL END" prompt markers
 * as though they were a file name (both observed in practice — see
 * extractQuotesAndCitations()'s and resolveCitation()'s doc comments).
 * Searching by the quote's own content sidesteps both: whatever the
 * model calls its source, the displayed citation can only ever be a
 * chunk that genuinely contains the quoted words, or "not found" if it
 * doesn't appear anywhere.
 *
 * An attribute's answer isn't limited to a single quote — a "give a
 * detailed answer, then a verdict" instruction (see
 * HARDCODED_FALLBACK_COMPARE_INSTRUCTION in idealProposals.js)
 * routinely produces several supporting quotes for one attribute, and
 * every one of them is found, independently verified, and spliced back
 * into the displayed text in order (see spliceVerifiedQuotes() below),
 * not just the first. Text after the LAST quote+citation found is
 * still discarded, though, which fixes a related bug where a batch's
 * last attribute picked up unrelated rambling the model tacked on
 * after finishing its real answer (nothing else bounds the end of the
 * last attribute's segment — see splitByAttributeNames() below); that
 * landmark just moves to the last citation now instead of the only
 * one. Same philosophy as the rest of this file throughout: never
 * silently trust unreliable model output when it can instead be
 * checked, corrected from data, or clearly marked as unverified.
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
 * Finds EVERY quote + citation attempt in one attribute's already-
 * isolated text (the output of extractCategoryAndResult() above), in
 * the order they appear — the citations compareInstruction asks for,
 * requested precisely so each one can be mechanically checked against
 * the actual chunk it claims to come from (see resolveCitation()
 * below) rather than just trusted outright.
 *
 * This used to stop at the first match, back when compareInstruction
 * asked for one terse "<category> — <reason>. Quote: ..." line per
 * attribute and nothing more. The current "give a detailed answer,
 * then a verdict" instruction (see HARDCODED_FALLBACK_COMPARE_INSTRUCTION
 * in idealProposals.js) routinely produces several sentences of
 * supporting detail per attribute, each with its own quote — so this
 * now keeps scanning forward and returns all of them, not just the
 * first.
 *
 * Recognizes three shapes per match, same as always:
 *   1. An explicit "Quote: "..." [file, chunk N]" label — the format
 *      compareInstruction actually asks for.
 *   2. No label at all: some models (observed in practice with a 3B
 *      model, not just a 1B one) skip "Quote:" entirely and just
 *      embed the verbatim phrase directly in their reasoning
 *      sentence, immediately followed by a bracketed citation — e.g.
 *      `Exceeds — "Develop a coordination strategy..." [Source: file,
 *      chunk 6b]`. Only treated as a quote+citation when the bracket
 *      immediately follows a quoted span (nothing but light
 *      punctuation/whitespace in between), so an ordinary quoted word
 *      inside a reasoning sentence that ISN'T followed by a citation
 *      is left alone rather than mistaken for one.
 *   3. Neither a label NOR quotation marks: a model has also been
 *      observed writing bare "none" (or "n/a"/"no quote") directly
 *      followed by a citation bracket and nothing else marking it as
 *      a quote placeholder — e.g. `Not addressed — none [Source:
 *      report.pdf, chunk 106]`. This is really the same "I have no
 *      quote to give" case pattern 1 already handles via its `(none|
 *      n/a|no quote)` alternative, just missing both the "Quote:"
 *      label and the quotes a model would normally wrap an actual
 *      quote in. Recognized as its own pattern (not folded into
 *      pattern 1, which requires the literal word "Quote") so this
 *      shows up as a clean, citation-free reason instead of leaving a
 *      dangling "none [...]" fragment sitting in resultText. Like
 *      pattern 2, the bracket must immediately follow (only light
 *      punctuation/whitespace in between), so an incidental "none"
 *      elsewhere in ordinary prose isn't mistaken for this
 *      placeholder.
 *
 * All three patterns are searched across the whole text (not just once
 * each), and where two patterns would match overlapping spans at the
 * same position — e.g. a labeled "Quote: "abc" [file, chunk 1]" also
 * satisfies the label-free inline shape starting a few characters
 * later, right at the quote mark — whichever one starts EARLIEST wins
 * and the later, overlapping one is skipped, same tie-break this
 * function always used, just applied at every position instead of
 * only the first.
 *
 * The claimed file name and chunk token on each match are captured
 * as-is and are NOT trusted as the real citation — see
 * resolveCitation() below, which looks up the true source by searching
 * for the quote's actual text among this batch's retrieved chunks
 * instead. That's because models have been observed citing things that
 * were never real sources at all: a non-integer "chunk 6b" (chunk
 * indices are always plain integers — see embedPipeline.js), or even
 * the prompt's own "PROPOSAL START"/"PROPOSAL END" section markers as
 * though they were a file name. Trusting the model's claimed citation
 * would surface either of those errors straight to the screen looking
 * exactly as authoritative as a real one; searching for the quote's
 * own text instead sidesteps the model's naming mistakes entirely and
 * can only ever point at a chunk that genuinely contains the words
 * quoted.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, quote: string, claimedSourceFile: string|null, claimedChunkIndex: string|null}>}
 *   In text order. `quote` is '' for a "none"-shaped match — see
 *   spliceVerifiedQuotes() below for how callers should treat that
 *   (render nothing for it, but don't lose the surrounding prose).
 *   `claimedChunkIndex` is the raw captured token as a trimmed string
 *   (e.g. "6", or the bogus "6b" or "PROPOSAL START"), kept only as a
 *   tiebreaker in resolveCitation() below — never displayed directly.
 */
function extractQuotesAndCitations(text) {
  // "Quote" is followed by an optional colon, not a required one — a
  // model has been observed writing "Quote none" with no punctuation
  // at all (still unambiguous: only "Quote"/"Quote:" ever precedes the
  // quoted-text-or-none shape this looks for), and requiring the colon
  // would make that whole segment fall through unrecognized instead.
  // All three carry the "g" flag now (they didn't need one when only
  // the first match anywhere ever mattered) so exec() can be called
  // repeatedly to walk every match in the text.
  const labeledRe = /[\s.;:—–-]*Quote\s*:?\s*(?:["“]([^"”]*)["”]|(none|n\/a|no quote))\s*(?:\[\s*(?:Source\s*:\s*)?([^,\]]+?)\s*,\s*chunk\s*([^\]]+?)\s*\])?/gi;
  const inlineRe = /["“]([^"”]+)["”]\s*[.,;:]?\s*(?:\[\s*(?:Source\s*:\s*)?([^,\]]+?)\s*,\s*chunk\s*([^\]]+?)\s*\])/gi;
  const bareNoneRe = /(?:none|n\/a|no quote)\s*[.,;:]?\s*(?:\[\s*(?:Source\s*:\s*)?([^,\]]+?)\s*,\s*chunk\s*([^\]]+?)\s*\])/gi;

  const raw = [];
  for (const { re, kind } of [
    { re: labeledRe, kind: 'labeled' },
    { re: inlineRe, kind: 'inline' },
    { re: bareNoneRe, kind: 'bareNone' },
  ]) {
    let m;
    while ((m = re.exec(text))) {
      raw.push({ m, kind, start: m.index, end: m.index + m[0].length });
      // Defensive only — none of these patterns can match an empty
      // string, so lastIndex always advances on its own, but a stuck
      // lastIndex would otherwise infinite-loop here.
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  raw.sort((a, b) => a.start - b.start);

  const results = [];
  let cursor = 0;
  for (const cand of raw) {
    if (cand.start < cursor) continue; // overlaps a match already kept at an earlier position — skip
    const { m, kind } = cand;
    let quote, claimedSourceFile, claimedChunkIndex;
    if (kind === 'labeled') {
      quote = (m[1] || '').trim();
      claimedSourceFile = m[3] ? m[3].trim() : null;
      claimedChunkIndex = m[4] !== undefined ? m[4].trim() : null;
    } else if (kind === 'inline') {
      quote = (m[1] || '').trim();
      claimedSourceFile = m[2] ? m[2].trim() : null;
      claimedChunkIndex = m[3] !== undefined ? m[3].trim() : null;
    } else {
      // bareNone: never has a quote to capture — "none" itself isn't
      // the quote text, it's the model saying there ISN'T one — so
      // quote stays '' just like the labeled "Quote: none" case does.
      quote = '';
      claimedSourceFile = m[1] ? m[1].trim() : null;
      claimedChunkIndex = m[2] !== undefined ? m[2].trim() : null;
    }
    results.push({ start: cand.start, end: cand.end, quote, claimedSourceFile, claimedChunkIndex });
    cursor = cand.end;
  }
  return results;
}

/**
 * Renders one match from extractQuotesAndCitations() into display
 * text — the verified real citation (never the model's claimed one;
 * see resolveCitation()'s doc comment for why) plus a ✓/⚠ marker.
 * Returns '' for a "none"-shaped match (nothing to show), which
 * spliceVerifiedQuotes() below relies on to know when to skip one.
 * @param {{quote: string, claimedSourceFile: string|null, claimedChunkIndex: string|null}} match
 * @param {Array<{sourceFile: string, chunkIndex: number, text: string}>} [matches]
 * @returns {string}
 */
function renderQuoteMatch(match, matches) {
  if (!match.quote) return '';
  const resolved = resolveCitation(match.quote, matches, match.claimedSourceFile, match.claimedChunkIndex);
  const citation = resolved && resolved.verified ? ` [${resolved.sourceFile}, chunk ${resolved.chunkIndex}]` : '';
  const verifyNote = resolved && resolved.verified ? ' ✓ quote verified'
    : resolved && resolved.verified === false ? ' ⚠ quote NOT found verbatim in any retrieved chunk'
    : '';
  return `"${match.quote}"${citation}${verifyNote}`;
}

/**
 * Splices every quote+citation match found in `text` (via
 * extractQuotesAndCitations() above) back into the display text, each
 * one replaced by its VERIFIED form (renderQuoteMatch()) rather than
 * left exactly as the model wrote it, with the prose around and
 * between them preserved so a multi-quote answer still reads as one
 * continuous piece of reasoning instead of a disconnected list of
 * citations. A "none"-shaped match contributes nothing of its own, but
 * the prose on either side of it is stitched together as if it had
 * never matched at all — a model saying "no quote for this part" for
 * one sentence shouldn't sever the sentences around it.
 *
 * Text after the LAST match is always dropped, same as the original
 * single-quote version — see extractQuotesAndCitations()'s doc comment
 * for why (a batch's last attribute has nothing else bounding the end
 * of its segment, so a model that rambles on after its real, cited
 * answer needs a landmark to cut at; the LAST citation is that
 * landmark now, same as the only citation used to be). If no match had
 * an actual quote at all (every one found was a "none"), the cutoff
 * falls back to right before the FIRST match — the same thing a lone
 * "none" always produced.
 *
 * When no quote-shaped match is found anywhere, `text` is returned
 * completely unchanged (no citation machinery was ever invoked, so
 * nothing here should second-guess the plain prose).
 *
 * @param {string} text
 * @param {Array<{sourceFile: string, chunkIndex: number, text: string}>} [chunkMatches] -
 *   this batch's own retrieved chunks, passed straight through to
 *   resolveCitation() for each quote found.
 * @returns {string}
 */
function spliceVerifiedQuotes(text, chunkMatches) {
  const found = extractQuotesAndCitations(text);
  if (found.length === 0) return text;

  let out = '';
  let pending = '';
  let cursor = 0;
  let renderedAny = false;

  for (const m of found) {
    pending += text.slice(cursor, m.start);
    const rendered = renderQuoteMatch(m, chunkMatches);
    if (rendered) {
      // For a SECOND-or-later quote, `pending` typically starts right
      // after the previous quote's "]" citation bracket, where the
      // model's own sentence-ending punctuation lands (". Additionally,
      // ..."). Stripped here rather than left in, since this function
      // supplies its own ". " separator between quotes right below —
      // without stripping, the two collide into a double "..  Foo"
      // artifact. The very first quote's leading text never has this
      // problem (nothing before it ends mid-citation), so this only
      // needs to apply once `out` is already non-empty.
      const between = (out ? pending.replace(/^[\s.,;:\-–—]+/, '') : pending).trim();
      out += out
        ? (between ? `. ${between} — ${rendered}` : ` — ${rendered}`)
        : (between ? `${between} — ${rendered}` : rendered);
      pending = '';
      renderedAny = true;
    }
    // A "none" match's own span is simply dropped (never added to
    // `pending`); whatever text came before it keeps accumulating in
    // `pending` for whichever real quote comes next.
    cursor = m.end;
  }

  if (!renderedAny) {
    // Every match found was a "none" placeholder — nothing to show but
    // citation attempts for quotes that don't exist, all discarded;
    // keep only what came before the first one, same as a lone "none"
    // always produced.
    return text.slice(0, found[0].start).trim();
  }

  return out;
}

// Matches an ellipsis a model used to shorten a quote — "...", a
// spaced-out ". . .", the single Unicode "…" character, or any of
// those wrapped in brackets ("[...]"). The bracketed alternatives are
// tried FIRST in the alternation so a bracket is consumed as part of
// the same match as the dots inside it — otherwise splitting on just
// the inner "..." would leave stray "[" / "]" characters stuck onto
// the pieces on either side.
const ELLIPSIS_RE = /\[\s*(?:\.\s*){3,}\s*\]|\[\s*…\s*\]|(?:\.\s*){3,}|…/g;

/**
 * Splits a quote on any ellipsis it contains into the pieces on
 * either side, trimmed, with empty pieces dropped (a quote that
 * starts or ends with an ellipsis produces one). A quote with no
 * ellipsis at all comes back as a single-element array holding the
 * whole (trimmed) quote — the same shape either way, so callers don't
 * need to special-case "was there an ellipsis or not."
 * @param {string} quote
 * @returns {string[]}
 */
function splitQuoteOnEllipsis(quote) {
  return quote
    .split(ELLIPSIS_RE)
    .map((p) => p.trim())
    .filter(Boolean);
}

// A floor below which a single piece of an ellipsis-shortened quote
// is too short to trust as real, distinguishing evidence on its own —
// see chunkContainsOrderedPieces()'s doc comment for why this only
// applies to a MULTI-piece (ellipsis) quote, never a plain one.
function isSubstantialPiece(piece) {
  const words = piece.split(/\s+/).filter(Boolean);
  return words.length >= 4 || piece.length >= 15;
}

/**
 * Checks whether every one of `pieces` appears in `haystack`, in that
 * same order, with each piece's match starting no earlier than where
 * the previous one's match ended (never overlapping, never out of
 * order). This is the piece-based generalization of a plain substring
 * search: for an ordinary quote (a single piece, no ellipsis), it
 * reduces to exactly that — one `indexOf` call, same as before.
 *
 * The ORDER requirement specifically is what keeps this from being too
 * permissive once a quote is broken into pieces: checking only that
 * each piece appears SOMEWHERE in the chunk (regardless of position)
 * would let a fabricated quote stitched from unrelated fragments
 * scattered across the chunk — in reverse order, or from opposite ends
 * of a long chunk — come back "verified," which isn't what an
 * ellipsis is supposed to represent (a shortened but still faithful,
 * contiguous excerpt). Requiring pieces to appear in the chunk's own
 * order, without overlapping, is a much closer match to that intent.
 * @param {string} haystack - already normalized (see resolveCitation())
 * @param {string[]} pieces - already normalized, in quote order
 * @returns {boolean}
 */
function chunkContainsOrderedPieces(haystack, pieces) {
  let searchFrom = 0;
  for (const piece of pieces) {
    const idx = haystack.indexOf(piece, searchFrom);
    if (idx === -1) return false;
    searchFrom = idx + piece.length;
  }
  return true;
}

/**
 * Determines the REAL citation for an extracted quote by searching
 * for its actual text among this batch's retrieved chunks, rather
 * than trusting whatever file/chunk the model claimed — see
 * extractQuotesAndCitations() above for the failure modes (hallucinated
 * "chunk 6b", or a prompt marker like "PROPOSAL START" cited as if it
 * were a file name) that made trusting the model's own citation
 * unreliable enough to abandon entirely. A quote's real source is
 * unambiguous as long as its exact wording only appears in one place,
 * which is true of ordinary prose almost all the time.
 *
 * Handles a quote a model has shortened with an ellipsis ("Develop a
 * coordination strategy ... to pursue federal funding") the same way:
 * split on the ellipsis (splitQuoteOnEllipsis()), require each
 * resulting piece to appear in the SAME chunk in the SAME order
 * (chunkContainsOrderedPieces()) rather than requiring the literal
 * shortened string to appear verbatim, which it by definition never
 * will once words have been omitted from the middle. This was a real,
 * observed gap: a genuinely accurate, verbatim-on-both-sides quote was
 * coming back "not found" purely because the model — reasonably —
 * shortened a long passage rather than quoting it in full. A single
 * short/trivial piece (see isSubstantialPiece()) is dropped rather
 * than required, so an ellipsis next to a throwaway word like "the"
 * doesn't demand an exact position for it; this floor is skipped
 * entirely for a plain, non-ellipsis quote, so an ordinary short
 * quote is never newly rejected just for being short — only pieces
 * created by SPLITTING an ellipsis are ever held to it.
 *
 * @param {string} quote
 * @param {Array<{sourceFile: string, chunkIndex: number, text: string}>} matches -
 *   this batch's own retrieved chunks (with full text — the same
 *   array index.js already has in hand from search(), before
 *   sourcesSummary() strips text out for the API response).
 * @param {string|null} [claimedSourceFile] - only used to break a tie
 *   when the same quoted text happens to appear in more than one
 *   retrieved chunk.
 * @param {string|null} [claimedChunkIndex]
 * @returns {{verified: true, sourceFile: string, chunkIndex: number}|{verified: false}|null}
 *   null if there was no quote to check at all (the model wrote
 *   "none," or nothing matched the quote format); `{verified: false}`
 *   if a quote was given but its text doesn't appear verbatim in any
 *   retrieved chunk (fabricated or paraphrased); otherwise the real
 *   [sourceFile, chunkIndex] the quote actually came from.
 */
function resolveCitation(quote, matches, claimedSourceFile, claimedChunkIndex) {
  if (!quote || !matches || matches.length === 0) return null;

  // Whitespace-BLIND matching: every whitespace character (space, tab,
  // newline) is stripped out entirely, not just collapsed, so two
  // strings that agree on every non-whitespace character but disagree
  // on exactly where the whitespace falls are treated as identical.
  // This exists because of a real, repeatedly observed PDF-extraction
  // artifact: pdf-parse occasionally inserts a stray space in the
  // middle of an ordinary word, with no relation to hyphenation or line
  // wrapping at all — confirmed against real chunk text as "Long-te rm"
  // (for "Long-term"), "Ic e" (for "Ice"), "re al-ti me" (for
  // "real-time"), "re ly" (for "rely"), and "st orm" (for "storm"), all
  // from the same single retrieved chunk. A model quoting the same
  // passage naturally writes the word the normal way, with no stray
  // space, since that's how the word actually reads — so what should be
  // an exact, verbatim quote was instead coming back "NOT found
  // verbatim in any retrieved chunk" purely because of where pdf-parse
  // happened to split a word, not because of anything wrong with the
  // quote.
  //
  // An earlier version of this function only collapsed repeated
  // whitespace into one space and separately special-cased a stray
  // space right after a hyphen ("sea- level" -> "sea-level"). That
  // narrower fix covered a word broken at a real hyphen but not one
  // broken anywhere else in the word (exactly the "Ic e" / "re ly"
  // shape above), so it's replaced here by stripping whitespace
  // unconditionally — which also makes the old hyphen-specific
  // replace redundant, since removing every space around a hyphen
  // has the same end result as the old regex intended.
  //
  // Known false-positive risk, accepted deliberately (same tradeoff
  // class as looksLikeContinuation() in structuredText.js): because
  // whitespace no longer marks a word boundary at all once both sides
  // are stripped, a FABRICATED quote formed by jamming two real
  // adjacent words together (e.g. writing "catfish" when the chunk
  // actually has "...the cat. Fish..." elsewhere) could in principle
  // be misreported as verified. This is judged far less likely in
  // practice than the genuine extraction artifact above, and it's a
  // strict broadening of a risk this function already accepted for the
  // hyphen case specifically — see this function's own doc comment.
  const normalize = (s) => String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '');

  const rawPieces = splitQuoteOnEllipsis(quote);
  if (rawPieces.length === 0) return null; // e.g. the "quote" was just an ellipsis with nothing else

  // The length floor only kicks in once there's actually more than one
  // piece to require (i.e. the model used an ellipsis) — see
  // chunkContainsOrderedPieces()'s doc comment above for why a plain,
  // single-piece quote is never filtered by length at all, same as
  // before this change.
  const requiredPieces = rawPieces.length > 1 ? rawPieces.filter(isSubstantialPiece) : rawPieces;
  if (requiredPieces.length === 0) return { verified: false }; // every piece was too trivial to trust

  const normalizedPieces = requiredPieces.map(normalize);

  const candidates = matches.filter((m) => chunkContainsOrderedPieces(normalize(m.text), normalizedPieces));
  if (candidates.length === 0) return { verified: false };

  const claimed = claimedSourceFile != null && claimedChunkIndex != null
    ? candidates.find((m) => m.sourceFile === claimedSourceFile && Number(m.chunkIndex) === Number(claimedChunkIndex))
    : null;
  const chosen = claimed || candidates[0];

  return { verified: true, sourceFile: chosen.sourceFile, chunkIndex: chosen.chunkIndex };
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
 * When one or more quote + citations were requested and successfully
 * parsed (see extractQuotesAndCitations() and spliceVerifiedQuotes()
 * above), each is folded back into `resultText` in place as a
 * `"quote" [file, chunk N]` segment, suffixed with a checkmark or
 * warning depending on resolveCitation()'s outcome against `matches`
 * (✓ quote verified / ⚠ quote NOT found verbatim in any retrieved
 * chunk) — so the on-screen table and the CSV export both surface the
 * verification result for every quote without either one needing its
 * own new column or field; `resultText` stays a single plain string
 * throughout.
 *
 * @param {string} answerText - the chat model's raw answer for this batch
 * @param {Array<{name: string, proposal: string}>} attributes - the
 *   attributes that were actually asked about in this batch (i.e. one
 *   element of batchAttributes()'s return value)
 * @param {Array<{sourceFile: string, chunkIndex: number, text: string}>} [matches] -
 *   this batch's own retrieved chunks, for verifyQuote() above. Optional:
 *   omit to still extract and display a quote/citation without
 *   verifying it (e.g. in an isolated unit test with no real matches
 *   to check against) — the ✓/⚠ suffix is simply left off in that case.
 * @returns {Array<{name: string, proposal: string, resultText: string, category: string}>}
 */
function parseComparisonAnswer(answerText, attributes, matches) {
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

    // Finds every quote+citation in this attribute's text (not just
    // the first — see spliceVerifiedQuotes()'s doc comment), verifies
    // each one against this batch's actual retrieved chunks, and
    // splices the verified forms back into place. The displayed
    // citation for each quote is always the REAL one resolveCitation()
    // found by searching for the quote's actual text — never whatever
    // file/chunk the model itself claimed. When a quote can't be found
    // anywhere in this batch's retrieved chunks at all, no citation is
    // shown for it, since fabricating one from the model's own
    // unreliable claim would be worse than showing none.
    const finalResultText = spliceVerifiedQuotes(resultText, matches);

    return {
      name: attr.name,
      proposal: attr.proposal,
      resultText: finalResultText,
      category,
    };
  });
}

// Every verdict this app's verdict-vocabulary regexes above can
// produce, worst to best, with '' (no verdict the parser could find at
// all -- see parseComparisonAnswer()'s own doc comment on an empty
// `category`) as the worst rung rather than a separate special case.
// This is the ONE authoritative ordering the "retry against the next
// batch of retrieved chunks" feature (see maybeRetryWithNextBand() in
// index.js) compares against -- both RETRY_TRIGGER_VERDICTS and
// mergeRetryRecord() below are built on it, so there's a single place
// that says which verdict outranks which, not one notion of "better"
// re-derived per caller.
const VERDICT_ORDER = ['', 'Not addressed', 'Falls short', 'Matches', 'Exceeds'];

/**
 * @param {string} category - '' for an unparsed result, otherwise one
 *   of VERDICT_ORDER's other entries.
 * @returns {number} that verdict's rank, 0 (worst) upward. An
 *   unrecognized string (shouldn't happen -- category always comes
 *   from the same fixed vocabulary parseComparisonAnswer() produces)
 *   is treated as rank 0 rather than thrown on, same treatment as ''.
 */
function verdictRank(category) {
  const idx = VERDICT_ORDER.indexOf(category || '');
  return idx === -1 ? 0 : idx;
}

// Which verdict(s) are currently eligible to trigger a retry against a
// later, different batch of retrieved chunks (see
// maybeRetryWithNextBand() in index.js for the full mechanism and why
// it exists -- in short: a genuinely relevant chunk can rank just
// outside the originally-retrieved top-K, and re-asking against the
// NEXT band of chunks, on its own rather than piled on top of the
// first band, can surface it without diluting the model's attention
// the way simply asking for more chunks at once would). Deliberately a
// short list here, not a hardcoded `category === 'Not addressed'`
// check at the call site, so adding 'Falls short' later -- discussed
// but not yet built, since a Falls-short result usually already
// contains real, correct partial material worth keeping regardless of
// what a retry finds, which is a different tradeoff than a
// Not-addressed result (which has nothing worth keeping on its own) --
// is a one-line change here rather than a new code path.
const RETRY_TRIGGER_VERDICTS = ['Not addressed'];

/**
 * Combines one attribute's original result with a second attempt run
 * against a different, later batch of retrieved chunks -- see
 * maybeRetryWithNextBand() in index.js for when that second attempt
 * happens at all (only for a verdict in RETRY_TRIGGER_VERDICTS above,
 * and only when the original retrieval's own chunks all scored above
 * the run's relevance threshold, a proxy for "there's probably more
 * genuinely relevant material in this corpus worth checking the next
 * band of" rather than "this topic just isn't well covered here at
 * all").
 *
 * Compares `original.category` against `retry.category` using
 * VERDICT_ORDER above:
 *   - retry ranks WORSE than original: keeps `original` almost
 *     entirely as-is, only appending a short, generic note that a
 *     second batch was checked and didn't turn up anything more
 *     relevant -- never restating the retry's own (worse) verdict or
 *     text, which would just be noise under an already-superseded
 *     result.
 *   - retry ranks the SAME as original: keeps `original.category`,
 *     but appends the retry's own resultText after a short separator,
 *     so a reader sees the fuller picture of everywhere this
 *     attribute's material was actually checked.
 *   - retry ranks BETTER than original: same appending as the "same"
 *     case, but `category` becomes the retry's (better) one -- the
 *     retry found genuinely new, more complete evidence, so it's what
 *     gets credited, with the original attempt's own text kept too
 *     rather than discarded (nothing the original attempt said was
 *     WRONG, just incomplete).
 * Either way, `name`/`proposal` are untouched -- only `resultText` and
 * (sometimes) `category` change.
 *
 * @param {{name: string, proposal: string, resultText: string, category: string}} original
 * @param {{name: string, proposal: string, resultText: string, category: string}} retry
 * @returns {{name: string, proposal: string, resultText: string, category: string}}
 */
function mergeRetryRecord(original, retry) {
  const origRank = verdictRank(original.category);
  const retryRank = verdictRank(retry.category);

  if (retryRank < origRank) {
    return {
      ...original,
      resultText:
        `${original.resultText}\n\n(Also checked the next batch of retrieved chunks; ` +
        'found nothing more relevant there.)',
    };
  }

  const merged = {
    ...original,
    resultText:
      `${original.resultText}\n\n— Also checked the next batch of retrieved chunks —\n\n${retry.resultText}`,
  };
  if (retryRank > origRank) merged.category = retry.category;
  return merged;
}

module.exports = {
  parseComparisonAnswer,
  extractQuotesAndCitations,
  spliceVerifiedQuotes,
  resolveCitation,
  splitQuoteOnEllipsis,
  VERDICT_ORDER,
  verdictRank,
  RETRY_TRIGGER_VERDICTS,
  mergeRetryRecord,
};
