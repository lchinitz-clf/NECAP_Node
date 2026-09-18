/**
 * Combines cosine-similarity vector search (store.js) and BM25
 * keyword search (keywordSearch.js) for one workspace into a single
 * ranked result, via reciprocal rank fusion (RRF).
 *
 * Why RRF specifically, not a simpler union of the two top-K lists:
 * a plain union tells you which chunks showed up in EITHER list, but
 * not which order to present or trim them in, and it throws away the
 * signal that a chunk ranked well by BOTH methods is much more likely
 * to be genuinely relevant than one that only barely made it into one
 * list. RRF fuses the two methods' RANKINGS rather than their raw
 * scores, which sidesteps the awkward problem of putting a cosine
 * similarity (bounded 0..1) and a BM25 score (unbounded and corpus-
 * dependent) on one shared scale: for each record, sum
 * 1/(RRF_K + rank) across whichever ranked list(s) it appears in,
 * then sort descending by that sum. A record ranked #1 by both
 * methods rises to the very top; a record found by only one method
 * still gets credit, just less of it; a record neither method ranked
 * highly sinks to the bottom, same as before.
 *
 * Both methods rank the ENTIRE workspace, not just a pre-cut topK —
 * see store.js's and keywordSearch.js's own doc comments for why a
 * full scan is fine at this app's scale (hundreds to low thousands of
 * chunks per workspace). That matters here specifically: fusing two
 * already-truncated top-5 lists would mean a chunk that BM25 would
 * have ranked, say, 6th never gets a chance to be pulled in by a
 * strong vector-side ranking either — ranking everything first and
 * truncating only after fusion is what actually fixes the reported
 * "topK raised to 10 and the chunk still never showed up" problem,
 * since that chunk's weak vector rank no longer has to carry it alone.
 */

const { loadStore, cosineSimilarity } = require('./store');
const { bm25Rank } = require('./keywordSearch');

// The standard constant from the reciprocal-rank-fusion literature
// (Cormack, Clarke & Buettcher, "Reciprocal Rank Fusion Outperforms
// Condorcet and Individual Rank Learning Methods," SIGIR 2009) — it
// dampens the gap between e.g. rank 1 and rank 2 in either list, so a
// handful of near-ties near the top don't swing the fused order more
// sharply than they should. 60 is the value that paper (and most
// production hybrid-search implementations since) settled on; there's
// no app-specific reason yet to tune it differently.
const RRF_K = 60;

/**
 * @param {string} workspaceId
 * @param {number[]} queryVector - already-embedded query, for the vector half
 * @param {string} queryText - the same query's raw text, for the keyword half
 * @param {number} topK
 * @returns {Array<{id: string, sourceFile: string, chunkIndex: number, text: string, score: number, matchedBy: string[]}>}
 *
 * `score` is deliberately still a plain cosine similarity (0..1),
 * exactly what search() in store.js has always returned — NOT a
 * fused RRF number. The browser UI's relevance-threshold slider and
 * its "N of M retrieved blocks met your relevance setting" copy (see
 * renderSources() in public/script.js) are written in terms of that
 * 0..1 cosine similarity; changing what `score` means here would
 * silently break that display without a matching UI rewrite. RRF only
 * changes WHICH chunks are selected and in what ORDER — it never
 * changes how a chunk's relevance is displayed once selected.
 *
 * `matchedBy` is added purely for transparency, in the same spirit as
 * the `retrievalQuery` field added earlier for the same reason: it
 * lists which retrieval method(s) actually surfaced this chunk.
 * `'vector'` means this chunk would have been in a plain vector-only
 * search's own top `topK` (i.e., this isn't new — vector search alone
 * would have found it too); `'keyword'` means it shares at least one
 * real keyword with the query per BM25. A chunk that only carries
 * `['keyword']` is exactly the case this feature was built for: one
 * that hybrid search now surfaces but plain vector search, even at a
 * raised topK, would not have.
 */
function hybridSearch(workspaceId, queryVector, queryText, topK = 5) {
  const records = loadStore(workspaceId);
  if (records.length === 0) return [];

  const vectorRanked = records
    .map((r) => ({ id: r.id, score: cosineSimilarity(queryVector, r.vector) }))
    .sort((a, b) => b.score - a.score);
  const vectorScoreById = new Map(vectorRanked.map((r) => [r.id, r.score]));
  const vectorRankById = new Map(vectorRanked.map((r, i) => [r.id, i]));

  // Keyword ranking is only meaningful for records that actually share
  // a keyword with the query — bm25Rank() still returns every record
  // (sorted, score 0 for the rest), so once the descending scores hit
  // 0 the remaining entries are all ties with nothing to rank; walking
  // in sorted order and stopping there gives each genuine match a
  // distinct rank (0, 1, 2, ...) without also handing out an arbitrary
  // rank — and its RRF bonus — to records with no real keyword match
  // at all.
  const keywordRanked = bm25Rank(queryText, records);
  const keywordRankById = new Map();
  for (const r of keywordRanked) {
    if (r.score <= 0) break;
    keywordRankById.set(r.id, keywordRankById.size);
  }

  const fused = records.map((r) => {
    const vRank = vectorRankById.get(r.id);
    const kRank = keywordRankById.get(r.id);
    let rrfScore = 1 / (RRF_K + vRank + 1);
    if (kRank !== undefined) rrfScore += 1 / (RRF_K + kRank + 1);

    const matchedBy = [];
    if (vRank < topK) matchedBy.push('vector');
    if (kRank !== undefined) matchedBy.push('keyword');

    return { record: r, rrfScore, score: vectorScoreById.get(r.id), matchedBy };
  });

  fused.sort((a, b) => b.rrfScore - a.rrfScore);

  return fused.slice(0, topK).map(({ record, score, matchedBy }) => ({
    ...record,
    score,
    matchedBy,
  }));
}

module.exports = { hybridSearch, RRF_K };
