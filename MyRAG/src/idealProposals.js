/**
 * Loads and serves the "ideal proposal" comparison topics used by the
 * Ask form's optional compare-against-an-ideal mode — see
 * idealProposals.json at the project root for the actual data, and the
 * "Comparing against an ideal proposal" section in README.md for the
 * full design, including the alternative approach NOT implemented
 * here (folding the ideal content into the system prompt instead of
 * the question) in case this one doesn't work well in practice and a
 * switch is worth trying later.
 *
 * Deliberately NOT embedded/vectorized anywhere, and NOT cached in
 * memory: loadTopics() re-reads idealProposals.json from disk on every
 * call, so editing that file takes effect on the very next request —
 * no re-embedding step, no server restart, matching the "just a file
 * you can open and edit" philosophy store.json already uses elsewhere
 * in this app. The file is expected to stay small (a handful of
 * topics, each a handful of attributes), so re-parsing it per request
 * is cheap enough that always-fresh is worth more here than the
 * marginal cost saved by caching it.
 */

const fs = require('fs');
const path = require('path');

const IDEAL_PROPOSALS_PATH = path.join(__dirname, '..', 'idealProposals.json');

// Last-resort fallback only — used when idealProposals.json itself
// doesn't define a file-level `defaultCompareInstruction` either (e.g.
// a minimal or very old file). The normal, hand-editable default lives
// in the JSON file, not here: see getTopic()'s fallback chain below.
const HARDCODED_FALLBACK_COMPARE_INSTRUCTION =
  'Compare and contrast the proposal under review with the ideal proposal ' +
  'described above. For each attribute, note whether the reviewed proposal ' +
  'matches, falls short of, or exceeds the ideal, and flag anything the ' +
  'ideal calls for that the reviewed proposal does not appear to address at all.';

/**
 * Reads and parses idealProposals.json fresh from disk.
 *
 * A missing file yields an empty topic list rather than an error —
 * this whole feature is optional, and an installation that's never
 * set it up (or a fresh checkout before anyone's populated it) should
 * still run normally, just with nothing to offer in the compare-mode
 * dropdown. A file that exists but is malformed (bad JSON, or missing
 * the top-level "topics" array) throws instead, since that's a real
 * configuration mistake worth surfacing rather than silently ignoring.
 *
 * @returns {{defaultCompareInstruction?: string, topics: Array<{id: string, label: string, description?: string, compareInstruction?: string, attributes: Array<{name: string, proposal: string}>}>}}
 */
function loadTopics() {
  if (!fs.existsSync(IDEAL_PROPOSALS_PATH)) return { topics: [] };

  const raw = fs.readFileSync(IDEAL_PROPOSALS_PATH, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`idealProposals.json is not valid JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.topics)) {
    throw new Error('idealProposals.json must have a top-level "topics" array.');
  }
  return data;
}

/**
 * Lean summary of every topic, for populating the Ask form's dropdown:
 * id (the value actually submitted back in a query) plus label and
 * description (display only). Deliberately excludes attributes and
 * compareInstruction — the browser only ever needs to say WHICH topic
 * was picked, never the substance of it. The actual "ideal" content
 * stays server-side and is folded in only when a query names that
 * topic's id, the same "client sends a name/id, server resolves the
 * behavior" pattern chatModel and embedModel already use.
 * @returns {Array<{id: string, label: string, description: string|undefined}>}
 */
function listTopicSummaries() {
  return loadTopics().topics.map(({ id, label, description }) => ({ id, label, description }));
}

/**
 * Looks up one topic by id, full detail included — used server-side
 * once a query actually requests this topic. Returns undefined if no
 * topic with that id exists (including when idealProposals.json is
 * missing entirely).
 *
 * The returned topic's `compareInstruction` is always populated,
 * resolved through a three-level fallback: the topic's own
 * `compareInstruction` if it set one (the rare case — a topic that
 * genuinely needs different phrasing from every other topic), else
 * the file's top-level `defaultCompareInstruction` (the normal case —
 * one general instruction, hand-editable in idealProposals.json,
 * shared by every topic that doesn't override it), else
 * HARDCODED_FALLBACK_COMPARE_INSTRUCTION as a last resort if the file
 * doesn't define a file-level default either. Resolving this here,
 * once, keeps composeComparisonQuestion() below simple — it just reads
 * `topic.compareInstruction` and doesn't need to know this fallback
 * chain exists at all.
 * @param {string} id
 * @returns {object|undefined}
 */
function getTopic(id) {
  const data = loadTopics();
  const topic = data.topics.find((t) => t.id === id);
  if (!topic) return undefined;
  return {
    ...topic,
    compareInstruction:
      topic.compareInstruction || data.defaultCompareInstruction || HARDCODED_FALLBACK_COMPARE_INSTRUCTION,
  };
}

/**
 * Turns one topic into the actual text folded into the question for a
 * comparison query — this is "approach 1" from README.md's "Comparing
 * against an ideal proposal" section: the result of this function
 * becomes (or is very nearly) the `question` passed to both embed()
 * and buildRagMessages() in index.js. That's what makes this approach
 * different from just adding an instruction to the system prompt —
 * because this text is what gets embedded for retrieval, selecting a
 * topic actually steers WHICH chunks get retrieved from the document
 * under review toward passages relevant to these attributes, not just
 * how the model is told to talk about whatever got retrieved anyway.
 *
 * @param {object} topic - as returned by getTopic() — note that its
 *   `compareInstruction` is expected to already be resolved (getTopic()
 *   does this), so passing a raw topic object pulled directly out of
 *   loadTopics().topics instead would skip the file-level-default and
 *   per-topic-override fallback chain; the `|| HARDCODED_FALLBACK...`
 *   below only guards the (unlikely) case of `compareInstruction`
 *   being missing entirely, e.g. from such a raw/unresolved object.
 * @param {string} [userQuestion] - whatever the user additionally typed
 *   into the question box, if anything. Appended as extra guidance
 *   rather than replacing the topic's own content, so a reviewer can
 *   still narrow a comparison ("...focusing especially on the
 *   environmental review process") without losing the rest of the
 *   ideal attributes.
 * @param {Array<{name: string, proposal: string}>} [attributesOverride] -
 *   a subset of the topic's attributes to fold in instead of the whole
 *   list — this is what makes per-batch comparison questions possible
 *   (see batchAttributes() below and the "attributes per call" setting
 *   in index.js's /query and /query/stream). Omit to use every one of
 *   the topic's attributes, i.e. today's un-batched behavior.
 * @returns {string}
 */
function composeComparisonQuestion(topic, userQuestion, attributesOverride) {
  const attributes = attributesOverride || topic.attributes || [];
  const attributeLines = attributes
    .map((a) => `- ${a.name}: ${a.proposal}`)
    .join('\n');

  const instruction = topic.compareInstruction || HARDCODED_FALLBACK_COMPARE_INSTRUCTION;

  const parts = [
    `An ideal ${topic.label} proposal has the following attributes:`,
    attributeLines,
    instruction,
  ];

  if (userQuestion && userQuestion.trim()) {
    parts.push(`Additional guidance from the reviewer: ${userQuestion.trim()}`);
  }

  return parts.join('\n\n');
}

/**
 * Splits a topic's attributes into batches for the "attributes per
 * call" Advanced setting — the fix for a comparison with a lot of
 * attributes growing one giant question (and one giant embed+chat
 * call) without bound. Each batch becomes its own retrieval + chat
 * call in index.js's /query and /query/stream, via its own
 * composeComparisonQuestion(topic, question, batch) call.
 *
 * @param {Array<{name: string, proposal: string}>} attributes
 * @param {number} [attributesPerCall] - how many attributes per batch.
 *   Follows the same "blank/0 means don't restrict" convention as
 *   maxTokens and numCtx elsewhere in this app: undefined, 0, a
 *   negative number, or a number at least as large as the attribute
 *   count all just mean "one batch with everything" — today's
 *   behavior, unchanged. Anything else splits `attributes` into
 *   consecutive chunks of that size (the last chunk may be smaller).
 * @returns {Array<Array<{name: string, proposal: string}>>} always at
 *   least one batch (an empty array if `attributes` itself is empty),
 *   so callers can always do `for (const batch of batchAttributes(...))`
 *   without a special case for "no topic"/"no attributes".
 */
function batchAttributes(attributes, attributesPerCall) {
  const list = attributes || [];
  if (!attributesPerCall || attributesPerCall <= 0 || attributesPerCall >= list.length) {
    return [list];
  }
  const batches = [];
  for (let i = 0; i < list.length; i += attributesPerCall) {
    batches.push(list.slice(i, i + attributesPerCall));
  }
  return batches;
}

module.exports = {
  loadTopics,
  listTopicSummaries,
  getTopic,
  composeComparisonQuestion,
  batchAttributes,
  HARDCODED_FALLBACK_COMPARE_INSTRUCTION,
};
