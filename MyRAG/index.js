const path = require('path');

// Loads a .env file (if one exists) into process.env — this has to run
// BEFORE any of this app's own modules are required below, since a few
// of them (src/basicAuth.js's AUTH_USER/AUTH_PASSWORD/AUTH_USERS,
// src/ollamaClient.js's OLLAMA_BASE_URL) read process.env once, at
// require-time, not on every request; requiring them first would mean
// they'd only ever see whatever was ALREADY in the environment before
// this line ran. Pointed explicitly at a .env file next to this script
// (`__dirname`), not dotenv's own default of "whatever the current
// working directory happens to be when `node`/`npm start` was
// launched from" — that default would silently stop finding the file
// the moment this app is ever started from a different working
// directory (a systemd service, a scheduled task, a different shell),
// which is exactly the kind of "works on my machine" footgun worth
// avoiding here. A variable already set in the real environment is
// left alone — dotenv doesn't override those with the .env file's
// value — so an explicit `$env:AUTH_USERS=...` before launching still
// takes priority over whatever .env says, same as most tools behave.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { extractText, SUPPORTED_EXTENSIONS } = require('./src/extract');
const { chunkText } = require('./src/chunker');
const { embed, chat, listModels } = require('./src/ollamaClient');
const { listDocuments, getChunk, listChunksForDocument, deleteDocument } = require('./src/store');
const { hybridSearch } = require('./src/hybridSearch');
const { embedDocumentIntoWorkspace, rebuildWorkspaceIndex } = require('./src/embedPipeline');
const { isValidWorkspaceId, listWorkspaces, ensureUploadsDir, deleteWorkspace } = require('./src/workspace');
const { loadTopics, saveTopics, listTopicSummaries, getTopic, composeComparisonQuestion, composeRetrievalQuery, batchAttributes, getIncludedAttributes, buildRubricMatches, resolveInstructionText, HARDCODED_FALLBACK_COMPARE_INSTRUCTION } = require('./src/idealProposals');
const { loadBestPracticeAttributes } = require('./src/bestPractices');
const { filterBestPracticeAttributes, listDistinctHazards, listDistinctStates } = require('./src/bestPracticesFilter');
const { parseComparisonAnswer, RETRY_TRIGGER_VERDICTS, mergeRetryRecord, verdictRank, verifyQuotesInPlace } = require('./src/responseParser');
const { inspectWorkbook, convertSheetToAttributes } = require('./src/xlsxImport');
const { logQueryActivity, logAction } = require('./src/activityLog');
const { getAllDescriptions, setDescription, deleteDescription, getExcludedSourceFiles, setIncluded } = require('./src/documentMeta');
const { isValidLogFileName, listLogFiles, summarizeLogFile, getLogEntry, getLogEntryAnswer } = require('./src/logViewer');
const { basicAuth, resolveRole } = require('./src/basicAuth');
const { sendRubricCompletionEmail } = require('./src/emailNotify');

const app = express();

// Mounted first, ahead of everything else — including express.static
// below — so nothing in the app (the UI's own HTML/JS/CSS included) is
// reachable without a valid credential once one is configured. See
// src/basicAuth.js for the full design: this is a no-op (nothing is
// gated) unless AUTH_USER/AUTH_PASSWORD or AUTH_USERS is set in the
// environment, so local, everyday testing keeps working with zero
// config exactly as before.
app.use(basicAuth);

app.use(express.json());

// Serves public/index.html (and anything else dropped in public/) as
// plain static files. This is the whole "web UI" — no build step, no
// framework, just a page that calls the same /query endpoint you've
// been hitting with Invoke-RestMethod. Visiting http://localhost:PORT/
// in a browser loads it automatically (express.static serves
// index.html for the root path by default).
app.use(express.static(path.join(__dirname, 'public')));

// Sanity check — confirms the server is up before we test anything real.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * GET /auth/me
 *
 * The one small server-side piece the client-side-only role UI (see
 * script.js's applyRolePermissions()) actually needs: a way to find
 * out who's logged in at all. The browser's own Basic Auth credential
 * (the native login prompt) is never readable by a page's own
 * JavaScript — there's no DOM/Fetch API that exposes an
 * `Authorization` header the browser is resending on every request —
 * even though basicAuth() middleware above already decodes it into
 * req.authUser on the server for every request, for the activity log.
 * This route just hands that back, plus the role it resolves to
 * (resolveRole() in src/basicAuth.js, built from the AUTH_ROLES env
 * var — see that file for the full username->role design and its
 * "no server-side enforcement yet" caveat). No other route changes
 * behavior based on role; this is purely so the page can decide what
 * to show.
 */
app.get('/auth/me', (req, res) => {
  res.json({ user: req.authUser || null, role: resolveRole(req.authUser) });
});

/**
 * GET /workspaces
 *
 * Lists existing workspace ids, so a UI can offer "pick an existing
 * workspace or type a new one" instead of the caller having to already
 * know what's out there. A workspace doesn't need any special
 * "creation" step — it comes into existence the first time something
 * is embedded into it (see /embed below).
 */
app.get('/workspaces', (req, res) => {
  res.json({ workspaces: listWorkspaces() });
});

/**
 * GET /models
 *
 * Lists models currently pulled in this Ollama installation, so the
 * UI's chat-model picker shows what's actually available instead of a
 * hardcoded guess. Deliberately NOT used for the embedding model — see
 * the long comment on embedDocumentIntoWorkspace's embedModel handling
 * for why that one stays fixed rather than becoming a per-query choice.
 */
app.get('/models', async (req, res) => {
  try {
    const models = await listModels();
    res.json({ models });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /ideal-proposals
 *
 * Lists the "ideal proposal" comparison topics defined in
 * idealProposals.json at the project root — see src/idealProposals.js
 * and the "Comparing against an ideal proposal" section in README.md
 * for the full design. Populates the Ask form's optional compare-mode
 * dropdown. Only id/label/description come back here; each topic's
 * actual attributes and compareInstruction stay server-side and are
 * only folded into a query when that query names the topic's id via
 * `idealTopicId` on /query or /query/stream. A missing or not-yet-
 * populated idealProposals.json just yields an empty list, not an
 * error — this feature is entirely optional.
 */
app.get('/ideal-proposals', (req, res) => {
  try {
    res.json({ topics: listTopicSummaries() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /best-practices/filters
 *
 * Every distinct hazard and state value actually present in
 * bestPractices.json, for populating the Best Practices Comparison
 * tab's Hazard/State dropdowns straight from whatever the loaded
 * dataset actually contains (see listDistinctHazards()/
 * listDistinctStates() in src/bestPracticesFilter.js) — same
 * "server resolves the real list, browser just shows it" pattern
 * /ideal-proposals above already uses for topics. A missing
 * bestPractices.json yields `{hazards: [], states: []}`, not an
 * error — same "this feature is entirely optional" treatment
 * idealProposals.json gets above, via loadBestPracticeAttributes()
 * already returning [] for a missing file.
 */
app.get('/best-practices/filters', (req, res) => {
  try {
    const attributes = loadBestPracticeAttributes();
    res.json({
      hazards: listDistinctHazards(attributes),
      states: listDistinctStates(attributes),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /best-practices/preview
 *
 * Live preview for the Best Practices Comparison tab's Hazard/State
 * multi-selects: given the same {hazards, states} shape the Hazard/
 * State selections are already sent as in `bestPracticesFilter` (see
 * buildBestPracticesTopic() below), re-filters bestPractices.json with
 * the exact same filterBestPracticeAttributes() and reports back how
 * many -- and which -- entries would be compared, WITHOUT actually
 * running a comparison: no workspaceId, no retrieval, no chat call.
 * This is what lets the UI show "N items currently in the comparison
 * list" (and preview their names) the moment a hazard/state selection
 * changes, rather than only finding out how many entries matched after
 * clicking Compare and waiting for the first batch.
 *
 * Deliberately returns the FULL matching attribute list in this one
 * response, not just `count` -- see bestPracticesTab.js's
 * renderPreview()/showPreviewDetail() for why: the UI needs every
 * matching entry's full text in hand so that clicking any one name
 * later shows its full text INSTANTLY, with no second round trip per
 * click. Sending the full list unconditionally, every time the
 * selection changes, is deliberately not gated by match count on this
 * end -- even the largest realistic match count here (order of a few
 * hundred rows, well short of the full ~747-row sheet, since a real
 * selection always narrows by at least one hazard) is a small JSON
 * payload for a server and browser both running locally. The
 * "under ~200, show the names; 200 or more, show a button first"
 * split the user actually sees is purely a rendering choice the
 * browser makes with data it already has -- see renderPreview() --
 * never a reason to ask this endpoint for less.
 *
 * Body: { hazards: string[], states?: string[] }
 * Response: { count: number, entries: Array<Object> } -- `entries` is
 *   every matching attribute object exactly as
 *   loadBestPracticeAttributes() returns it (name, proposal, state,
 *   hazards, sectors, commitmentLevels, scope, fundingStatus,
 *   fundingSource, status, url, notes), in filterBestPracticeAttributes()'s
 *   usual original-sheet order.
 */
app.post('/best-practices/preview', (req, res) => {
  const { hazards, states } = req.body || {};
  if (!Array.isArray(hazards) || hazards.length === 0) {
    return res.status(400).json({ error: 'hazards (a non-empty array) is required.' });
  }
  try {
    const allAttributes = loadBestPracticeAttributes();
    const entries = filterBestPracticeAttributes(allAttributes, { hazards, states });
    res.json({ count: entries.length, entries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Could not load bestPractices.json: ${err.message}` });
  }
});

// Same allowlist-pattern approach isValidWorkspaceId() uses in
// workspace.js — a topic id never touches the filesystem directly (it
// only ever lives inside idealProposals.json), but keeping it to the
// same simple, URL-safe character set means it can always be used as
// a route param (see :topicId below) and never needs any special
// escaping/decoding beyond the usual encodeURIComponent().
const TOPIC_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function isValidTopicId(id) {
  return typeof id === 'string' && TOPIC_ID_PATTERN.test(id);
}

/**
 * Shared validation for one attribute row ({name, proposal, included?})
 * submitted from the Rubric Control UI or produced by the xlsx
 * importer. `name` and `proposal` are required, non-empty strings — an
 * attribute with no proposal text is meaningless (there's nothing to
 * compare a document against), and one with no name can't be told
 * apart from any other in the results table or CSV. `included`, when
 * present at all, must be an actual boolean — it's optional precisely
 * so older callers (and the xlsx importer) that don't know about this
 * field yet can keep omitting it; see isAttributeIncluded() in
 * src/idealProposals.js for the "missing means true" default this
 * enables.
 * @param {*} attributes
 * @returns {string|null} an error message, or null if every attribute is valid
 */
function attributesError(attributes) {
  if (!Array.isArray(attributes)) return '"attributes" must be an array';
  for (let i = 0; i < attributes.length; i++) {
    const a = attributes[i];
    if (!a || typeof a !== 'object') return `attributes[${i}] must be an object`;
    if (typeof a.name !== 'string' || !a.name.trim()) return `attributes[${i}].name is required`;
    if (typeof a.proposal !== 'string' || !a.proposal.trim()) return `attributes[${i}].proposal is required`;
    if ('included' in a && typeof a.included !== 'boolean') return `attributes[${i}].included must be a boolean`;
  }
  return null;
}

/**
 * Normalizes a validated attributes array before it's persisted to
 * idealProposals.json: every attribute saved through the app from here
 * on carries an explicit `included` boolean (defaulting a missing
 * value to `true`), rather than relying on isAttributeIncluded()'s
 * "missing means true" fallback forever. Pre-existing entries in the
 * file that this route never touches keep relying on that fallback
 * until they're next saved — this only normalizes what's actually
 * being written right now.
 * @param {Array<{name: string, proposal: string, included?: boolean}>} attributes
 * @returns {Array<{name: string, proposal: string, included: boolean}>}
 */
function normalizeAttributesForSave(attributes) {
  return (attributes || []).map((a) => ({ ...a, included: a.included !== false }));
}

/**
 * GET /ideal-proposals/:topicId
 *
 * Full detail for one topic, for the Rubric Control UI's edit form —
 * deliberately NOT getTopic() from idealProposals.js, which resolves
 * compareInstruction through its file-level-default/hardcoded-fallback
 * chain for use in an actual comparison prompt. An edit form needs the
 * topic's own raw stored fields instead (compareInstruction present
 * only if this topic actually set one), so saving it back doesn't bake
 * a resolved fallback string into a topic that never had its own
 * override.
 */
app.get('/ideal-proposals/:topicId', (req, res) => {
  const { topicId } = req.params;
  if (!isValidTopicId(topicId)) return res.status(400).json({ error: 'Invalid topic id' });

  try {
    const data = loadTopics();
    const topic = data.topics.find((t) => t.id === topicId);
    if (!topic) return res.status(404).json({ error: `No topic with id "${topicId}"` });
    res.json({ topic });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /ideal-proposals
 * Body: { id, label, attributes: [{name, proposal}, ...], description?, compareInstruction? }
 *
 * Creates a brand new topic in idealProposals.json. `id` is fixed at
 * creation — there is deliberately no rename support (see PUT below,
 * which can overwrite everything about a topic except its id) —
 * matching what was decided for the Rubric Control feature: a topic's
 * id is its permanent identity, so anything that already refers to a
 * topic by id (a saved query, a script) keeps working even after its
 * label/description/attributes are edited.
 */
app.post('/ideal-proposals', (req, res) => {
  const { id, label, description, attributes, compareInstruction } = req.body || {};

  if (!isValidTopicId(id)) {
    return res.status(400).json({ error: 'id is required and may only contain letters, numbers, hyphens, and underscores (max 64 characters)' });
  }
  if (typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  const attrErr = attributesError(attributes || []);
  if (attrErr) return res.status(400).json({ error: attrErr });

  try {
    const data = loadTopics();
    if (data.topics.some((t) => t.id === id)) {
      return res.status(409).json({ error: `A topic with id "${id}" already exists` });
    }

    const topic = { id, label: label.trim(), attributes: normalizeAttributesForSave(attributes) };
    if (description && description.trim()) topic.description = description.trim();
    if (compareInstruction && compareInstruction.trim()) topic.compareInstruction = compareInstruction.trim();

    data.topics.push(topic);
    saveTopics(data);
    logAction({ req, type: 'rubricTopicCreate', success: true, details: { topicId: id, label: topic.label, attributeCount: topic.attributes.length } });
    res.status(201).json({ topic });
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'rubricTopicCreate', success: false, error: err.message, details: { topicId: id } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /ideal-proposals/:topicId
 * Body: { label, attributes: [{name, proposal}, ...], description?, compareInstruction? }
 *
 * Overwrites an existing topic's label/description/attributes/
 * compareInstruction in place — :topicId itself is immutable (no
 * rename support; see POST above). This always fully replaces the
 * topic's attributes array rather than merging with what was there
 * before, matching the explicit decision for both manual edits and
 * xlsx-import saves: an xlsx import represents the complete current
 * state of that rubric, so a save from it should leave the topic with
 * exactly those attributes, not the union of old and new.
 */
app.put('/ideal-proposals/:topicId', (req, res) => {
  const { topicId } = req.params;
  if (!isValidTopicId(topicId)) return res.status(400).json({ error: 'Invalid topic id' });

  const { label, description, attributes, compareInstruction } = req.body || {};
  if (typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  const attrErr = attributesError(attributes || []);
  if (attrErr) return res.status(400).json({ error: attrErr });

  try {
    const data = loadTopics();
    const index = data.topics.findIndex((t) => t.id === topicId);
    if (index === -1) return res.status(404).json({ error: `No topic with id "${topicId}"` });

    const topic = { id: topicId, label: label.trim(), attributes: normalizeAttributesForSave(attributes) };
    if (description && description.trim()) topic.description = description.trim();
    if (compareInstruction && compareInstruction.trim()) topic.compareInstruction = compareInstruction.trim();

    data.topics[index] = topic;
    saveTopics(data);
    logAction({ req, type: 'rubricTopicUpdate', success: true, details: { topicId, label: topic.label, attributeCount: topic.attributes.length } });
    res.json({ topic });
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'rubricTopicUpdate', success: false, error: err.message, details: { topicId } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /ideal-proposals/:topicId
 *
 * Removes a topic from idealProposals.json entirely. No confirmation
 * step server-side, same convention as DELETE /workspaces/:workspaceId
 * — the browser UI asks before ever sending this request.
 */
app.delete('/ideal-proposals/:topicId', (req, res) => {
  const { topicId } = req.params;
  if (!isValidTopicId(topicId)) return res.status(400).json({ error: 'Invalid topic id' });

  try {
    const data = loadTopics();
    const index = data.topics.findIndex((t) => t.id === topicId);
    if (index === -1) return res.status(404).json({ error: `No topic with id "${topicId}"` });

    const [removed] = data.topics.splice(index, 1);
    saveTopics(data);
    logAction({ req, type: 'rubricTopicDelete', success: true, details: { topicId, label: removed.label } });
    res.json({ removed: { id: removed.id, label: removed.label } });
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'rubricTopicDelete', success: false, error: err.message, details: { topicId } });
    res.status(500).json({ error: err.message });
  }
});

// Transient, in-memory upload for the two xlsx-import routes below —
// deliberately NOT the disk-backed `upload` multer instance further
// down this file (used for actual document uploads). A rubric
// workbook isn't workspace-scoped and there's no ongoing reason to
// keep the raw spreadsheet around after it's been read once; holding
// it only in memory for the life of one request avoids ever writing it
// to disk at all.
const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — a rubric workbook is a small, mostly-text file; generous but not unbounded.
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx') {
      return cb(new Error(`Unsupported file type "${ext}". Only .xlsx is supported.`));
    }
    cb(null, true);
  },
});

/**
 * POST /ideal-proposals/xlsx-inspect
 * multipart/form-data: "file" (.xlsx)
 *
 * Lists a workbook's sheets and each sheet's header-row column names,
 * so the Rubric Control UI can offer real dropdowns for "which sheet"
 * and "which columns" instead of requiring someone to already know the
 * exact sheet/column names by heart the way excel_to_json.py's CLI
 * did. Read-only — nothing is written anywhere by this route.
 */
app.post('/ideal-proposals/xlsx-inspect', (req, res) => {
  uploadXlsx.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected form field "file")' });

    try {
      const sheets = await inspectWorkbook(req.file.buffer);
      res.json({ sheets });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: `Could not read workbook: ${err.message}` });
    }
  });
});

/**
 * POST /ideal-proposals/import-xlsx
 * multipart/form-data: "file" (.xlsx), plus text fields "sheet",
 * "nameColumns" (comma-separated, no spaces around the commas — same
 * format excel_to_json.py's CLI took), and "proposalColumn".
 *
 * Converts one sheet into an attribute list and returns it as a
 * PREVIEW — this route never touches idealProposals.json itself. The
 * Rubric Control UI loads the returned attributes into its editor so
 * they can be reviewed (and hand-adjusted, if needed) before an
 * explicit Save, which goes through POST or PUT /ideal-proposals
 * above and always fully replaces whatever attribute list was there.
 */
app.post('/ideal-proposals/import-xlsx', (req, res) => {
  uploadXlsx.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected form field "file")' });

    const { sheet, nameColumns, proposalColumn } = req.body;
    if (!sheet) return res.status(400).json({ error: 'sheet is required' });
    if (!nameColumns || !nameColumns.trim()) return res.status(400).json({ error: 'nameColumns is required' });
    if (!proposalColumn) return res.status(400).json({ error: 'proposalColumn is required' });

    try {
      const columns = nameColumns.split(',').map((c) => c.trim()).filter(Boolean);
      const result = await convertSheetToAttributes(req.file.buffer, sheet, columns, proposalColumn);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });
});

/**
 * GET /workspaces/:workspaceId/documents
 *
 * Lists the documents actually embedded in a workspace (grouped by
 * source filename, with a chunk count and page count per document) —
 * read-only, purely for a UI to show "what's in here." A workspace
 * that doesn't exist yet (nobody has embedded into it) just comes back
 * with an empty list rather than an error, same as /query treats it.
 */
app.get('/workspaces/:workspaceId/documents', (req, res) => {
  const { workspaceId } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  try {
    const descriptions = getAllDescriptions(workspaceId);
    // Same join-at-the-edge shape as `description` below: `included`
    // also lives in documentMeta.json (see getExcludedSourceFiles()'s
    // own doc comment there), merged in here rather than carried
    // inside listDocuments() itself. A document with no explicit
    // exclusion — which includes every brand-new document, since
    // nothing writes an entry here at embed time — correctly comes
    // back `included: true` simply by not being in this Set at all.
    const excludedSourceFiles = getExcludedSourceFiles(workspaceId);
    // documentMeta.json lives separately from store.json specifically
    // so it survives a rebuild/re-embed (see documentMeta.js) — merged
    // in here rather than carried inside listDocuments() itself, same
    // "join at the edge, keep the two files independent" shape as
    // store.js and documentMeta.js not knowing about each other at all.
    const documents = listDocuments(workspaceId).map((doc) => ({
      ...doc,
      description: descriptions[doc.sourceFile] || '',
      included: !excludedSourceFiles.has(doc.sourceFile),
    }));
    const totalChunks = documents.reduce((sum, d) => sum + d.chunks, 0);
    res.json({ workspaceId, documents, totalChunks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /workspaces/:workspaceId/documents/:sourceFile/description
 *
 * Sets (or, given an empty string, clears) one document's free-text
 * description — see src/documentMeta.js for why this is kept in its
 * own small file rather than inside store.json. :sourceFile must be
 * URL-encoded by the caller (the UI does this automatically), same as
 * the other per-document routes above.
 *
 * Like every other role-related behavior in this app so far (see
 * src/basicAuth.js's own doc comment, and the README's "Roles"
 * section), this route itself does NOT check who's calling — the
 * browser UI only shows the description field as editable for the
 * `admin` role (see renderDocuments() in script.js), but nothing here
 * stops a hand-built request from any role. A real per-route check
 * would need to look up the caller's role the same way GET /auth/me
 * does (resolveRole(req.authUser) in src/basicAuth.js) and reject
 * anything but 'admin' before reaching setDescription() — worth
 * doing if this ever needs to be a real boundary rather than a UI
 * nicety.
 */
app.put('/workspaces/:workspaceId/documents/:sourceFile/description', (req, res) => {
  const { workspaceId, sourceFile } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  const { description } = req.body;
  if (typeof description !== 'string') {
    return res.status(400).json({ error: '"description" must be a string.' });
  }

  try {
    const saved = setDescription(workspaceId, sourceFile, description);
    logAction({ req, type: 'documentDescriptionUpdate', workspaceId, success: true, details: { sourceFile, description: saved } });
    res.json({ workspaceId, sourceFile, description: saved });
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'documentDescriptionUpdate', workspaceId, success: false, error: err.message, details: { sourceFile } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /workspaces/:workspaceId/documents/:sourceFile/included
 *
 * Sets, or (given `true`, the default) clears, one document's
 * inclusion flag — whether its chunks are candidates for retrieval at
 * all in this workspace's /query and /query/stream runs (see
 * getExcludedSourceFiles() in src/documentMeta.js and its use in
 * hybridSearch() in src/hybridSearch.js). Modeled directly on the
 * `.../description` route just above: same per-document URL shape,
 * same persisted-in-documentMeta.json storage, same role posture (see
 * that route's own doc comment for the "not actually a security
 * boundary" caveat — the browser UI only shows this checkbox as
 * editable for the `admin` role, same as the description field, but
 * nothing here enforces that server-side).
 *
 * This is deliberately a per-workspace, shared setting, not a
 * per-user one — the same shape a saved Rubric Control topic's own
 * attribute-level Include checkboxes already have (anyone who opens
 * that topic sees, and is bound by, whatever its checkboxes are
 * currently set to). A document someone excludes here is excluded for
 * every person who queries this workspace afterward, not just the
 * person who unchecked it.
 */
app.put('/workspaces/:workspaceId/documents/:sourceFile/included', (req, res) => {
  const { workspaceId, sourceFile } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  const { included } = req.body;
  if (typeof included !== 'boolean') {
    return res.status(400).json({ error: '"included" must be a boolean.' });
  }

  try {
    const saved = setIncluded(workspaceId, sourceFile, included);
    logAction({ req, type: 'documentIncludedUpdate', workspaceId, success: true, details: { sourceFile, included: saved } });
    res.json({ workspaceId, sourceFile, included: saved });
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'documentIncludedUpdate', workspaceId, success: false, error: err.message, details: { sourceFile } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /workspaces/:workspaceId/chunks/:chunkId
 *
 * Fetches one chunk's full text on demand, by the same `id` (a
 * `"<sourceFile>::<chunkIndex>"` string) that sourcesSummary() now
 * includes in every /query and /query/stream response's sources list.
 * This is what powers the "click the chunk number to view its text"
 * modal in the browser UI — see getChunk() in store.js for why this is
 * a fetch-on-demand endpoint rather than sending every retrieved
 * chunk's full text up front with the query response itself.
 *
 * :chunkId must be URL-encoded by the caller (the UI does this
 * automatically) since it embeds a filename that can contain spaces,
 * parentheses, etc., plus the literal "::" separator.
 */
app.get('/workspaces/:workspaceId/chunks/:chunkId', (req, res) => {
  const { workspaceId, chunkId } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  try {
    const chunk = getChunk(workspaceId, chunkId);
    if (!chunk) {
      return res.status(404).json({ error: `No chunk found with id "${chunkId}" in workspace "${workspaceId}"` });
    }
    res.json(chunk);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /workspaces/:workspaceId/documents/:sourceFile/chunks
 *
 * Lists every chunk recorded for one document — shown to the user as
 * a "block", never a "chunk" (see public/script.js and index.html:
 * this app's UI language is "block" throughout; "chunk" stays an
 * internal/API implementation detail, matching the existing
 * GET .../chunks/:chunkId endpoint and getChunk() in store.js) — as
 * {chunkIndex, id} pairs, sorted ascending. This is what powers the
 * "pick a document, then pick a block, then view its text" lookup
 * tool on the "Documents in this area" panel: the browser calls this
 * once a document is picked to populate the block dropdown, then
 * reuses each entry's `id` directly against
 * GET /workspaces/:workspaceId/chunks/:chunkId above to fetch that
 * block's text — no separate id-construction step needed on the
 * client.
 *
 * :sourceFile must be URL-encoded by the caller (the UI does this
 * automatically), same as DELETE .../documents/:sourceFile below.
 * An unknown sourceFile isn't an error — it just comes back with an
 * empty `chunks` array, same "read-only summary, no such thing as a
 * 404 for an empty result" philosophy as GET .../documents above.
 */
app.get('/workspaces/:workspaceId/documents/:sourceFile/chunks', (req, res) => {
  const { workspaceId, sourceFile } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  try {
    const chunks = listChunksForDocument(workspaceId, sourceFile);
    res.json({ workspaceId, sourceFile, chunks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /workspaces/:workspaceId/documents/:sourceFile
 *
 * Removes every chunk belonging to one document from a workspace's
 * search index. :sourceFile must be URL-encoded by the caller (the UI
 * does this automatically) since filenames can contain characters like
 * spaces or parentheses.
 *
 * If the document was uploaded through this app (POST
 * /workspaces/:id/upload-and-embed), its underlying file under
 * workspaces/<id>/uploads/ is deleted along with its chunks — this app
 * created that file for exactly this purpose, so removing the document
 * actually frees the disk space rather than just hiding it from
 * search. If it was embedded from a server path (POST /embed), only
 * the index entries are removed — the original file could be anywhere
 * on disk and this app never touches it on its own initiative. The
 * response's `wasUpload` and `fileDeleted` fields say plainly which of
 * these happened. See the comment on deleteDocument() in store.js for
 * the full reasoning and the path-containment guardrail around it.
 */
app.delete('/workspaces/:workspaceId/documents/:sourceFile', (req, res) => {
  const { workspaceId, sourceFile } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  try {
    const result = deleteDocument(workspaceId, sourceFile);
    deleteDescription(workspaceId, sourceFile); // so a later document reusing this filename starts with no stale description
    logAction({ req, type: 'documentDelete', workspaceId, success: true, details: { sourceFile, ...result } });
    res.json({ workspaceId, sourceFile, ...result });
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'documentDelete', workspaceId, success: false, error: err.message, details: { sourceFile } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /workspaces/:workspaceId
 *
 * Wipes an entire workspace: every chunk in its store.json, every
 * uploaded file under workspaces/<id>/uploads/, and the workspace
 * directory itself — back to "this workspace has never existed,"
 * matching how a workspace comes into being in the first place (the
 * first successful embed into a name creates its directory). This is
 * the blunt recovery tool for "something about this workspace's index
 * is wrong and I just want to start over," as opposed to DELETE
 * .../documents/:sourceFile above, which removes one document at a
 * time. See deleteWorkspace() in workspace.js for why this doesn't
 * need that route's per-file path-containment checks — deleting the
 * whole directory tree in one recursive call can't reach outside it.
 *
 * Like the per-document delete, this only ever removes files this app
 * itself owns (workspaces/<id>/uploads/) — any document that was
 * embedded from an arbitrary server path via POST /embed only loses
 * its index entries here, never its original file, which could be
 * anywhere on disk. There is no confirmation step server-side; the
 * browser UI asks before ever sending this request, and a script/API
 * caller is expected to have already decided.
 */
app.delete('/workspaces/:workspaceId', (req, res) => {
  const { workspaceId } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  try {
    const result = deleteWorkspace(workspaceId);
    logAction({ req, type: 'workspaceDelete', workspaceId, success: true });
    res.json({ workspaceId, ...result });
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'workspaceDelete', workspaceId, success: false, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /workspaces/:workspaceId/rebuild-index
 * Body (all optional): { "embedModel": "...", "maxWords": 300, "overlapWords": 40 }
 *
 * Rebuilds store.json from scratch, based solely on whatever files are
 * actually sitting in workspaces/<id>/uploads/ right now — the
 * recovery path for "store.json is missing, corrupted, or I just don't
 * trust it still matches what's really here." See
 * rebuildWorkspaceIndex() in embedPipeline.js for the full reasoning,
 * and in particular two real limitations worth knowing before relying
 * on this: it can only recover documents that were UPLOADED through
 * this app (not ones embedded from an arbitrary server path via POST
 * /embed — those are simply gone once store.json is), and a recovered
 * document's name is reconstructed from its sanitized on-disk
 * filename, which may not exactly match how it displayed before if the
 * original name had spaces or punctuation.
 *
 * Like /workspaces/:id/upload-and-embed, this can take a while (every
 * file gets fully re-embedded from scratch) so the response is
 * streamed as newline-delimited JSON rather than one blocking response:
 *   {"type":"file-start","sourceFile":"...","fileIndex":1,"totalFiles":3}
 *   {"type":"start","sourceFile":"...","numPages":12,"totalChunks":40}
 *   {"type":"progress","chunksEmbedded":1,"totalChunks":40}
 *   ...
 *   {"type":"file-done","sourceFile":"...","chunksEmbedded":40}
 *   ... (repeats per file)
 *   {"type":"done","workspaceId":"...","filesProcessed":3,"totalChunks":118,"documents":[...]}
 * or, if something fails partway through:
 *   {"type":"error","error":"..."}
 * A partway failure does NOT touch the existing store.json — see the
 * "deliberately all-or-nothing" note on rebuildWorkspaceIndex() — so
 * an error here means the rebuild didn't happen, not that it happened
 * incompletely.
 */
app.post('/workspaces/:workspaceId/rebuild-index', async (req, res) => {
  const { workspaceId } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  let maxWords, overlapWords;
  try {
    maxWords = parsePositiveIntField(req.body.maxWords, 'maxWords');
    overlapWords = parsePositiveIntField(req.body.overlapWords, 'overlapWords');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const { embedModel } = req.body;

  res.setHeader('Content-Type', 'application/x-ndjson');
  if (res.flushHeaders) res.flushHeaders();

  const send = (event) => res.write(JSON.stringify(event) + '\n');

  try {
    const result = await rebuildWorkspaceIndex(workspaceId, {
      embedModel,
      maxWords,
      overlapWords,
      onProgress: send,
    });
    logAction({ req, type: 'indexRebuild', workspaceId, success: true, details: { filesProcessed: result.filesProcessed, totalChunks: result.totalChunks } });
    send({ type: 'done', ...result });
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'indexRebuild', workspaceId, success: false, error: err.message });
    send({ type: 'error', error: err.message });
  }
  res.end();
});

/**
 * Shared validation for the workspaceId every /embed and /query
 * request now needs. Returns an error message string if invalid,
 * or null if it's fine — kept as one function so the two routes below
 * give identical error messages.
 */
function workspaceIdError(workspaceId) {
  if (!workspaceId) return 'workspaceId is required';
  if (!isValidWorkspaceId(workspaceId)) {
    return 'workspaceId must be 1-64 characters: letters, numbers, hyphens, and underscores only';
  }
  return null;
}

/**
 * Parses an optional numeric field (maxWords/overlapWords) into a
 * positive integer. Only needed for the upload route — multipart form
 * fields always arrive as strings, unlike /embed and /ingest's JSON
 * bodies, where a caller sending a real number just works untouched.
 * Returns undefined for an absent/blank field, letting chunkText's own
 * default (chunker.js) apply, same as omitting the field entirely from
 * a JSON body already does. Throws for a field that *was* provided but
 * isn't a valid positive whole number, so a typo gets a clear 400
 * instead of silently producing zero-word or negative-size chunks.
 *
 * NOTE on chunk size specifically: this does NOT bypass chunker.js's
 * separate maxChars ceiling (1800 characters, not exposed here or
 * anywhere else). That hard backstop is what actually keeps every
 * chunk safely under Ollama's fixed 512-token embedding limit — see
 * the big comment at the top of chunker.js — and it's enforced inside
 * chunkText() unconditionally, independent of whatever maxWords is
 * requested. So raising maxWords well past ~300-400 words on typical
 * prose won't actually produce bigger chunks: maxChars will bind first
 * and cap them regardless. maxWords only really matters as a way to
 * request SMALLER chunks than that.
 * @param {*} value
 * @param {string} fieldName
 * @returns {number|undefined}
 */
function parsePositiveIntField(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${fieldName} must be a positive whole number`);
  }
  return n;
}

/**
 * POST /ingest
 * Body: { "filePath": "C:\\path\\to\\document.pdf", "maxWords": 500, "overlapWords": 75 }
 *
 * Extraction + chunking only, no embeddings. Kept around from step 1
 * for quickly inspecting how a document chunks before committing to
 * embedding it. filePath's extension picks the extractor — see
 * extract.js's SUPPORTED_EXTENSIONS (.pdf, .docx, .txt).
 */
app.post('/ingest', async (req, res) => {
  const { filePath, maxWords, overlapWords } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });

  try {
    const { text, numPages } = await extractText(filePath);
    const chunks = chunkText(text, { maxWords, overlapWords });
    res.json({
      filePath,
      numPages,
      totalCharacters: text.length,
      totalChunks: chunks.length,
      chunks: chunks.map((text, i) => ({ index: i, text })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /embed
 * Body: { "workspaceId": "ma-climate-plan", "filePath": "...", "maxWords": 500, "overlapWords": 75, "embedModel": "nomic-embed-text" }
 *
 * Extracts + chunks a document (.pdf, .docx, or .txt — picked by
 * filePath's extension, see extract.js's SUPPORTED_EXTENSIONS), embeds
 * every chunk via Ollama, and appends the results (text + vector +
 * source metadata) to the given workspace's store. This is the step
 * that actually builds your searchable index. The workspace is created
 * automatically the first time you embed into it — no separate
 * "create workspace" call needed.
 *
 * NOTE on filePath: this still means "a path on the machine running
 * this server," same as every earlier step — it works today because
 * the server and the browser are the same machine. That assumption
 * breaks the moment this runs somewhere remote, which is exactly why
 * it's flagged here: filePath is a deliberately temporary interface,
 * standing in for the real upload endpoint below. Both ultimately call
 * the same embedDocumentIntoWorkspace() — only how filePath gets
 * populated differs.
 *
 * Runs embeddings sequentially, one chunk at a time — simplest and
 * gentlest on a modest GPU/CPU, at the cost of taking a little while
 * for a large document. Progress is logged to the server console so
 * you can watch it work.
 */
app.post('/embed', async (req, res) => {
  const { filePath, workspaceId, maxWords, overlapWords, embedModel } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  try {
    const result = await embedDocumentIntoWorkspace(workspaceId, filePath, { maxWords, overlapWords, embedModel });
    logAction({ req, type: 'documentEmbed', workspaceId, success: true, details: { sourceFile: result.sourceFile, chunksEmbedded: result.chunksEmbedded } });
    res.json(result);
  } catch (err) {
    console.error(err);
    logAction({ req, type: 'documentEmbed', workspaceId, success: false, error: err.message, details: { filePath } });
    res.status(500).json({ error: err.message });
  }
});

// Handles the actual file bytes for uploads, one per workspace. The
// destination directory depends on :workspaceId from the URL (a route
// param, parsed by Express before multer ever runs — unlike a
// multipart body field, which isn't reliably available yet at this
// point), so workspaceId is validated again right here, independent of
// the route handler below, before anything is written to disk.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const { workspaceId } = req.params;
      if (!isValidWorkspaceId(workspaceId)) {
        return cb(new Error('Invalid workspace id'));
      }
      try {
        cb(null, ensureUploadsDir(workspaceId));
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      // Strip any directory components and anything but safe
      // characters from the original name, and prefix with a
      // timestamp so re-uploading a same-named file never collides
      // with (or silently overwrites) an earlier upload.
      const safeBase = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safeBase}`);
    },
  }),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB — raised from the original 50MB to cover larger real-world documents (e.g. image-heavy scanned PDFs); still a hard cap, not unlimited.
  fileFilter: (req, file, cb) => {
    // Extension-based, not mimetype-based — browsers are inconsistent
    // about what mimetype they report for .docx/.txt across OSes, so
    // the file's own name is the more reliable signal (same reasoning
    // extractText() itself uses to pick an extractor).
    const ext = path.extname(file.originalname).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      return cb(new Error(`Unsupported file type "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`));
    }
    cb(null, true);
  },
});

/**
 * POST /workspaces/:workspaceId/upload-and-embed
 * multipart/form-data: "file" (.pdf, .docx, or .txt — see
 * extract.js's SUPPORTED_EXTENSIONS), plus optional text fields
 * "maxWords" and "overlapWords" (see chunkText() in chunker.js) — omit
 * either to use its default. Whatever maxWords is set to, chunkText's
 * own separate maxChars ceiling still applies underneath it and can't
 * be raised from here — see parsePositiveIntField's comment above for
 * why that matters.
 *
 * This is the browser-UI counterpart to /embed: instead of pointing at
 * a path already on the server, you send the actual file bytes, which
 * get saved under workspaces/<id>/uploads/ and then run through the
 * exact same embedDocumentIntoWorkspace() pipeline /embed uses. This
 * is also the piece that makes "the server isn't your own machine
 * anymore" workable at all — the browser no longer needs to know any
 * server-side file path.
 *
 * The response is NOT a single JSON object — it's streamed as
 * newline-delimited JSON (one JSON object per line, "NDJSON"), so the
 * browser can show live progress instead of just staring at a spinner
 * for however long embedding an entire document takes:
 *   {"type":"start","sourceFile":"...","numPages":127,"totalChunks":236}
 *   {"type":"progress","chunksEmbedded":1,"totalChunks":236}
 *   {"type":"progress","chunksEmbedded":2,"totalChunks":236}
 *   ...
 *   {"type":"done","workspaceId":"...","chunksEmbedded":236,"totalStored":236,...}
 * or, if something fails partway through:
 *   {"type":"error","error":"..."}
 *
 * Note the failure mode this implies: once streaming has started, the
 * HTTP status code is already committed to 200 (headers went out
 * first), so a mid-stream failure can't become a 500 — it shows up as
 * a "type":"error" line instead. A caller reading this response has to
 * check each line's "type", not just the HTTP status, to know whether
 * it actually succeeded. Failures *before* streaming starts (bad
 * workspace id, wrong file type, no file attached) still come back as
 * ordinary HTTP error responses, since nothing has been written yet.
 */
app.post('/workspaces/:workspaceId/upload-and-embed', (req, res) => {
  const { workspaceId } = req.params;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (expected form field "file")' });
    }

    // Multer has already written the file to workspaces/<id>/uploads/
    // by this point (it has to, to parse the rest of the multipart
    // body at all) — so a bad maxWords/overlapWords field here still
    // needs its own cleanup on the way out, same as any other
    // before-streaming-starts failure below; otherwise it'd be an
    // upload nothing ever points at, the exact kind of orphan DELETE's
    // uploadPath tracking was added to avoid.
    let maxWords, overlapWords;
    try {
      maxWords = parsePositiveIntField(req.body.maxWords, 'maxWords');
      overlapWords = parsePositiveIntField(req.body.overlapWords, 'overlapWords');
    } catch (err) {
      fs.unlink(req.file.path, () => {}); // best-effort; nothing more useful to do if this fails
      logAction({ req, type: 'documentUpload', workspaceId, success: false, error: err.message, details: { sourceFile: path.basename(req.file.originalname) } });
      return res.status(400).json({ error: err.message });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    if (res.flushHeaders) res.flushHeaders();

    const send = (event) => res.write(JSON.stringify(event) + '\n');

    try {
      const result = await embedDocumentIntoWorkspace(workspaceId, req.file.path, {
        onProgress: send,
        sourceFile: path.basename(req.file.originalname),
        maxWords,
        overlapWords,
        isUpload: true,
      });
      logAction({ req, type: 'documentUpload', workspaceId, success: true, details: { sourceFile: result.sourceFile, chunksEmbedded: result.chunksEmbedded } });
      send({ type: 'done', ...result, originalName: req.file.originalname });
    } catch (err) {
      console.error(err);
      logAction({ req, type: 'documentUpload', workspaceId, success: false, error: err.message, details: { sourceFile: path.basename(req.file.originalname) } });
      send({ type: 'error', error: err.message });
    } finally {
      res.end();
    }
  });
});

/**
 * POST /query
 * Body: { "question": "...", "workspaceId": "ma-climate-plan", "topK": 5, "chatModel": "qwen2.5:14b", "embedModel": "nomic-embed-text", "temperature": 0.2, "maxTokens": 500, "numCtx": 8192, "repeatPenalty": 1.3, "idealTopicId": "offshore-wind" }
 *
 * `question` is normally required, but is optional if `idealTopicId`
 * is given — see the "Comparing against an ideal proposal" section in
 * README.md. When `idealTopicId` names a topic from
 * idealProposals.json, that topic's attributes (plus `question`, if
 * also given, as extra guidance) become the actual text embedded for
 * retrieval and sent to the chat model — composeComparisonQuestion()
 * in src/idealProposals.js builds it. An unrecognized `idealTopicId`
 * 400s with the id that wasn't found.
 *
 * Embeds the question, then retrieves the most relevant chunks stored
 * in the given workspace via hybridSearch() — a fusion of cosine-
 * similarity vector search and BM25 keyword search, not vector search
 * alone; see the doc comment in src/hybridSearch.js for why (in
 * short: a short, exact-phrase query can otherwise rank poorly by
 * embedding similarity even when a chunk contains that literal
 * phrase) — and asks the chat model to answer using only that
 * retrieved context. Returns both the generated answer AND the raw
 * list of chunks/sources used (each one's `matchedBy` says whether
 * vector search, keyword search, or both surfaced it), so you can see
 * exactly what grounded the answer rather than trusting the model's
 * prose to mention it.
 */
/**
 * Builds the system+user messages array for a RAG answer, shared by
 * both /query and /query/stream so the prompt only exists in one
 * place.
 */
/**
 * @param {string} question
 * @param {Array<{sourceFile: string, chunkIndex: number, text: string}>} matches
 * @param {string} [materialLabel] - what to call the retrieved material
 *   in the system prompt — "source material" by default (plain
 *   document Q&A), or "proposal" when a comparison topic is active
 *   (see the two /query and /query/stream call sites below). This
 *   exists to fix a real inconsistency: idealProposals.json's
 *   compareInstruction tells the model to always call the reviewed
 *   document "the proposal" and never "the context" — but this system
 *   prompt used to call it "the context" itself, in the very message
 *   where that material lives. Two different names for the same thing
 *   from two different parts of the same conversation is exactly the
 *   kind of contradiction a small/weak model is liable to get tangled
 *   in, so the caller now picks one name and this function uses it
 *   consistently, wrapping the block in matching START/END markers the
 *   same way composeComparisonQuestion() in src/idealProposals.js now
 *   wraps the rubric — a named landmark either instruction can point
 *   at, instead of vaguer language like "elsewhere in this
 *   conversation."
 *
 *   The markers are deliberately two plain words ("PROPOSAL START" /
 *   "PROPOSAL END"), NOT a colon-suffixed single-word label like
 *   "PROPOSAL:" — an earlier version used that shape and a small model
 *   ended up citing "(PROPOSAL:, chunk 12)" as though the marker
 *   itself were the source document's name. That marker sat directly
 *   above the real `[Source: file, chunk N]` tag it was supposed to
 *   cite instead, so with two "WORD:"-shaped labels stacked right on
 *   top of each other, a weak model grabbed the outer one. Dropping
 *   the colon removes that resemblance — there's now only one
 *   citation-shaped label near each chunk, the real one.
 */
function buildRagMessages(question, matches, materialLabel = 'source material') {
  const label = materialLabel.toUpperCase();
  const block = matches
    .map((m) => `[Source: ${m.sourceFile}, chunk ${m.chunkIndex}]\n${m.text}`)
    .join('\n\n---\n\n');

  // Only the plain Q&A case (materialLabel left at its default) gets this
  // quote-citation request appended. The comparison/rubric case already
  // asks for the same thing itself, via composeComparisonQuestion()'s own
  // compareInstruction in src/idealProposals.json — adding it here too
  // would duplicate (and risk subtly conflicting with) that instruction.
  const quoteInstruction =
    materialLabel === 'source material'
      ? ' For each answer, provide one or more direct quotes from the provided material that best ' +
        'illustrate the point(s) being made, in the format: Quote: "<a short phrase copied ' +
        `word-for-word from the ${materialLabel}>" [<source file name>, chunk <chunk number>].`
      : '';

  return [
    {
      role: 'system',
      content:
        `Answer the question using ONLY the ${materialLabel} between the ${label} START and ${label} END ` +
        'markers below. Do not use any outside knowledge. If the answer is not contained ' +
        `in the ${materialLabel}, say clearly that you don't have that information ` +
        `in the provided documents rather than guessing. The ${label} START and ${label} END markers ` +
        `are section boundaries, not a citation — never use "${label}" as a source name; only the file ` +
        `name inside a [Source: ...] tag is a real one.${quoteInstruction}\n\n` +
        `${label} START\n${block}\n${label} END`,
    },
    { role: 'user', content: question },
  ];
}

// Appended to whichever compareInstruction a Best Practices run would
// otherwise use (see buildBestPracticesTopic() below) — the one
// deliberate divergence from "reuse exactly what Rubric Control uses,"
// because a Best Practices comparison has a real failure mode a
// hand-authored rubric topic doesn't: each attribute here is drawn
// from a REAL state's actual program (see best_practices_to_json.py's
// `proposal` text, which routinely names that state outright, e.g.
// "Massachusetts funds a Community Wildfire Protection Plan..."), and
// the plan being evaluated is very often from a DIFFERENT state. Of
// course a Maine plan never mentions Massachusetts by name — that's
// not a meaningful gap, but without this paragraph a model has
// nothing telling it not to treat it as one. The question being asked
// is whether the plan's own content is SIMILAR to the benchmark entry,
// not whether it references the same state, agency, or program by
// name.
//
// Deliberately generic rather than naming the specific state(s)
// involved in any one run: a single run's attributes can span several
// different states at once (see filterBestPracticeAttributes() in
// src/bestPracticesFilter.js, which matches on hazard/state as an OR
// across however many of each were selected), so there's no single
// "the other state is X" sentence that would stay accurate for every
// attribute in the batch. Appended as the LAST paragraph of whatever
// compareInstruction resolves to, rather than spliced into the middle
// of it, specifically so this never has to assume anything about that
// text's own internal structure — it might be the hardcoded fallback
// below, or a hand-edited, multi-paragraph defaultCompareInstruction
// from idealProposals.json tuned over time via Rubric Control; this
// paragraph reads sensibly appended after either one unchanged.
//
// This hardcoded value is only the DEFAULT, not the only option: the
// Best Practices Comparison tab has its own "Jurisdiction guidance
// override" textarea (see bpJurisdictionGuidance in index.html and
// getJurisdictionGuidanceOverride() in bestPracticesTab.js) that
// replaces this constant wholesale, for that run only, when it isn't
// left blank — see buildBestPracticesTopic()'s jurisdictionGuidanceOverride
// parameter just below. Parallel in spirit to Rubric Control's own
// per-topic compareInstruction override (blank means "use the
// built-in default," anything typed in replaces it), but deliberately
// NOT persisted to idealProposals.json the way that one is — this is
// meant for quickly trying out different wording without editing code
// or restarting the server, so it's just sent fresh with whatever
// request triggered that run.
//
// Revised wording (this version) after a real, repeatedly observed
// failure the FIRST version of this paragraph didn't fully prevent: a
// model would still write a sentence like "does not mention
// Massachusetts or its building code" as its OWN stated reason for a
// Not addressed verdict — exactly the thing the first version's "do
// not penalize the material for failing to mention that other
// state... by name" sentence was supposed to rule out. That version
// was pure prohibition with no alternative procedure attached, which
// turned out to be a weak defense against the much more concrete,
// textually salient pull of the benchmark's own state/agency/program
// name appearing right there in the RUBRIC block a few lines above —
// a negative instruction several paragraphs removed from the point of
// generation, competing against a literal proper noun sitting right
// next to the comparison. This version gives the model a concrete
// procedure instead of only a prohibition: restate the benchmark in
// state-neutral terms FIRST (so the thing being compared against is
// never the original sentence containing the name), then adds a much
// more targeted, concrete version of the prohibition itself — not
// "don't penalize for this" but "do not write a sentence that cites
// this" — aimed directly at the exact leaked sentence shape observed
// in practice. Confirmed, via the user's own live testing against
// several real benchmark entries (not just the fake-ollama plumbing
// stub, which can't validate wording quality at all — see this
// constant's own override mechanism above for why that distinction
// matters), to stop that leaked sentence from appearing and to
// produce a substantively-reasoned verdict (e.g. "Falls short"
// because the material has two separate codes rather than one shared
// code, not because it fails to name the benchmark's state) in cases
// where the first version's wording alone did not.
const BEST_PRACTICES_JURISDICTION_GUIDANCE =
  "Each attribute below describes a real-world initiative from a specific state, which may be different " +
  "from the state the material above describes — that is expected, not a gap: a plan from one state will " +
  "naturally never name another state's program, agency, or specific law. Before judging, first restate " +
  "the benchmark attribute silently in your own words WITHOUT using any state name, agency name, or " +
  "program name — describe only what the program actually does (for example, \"a single building code " +
  "that applies to every building and includes flood-resistant design requirements,\" not \"the " +
  "Massachusetts State Building Code\"). Then compare the material above only against that state-neutral " +
  "restatement, never against the original wording's state, agency, or program names. Do not write any " +
  "sentence, anywhere in your answer, that cites the material's failure to mention the other state, its " +
  "agencies, or its program by name as a reason for your verdict — that fact is irrelevant and must never " +
  "appear in your reasoning. Judge only whether the material's own approach is substantively similar in " +
  "content and intent to the state-neutral restatement, regardless of which state is involved.";

// Appended after BEST_PRACTICES_JURISDICTION_GUIDANCE as a second,
// separate paragraph — same "last paragraph of compareInstruction,
// never spliced into the middle" placement, and same override
// convention (see that constant's doc comment just above). Added for a
// different, specifically observed failure mode: a real Best Practices
// run was coming back with a "matches" verdict and a correctly-cited
// quote, but no actual analysis — the model's "direct answer" was just
// a near-verbatim restatement of the benchmark attribute text (the
// RUBRIC block) instead of a description of what the retrieved
// material (the PROPOSAL block) itself says. Unlike a hand-authored
// Rubric Control attribute, which is usually already phrased as a
// criterion to check for, a Best Practices attribute is a flat
// declarative sentence describing a real program — there's nothing in
// that phrasing alone telling the model its job is to describe the
// PROPOSAL, not echo the RUBRIC. This paragraph says so explicitly.
//
// Rephrasing the jurisdiction-guidance paragraph above as an explicit
// yes/no question was tried first (by hand, via the UI override) and
// did NOT fix this on its own — the restatement behavior persisted.
// This paragraph targets the actual mechanism instead: naming the
// PROPOSAL/RUBRIC markers directly and telling the model plainly not to
// copy the benchmark back as its own answer.
//
// Same override mechanism as BEST_PRACTICES_JURISDICTION_GUIDANCE:
// optional, ephemeral, UI-only (bpAnalysisGuidance textarea /
// getAnalysisGuidanceOverride() in bestPracticesTab.js), never
// persisted to idealProposals.json. This hardcoded paragraph is always
// the real default; the override exists purely so different wording
// can be tried out quickly without editing code or restarting the
// server.
const BEST_PRACTICES_ANALYSIS_GUIDANCE =
  "Your direct answer must be a genuine description, in your own words, of what the material between " +
  "PROPOSAL START and PROPOSAL END above actually says about this topic. Do not copy, quote, or restate " +
  "the benchmark description given above as if it were your own answer — that description is only what " +
  "you are comparing against, not something to repeat back. If the plan under review contains nothing " +
  "relevant, say so plainly; if it does, describe specifically what it says before giving your verdict.";

// The "compare a Best Practices subset against a saved rubric" mode's
// own pair of guidance paragraphs — parallel in role to
// BEST_PRACTICES_JURISDICTION_GUIDANCE/BEST_PRACTICES_ANALYSIS_GUIDANCE
// just above, but reworded for a different "material" than those two
// assume. Those two are written for the ORIGINAL Best Practices mode,
// where the thing being checked is a submitted plan's actual document
// text (retrieved chunks, wrapped in a PROPOSAL START/END block by
// buildRagMessages() in index.js) — language like "the plan under
// review" and "the material... says about this topic" doesn't fit a
// RUBRIC UNDER REVIEW block (buildRubricMatches() in src/idealProposals.js,
// wrapped by buildRagMessages() the same way), which is a flat list of
// named, already-general criteria, not a narrative document.
//
// The underlying problem BEST_PRACTICES_JURISDICTION_GUIDANCE solves is
// still just as real here, confirmed directly by the person building
// this feature: Best Practices benchmark entries are written as one
// real state's actual program and routinely name that state outright,
// while Rubric Control topics are written generically on purpose (no
// state, agency, or program named) — so without this guidance, a model
// would still be tempted to mark a rubric "Not addressed" purely
// because it never names the benchmark's state, which is exactly
// backwards: a generic rubric item was never GOING to name any state,
// so that's not evidence of anything. The same "restate the benchmark
// in state-neutral terms first, then compare only against that
// restatement, and never cite the absent name as a reason" mechanism
// is kept for that reason — see BEST_PRACTICES_JURISDICTION_GUIDANCE's
// own doc comment above for the fuller history of why that specific
// mechanism (not just a blanket "don't penalize this" prohibition) is
// what actually worked in practice.
const BEST_PRACTICES_RUBRIC_JURISDICTION_GUIDANCE =
  "Each benchmark item below describes a real-world initiative from a specific state. The rubric under " +
  "review, by contrast, is written as a set of general criteria and will never name a specific state, " +
  "agency, or program — that is expected, not a gap: a generic rubric item was never going to name any " +
  "one state's program. Before judging, first restate the benchmark item silently in your own words " +
  "WITHOUT using any state name, agency name, or program name — describe only what the program actually " +
  "does (for example, \"a single building code that applies to every building and includes flood-resistant " +
  "design requirements,\" not \"the Massachusetts State Building Code\"). Then compare the rubric under " +
  "review only against that state-neutral restatement, never against the original wording's state, agency, " +
  "or program names. Do not write any sentence, anywhere in your answer, that cites the rubric's failure to " +
  "mention a state, agency, or program by name as a reason for your verdict — that fact is irrelevant and " +
  "must never appear in your reasoning. Judge only whether the rubric under review contains an item whose " +
  "substance is similar in content and intent to the state-neutral restatement, regardless of which state " +
  "the benchmark item involves.";

// Parallel to BEST_PRACTICES_ANALYSIS_GUIDANCE above, reworded for the
// RUBRIC UNDER REVIEW block instead of a PROPOSAL block of retrieved
// document text — same underlying failure mode this guards against
// (the model's "direct answer" turning into a near-verbatim restatement
// of the benchmark item instead of genuinely describing what it found),
// just phrased for "does the rubric have a matching item" rather than
// "what does the submitted plan say."
const BEST_PRACTICES_RUBRIC_ANALYSIS_GUIDANCE =
  "Your direct answer must identify whether any item in the rubric between RUBRIC UNDER REVIEW START and " +
  "RUBRIC UNDER REVIEW END above is substantially similar to this benchmark item, and if so, name that " +
  "rubric item and describe specifically what it says. Do not copy, quote, or restate the benchmark item's " +
  "own description as if it were your own answer — that description is only what you are comparing " +
  "against, not something to repeat back. If no item in the rubric addresses this concept, say so plainly.";

/**
 * Builds a synthetic "topic" object — same shape getTopic() in
 * idealProposals.js returns (id, label, attributes, resolved
 * compareInstruction) — out of a hazard/state filter over the Best
 * Practices benchmark dataset, so it can be handed to EXACTLY the same
 * comparison machinery a hand-authored idealProposals.json topic
 * already goes through below (batchAttributes(), composeComparisonQuestion(),
 * composeRetrievalQuery(), parseComparisonAnswer()) with no changes to
 * any of that code. Building this synthetic topic, and appending
 * BEST_PRACTICES_JURISDICTION_GUIDANCE above to its compareInstruction,
 * are the only things genuinely new here; everything downstream of it
 * is reused as-is, per "let's reuse what we have until it's clear we
 * need something else."
 *
 * `compareInstruction` starts from the same text getTopic() resolves
 * for a topic that doesn't set its own override: idealProposals.json's
 * file-level defaultCompareInstruction if set, else
 * HARDCODED_FALLBACK_COMPARE_INSTRUCTION. There's no per-entry override
 * mechanism here (unlike a hand-authored topic's own optional
 * compareInstruction) — every Best Practices comparison uses whichever
 * instruction every OTHER topic without its own override already uses,
 * deliberately not special-cased, per the "reuse what we have" plan;
 * HARDCODED_FALLBACK_COMPARE_INSTRUCTION, with
 * BEST_PRACTICES_JURISDICTION_GUIDANCE above appended as one more
 * paragraph — that addition is the one deliberate special-case; there
 * is still no per-entry override mechanism the way a hand-authored
 * topic's own optional compareInstruction is, so every Best Practices
 * comparison gets the same base instruction plus the same jurisdiction
 * guidance, regardless of which hazard/state(s) were picked.
 *
 * The returned attributes have no `included` field, which
 * getIncludedAttributes()'s isAttributeIncluded() check already treats
 * as "included" (its default for anything other than an explicit
 * `included: false`) — so getIncludedAttributes() can be called on
 * this synthetic topic exactly as it's called on a real one, with no
 * special-casing needed there either.
 *
 * @param {string[]} hazards - required, at least one; see
 *   filterBestPracticeAttributes() in src/bestPracticesFilter.js for
 *   why this one can't be omitted or empty. More than one is matched
 *   as an OR, same as that function.
 * @param {string[]} [states] - omit or pass an empty array to match
 *   every state that has an entry for one of the selected hazards.
 *   More than one is matched as an OR, same as hazards.
 * @param {string} [jurisdictionGuidanceOverride] - replaces
 *   BEST_PRACTICES_JURISDICTION_GUIDANCE wholesale when it's a
 *   non-blank string -- see that constant's own doc comment just above
 *   it for the parallel to Rubric Control's per-topic compareInstruction
 *   override (resolveInstructionText()'s same "blank means use the
 *   built-in default" convention, just for this one paragraph rather
 *   than the whole instruction, and never persisted to
 *   idealProposals.json the way a topic's own override is -- sent
 *   fresh with each run from the Best Practices tab's own textarea,
 *   specifically so it's quick to try out different wording without
 *   editing code or restarting the server). Blank/omitted uses the
 *   built-in paragraph unchanged, same as always.
 * @param {string} [analysisGuidanceOverride] - same convention as
 *   jurisdictionGuidanceOverride just above, but replaces
 *   BEST_PRACTICES_ANALYSIS_GUIDANCE (or, in rubric-comparison mode,
 *   BEST_PRACTICES_RUBRIC_ANALYSIS_GUIDANCE) instead. Blank/omitted
 *   uses that mode's built-in paragraph unchanged.
 * @param {boolean} [compareAgainstRubric] - false (the original
 *   behavior, unchanged) picks BEST_PRACTICES_JURISDICTION_GUIDANCE/
 *   BEST_PRACTICES_ANALYSIS_GUIDANCE as the built-in defaults — the
 *   pair written for comparing against a submitted plan's actual
 *   document text. true picks BEST_PRACTICES_RUBRIC_JURISDICTION_GUIDANCE/
 *   BEST_PRACTICES_RUBRIC_ANALYSIS_GUIDANCE instead — the pair reworded
 *   for comparing against a saved Rubric Control topic's own attributes
 *   (see buildRubricMatches() in src/idealProposals.js and its use in
 *   /query and /query/stream below). Either way, jurisdictionGuidanceOverride/
 *   analysisGuidanceOverride above — when non-blank — still replace
 *   whichever pair this flag selected, exactly as before; this flag
 *   only changes which paragraph is used as the DEFAULT.
 * @returns {{id: string, label: string, attributes: Array<Object>, compareInstruction: string, isBestPractices: true}}
 * @throws {Error} whatever loadBestPracticeAttributes()/
 *   filterBestPracticeAttributes() throw (a malformed bestPractices.json,
 *   or no hazards at all) — left for the caller to turn into the right
 *   HTTP response, same pattern the idealTopicId resolution right below
 *   this function already follows.
 */
function buildBestPracticesTopic(hazards, states, jurisdictionGuidanceOverride, analysisGuidanceOverride, compareAgainstRubric) {
  const allAttributes = loadBestPracticeAttributes();
  const attributes = filterBestPracticeAttributes(allAttributes, { hazards, states });

  const { defaultCompareInstruction } = loadTopics();
  const baseCompareInstruction =
    resolveInstructionText(defaultCompareInstruction) || HARDCODED_FALLBACK_COMPARE_INSTRUCTION;
  const defaultJurisdictionGuidance = compareAgainstRubric
    ? BEST_PRACTICES_RUBRIC_JURISDICTION_GUIDANCE
    : BEST_PRACTICES_JURISDICTION_GUIDANCE;
  const defaultAnalysisGuidance = compareAgainstRubric
    ? BEST_PRACTICES_RUBRIC_ANALYSIS_GUIDANCE
    : BEST_PRACTICES_ANALYSIS_GUIDANCE;
  const jurisdictionGuidance =
    (jurisdictionGuidanceOverride && jurisdictionGuidanceOverride.trim()) || defaultJurisdictionGuidance;
  const analysisGuidance =
    (analysisGuidanceOverride && analysisGuidanceOverride.trim()) || defaultAnalysisGuidance;
  const compareInstruction = `${baseCompareInstruction}\n\n${jurisdictionGuidance}\n\n${analysisGuidance}`;

  // Label is purely descriptive (shown in the UI's run summary and in
  // the exported report's "Ideal-proposal topic" row -- see
  // buildExportMeta() in bestPracticesTab.js) -- never parsed back out
  // by anything, so a plain comma-joined list for each of hazards/
  // states (in whichever order the caller selected them) is all this
  // needs, with no special-casing for exactly one of either.
  const hazardsLabel = (hazards || []).join(', ');
  const statesLabel = states && states.length ? states.join(', ') : 'all states';
  return {
    id: 'best-practices',
    label: `Best Practices Benchmark (${hazardsLabel}; ${statesLabel})`,
    attributes,
    compareInstruction,
    // Lets genuinely-shared code (currently just logQueryActivity() in
    // src/activityLog.js) distinguish this synthetic topic from a real,
    // hand-authored Rubric Control topic without string-matching on id
    // (a real topic id in idealProposals.json could coincidentally be
    // "best-practices" too). getTopic() in idealProposals.js never sets
    // this field, so it's reliably absent/falsy for every real topic.
    isBestPractices: true,
  };
}

function sourcesSummary(matches) {
  return matches.map((m) => ({
    id: m.id,
    sourceFile: m.sourceFile,
    chunkIndex: m.chunkIndex,
    score: m.score,
    // Which retrieval method(s) actually surfaced this chunk — see
    // the doc comment on hybridSearch() in src/hybridSearch.js.
    // Omitted only if matches ever came from something that doesn't
    // set it (shouldn't happen post-hybridSearch, kept defensive).
    ...(m.matchedBy ? { matchedBy: m.matchedBy } : {}),
  }));
}

app.post('/query', async (req, res) => {
  const { question, workspaceId, topK = 5, chatModel, embedModel, temperature, maxTokens, numCtx, repeatPenalty, idealTopicId, bestPracticesFilter, compareAgainstRubricId, think, attributesPerCall } = req.body;
  // A rubric-comparison run (see compareAgainstRubricId below) never
  // touches a workspace at all — no document retrieval happens, so
  // there's nothing a workspaceId would even be used for — so the
  // normally-required workspaceId check is skipped entirely in that
  // one case rather than asking the Best Practices tab to send a fake
  // placeholder value just to satisfy it.
  const wsErr = compareAgainstRubricId ? null : workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  // Resolving idealTopicId can throw (a malformed idealProposals.json)
  // separately from "not found" (a bad id), so this gets its own
  // try/catch ahead of the question-required check below — a topic
  // provides enough substance on its own to stand in for a question
  // (see the check right after this), so we need to know whether one
  // was actually found before deciding whether `question` is missing.
  let topic;
  if (idealTopicId) {
    try {
      topic = getTopic(idealTopicId);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: `Could not load idealProposals.json: ${err.message}` });
    }
    if (!topic) return res.status(400).json({ error: `Unknown ideal-proposal topic id: "${idealTopicId}"` });
  } else if (bestPracticesFilter && Array.isArray(bestPracticesFilter.hazards) && bestPracticesFilter.hazards.length > 0) {
    // Same shape as a real topic (see buildBestPracticesTopic()'s doc
    // comment above) — everything below this point treats it
    // identically to one resolved via getTopic(), no special-casing.
    // `hazards`/`states` are arrays (see buildBestPracticesTopic() and
    // filterBestPracticeAttributes() in src/bestPracticesFilter.js) —
    // one or more of each, matched as an OR, per the multi-select
    // Hazard/State controls on the Best Practices Comparison tab.
    // `jurisdictionGuidance`, if present and non-blank, overrides
    // whichever of BEST_PRACTICES_JURISDICTION_GUIDANCE/
    // BEST_PRACTICES_RUBRIC_JURISDICTION_GUIDANCE applies for this run
    // — see buildBestPracticesTopic()'s own doc comment above.
    try {
      topic = buildBestPracticesTopic(bestPracticesFilter.hazards, bestPracticesFilter.states, bestPracticesFilter.jurisdictionGuidance, bestPracticesFilter.analysisGuidance, Boolean(compareAgainstRubricId));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: `Could not load bestPractices.json: ${err.message}` });
    }
    if (topic.attributes.length === 0) {
      return res.status(400).json({
        error: `No Best Practices entries match hazard(s) "${bestPracticesFilter.hazards.join(', ')}"` +
          (bestPracticesFilter.states && bestPracticesFilter.states.length
            ? ` in state(s) "${bestPracticesFilter.states.join(', ')}".`
            : '.'),
      });
    }
  }

  if (!question && !topic) {
    return res.status(400).json({ error: 'question is required (or select an ideal-proposal topic, or a Best Practices hazard, to compare against)' });
  }

  // Resolves the SECOND topic a rubric-comparison run needs — not the
  // thing being asked about (that's `topic` above, e.g. the Best
  // Practices subset), but the material being checked against it: a
  // saved Rubric Control topic's own attributes, turned into a
  // synthetic `matches` array by buildRubricMatches() in
  // src/idealProposals.js so the rest of this route (buildRagMessages(),
  // parseComparisonAnswer(), quote verification) can treat it exactly
  // like a batch of retrieved chunks, with no retrieval ever actually
  // happening. Resolved once, up front, since (unlike a real
  // hybridSearch() result) it doesn't depend on which attribute batch
  // is currently being asked about — the whole rubric is handed over
  // every time.
  let rubricMatches = null;
  if (compareAgainstRubricId) {
    let rubricTopic;
    try {
      rubricTopic = getTopic(compareAgainstRubricId);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: `Could not load idealProposals.json: ${err.message}` });
    }
    if (!rubricTopic) return res.status(400).json({ error: `Unknown rubric topic id: "${compareAgainstRubricId}"` });
    rubricMatches = buildRubricMatches(rubricTopic);
    if (rubricMatches.length === 0) {
      return res.status(400).json({ error: `The rubric "${rubricTopic.label}" has no (included) attributes to compare against.` });
    }
  }

  // Every real hybridSearch() call below filters against this same
  // excluded-document set (see getExcludedSourceFiles()'s own doc
  // comment in src/documentMeta.js) — resolved once, up front, same
  // "doesn't depend on which attribute batch is running" reasoning as
  // rubricMatches above. Never actually used when rubricMatches is
  // set (that mode never calls hybridSearch() at all), and workspaceId
  // may not even be a real one in that case (see wsErr above) — so
  // this is skipped entirely rather than resolved unconditionally.
  const excludedSourceFiles = rubricMatches ? new Set() : getExcludedSourceFiles(workspaceId);

  // `batches` is what makes the "attributes per call" Advanced setting
  // work: a topic's attributes get split into one or more chunks (see
  // batchAttributes() in src/idealProposals.js), each becoming its own
  // retrieval + chat call below rather than one giant question folding
  // in every attribute at once. A plain (non-comparison) question is
  // always exactly one "batch" with no attribute subset — `null` — so
  // the loop below still runs exactly once, unchanged from before.
  const batches = topic ? batchAttributes(getIncludedAttributes(topic), attributesPerCall) : [null];

  // Hoisted above the try block (rather than declared as the try
  // block's first lines, which is how this used to read) so the catch
  // block below can still log whatever partial answer/sources had
  // already been accumulated when something failed — see
  // logQueryActivity()'s own doc comment in src/activityLog.js for why
  // even a failed request is worth recording with whatever's
  // available, not skipped entirely.
  let combinedAnswer = '';
  let allSources = [];
  let allRecords = [];
  const thinkingParts = [];
  const retrievalQueries = [];
  let totalPromptTokens = 0;
  let totalAnswerTokens = 0;
  let lastDoneReason;
  // The chat model that ACTUALLY answered — resolved by chat() itself
  // (its own default when `chatModel` above was left unspecified), not
  // just echoing back whatever `chatModel` was passed in. Captured from
  // chat()'s return value below on success, or from a thrown error's
  // own `.model` (see ollamaClient.js) if a chat call was reached but
  // failed. Stays undefined if no chat call was ever reached at all
  // (e.g. "no-documents").
  let resolvedChatModel;
  // Only populated for a plain (non-topic) question — see the
  // verifyQuotesInPlace() call below and its doc comment in
  // src/responseParser.js. A topic/comparison batch already gets its
  // quotes verified via parseComparisonAnswer()/the rubric results UI,
  // so this stays empty there to avoid implying a second, redundant
  // verification pass exists for that case.
  let combinedVerifiedAnswer = '';

  try {
    for (const attributesSubset of batches) {
      // See composeComparisonQuestion()'s big comment in
      // src/idealProposals.js: when a topic is selected, ITS text
      // (plus whatever the user additionally typed) becomes the
      // actual question sent to the chat model, not just an
      // instruction layered on top after the fact. `attributesSubset`
      // narrows that to just this batch's attributes.
      const effectiveQuestion = topic ? composeComparisonQuestion(topic, question, attributesSubset) : question;

      // Rubric-comparison mode (rubricMatches set above) skips
      // retrieval entirely: there's no larger pool to search down to
      // topK the way workspace documents have, so the SAME fixed
      // rubricMatches array is reused for every batch, no embed()/
      // hybridSearch() call happens, and retrievalQueries is left
      // untouched for this batch (nothing was actually embedded, so
      // there's nothing meaningful to show in the UI's retrieval-query
      // display for it).
      let matches;
      if (rubricMatches) {
        matches = rubricMatches;
      } else {
        // Retrieval uses a DIFFERENT, shorter text — see
        // composeRetrievalQuery()'s doc comment in src/idealProposals.js
        // for why: embedding the full instructional composeComparisonQuestion()
        // text (in place of a bare, focused query) was pulling in
        // topically-adjacent-but-irrelevant chunks, since that text is
        // mostly boilerplate shared across every attribute rather than
        // this attribute's own specific subject matter.
        const retrievalQuery = topic ? composeRetrievalQuery(topic, question, attributesSubset) : effectiveQuestion;
        retrievalQueries.push(retrievalQuery);

        const queryVector = await embed(retrievalQuery, embedModel);
        // hybridSearch() fuses cosine-similarity vector search with BM25
        // keyword search (see its doc comment in src/hybridSearch.js) —
        // this is what lets an exact-phrase query like "inland flooding"
        // still find a chunk containing that phrase even when its
        // embedding similarity alone wouldn't have ranked it highly
        // enough to make a plain vector topK.
        matches = hybridSearch(workspaceId, queryVector, retrievalQuery, topK, excludedSourceFiles);
      }

      if (matches.length === 0) {
        // Every batch would hit this same empty-after-filtering
        // workspace, so there's no point continuing the loop —
        // short-circuit the whole request exactly like the
        // single-pass version did. (Can't happen in rubric-comparison
        // mode -- rubricMatches.length was already checked above
        // before this loop ever started.) Distinguishes "genuinely no
        // documents embedded" from "documents exist here, but every
        // one of them is currently excluded" — the latter is a
        // workspace-configuration state someone chose on purpose (see
        // the Documents tab's Include checkboxes), not the same
        // problem as an empty workspace, and deserves its own message
        // rather than the misleading suggestion to go run /embed.
        const totalDocCount = listDocuments(workspaceId).length;
        const noDocsAnswer = totalDocCount === 0
          ? `No documents have been embedded yet in workspace "${workspaceId}". Run /embed first.`
          : `Every document in workspace "${workspaceId}" is currently excluded from search (see the Documents tab's Include checkboxes).`;
        logQueryActivity({ req, workspaceId, question, topic, compareAgainstRubricId, status: 'no-documents', answer: noDocsAnswer });
        return res.json({
          answer: noDocsAnswer,
          sources: [],
        });
      }

      // materialLabel drives both the wrapper text buildRagMessages()
      // puts around `matches` below AND (via composeComparisonQuestion()
      // in src/idealProposals.js) whether that block is called "RUBRIC"
      // or "BENCHMARK" -- see that function's own doc comment. "rubric
      // under review" is deliberately distinct wording from "proposal"
      // so a run that folds BOTH a benchmark block and a rubric block
      // into the same prompt never has two sections that could be
      // confused for each other.
      const materialLabel = rubricMatches ? 'rubric under review' : (topic ? 'proposal' : undefined);
      const messages = buildRagMessages(effectiveQuestion, matches, materialLabel);
      // doneReason ("stop" vs "length") is Ollama's own account of why
      // generation ended — see the long comment on chat()'s return value
      // in ollamaClient.js. Passed straight through here rather than
      // interpreted, since only the caller knows whether it itself set
      // maxTokens (in which case "length" was requested) or not (in
      // which case "length" means Ollama's own context window ran out).
      const { text: answer, thinking, doneReason, promptTokens, answerTokens, model: usedModel } = await chat(messages, { model: chatModel, temperature, maxTokens, numCtx, repeatPenalty, think });

      combinedAnswer += (combinedAnswer ? '\n\n' : '') + answer;
      if (!topic) {
        // Verified against THIS batch's own retrieved chunks (full text
        // included, unlike what the browser ever receives) — see
        // verifyQuotesInPlace()'s doc comment in src/responseParser.js
        // for why this can only happen here, server-side.
        const verifiedAnswer = verifyQuotesInPlace(answer, matches);
        combinedVerifiedAnswer += (combinedVerifiedAnswer ? '\n\n' : '') + verifiedAnswer;
      }
      allSources = allSources.concat(sourcesSummary(matches));
      totalPromptTokens += promptTokens || 0;
      totalAnswerTokens += answerTokens || 0;
      lastDoneReason = doneReason;
      resolvedChatModel = usedModel;
      if (thinking) thinkingParts.push(thinking);

      // Only a topic-driven comparison batch has attributes to parse
      // structured records out of — see parseComparisonAnswer() in
      // src/responseParser.js, and its module-level caveat about how
      // reliable this parsing actually is.
      if (attributesSubset && attributesSubset.length) {
        // `matches` (this batch's own retrieved chunks, full text
        // included) is what lets parseComparisonAnswer() mechanically
        // verify any quote the model claims came from a specific
        // [Source: file, chunk N] tag — see verifyQuote() in
        // src/responseParser.js.
        allRecords = allRecords.concat(parseComparisonAnswer(answer, attributesSubset, matches));
      }
    }

    logQueryActivity({
      req,
      workspaceId,
      question,
      topic,
      compareAgainstRubricId,
      status: 'completed',
      answer: combinedAnswer,
      sourceChunkIds: [...new Set(allSources.map((s) => s.id))],
      chatModel: resolvedChatModel,
    });

    // `thinking` is only included when non-empty — a model that
    // doesn't support it (or was asked not to via `think: false`)
    // shouldn't clutter every response with an empty field. `records`
    // is similarly only meaningful (non-empty) for a topic comparison.
    res.json({
      answer: combinedAnswer,
      sources: allSources,
      doneReason: lastDoneReason,
      promptTokens: totalPromptTokens,
      answerTokens: totalAnswerTokens,
      records: allRecords,
      totalBatches: batches.length,
      // Same text as `answer`, but with every "Quote: ... [file, chunk N]"
      // citation upgraded to its verified form. Only set for a plain
      // (non-topic) question — see combinedVerifiedAnswer's declaration
      // above.
      ...(combinedVerifiedAnswer ? { verifiedAnswer: combinedVerifiedAnswer } : {}),
      // One entry per batch, same order as `sources`/`records` were
      // accumulated in — the exact text embedded to retrieve that
      // batch's chunks. See composeRetrievalQuery() in
      // src/idealProposals.js and the matching field on /query/stream's
      // "sources" event.
      retrievalQueries,
      ...(thinkingParts.length ? { thinking: thinkingParts.join('\n\n') } : {}),
    });
  } catch (err) {
    console.error(err);
    logQueryActivity({
      req,
      workspaceId,
      question,
      topic,
      compareAgainstRubricId,
      status: 'error',
      error: err.message,
      answer: combinedAnswer,
      sourceChunkIds: [...new Set(allSources.map((s) => s.id))],
      chatModel: resolvedChatModel || err.model,
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /query/stream
 * Body: same as /query.
 *
 * The browser-UI counterpart to /query, same relationship as /embed
 * has to /workspaces/:id/upload-and-embed: this exists purely to give
 * a UI something to show while it waits, by streaming back progress
 * as newline-delimited JSON instead of one response at the end.
 * Everything up through retrieval (embedding the question, searching
 * the workspace) is fast enough that it can still fail as a normal
 * HTTP error — nothing has streamed yet at that point. Once retrieval
 * succeeds, this sends the sources immediately:
 *   {"type":"sources","sources":[...],"retrievalQuery":"..."}
 * Each entry in `sources` also carries `matchedBy` (`["vector"]`,
 * `["keyword"]`, or both) — which retrieval method(s) actually
 * surfaced that chunk; see hybridSearch() in src/hybridSearch.js.
 * `retrievalQuery` is the exact text that was embedded to produce this
 * batch's search — see composeRetrievalQuery() in src/idealProposals.js.
 * For a plain (non-comparison) question it's just the question itself,
 * but for a topic-driven comparison batch it's deliberately NOT the
 * full text sent to the chat model (see that function's doc comment) —
 * exposing it here is what lets someone directly check, in the UI,
 * whether two runs that "should" retrieve the same way actually are.
 * then switches Ollama's chat call into streaming mode and relays
 * each fragment of the answer as it's generated — for a reasoning
 * model with thinking enabled (the default; see the `think` param on
 * chat() in ollamaClient.js), its reasoning trace arrives first as its
 * own event type, entirely separate from the answer text:
 *   {"type":"thinking","text":"First,"}
 *   {"type":"thinking","text":" the"}
 *   ...
 *   {"type":"token","text":"Off"}
 *   {"type":"token","text":"shore"}
 *   ...
 * and finally:
 *   {"type":"done","answer":"...full text...","sources":[...]}
 * or, if generation fails partway through (same caveat as the upload
 * route — the HTTP status is already committed to 200 by then):
 *   {"type":"error","error":"..."}
 *
 * When an ideal-proposal topic is selected AND the "attributes per
 * call" Advanced setting splits it into more than one batch (see
 * batchAttributes() in src/idealProposals.js), this route runs one
 * full retrieval+chat pass per batch instead of one pass over every
 * attribute at once, and every event above additionally carries
 * `batchIndex` (0-based) and `totalBatches`. Each batch's own tokens
 * still stream live exactly as above, and once a batch's chat call
 * finishes, one more event appears before the next batch starts:
 *   {"type":"batch-done","batchIndex":0,"totalBatches":8,"answer":"...","sources":[...],"records":[{"name":"...","proposal":"...","resultText":"...","category":"Matches"},...],"doneReason":"stop","promptTokens":...,"answerTokens":...}
 * `records` is this batch's attributes parsed into structured rows
 * (see parseComparisonAnswer() in src/responseParser.js — and its
 * caveat about how reliable that parsing actually is); it's what
 * lets the browser UI build a per-attribute table and CSV export
 * incrementally, batch by batch, rather than only after everything
 * finishes. The final "done" event's `answer`/`promptTokens`/
 * `answerTokens`/`records` are the combination of every batch's,
 * and it carries `totalBatches` too, so a caller that only cares
 * about the end result never has to sum the individual batch-done
 * events itself. For a non-comparison question, or a comparison left
 * at "all" (the default — unchanged from before this setting
 * existed), `totalBatches` is simply 1 and there's exactly one
 * "batch-done" immediately before "done".
 */
app.post('/query/stream', async (req, res) => {
  // Server-side stand-in for "the time recorded by the timer" the
  // browser shows next to Ask/Stop (performance.now()-based, purely
  // client-side — see queryStartTime in public/script.js) for the
  // completion email's report, which the browser has no chance to hand
  // a number to (the run is over, and the connection with it, before
  // there's anything left to send). This whole route runs the entire
  // rubric analysis on this one open connection (see the cancellation
  // comment below), so "how long this handler ran" is the same
  // duration the browser's own timer measured, modulo network latency
  // on this one request/response — close enough that a second,
  // independent measurement isn't worth the complexity of somehow
  // threading the client's own number back in after the fact.
  const requestStartedAt = Date.now();
  const { question, workspaceId, topK = 5, chatModel, embedModel, temperature, maxTokens, numCtx, repeatPenalty, idealTopicId, bestPracticesFilter, compareAgainstRubricId, think, attributesPerCall, notifyEmail, notifyEmailTo, threshold, retryNotAddressed } = req.body;
  // See the matching comment on /query above -- a rubric-comparison run
  // never touches a workspace, so the usual workspaceId requirement is
  // skipped for it.
  const wsErr = compareAgainstRubricId ? null : workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  // Same topic-resolution rules as /query above — kept before anything
  // streams, so a bad idealTopicId/bestPracticesFilter or a broken
  // idealProposals.json/bestPractices.json still comes back as a clean
  // HTTP error rather than a stream event.
  let topic;
  if (idealTopicId) {
    try {
      topic = getTopic(idealTopicId);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: `Could not load idealProposals.json: ${err.message}` });
    }
    if (!topic) return res.status(400).json({ error: `Unknown ideal-proposal topic id: "${idealTopicId}"` });
  } else if (bestPracticesFilter && Array.isArray(bestPracticesFilter.hazards) && bestPracticesFilter.hazards.length > 0) {
    // `hazards`/`states` are arrays, matched as an OR -- and
    // `jurisdictionGuidance` is this run's optional override -- see
    // the matching comment on /query above.
    try {
      topic = buildBestPracticesTopic(bestPracticesFilter.hazards, bestPracticesFilter.states, bestPracticesFilter.jurisdictionGuidance, bestPracticesFilter.analysisGuidance, Boolean(compareAgainstRubricId));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: `Could not load bestPractices.json: ${err.message}` });
    }
    if (topic.attributes.length === 0) {
      return res.status(400).json({
        error: `No Best Practices entries match hazard(s) "${bestPracticesFilter.hazards.join(', ')}"` +
          (bestPracticesFilter.states && bestPracticesFilter.states.length
            ? ` in state(s) "${bestPracticesFilter.states.join(', ')}".`
            : '.'),
      });
    }
  }

  if (!question && !topic) {
    return res.status(400).json({ error: 'question is required (or select an ideal-proposal topic, or a Best Practices hazard, to compare against)' });
  }

  // Same second-topic resolution as /query above -- the saved Rubric
  // Control topic being checked against, turned into a synthetic
  // `matches` array via buildRubricMatches() in src/idealProposals.js.
  // Resolved once, before anything streams, for the same reason the
  // idealTopicId/bestPracticesFilter resolution above is: a bad id or a
  // broken idealProposals.json should come back as a clean HTTP error,
  // not a stream event.
  let rubricMatches = null;
  if (compareAgainstRubricId) {
    let rubricTopic;
    try {
      rubricTopic = getTopic(compareAgainstRubricId);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: `Could not load idealProposals.json: ${err.message}` });
    }
    if (!rubricTopic) return res.status(400).json({ error: `Unknown rubric topic id: "${compareAgainstRubricId}"` });
    rubricMatches = buildRubricMatches(rubricTopic);
    if (rubricMatches.length === 0) {
      return res.status(400).json({ error: `The rubric "${rubricTopic.label}" has no (included) attributes to compare against.` });
    }
  }

  // Same resolve-once-up-front reasoning as /query above — every real
  // hybridSearch() call in this route (firstMatches below, each later
  // batch's own retrieval, and the "retry against a wider band" pass)
  // filters against this same excluded-document set.
  const excludedSourceFiles = rubricMatches ? new Set() : getExcludedSourceFiles(workspaceId);

  // See the long comment on batchAttributes() in src/idealProposals.js
  // and on /query above — same batching, just streamed per batch here
  // instead of collected silently into one response.
  const batches = topic ? batchAttributes(getIncludedAttributes(topic), attributesPerCall) : [null];
  const totalBatches = batches.length;

  // Cancellation: if the browser's Stop button aborts its own fetch to
  // this route (or the tab just closes, or the connection drops), Node
  // fires 'close' on `res` — deliberately `res`, not `req`: `req`'s own
  // 'close' fires as soon as the incoming request body has been fully
  // received (practically immediately for a small JSON POST), which
  // has nothing to do with whether the client is still around for the
  // response, and would abort every request instantly. `res`'s 'close'
  // is the one that only fires once the underlying connection actually
  // terminates — either because we ourselves finished the response
  // normally, or because the client genuinely went away early.
  // Wiring that into an AbortController and threading its signal into
  // every downstream Ollama call below — embed() for retrieval, chat()
  // for generation — means Ollama itself is told to stop working, not
  // just that this tab stopped listening; without that, the model
  // would keep generating to completion on a server nobody's waiting
  // on anymore. `clientGone` is the other half of this: once the
  // connection is gone there's nowhere to send anything, so every
  // response below checks it first rather than trying to write to (and
  // possibly throwing on) a dead connection.
  const controller = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
    controller.abort();
  });
  // A write attempted after the connection is already gone can surface
  // as an 'error' event on `res` rather than a thrown exception where
  // it's called — left unhandled, that becomes an unhandled exception.
  // clientGone above is what actually stops this route from attempting
  // those writes; this just makes sure one that slips through anyway
  // (an unavoidable small race, not a bug) can't crash the server.
  res.on('error', () => {});

  // Only this FIRST batch's retrieval can still fail as a clean HTTP
  // error response — once anything has streamed (right after this),
  // the status code is already committed to 200, so every batch
  // after the first reports a retrieval failure as a stream
  // {"type":"error"} event instead (inside the loop below).
  const firstQuestion = topic ? composeComparisonQuestion(topic, question, batches[0]) : question;
  // See composeRetrievalQuery()'s doc comment in src/idealProposals.js:
  // retrieval deliberately embeds a shorter, more focused text than
  // firstQuestion above (which is what the chat model actually sees) —
  // embedding firstQuestion's full instructional boilerplate was
  // pulling in topically-adjacent-but-irrelevant chunks. `null` in
  // rubric-comparison mode: nothing is actually embedded for that mode
  // (see rubricMatches below), so there is no meaningful retrieval-query
  // text to show.
  const firstRetrievalQuery = rubricMatches ? null : (topic ? composeRetrievalQuery(topic, question, batches[0]) : firstQuestion);
  let firstMatches;
  if (rubricMatches) {
    // Rubric-comparison mode: no retrieval at all -- the same fixed
    // rubricMatches array (every included attribute of the selected
    // Rubric Control topic) stands in for every batch's "matches",
    // resolved once already, above.
    firstMatches = rubricMatches;
  } else {
    try {
      const queryVector = await embed(firstRetrievalQuery, embedModel, undefined, controller.signal);
      // See the matching call in /query above and hybridSearch()'s doc
      // comment in src/hybridSearch.js — same vector+keyword fusion,
      // just for this route's first batch.
      firstMatches = hybridSearch(workspaceId, queryVector, firstRetrievalQuery, topK, excludedSourceFiles);
    } catch (err) {
      if (clientGone) {
        // Stopped before retrieval even finished — no one to report back
        // to, but still worth a log entry: the request was genuinely
        // attempted, and "aborted" is a more accurate record of what
        // happened than silently dropping it.
        logQueryActivity({ req, workspaceId, question, topic, compareAgainstRubricId, status: 'aborted' });
        return;
      }
      console.error(err);
      logQueryActivity({ req, workspaceId, question, topic, compareAgainstRubricId, status: 'error', error: err.message });
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  if (res.flushHeaders) res.flushHeaders();
  const send = (event) => res.write(JSON.stringify(event) + '\n');

  if (firstMatches.length === 0) {
    // See the matching comment on /query above — distinguishes a
    // genuinely empty workspace from one where every document is
    // currently excluded from search.
    const totalDocCount = listDocuments(workspaceId).length;
    const noDocsAnswer = totalDocCount === 0
      ? `No documents have been embedded yet in workspace "${workspaceId}". Run /embed first.`
      : `Every document in workspace "${workspaceId}" is currently excluded from search (see the Documents tab's Include checkboxes).`;
    logQueryActivity({ req, workspaceId, question, topic, compareAgainstRubricId, status: 'no-documents', answer: noDocsAnswer });
    send({
      type: 'done',
      answer: noDocsAnswer,
      sources: [],
      totalBatches: 1,
    });
    return res.end();
  }

  let combinedAnswer = '';
  // Same purpose as /query's combinedVerifiedAnswer above — only
  // populated for a plain (non-topic) question. See
  // verifyQuotesInPlace()'s doc comment in src/responseParser.js.
  let combinedVerifiedAnswer = '';
  let allRecords = [];
  // Pooled across every batch — same purpose as /query's `allSources`,
  // but this route never otherwise keeps a combined sources array (each
  // batch's sources are only ever sent as their own "sources"/
  // "batch-done" stream events), so this exists purely to feed
  // logQueryActivity()'s sourceChunkIds below.
  let allSourceIds = [];
  let totalPromptTokens = 0;
  let totalAnswerTokens = 0;
  let lastDoneReason;
  // Same purpose as /query's resolvedChatModel above — the chat model
  // that ACTUALLY answered, resolved by chat() itself rather than just
  // echoing back the requested `chatModel`.
  let resolvedChatModel;
  // Only populated (and only matters) when this is a rubric comparison
  // AND notifyEmail was requested — see the completion email send
  // below. Mirrors, batch for batch, the exact same shape the browser
  // builds client-side into `latestBatches` from these same "batch-done"
  // events (see script.js) — buildAttributeResultsHtml() in
  // public/reportHtml.js expects that shape regardless of which side
  // builds it, so the emailed report and the "Export HTML" download
  // are always identical for the same run.
  const batchesForReport = topic && notifyEmail ? [] : null;

  try {
    for (let i = 0; i < batches.length; i++) {
      if (clientGone) break;
      const attributesSubset = batches[i];

      // Batch 0 reuses the retrieval already done above (so it isn't
      // repeated); every later batch gets its own question, embed,
      // and search — a fresh retrieval scoped to just that batch's
      // attributes, which is the whole point of batching (see the
      // big comment on batchAttributes() in src/idealProposals.js).
      let matches, effectiveQuestion, retrievalQuery;
      if (i === 0) {
        matches = firstMatches;
        effectiveQuestion = firstQuestion;
        retrievalQuery = firstRetrievalQuery;
      } else if (rubricMatches) {
        // Rubric-comparison mode: every batch reuses the same fixed
        // rubricMatches array -- see the matching branch on /query
        // above and buildRubricMatches() in src/idealProposals.js.
        effectiveQuestion = composeComparisonQuestion(topic, question, attributesSubset);
        retrievalQuery = null;
        matches = rubricMatches;
      } else {
        effectiveQuestion = topic ? composeComparisonQuestion(topic, question, attributesSubset) : question;
        retrievalQuery = topic ? composeRetrievalQuery(topic, question, attributesSubset) : effectiveQuestion;
        const queryVector = await embed(retrievalQuery, embedModel, undefined, controller.signal);
        matches = hybridSearch(workspaceId, queryVector, retrievalQuery, topK, excludedSourceFiles);
      }

      // retrievalQuery is included here (not just used internally)
      // specifically so someone can see, directly in the UI, exactly
      // what text was embedded for this batch's search — the fastest
      // way to check whether a comparison run and a plain query that
      // "should" behave the same are actually searching with the same
      // text, without needing to hand anyone their private rubric
      // content to debug it. See composeRetrievalQuery()'s doc comment
      // in src/idealProposals.js for the retrieval-vs-chat-prompt split
      // this is meant to make visible.
      send({ type: 'sources', batchIndex: i, totalBatches, sources: sourcesSummary(matches), retrievalQuery });
      allSourceIds = allSourceIds.concat(matches.map((m) => m.id));

      if (matches.length === 0) {
        // Shouldn't normally happen once batch 0 already found
        // something, but handled defensively rather than assumed
        // impossible — nothing to chat about for this batch.
        send({ type: 'batch-done', batchIndex: i, totalBatches, answer: '', sources: [], records: [] });
        continue;
      }

      // See the matching comment on /query above for why "rubric under
      // review" is its own distinct materialLabel, separate from
      // "proposal".
      const materialLabel = rubricMatches ? 'rubric under review' : (topic ? 'proposal' : undefined);
      const messages = buildRagMessages(effectiveQuestion, matches, materialLabel);
      const { text: answer, thinking, doneReason, promptTokens, answerTokens, model: usedModel } = await chat(messages, {
        model: chatModel,
        temperature,
        maxTokens,
        numCtx,
        repeatPenalty,
        think,
        signal: controller.signal,
        onToken: (piece) => send({ type: 'token', batchIndex: i, totalBatches, text: piece }),
        onThinking: (piece) => send({ type: 'thinking', batchIndex: i, totalBatches, text: piece }),
      });

      combinedAnswer += (combinedAnswer ? '\n\n' : '') + answer;
      // Only computed for a plain question — a topic/comparison batch's
      // quotes are already verified via parseComparisonAnswer() just
      // below, surfaced through the rubric results UI instead.
      let verifiedAnswer;
      if (!topic) {
        verifiedAnswer = verifyQuotesInPlace(answer, matches);
        combinedVerifiedAnswer += (combinedVerifiedAnswer ? '\n\n' : '') + verifiedAnswer;
      }
      totalPromptTokens += promptTokens || 0;
      totalAnswerTokens += answerTokens || 0;
      lastDoneReason = doneReason;
      resolvedChatModel = usedModel;

      // `matches` here plays the same role as in /query above — lets
      // parseComparisonAnswer() verify any quote against this batch's
      // own retrieved chunk text.
      let records = attributesSubset && attributesSubset.length
        ? parseComparisonAnswer(answer, attributesSubset, matches)
        : [];

      // This batch's own reported token/cutoff figures, mutable so the
      // optional retry pass below can fold its own usage into them —
      // the batch-done event and the report should reflect the FULL
      // cost of producing this batch's final result, retry included,
      // not just the first attempt. totalPromptTokens/totalAnswerTokens/
      // lastDoneReason (the whole-run totals, used by the final "done"
      // event) are updated the same way, separately, below.
      let batchPromptTokens = promptTokens;
      let batchAnswerTokens = answerTokens;
      let batchDoneReason = doneReason;

      // Optional "retry against the next batch of retrieved chunks"
      // pass — see mergeRetryRecord()'s doc comment in
      // src/responseParser.js for the full mechanism and the
      // "worse/same/better" merge rule this relies on. Fires only
      // when the browser actually asked for it (`retryNotAddressed`,
      // the "Retry Not addressed..." checkbox), this is a rubric
      // comparison at all (nothing to retry against for a plain
      // question — see idealTopicId above), this batch actually has
      // an attribute whose verdict is eligible to retry
      // (RETRY_TRIGGER_VERDICTS), `threshold` was supplied (the
      // browser always sends its live Relevance field, but a caller
      // that doesn't can't be evaluated against it), AND every one of
      // this batch's own retrieved chunks scored at or above that
      // threshold. That last condition is deliberately a proxy for
      // "this corpus probably has more genuinely relevant material to
      // check" rather than "this topic just isn't well covered here at
      // all" — see the discussion this feature came out of: a topic
      // with weak retrieval across the board is very unlikely to have
      // anything BETTER sitting just past the cutoff, since the next
      // band is by construction even weaker-scoring than this one.
      //
      // Deliberately re-runs the WHOLE batch's question against the
      // next band, even when only one attribute in a multi-attribute
      // batch actually needs it (attributesPerCall > 1) — there's no
      // cheaper way to isolate just that one attribute's own
      // retrieval, and mergeRetryRecord() already protects every OTHER
      // attribute in the batch from regressing: an attribute that was
      // already fine will almost always come back "worse" against the
      // weaker next band and simply keep its original result.
      let retryMatches = null;
      let retryIncorporated = false;
      const shouldRetry =
        retryNotAddressed &&
        topic &&
        // Rubric-comparison mode has no "next band" to retry against —
        // rubricMatches is the SAME fixed, complete list every batch
        // already saw in full, not a topK-cut sample of a larger pool,
        // so there is nothing further to widen into. Guarded explicitly
        // here rather than just relying on matches.every(...) below to
        // happen to come out false, since rubricMatches' placeholder
        // `score: 1` (see its own doc comment in src/idealProposals.js)
        // could otherwise satisfy that check by coincidence.
        !rubricMatches &&
        records.length > 0 &&
        threshold !== undefined &&
        matches.length > 0 &&
        matches.every((m) => m.score >= threshold) &&
        records.some((r) => RETRY_TRIGGER_VERDICTS.includes(r.category));

      if (shouldRetry) {
        try {
          const retryVector = await embed(retrievalQuery, embedModel, undefined, controller.signal);
          // Same ranking hybridSearch() always produces (see its own
          // doc comment: the fused order is stable regardless of
          // topK, just cut off at a different length) — asking for
          // twice as many and slicing off the first half is what
          // isolates ranks topK+1..2*topK, the "next batch," without
          // ever re-showing this batch's own already-tried chunks.
          const widerMatches = hybridSearch(workspaceId, retryVector, retrievalQuery, topK * 2, excludedSourceFiles);
          const nextBandMatches = widerMatches.slice(topK);
          if (nextBandMatches.length > 0) {
            const retryMessages = buildRagMessages(effectiveQuestion, nextBandMatches, topic ? 'proposal' : undefined);
            const retryChatResult = await chat(retryMessages, {
              model: chatModel,
              temperature,
              maxTokens,
              numCtx,
              repeatPenalty,
              think,
              signal: controller.signal,
            });
            const retryRecords = parseComparisonAnswer(retryChatResult.text, attributesSubset, nextBandMatches);

            retryIncorporated = records.some((orig, idx) => verdictRank(retryRecords[idx].category) >= verdictRank(orig.category));
            records = records.map((orig, idx) => mergeRetryRecord(orig, retryRecords[idx]));
            retryMatches = nextBandMatches;

            batchPromptTokens += retryChatResult.promptTokens || 0;
            batchAnswerTokens += retryChatResult.answerTokens || 0;
            totalPromptTokens += retryChatResult.promptTokens || 0;
            totalAnswerTokens += retryChatResult.answerTokens || 0;
            if (retryChatResult.doneReason === 'length') {
              batchDoneReason = 'length';
              lastDoneReason = 'length';
            }
          }
        } catch (err) {
          // Never lets a failed retry attempt take down the whole
          // batch — the original, already-computed `records` (and the
          // chat call that already streamed to the browser) stand on
          // their own regardless. Logged, not surfaced as a stream
          // {"type":"error"} event, since the batch itself still
          // completed successfully from the browser's point of view.
          console.error('[query/stream] "retry Not addressed with next batch" attempt failed, keeping original result:', err);
        }
      }

      // Only widened when the retry above actually ran AND its
      // material ended up incorporated into at least one attribute's
      // merged result (see mergeRetryRecord()) — a "worse" outcome
      // intentionally leaves the reported sources exactly as they
      // were, since nothing from that next band is actually reflected
      // in what's shown.
      const reportedMatches = retryIncorporated && retryMatches ? matches.concat(retryMatches) : matches;
      const reportedSources = sourcesSummary(reportedMatches);

      allRecords = allRecords.concat(records);
      if (batchesForReport) {
        batchesForReport.push({
          batchIndex: i,
          totalBatches,
          sources: reportedSources,
          records,
          promptTokens: batchPromptTokens,
          answerTokens: batchAnswerTokens,
          doneReason: batchDoneReason,
        });
      }

      // `thinking` here mirrors /query's response: only included when
      // non-empty, for a caller that reconnected mid-stream or
      // otherwise missed the individual "thinking" events above.
      send({
        type: 'batch-done',
        batchIndex: i,
        totalBatches,
        answer,
        sources: reportedSources,
        doneReason: batchDoneReason,
        promptTokens: batchPromptTokens,
        answerTokens: batchAnswerTokens,
        records,
        ...(thinking ? { thinking } : {}),
        ...(verifiedAnswer ? { verifiedAnswer } : {}),
      });
    }

    if (!clientGone) {
      send({
        type: 'done',
        answer: combinedAnswer,
        promptTokens: totalPromptTokens,
        answerTokens: totalAnswerTokens,
        doneReason: lastDoneReason,
        records: allRecords,
        totalBatches,
        ...(combinedVerifiedAnswer ? { verifiedAnswer: combinedVerifiedAnswer } : {}),
      });
      logQueryActivity({
        req,
        workspaceId,
        question,
        topic,
        compareAgainstRubricId,
        status: 'completed',
        answer: combinedAnswer,
        sourceChunkIds: [...new Set(allSourceIds)],
        chatModel: resolvedChatModel,
      });
      // Deliberately NOT awaited: the browser is waiting on this
      // response to close so it can update the UI, and sending an
      // email (an outbound SMTP round trip) has no reason to hold that
      // up. sendRubricCompletionEmail() never throws (see its own doc
      // comment in src/emailNotify.js) — the .catch() here is only a
      // last-resort safety net, not something expected to ever fire.
      if (batchesForReport) {
        sendRubricCompletionEmail({
          req,
          workspaceId,
          topicLabel: topic.label,
          notifyEmailTo,
          batches: batchesForReport,
          chatModel: resolvedChatModel,
          topK,
          temperature,
          repeatPenalty,
          maxTokens,
          numCtx,
          think,
          attributesPerCall,
          elapsedMs: Date.now() - requestStartedAt,
        }).catch((err) => console.error('[query/stream] unexpected error sending completion email:', err));
      }
    } else {
      // The loop above exited via `if (clientGone) break;` — the
      // client disconnected between batches, with nothing having
      // thrown. Distinct from the catch block below, which handles an
      // abort landing mid-await (embed()/chat() rejecting with an
      // AbortError) — this is the same outcome reached a different
      // way, so it's logged identically.
      logQueryActivity({
        req,
        workspaceId,
        question,
        topic,
        compareAgainstRubricId,
        status: 'aborted',
        answer: combinedAnswer,
        sourceChunkIds: [...new Set(allSourceIds)],
        chatModel: resolvedChatModel,
      });
    }
  } catch (err) {
    // A failure here most commonly means chat() rejected mid-stream —
    // ollamaClient.js's chat() attaches whatever text had already
    // streamed as err.partialText in that case (see its own doc
    // comment), which combinedAnswer would NOT otherwise reflect: that
    // only gets updated once chat() returns normally, which it never
    // does on a thrown error. Folding it in here means the log still
    // captures a genuine partial answer instead of nothing, for
    // exactly the case this matters most — an aborted stream.
    const loggedAnswer = err.partialText
      ? (combinedAnswer ? combinedAnswer + '\n\n' : '') + err.partialText
      : combinedAnswer;

    if (clientGone) {
      console.log(`[query/stream] [${workspaceId}] stopped by client before finishing`);
      logQueryActivity({
        req,
        workspaceId,
        question,
        topic,
        compareAgainstRubricId,
        status: 'aborted',
        answer: loggedAnswer,
        sourceChunkIds: [...new Set(allSourceIds)],
        chatModel: resolvedChatModel || err.model,
      });
    } else {
      console.error(err);
      send({ type: 'error', error: err.message });
      logQueryActivity({
        req,
        workspaceId,
        question,
        topic,
        compareAgainstRubricId,
        status: 'error',
        error: err.message,
        answer: loggedAnswer,
        sourceChunkIds: [...new Set(allSourceIds)],
        chatModel: resolvedChatModel || err.model,
      });
    }
  } finally {
    if (!clientGone) res.end();
  }
});

// ---- Logs tab ----
//
// Read-only browsing of the JSONL files src/activityLog.js writes —
// see src/logViewer.js for the actual file reading/parsing and why a
// log line's 0-based position in its file is a safe, stable id to
// address it by. All three routes below are pure reads (no logAction()
// call of their own — viewing logs isn't itself a state-changing
// action, same reasoning GET .../documents/:sourceFile/chunks above
// isn't logged either) and, like every other route in this file, pass
// through whatever basicAuth.js has configured — there's no separate
// permission tier for this tab; anyone who can already reach the rest
// of this app can read the logs (see the "Logs" section of README.md,
// added alongside this feature, for why that's an accepted tradeoff
// for now rather than an oversight).

/**
 * GET /logs
 *
 * Lists every log file actually present in logs/, newest month first
 * — this is what populates the "Logs" tab's file picker. Always 200,
 * even with an empty `files` array on a brand new install that hasn't
 * logged anything yet.
 */
app.get('/logs', (req, res) => {
  res.json({ files: listLogFiles() });
});

/**
 * GET /logs/:filename/summaries
 *
 * The compact, clickable list for one log file — one short entry per
 * line (never the full record, never `answer` — see
 * summarizeLogFile()'s own doc comment in src/logViewer.js), newest
 * line first. :filename must be exactly one of the names GET /logs
 * just returned (e.g. "activity-2026-09.jsonl") — anything else is a
 * 400, and a well-formed name for a file that doesn't actually exist
 * is a 404, same two-tier validation-then-lookup split workspaceId
 * uses elsewhere in this file.
 */
app.get('/logs/:filename/summaries', (req, res) => {
  const { filename } = req.params;
  if (!isValidLogFileName(filename)) {
    return res.status(400).json({ error: `Invalid log file name "${filename}".` });
  }

  try {
    const result = summarizeLogFile(filename);
    if (!result) return res.status(404).json({ error: `No log file named "${filename}".` });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /logs/:filename/lines/:line
 *
 * The full record for exactly one line, with `answer` stripped out —
 * see getLogEntry()'s own doc comment in src/logViewer.js for exactly
 * what that means for a line that failed to parse. :line is the same
 * 0-based index a GET .../summaries response's `line` field already
 * gave the browser for this entry — not a user-typed value, so an
 * out-of-range or malformed one here normally only happens from a
 * hand-built request (see README.md's "Testing with PowerShell"
 * section), same 404-not-500 treatment getChunk() gets for an unknown
 * chunk id above.
 */
app.get('/logs/:filename/lines/:line', (req, res) => {
  const { filename } = req.params;
  if (!isValidLogFileName(filename)) {
    return res.status(400).json({ error: `Invalid log file name "${filename}".` });
  }
  if (!/^\d+$/.test(req.params.line)) {
    return res.status(400).json({ error: `Invalid log line "${req.params.line}".` });
  }
  const line = Number(req.params.line);

  try {
    const entry = getLogEntry(filename, line);
    if (!entry) return res.status(404).json({ error: `No line ${line} in log file "${filename}".` });
    res.json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /logs/:filename/lines/:line/answer
 *
 * Just the `answer` text GET .../lines/:line above deliberately left
 * out — fetched only when "Show answer" is actually clicked for an
 * entry whose `hasAnswer` came back true, so a long generated answer
 * never crosses the wire unless someone specifically asks for that one
 * entry's. A line with no answer at all (true for every action-log
 * entry, and for most activity-log entries — see hasAnswer's own doc
 * comment in src/logViewer.js) 404s here rather than returning an
 * empty string, since the UI shouldn't be offering this button at all
 * in that case.
 */
app.get('/logs/:filename/lines/:line/answer', (req, res) => {
  const { filename } = req.params;
  if (!isValidLogFileName(filename)) {
    return res.status(400).json({ error: `Invalid log file name "${filename}".` });
  }
  if (!/^\d+$/.test(req.params.line)) {
    return res.status(400).json({ error: `Invalid log line "${req.params.line}".` });
  }
  const line = Number(req.params.line);

  try {
    const answer = getLogEntryAnswer(filename, line);
    if (answer === null) return res.status(404).json({ error: `No answer recorded for line ${line} in log file "${filename}".` });
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`local-rag server listening on http://localhost:${PORT}`);
});
