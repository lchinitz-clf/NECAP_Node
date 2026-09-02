/**
 * Splits text into overlapping, word-count-based chunks.
 *
 * This is deliberately simple to start: a sliding window over the raw
 * word stream. It doesn't yet respect sentence/paragraph boundaries,
 * which means a chunk can start or end mid-sentence. That's a fine
 * starting point and something we can improve later (e.g. splitting on
 * paragraph breaks first, then packing paragraphs into chunks up to
 * maxWords) once we've seen how retrieval quality looks with this
 * simple version.
 *
 * Default size (300 words, ~40 overlap) is deliberately conservative:
 * Ollama's embedding endpoint has a hard, non-overridable 512-token
 * context limit for nomic-embed-text (see ollamaClient.js), and 300
 * words leaves comfortable headroom below that even for dense
 * technical text with lots of footnotes/acronyms, which tends to use
 * more tokens per word than plain prose.
 *
 * IMPORTANT CAVEAT this ran into in practice: "words" here just means
 * "things separated by whitespace." Most real prose averages ~5-6
 * characters per word, which is where the "300 words ~= 450 tokens"
 * estimate comes from. But some text (table-of-contents dot-leaders,
 * long unbroken identifiers, URLs, glued-together table cells) can
 * produce individual whitespace-split "words" that are 50-100+
 * characters long — one "word" by count, but far more than one word's
 * worth of actual content. A chunk that happens to contain a few of
 * those can blow well past the token budget even while staying under
 * maxWords. extract.js now strips the worst offender (dot-leaders) at
 * the source, but as a backstop that doesn't depend on that cleanup
 * catching everything, maxChars below enforces a hard character-length
 * ceiling per chunk, checked word-by-word as the chunk is built — so
 * no single chunk can silently balloon in character count the way the
 * original table-of-contents chunk did (300 words / 4125 characters,
 * versus ~2032 characters for a typical 300-word chunk of this
 * document).
 *
 * @param {string} text - Raw extracted text.
 * @param {object} opts
 * @param {number} opts.maxWords - Target chunk size, in words.
 * @param {number} opts.overlapWords - How many trailing words of one
 *   chunk get repeated at the start of the next, so a sentence that
 *   straddles a boundary isn't lost from context entirely.
 * @param {number} opts.maxChars - Hard character-length ceiling per
 *   chunk. Whichever limit (maxWords or maxChars) is hit first ends
 *   the chunk. 1800 is set well below the ~2032-median/4125-max range
 *   we saw on real chunks, leaving headroom for text denser than this
 *   document's.
 * @returns {string[]} Array of chunk strings.
 */
function chunkText(text, { maxWords = 300, overlapWords = 40, maxChars = 1800 } = {}) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks = [];
  let start = 0;

  while (start < words.length) {
    // Grow the chunk word-by-word until we hit whichever limit comes
    // first: maxWords, or maxChars. This is what protects against the
    // "one giant whitespace-split token" case — a single 137-char
    // "word" can trip the maxChars limit long before maxWords does.
    let end = start;
    let charCount = 0;
    while (end < words.length && end - start < maxWords) {
      const nextLen = words[end].length + (end > start ? 1 : 0); // +1 for the joining space
      if (end > start && charCount + nextLen > maxChars) break;
      charCount += nextLen;
      end++;
    }
    // Guarantee forward progress even if a single word alone exceeds
    // maxChars (rare after the dot-leader cleanup, but not impossible
    // for something like a very long URL) — always take at least one
    // word so we never spin in place.
    if (end === start) end = start + 1;

    chunks.push(words.slice(start, end).join(' '));

    if (end === words.length) break;

    // Step back by overlapWords so the next chunk repeats some tail
    // context from this one, instead of starting fresh.
    start = Math.max(end - overlapWords, start + 1);
  }

  return chunks;
}

module.exports = { chunkText };
