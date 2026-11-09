/**
 * Loads the "Best Practices" benchmark attribute list produced by
 * best_practices_to_json.py (see that script at the project root for
 * the conversion itself, and src/bestPracticesFilter.js for the
 * hazard/state filtering this feeds into).
 *
 * Lives at the project root, a peer of idealProposals.json -- same
 * reasoning as that file: this is global reference data, independent
 * of which workspace/plan is being evaluated, not something scoped
 * under workspaces/<id>/.
 *
 * Deliberately NOT cached in memory, same "just a file you can
 * re-generate and drop in" philosophy idealProposals.js's loadTopics()
 * already follows for the exact same reason: loadBestPracticeAttributes()
 * re-reads bestPractices.json from disk on every call, so
 * re-running best_practices_to_json.py and overwriting the file takes
 * effect on the very next request, no server restart. This file is
 * expected to be the FULL converted sheet (747 attributes on the real
 * one this was built against) rather than idealProposals.json's
 * "handful of topics, each a handful of attributes," but re-parsing a
 * few hundred small JSON objects per request is still cheap enough
 * that always-fresh is worth more here than the marginal cost saved by
 * caching it -- and it means picking up a freshly re-converted sheet
 * (new rows added, a correction made) never requires remembering to
 * restart anything, same promise idealProposals.json's editors rely on
 * today.
 *
 * This module is deliberately separate from idealProposals.js rather
 * than an extension of it -- see bestPracticesFilter.js's own doc
 * comment for why these two kinds of "topic" (a small hand-curated
 * rubric vs. a large generated benchmark dataset) are kept apart.
 */

const fs = require('fs');
const path = require('path');

const BEST_PRACTICES_PATH = path.join(__dirname, '..', 'bestPractices.json');

/**
 * Reads and parses bestPractices.json fresh from disk.
 *
 * A missing file yields an empty attribute list rather than an error --
 * same reasoning as loadTopics() in idealProposals.js: this whole
 * feature is optional, and an installation that hasn't generated the
 * file yet (or doesn't use this feature at all) should still run
 * normally. A file that exists but is malformed (bad JSON, or missing
 * the top-level "attributes" array) throws instead, since that's a
 * real conversion/configuration mistake worth surfacing rather than
 * silently ignoring.
 *
 * @returns {Array<{name: string, proposal: string, state?: string, hazards?: string[], sectors?: string[], commitmentLevels?: string[], scope?: string[], fundingStatus?: string[], fundingSource?: string[], status?: string[], url?: string, notes?: string}>}
 */
function loadBestPracticeAttributes() {
  if (!fs.existsSync(BEST_PRACTICES_PATH)) return [];

  const raw = fs.readFileSync(BEST_PRACTICES_PATH, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`bestPractices.json is not valid JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.attributes)) {
    throw new Error('bestPractices.json must have a top-level "attributes" array.');
  }
  return data.attributes;
}

module.exports = { loadBestPracticeAttributes, BEST_PRACTICES_PATH };
