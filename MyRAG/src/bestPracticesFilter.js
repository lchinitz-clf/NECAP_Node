/**
 * Filtering/lookup helpers for the "Best Practices" benchmark attribute
 * list produced by best_practices_to_json.py (see that script at the
 * project root for the conversion itself and the exact attribute
 * shape: {name, proposal, state, hazards, sectors, commitmentLevels,
 * scope, fundingStatus, fundingSource, status, url, notes}).
 *
 * This module is deliberately separate from idealProposals.js rather
 * than an extension of it: a hand-curated rubric topic's attributes
 * are a small, fixed list a person edits one at a time through Rubric
 * Control, while this is a large, generated dataset (747 entries on
 * the real sheet this was built against) that needs to be NARROWED by
 * metadata before it's ever handed to the comparison engine — nothing
 * in idealProposals.js does that kind of filtering today, and bolting
 * it on there would make that module responsible for two very
 * different kinds of "topic."
 *
 * Nothing here talks to the comparison engine (buildRagMessages(),
 * composeComparisonQuestion(), batchAttributes(), etc. in index.js /
 * idealProposals.js) — this module's whole job is turning "the user
 * picked Hazard=Wildfire, State=(any)" into the matching subset of
 * attributes; what happens to that subset afterward is the same
 * machinery a hand-authored topic's attributes already go through.
 */

/**
 * Case-insensitively checks whether `value` is present in `list`.
 * Every category field on an attribute (hazards, sectors, ...) is a
 * list of human-readable words straight from a flag column's own name
 * (see best_practices_to_json.py's pascal_to_words()) -- consistent
 * capitalization within one run, but never assumed to exactly match
 * whatever casing a caller typed or a UI control passed through.
 * @param {string[]} list
 * @param {string} value
 * @returns {boolean}
 */
function includesCaseInsensitive(list, value) {
  if (!value) return false;
  const needle = value.trim().toLowerCase();
  return (list || []).some((item) => (item || '').trim().toLowerCase() === needle);
}

/**
 * Narrows a Best Practices attribute list down to the entries matching
 * a hazard (required) and, optionally, a state.
 *
 * `hazard` is a membership test against each entry's own `hazards`
 * array, NOT an equality check -- real data has plenty of entries
 * tagged with more than one hazard (e.g. an electric-grid resilience
 * grant tagged Straight Line Winds, Wildfire, Winter Weather, AND
 * Tornado all at once), so an entry should match a hazard filter if
 * that hazard is anywhere in its list, regardless of how many others
 * are also there.
 *
 * `state` is left undefined/omitted to mean "every state that has an
 * entry for this hazard" -- the default this was designed around (see
 * the real-data distribution this came out of: every common hazard
 * spans multiple states, so comparing against all of them is a
 * genuinely richer report, not just a fallback for "didn't specify
 * one"). Passing a state narrows to just that one.
 *
 * @param {Array<Object>} attributes - as produced by
 *   best_practices_to_json.py (or loaded from its output file)
 * @param {{hazard: string, state?: string}} filter
 * @returns {Array<Object>} the matching subset, in the same order as
 *   `attributes` -- never reordered, so a caller that cares about the
 *   sheet's original row order (e.g. for stable batching) doesn't need
 *   to re-sort.
 * @throws {Error} if `hazard` is missing or blank -- there's no
 *   sensible "match everything" behavior for this filter the way
 *   there is for `state` (a Best Practices run with no hazard at all
 *   isn't "compare against the whole 747-row sheet," it's a request
 *   that doesn't make sense for this feature yet).
 */
function filterBestPracticeAttributes(attributes, { hazard, state } = {}) {
  if (!hazard || !hazard.trim()) {
    throw new Error('hazard is required to filter Best Practices attributes.');
  }
  return (attributes || []).filter((entry) => {
    if (!includesCaseInsensitive(entry.hazards, hazard)) return false;
    if (state && state.trim() && (entry.state || '').trim().toLowerCase() !== state.trim().toLowerCase()) {
      return false;
    }
    return true;
  });
}

/**
 * Deduplicates `values` the same case-INsensitive way
 * filterBestPracticeAttributes() above matches them, so the list used
 * to populate a dropdown can never show two entries that would both
 * match the same filter (e.g. "Wildfire" and "wildfire" as two
 * separate options). Keeps the FIRST casing encountered as the
 * canonical display form for each group -- not expected to matter in
 * practice, since every hazard label the converter produces comes from
 * the same transformation of the same column header and is therefore
 * always rendered identically, but this is cheap insurance against
 * drift if the file is ever hand-edited afterward.
 * @param {string[]} values
 * @returns {string[]} sorted alphabetically (by the kept casing)
 */
function dedupeCaseInsensitive(values) {
  const byLowercase = new Map();
  for (const value of values) {
    if (!value) continue;
    const key = value.trim().toLowerCase();
    if (!byLowercase.has(key)) byLowercase.set(key, value);
  }
  return Array.from(byLowercase.values()).sort((a, b) => a.localeCompare(b));
}

/**
 * Every distinct hazard value actually present across `attributes` —
 * meant to populate the Hazard dropdown directly from whatever the
 * loaded dataset actually contains, so that list can never drift out
 * of sync with the real data (no hand-maintained vocabulary list to
 * forget to update when the spreadsheet gains a new hazard column).
 * @param {Array<Object>} attributes
 * @returns {string[]} sorted alphabetically, case-insensitively deduped
 */
function listDistinctHazards(attributes) {
  const all = [];
  for (const entry of attributes || []) {
    all.push(...(entry.hazards || []));
  }
  return dedupeCaseInsensitive(all);
}

/**
 * Every distinct state value actually present across `attributes` —
 * same reasoning as listDistinctHazards() above, for the optional
 * State dropdown.
 * @param {Array<Object>} attributes
 * @returns {string[]} sorted alphabetically, case-insensitively deduped
 */
function listDistinctStates(attributes) {
  return dedupeCaseInsensitive((attributes || []).map((entry) => entry.state));
}

module.exports = {
  filterBestPracticeAttributes,
  listDistinctHazards,
  listDistinctStates,
};
