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
 * compareInstruction asks for a quote + citation on each line
 * (`Quote: "..." [file, chunk N]`, or a model's own inline variant —
 * see extractQuoteAndCitation() below), that segment is pulled out of
 * an already-isolated attribute's text and resolveCitation() looks up
 * the REAL [file, chunk] it came from by searching for the quote's
 * actual text among this batch's retrieved chunks — never by trusting
 * whatever citation the model itself wrote next to it. Two real
 * failure modes made that trust unworkable: a small model inventing a
 * non-integer "chunk 6b" that doesn't exist, and a model citing this
 * app's own "PROPOSAL START"/"PROPOSAL END" prompt markers as though
 * they were a file name (both observed in practice — see
 * extractQuoteAndCitation()'s and resolveCitation()'s doc comments).
 * Searching by the quote's own content sidesteps both: whatever the
 * model calls its source, the displayed citation can only ever be a
 * chunk that genuinely contains the quoted words, or "not found" if
 * it doesn't appear anywhere. The same quote+citation search also
 * doubles as a boundary marker: everything after it is discarded,
 * which fixes a related bug where a batch's last attribute picked up
 * unrelated rambling the model tacked on after finishing its real
 * answer (nothing else bounds the end of the last attribute's
 * segment — see splitByAttributeNames() below). Same philosophy as
 * the rest of this file throughout: never silently trust unreliable
 * model output when it can instead be checked, corrected from data,
 * or clearly marked as unverified.
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
 * Pulls a quote + citation off of one attribute's already-isolated
 * text (the output of extractCategoryAndResult() above) — the citation
 * compareInstruction asks for, requested precisely so it can be
 * mechanically checked against the actual chunk it claims to come
 * from (see resolveCitation() below) rather than just trusted
 * outright.
 *
 * Recognizes three shapes, tried in this order:
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
 *      dangling "none [...]" fragment — with a fabricated-looking
 *      citation attached to a nonexistent quote — sitting in
 *      resultText. Like pattern 2, the bracket must immediately
 *      follow (only light punctuation/whitespace in between), so an
 *      incidental "none" elsewhere in ordinary prose isn't mistaken
 *      for this placeholder.
 *
 * Neither pattern is anchored to the end of `text`. That's
 * deliberate and fixes a real failure mode: a batched answer's LAST
 * attribute has nothing bounding the end of its segment (see
 * splitByAttributeNames() above), so if the model tacks on unrelated
 * rambling after finishing this attribute's real answer — in
 * practice, a model has been seen appending stray commentary about a
 * DIFFERENT attribute right after finishing this one — that trailing
 * text used to get silently absorbed into this attribute's
 * resultText. Finding the quote+citation as a landmark ANYWHERE in
 * the text and discarding everything after it fixes that: once the
 * attribute's real answer is complete (marked by its citation), any
 * further text is dropped as bleed rather than displayed as if it
 * belonged to this attribute.
 *
 * The claimed file name and chunk token are captured as-is and are
 * NOT trusted as the real citation — see resolveCitation() below,
 * which looks up the true source by searching for the quote's actual
 * text among this batch's retrieved chunks instead. That's because
 * models have been observed citing things that were never real
 * sources at all: a non-integer "chunk 6b" (chunk indices are always
 * plain integers — see embedPipeline.js), or even the prompt's own
 * "PROPOSAL START"/"PROPOSAL END" section markers as though they were
 * a file name. Trusting the model's claimed citation would surface
 * either of those errors straight to the screen looking exactly as
 * authoritative as a real one; searching for the quote's own text
 * instead sidesteps the model's naming mistakes entirely and can only
 * ever point at a chunk that genuinely contains the words quoted.
 *
 * @param {string} text
 * @returns {{resultText: string, quote: string, claimedSourceFile: string|null, claimedChunkIndex: string|null}}
 *   `claimedChunkIndex` is the raw captured token as a trimmed string
 *   (e.g. "6", or the bogus "6b" or "PROPOSAL START"), kept only as a
 *   tiebreaker in resolveCitation() below — never displayed directly.
 */
function extractQuoteAndCitation(text) {
  // "Quote" is followed by an optional colon, not a required one — a
  // model has been observed writing "Quote none" with no punctuation
  // at all (still unambiguous: only "Quote"/"Quote:" ever precedes the
  // quoted-text-or-none shape this looks for), and requiring the colon
  // would make that whole segment fall through unrecognized instead.
  const labeledRe = /[\s.;:—–-]*Quote\s*:?\s*(?:["“]([^"”]*)["”]|(none|n\/a|no quote))\s*(?:\[\s*(?:Source\s*:\s*)?([^,\]]+?)\s*,\s*chunk\s*([^\]]+?)\s*\])?/i;
  const inlineRe = /["“]([^"”]+)["”]\s*[.,;:]?\s*(?:\[\s*(?:Source\s*:\s*)?([^,\]]+?)\s*,\s*chunk\s*([^\]]+?)\s*\])/i;
  const bareNoneRe = /(?:none|n\/a|no quote)\s*[.,;:]?\s*(?:\[\s*(?:Source\s*:\s*)?([^,\]]+?)\s*,\s*chunk\s*([^\]]+?)\s*\])/i;

  const labeledMatch = labeledRe.exec(text);
  const inlineMatch = inlineRe.exec(text);
  const bareNoneMatch = bareNoneRe.exec(text);

  // All three patterns are searched for unconditionally, and whichever
  // one starts EARLIEST in the text wins — not by fixed priority.
  // That matters once a model rambles past its real answer: relaxing
  // the colon above means a stray, out-of-place "Quote none" further
  // down a rambling response (see this module's doc comment for the
  // real example that surfaced this) can now match the labeled
  // pattern too, and if labeled always won outright, that LATER stray
  // match would be picked over the real, earlier inline citation right
  // after the actual answer — silently letting everything in between
  // (the ramble this whole function exists to cut off) leak back into
  // resultText. Taking whichever match has the smaller index keeps
  // this landmark-based cut at the first quote-shaped thing in the
  // text, which is always the real answer when the model followed
  // instructions at all, regardless of which of the three shapes it
  // used.
  let chosen = null;
  for (const candidate of [
    labeledMatch && { m: labeledMatch, kind: 'labeled' },
    inlineMatch && { m: inlineMatch, kind: 'inline' },
    bareNoneMatch && { m: bareNoneMatch, kind: 'bareNone' },
  ]) {
    if (!candidate) continue;
    if (!chosen || candidate.m.index < chosen.m.index) chosen = candidate;
  }

  if (!chosen) {
    return { resultText: text, quote: '', claimedSourceFile: null, claimedChunkIndex: null };
  }

  const { m, kind } = chosen;
  // No `|| text.trim()` fallback here: an empty prefix is a normal,
  // expected result (the quote itself doubling as the whole reason,
  // with nothing said before it) — not a failure to recover from.
  // Falling back to the full original text on an empty prefix used to
  // silently re-attach the quote/citation (and anything the model
  // rambled on AFTER them) right back onto resultText, undoing the
  // whole point of finding this landmark in the first place.
  const resultText = text.slice(0, m.index).trim();
  if (kind === 'labeled') {
    return {
      resultText,
      quote: (m[1] || '').trim(),
      claimedSourceFile: m[3] ? m[3].trim() : null,
      claimedChunkIndex: m[4] !== undefined ? m[4].trim() : null,
    };
  }
  if (kind === 'inline') {
    return {
      resultText,
      quote: (m[1] || '').trim(),
      claimedSourceFile: m[2] ? m[2].trim() : null,
      claimedChunkIndex: m[3] !== undefined ? m[3].trim() : null,
    };
  }
  // bareNone: never has a quote to capture — "none" itself isn't the
  // quote text, it's the model saying there ISN'T one — so quote stays
  // '' just like the labeled "Quote: none" case does.
  return {
    resultText,
    quote: '',
    claimedSourceFile: m[1] ? m[1].trim() : null,
    claimedChunkIndex: m[2] !== undefined ? m[2].trim() : null,
  };
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
 * extractQuoteAndCitation() above for the failure modes (hallucinated
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

  const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

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
 * When a quote + citation was requested and successfully parsed (see
 * extractQuoteAndCitation() above), it's folded back into `resultText`
 * as a trailing `— "quote" [file, chunk N]` segment, suffixed with a
 * checkmark or warning depending on verifyQuote()'s outcome against
 * `matches` (✓ quote verified / ⚠ quote NOT found verbatim in cited
 * block) — so the on-screen table and the CSV export both surface the
 * verification result without either one needing its own new column
 * or field; `resultText` stays a single plain string throughout.
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

    const parsedQuote = extractQuoteAndCitation(resultText);
    let finalResultText = parsedQuote.resultText;
    if (parsedQuote.quote) {
      // The displayed citation is always the REAL one resolveCitation()
      // found by searching for the quote's actual text — never
      // whatever file/chunk the model itself claimed (see
      // extractQuoteAndCitation()'s doc comment for why that claim
      // isn't trusted). When the quote can't be found anywhere in this
      // batch's retrieved chunks at all, no citation is shown, since
      // fabricating one from the model's own unreliable claim would be
      // worse than showing none.
      const resolved = resolveCitation(parsedQuote.quote, matches, parsedQuote.claimedSourceFile, parsedQuote.claimedChunkIndex);
      const citation = resolved && resolved.verified ? ` [${resolved.sourceFile}, chunk ${resolved.chunkIndex}]` : '';
      const verifyNote = resolved && resolved.verified ? ' ✓ quote verified'
        : resolved && resolved.verified === false ? ' ⚠ quote NOT found verbatim in any retrieved chunk'
        : '';
      const prefix = parsedQuote.resultText ? `${parsedQuote.resultText} — ` : '';
      finalResultText = `${prefix}"${parsedQuote.quote}"${citation}${verifyNote}`;
    }

    return {
      name: attr.name,
      proposal: attr.proposal,
      resultText: finalResultText,
      category,
    };
  });
}

module.exports = { parseComparisonAnswer, extractQuoteAndCitation, resolveCitation, splitQuoteOnEllipsis };
