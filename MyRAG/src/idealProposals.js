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
  'Compare the proposal (between the PROPOSAL START and PROPOSAL END markers ' +
  'you were given separately) against the rubric (between the RUBRIC START and ' +
  'RUBRIC END markers above). For each attribute, note whether the ' +
  'proposal matches, falls short of, or exceeds the rubric, and flag ' +
  'anything the rubric calls for that the proposal does not appear to ' +
  'address at all.';

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
 * @returns {{defaultCompareInstruction?: string|string[], topics: Array<{id: string, label: string, description?: string, compareInstruction?: string|string[], attributes: Array<{name: string, proposal: string}>}>}}
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
 * Writes `data` to idealProposals.json, replacing its entire contents —
 * the save-side counterpart to loadTopics(), following the same "just
 * a file" philosophy documented in this module's own header comment:
 * no locking, no partial/merge writes, no in-memory cache to keep in
 * sync. Every route in index.js that creates, overwrites, or deletes a
 * topic (see the Rubric Control feature in README.md) follows the same
 * read-modify-write pattern: loadTopics() to get the current contents,
 * change just the `topics` array in memory, then saveTopics() the
 * whole thing back — so defaultCompareInstruction and any other
 * top-level field a person hand-edited into the file are preserved
 * automatically as long as callers always start from a fresh
 * loadTopics() rather than constructing `data` from scratch.
 *
 * Minimal shape validation only (a top-level "topics" array) — same
 * bar loadTopics() itself enforces, not full per-topic schema
 * checking, since the route handlers above this already validate the
 * specific fields they accept from a request body before ever
 * reaching here.
 *
 * @param {{defaultCompareInstruction?: string|string[], topics: Array<Object>}} data
 * @throws {Error} if `data` doesn't have a top-level "topics" array.
 */
function saveTopics(data) {
  if (!data || !Array.isArray(data.topics)) {
    throw new Error('Cannot save idealProposals.json: data must have a top-level "topics" array.');
  }
  fs.writeFileSync(IDEAL_PROPOSALS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
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
 * `attributeCount` is included too (added for the Rubric Control UI's
 * topic list — see index.html/script.js — so it can show how many
 * attributes each topic has without a second request per topic); it's
 * a harmless addition for the Ask form's dropdown, which simply never
 * reads that field.
 * @returns {Array<{id: string, label: string, description: string|undefined, attributeCount: number}>}
 */
function listTopicSummaries() {
  return loadTopics().topics.map(({ id, label, description, attributes }) => ({
    id,
    label,
    description,
    attributeCount: Array.isArray(attributes) ? attributes.length : 0,
  }));
}

/**
 * Normalizes a `compareInstruction`/`defaultCompareInstruction` value
 * from idealProposals.json into a single string. Accepts either form
 * the JSON field can take: the original plain string, or an array of
 * paragraph strings — one array entry per paragraph, joined back
 * together with a blank line between them. The array form exists
 * purely for readability/hand-editing: a long instruction as one
 * escaped, line-wrapped JSON string (every paragraph break written
 * out as a literal `\n\n`) is genuinely hard to read or edit by hand;
 * as an array, each paragraph is just its own line in the file, no
 * `\n` escaping needed anywhere (JSON's usual `"` escaping inside a
 * paragraph's own text still applies either way — that's unavoidable
 * in JSON regardless of which form is used).
 *
 * @param {string|string[]|undefined} value
 * @returns {string|undefined} undefined if `value` was missing or
 *   neither a string nor an array — callers' own fallback chains
 *   (see getTopic() below) still apply in that case.
 */
function resolveInstructionText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((p) => typeof p === 'string').join('\n\n');
  }
  return undefined;
}

/**
 * Looks up one topic by id, full detail included — used server-side
 * once a query actually requests this topic. Returns undefined if no
 * topic with that id exists (including when idealProposals.json is
 * missing entirely).
 *
 * The returned topic's `compareInstruction` is always populated (as a
 * single string, whichever form it was written in — see
 * resolveInstructionText() above), resolved through a three-level
 * fallback: the topic's own `compareInstruction` if it set one (the
 * rare case — a topic that genuinely needs different phrasing from
 * every other topic), else the file's top-level
 * `defaultCompareInstruction` (the normal case — one general
 * instruction, hand-editable in idealProposals.json, shared by every
 * topic that doesn't override it), else HARDCODED_FALLBACK_COMPARE_INSTRUCTION
 * as a last resort if the file doesn't define a file-level default
 * either. Resolving this here, once, keeps composeComparisonQuestion()
 * below simple — it just reads `topic.compareInstruction` as a plain
 * string and doesn't need to know either this fallback chain or the
 * string-vs-array question exists at all.
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
      resolveInstructionText(topic.compareInstruction) ||
      resolveInstructionText(data.defaultCompareInstruction) ||
      HARDCODED_FALLBACK_COMPARE_INSTRUCTION,
  };
}

/**
 * Turns one topic into the actual text folded into the question for a
 * comparison query — this is "approach 1" from README.md's "Comparing
 * against an ideal proposal" section: the result of this function
 * becomes (or is very nearly) the `question` passed to
 * buildRagMessages() in index.js, i.e. the literal user-turn message
 * the chat model sees. That's what makes this approach different from
 * just adding an instruction to the system prompt — selecting a topic
 * steers not just how the model is told to talk about whatever got
 * retrieved, but (via composeRetrievalQuery() below, NOT this
 * function — see its own doc comment for why the two are deliberately
 * different texts) which chunks get retrieved in the first place.
 *
 * IMPORTANT: despite the "approach 1" framing above, this function's
 * output is no longer what gets embedded for retrieval — only what
 * gets sent to the chat model. It used to be both (hence the doc
 * comments elsewhere still describing this as "the text that drives
 * both retrieval and the prompt"), until a real failure surfaced the
 * problem with that: this text includes not just the attribute(s)
 * being asked about but the RUBRIC START/END wrapper, the scopeGuard
 * sentence, and every paragraph of compareInstruction — a few hundred
 * words of "compare the rubric to the proposal, note whether it
 * matches, falls short of, or exceeds..." instructional boilerplate
 * that's nearly IDENTICAL across every attribute in every topic.
 * Embedding all of that pulls the query embedding toward that shared
 * boilerplate and away from the attribute's own specific subject
 * matter, which in practice retrieved a chunk of generic "nature-based
 * solutions" text for a rubric item specifically about wind-buffering
 * wetlands — a chunk a plain, bare-attribute-text search (what
 * composeRetrievalQuery() below now provides instead) did not
 * retrieve at all. See composeRetrievalQuery()'s doc comment for the
 * full reasoning, and the "Comparing against an ideal proposal"
 * section of README.md for the write-up of this split.
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

  // Wrapped in explicit start/end markers rather than just left as a
  // list a compareInstruction refers back to with a word like "above"
  // — a purely positional reference like that is exactly the kind of
  // thing a small/weak chat model can lose track of once there's a
  // system message, a batch of proposal text, and this instruction
  // all competing for its attention. A named landmark ("the list
  // between RUBRIC START and RUBRIC END") is unambiguous regardless of
  // model size or how this question gets batched. See buildRagMessages()
  // in index.js for the matching PROPOSAL START/PROPOSAL END markers
  // around the retrieved document material this gets compared against
  // — both use two plain words rather than a colon-suffixed single
  // label like "RUBRIC:", specifically so neither marker resembles a
  // `[Source: file, chunk N]` citation tag closely enough for a weak
  // model to cite the marker itself by mistake (see buildRagMessages()'
  // own doc comment for the real failure this caused before that fix).
  const rubricBlock = `RUBRIC START\n${attributeLines}\nRUBRIC END`;

  // A separate, code-generated guard against a real failure mode seen
  // in practice even with a single-attribute batch (attributesPerCall
  // set to 1, so the model is asked about exactly ONE attribute and
  // nothing else is even in the rubric block above): a weak model
  // still went on to invent commentary about a DIFFERENT attribute id
  // it was never given ("HW2 is not present in this proposal..."),
  // apparently free-associating from naming patterns in the source
  // material or its own training rather than anything actually in
  // this prompt. Naming the exact attribute(s) actually in play here,
  // in plain generated text rather than relying on the (user-edited,
  // easy to fall out of sync) compareInstruction to cover this case,
  // gives the model one more concrete, hard-to-misread anchor for
  // what it's allowed to talk about. This doesn't guarantee
  // compliance from every model — nothing here can force that — but
  // costs nothing to include, and responseParser.js's quote-boundary
  // trimming (see its module doc comment) already discards whatever
  // a model says about other attributes after its real answer, so
  // this is a second layer on top of that safety net, not a
  // replacement for it.
  const attributeNames = attributes.map((a) => `"${a.name}"`).join(', ');
  const scopeGuard = attributes.length === 1
    ? `You are being asked about exactly one attribute right now: ${attributeNames}. Do not mention, evaluate, compare against, or speculate about any other attribute or rubric item — not one from a previous question, not one you recognize from the source material's own structure or numbering, and not one from your own general knowledge — even if it seems related. Respond only about ${attributeNames} and nothing else.`
    : `You are being asked about exactly these attributes right now, and no others: ${attributeNames}. Do not mention, evaluate, compare against, or speculate about any other attribute or rubric item — not one from a previous question, not one you recognize from the source material's own structure or numbering, and not one from your own general knowledge — even if it seems related.`;

  const parts = [
    `An ideal ${topic.label} proposal has the following attributes:`,
    rubricBlock,
    scopeGuard,
    instruction,
  ];

  if (userQuestion && userQuestion.trim()) {
    parts.push(`Additional guidance from the reviewer: ${userQuestion.trim()}`);
  }

  return parts.join('\n\n');
}

/**
 * Builds JUST the text that should be embedded for retrieval when a
 * comparison topic is active — deliberately NOT composeComparisonQuestion()
 * above, which is what actually gets sent to the chat model as the
 * user-turn message. The two used to be the same text (one function,
 * doing double duty), until a real case showed why that was a bug:
 * composeComparisonQuestion()'s output is mostly instructional
 * boilerplate — the RUBRIC START/END wrapper, the scopeGuard sentence,
 * and every paragraph of compareInstruction ("compare the rubric to
 * the proposal, note whether it matches, falls short of, or
 * exceeds...") — and that boilerplate is nearly IDENTICAL across every
 * attribute in every topic. Embedding all of it for retrieval pulls
 * the query embedding toward that shared instructional language and
 * away from the attribute's own specific subject matter, diluting
 * exactly the signal retrieval depends on.
 *
 * The concrete failure this caused, confirmed by directly comparing
 * retrieved chunks with retrievalQuery exposed in the UI (see the
 * "sources" event in index.js): a rubric item asking specifically
 * about "coastal wetlands or dune systems that buffer WIND impacts"
 * retrieved a chunk of generic "nature-based solutions" boilerplate
 * (ecosystems, biodiversity, reciprocity with the land — nothing
 * about wind specifically) when run through comparison mode, but
 * correctly came back "I do not have that information" when the exact
 * same substantive question was typed directly into the plain Ask
 * form. Both requests searched the same store — the only real
 * difference was what text got embedded to search it. This function
 * makes comparison mode do the same thing the plain form already did
 * correctly: embed only the substance being searched for, not the
 * instructions about how to answer once something's found. The chat
 * model still receives the FULL composeComparisonQuestion() text
 * (with every instruction intact) as its own separate message — this
 * only changes what steers retrieval.
 *
 * IMPORTANT: this deliberately embeds ONLY each attribute's `proposal`
 * text, NOT its `name`. That wasn't the original design — an earlier
 * version embedded `"<name>: <proposal>"`, on the reasoning that the
 * name might carry useful searchable context too — but comparing
 * retrieved chunks side by side (same store, three retrieval texts:
 * bare proposal text, "<name>: <proposal>", and the full
 * composeComparisonQuestion() output) proved that was itself the
 * entire remaining source of drift once the instructional boilerplate
 * was already removed: `name` fields built by joining several
 * spreadsheet columns (e.g. "HW10 - Adaptation Strategies &
 * Long-Term Actions - Nature-based solutions" — see
 * excel_to_json.py's JOIN_SEPARATOR) carry broad category language
 * ("Adaptation Strategies," "Nature-based solutions") that's shared
 * across many attributes in the same category, and prepending it
 * pulled the retrieval embedding toward that shared category instead
 * of staying anchored to the specific proposal sentence — "<name>:
 * <proposal>" and the full instructional text retrieved the identical
 * (wrong) chunk set, while the bare proposal text alone retrieved the
 * same chunks as typing the sentence directly into the plain Ask
 * form. `name` is still what gets shown to the person (in the rubric
 * block, in the results table, everywhere else) — it's excluded ONLY
 * from what gets embedded here.
 *
 * @param {object} topic
 * @param {string} [userQuestion] - same meaning as in
 *   composeComparisonQuestion() above — folded in here too, so a
 *   reviewer's own typed guidance still steers retrieval, not just the
 *   model's eventual answer.
 * @param {Array<{name: string, proposal: string}>} [attributesOverride] -
 *   same meaning as in composeComparisonQuestion() above — this batch's
 *   attributes, or every one of the topic's if omitted.
 * @returns {string}
 */
function composeRetrievalQuery(topic, userQuestion, attributesOverride) {
  const attributes = attributesOverride || topic.attributes || [];
  // `|| a.name` is only a last-resort fallback for a malformed
  // attribute with no `proposal` text at all — normal attributes
  // always have one, and this never adds `name` alongside a `proposal`
  // that's already there (see the doc comment above for why not).
  const attributeLines = attributes
    .map((a) => a.proposal || a.name || '')
    .filter(Boolean)
    .join('\n');

  return userQuestion && userQuestion.trim()
    ? `${attributeLines}\n\n${userQuestion.trim()}`
    : attributeLines;
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
  saveTopics,
  listTopicSummaries,
  getTopic,
  composeComparisonQuestion,
  composeRetrievalQuery,
  batchAttributes,
  resolveInstructionText,
  HARDCODED_FALLBACK_COMPARE_INSTRUCTION,
};
