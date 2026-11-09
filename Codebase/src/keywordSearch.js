/**
 * A lightweight, dependency-free BM25 keyword search over a
 * workspace's stored chunks — a companion to the cosine-similarity
 * vector search in store.js (see hybridSearch.js for how the two are
 * combined into one result).
 *
 * Why this exists: pure vector search has a real, reported failure
 * mode. A short, exact phrase (e.g. "inland flooding") can fail to
 * retrieve a chunk that contains that literal phrase, because an
 * embedding model necessarily blends many words' meaning into one
 * fixed-size vector — a short query's vector doesn't always land
 * close enough to a long chunk's vector, even when the chunk plainly
 * contains the words being searched for, and raising topK doesn't
 * reliably fix this if the chunk's cosine similarity is simply low
 * relative to everything else in the workspace.
 *
 * BM25 ("Best Matching 25") instead scores a chunk by which of the
 * query's individual keywords it contains, how often (with
 * diminishing returns, so a chunk that just repeats one keyword many
 * times doesn't dominate unfairly), and how rare each keyword is
 * across the whole corpus (a rare, specific term like "stormwater"
 * counts for more than a common one like "plan"). This is the
 * standard algorithm behind most "keyword search" products —
 * Elasticsearch and Lucene use a close variant — and unlike naive
 * substring matching, it's insensitive to word order: "flooding in
 * inland areas" and "coastal and inland flooding events" both score
 * well against the query "inland flooding," since both contain the
 * same keyword set regardless of how the words are arranged around
 * them.
 *
 * Deliberately no stemming (e.g. "flooding" vs "flood" remain
 * distinct tokens) and no synonym handling — a reasonable, honest
 * limitation for a first version rather than a bug: it already solves
 * the specific word-order problem this was built for, and stemming
 * would be a self-contained follow-up if it turns out to matter in
 * practice, not something this module needs to get right on day one.
 */

// A small, hardcoded list of common English words that carry almost
// no distinguishing signal for keyword search — filtering them out
// keeps scoring focused on the words that actually distinguish one
// chunk from another, and stops something like "the" or "and" (which
// appears in nearly every chunk) from ever being treated as a
// meaningful search term. Intentionally short and conservative: it's
// better to under-filter (a stopword slips through and just scores
// low anyway, via BM25's own rarity weighting) than to over-filter (a
// word someone might actually be searching for gets silently dropped
// everywhere).
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for',
  'from', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'over', 'that', 'the', 'their', 'there', 'these',
  'this', 'those', 'through', 'to', 'was', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
  'about', 'above', 'after', 'again', 'all', 'also', 'any', 'because',
  'before', 'being', 'below', 'between', 'both', 'can', 'did', 'do',
  'does', 'down', 'during', 'each', 'few', 'further', 'had', 'here',
  'him', 'his', 'i', 'more', 'most', 'my', 'no', 'nor', 'not', 'now',
  'once', 'only', 'other', 'our', 'out', 'own', 'same', 'she',
  'should', 'so', 'some', 'such', 'than', 'them', 'then', 'they',
  'under', 'until', 'up', 'very', 'we', 'while',
]);

/**
 * Splits text into lowercase word tokens: lowercases, splits on any
 * run of non-alphanumeric characters (so punctuation, hyphens,
 * newlines all just become token boundaries), and drops stopwords and
 * single-character tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Builds the per-corpus statistics BM25 needs: each chunk's own term
 * frequencies and length, plus how many chunks contain each term at
 * least once (document frequency) and the corpus's average chunk
 * length. Built fresh on every call — no caching across requests.
 *
 * That's a deliberate match to store.js's own approach (loadStore()
 * re-reads store.json and search() recomputes cosine similarity from
 * scratch on every call): at this app's scale — hundreds to low
 * thousands of chunks per workspace, per store.js's own doc comment —
 * a full rebuild is fast enough in plain JavaScript, and it means a
 * workspace that was just embedded into, rebuilt, or had a document
 * removed is always reflected immediately, with no separate
 * invalidation step that could ever drift out of sync.
 * @param {Array<{id: string, text: string}>} records
 */
function buildIndex(records) {
  const docTermFreqs = new Map(); // record.id -> Map(term -> count in that chunk)
  const docLengths = new Map(); // record.id -> token count
  const df = new Map(); // term -> number of chunks containing it at least once

  for (const r of records) {
    const tokens = tokenize(r.text);
    docLengths.set(r.id, tokens.length);
    const termFreq = new Map();
    for (const t of tokens) {
      termFreq.set(t, (termFreq.get(t) || 0) + 1);
    }
    docTermFreqs.set(r.id, termFreq);
    for (const t of termFreq.keys()) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const totalLength = Array.from(docLengths.values()).reduce((a, b) => a + b, 0);
  const avgDocLength = records.length ? totalLength / records.length : 0;

  return { docTermFreqs, docLengths, df, avgDocLength, N: records.length };
}

// Standard BM25 defaults from the information-retrieval literature —
// k1 controls how quickly extra occurrences of a term stop adding
// much to the score (term-frequency saturation), b controls how
// strongly a chunk's length is normalized against the corpus average
// (0 = ignore length entirely, 1 = fully normalize). 1.5/0.75 are the
// values most BM25 implementations (including Elasticsearch's) ship
// as their default, and there's no app-specific reason yet to deviate
// from them.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * Ranks every record in `records` by BM25 relevance to `queryText`,
 * highest score first. A record that shares no keyword with the query
 * at all gets a score of exactly 0 and is still included, not
 * filtered out — the caller (hybridSearch.js) needs a full ranking
 * from both retrieval methods to fuse against, not a pre-cut
 * shortlist; it decides separately what counts as "actually matched
 * by keyword" (score > 0).
 * @param {string} queryText
 * @param {Array<{id: string, text: string}>} records
 * @returns {Array<{id: string, score: number}>} same length as records, sorted descending by score
 */
function bm25Rank(queryText, records) {
  const queryTerms = [...new Set(tokenize(queryText))];
  const { docTermFreqs, docLengths, df, avgDocLength, N } = buildIndex(records);

  return records
    .map((r) => {
      const termFreq = docTermFreqs.get(r.id);
      const docLength = docLengths.get(r.id) || 0;
      let score = 0;
      for (const term of queryTerms) {
        const tf = termFreq.get(term) || 0;
        if (tf === 0) continue;
        const docFreq = df.get(term) || 0;
        // Standard BM25 idf, floored at 0 so a term appearing in
        // nearly every chunk in the corpus can never go negative and
        // start penalizing chunks that contain it.
        const idf = Math.max(0, Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1));
        const numerator = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / (avgDocLength || 1)));
        score += idf * (numerator / denominator);
      }
      return { id: r.id, score };
    })
    .sort((a, b) => b.score - a.score);
}

module.exports = { tokenize, bm25Rank, STOPWORDS };
