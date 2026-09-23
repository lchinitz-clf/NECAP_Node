/**
 * Append-only audit trail split across TWO separate log files:
 *
 *   logs/activity-YYYY-MM.jsonl - full detail for every query and
 *     ideal-proposal-comparison ("rubric analysis") request: who asked,
 *     when, against which storage area, what was asked, what chat
 *     model actually answered it, and what came back — including
 *     requests that were aborted or failed, not just ones that
 *     completed normally. Written by logQueryActivity() below. See
 *     /query and /query/stream in index.js for the two request paths
 *     that both log through it, and the "Comparing against an ideal
 *     proposal" section of README.md for what a rubric analysis
 *     actually is.
 *
 *   logs/actions-YYYY-MM.jsonl - a terser record of every action that
 *     changes something on disk: uploading/embedding a document,
 *     deleting a document or a whole workspace, rebuilding a
 *     workspace's index, and creating/updating/deleting a rubric
 *     topic — plus, alongside all of those, a one-line marker (not the
 *     full question/answer detail, which stays exclusive to the file
 *     above) every time a query or rubric analysis happens. Written by
 *     logAction() below, called directly from index.js's write routes;
 *     logQueryActivity() also writes one of these terse markers itself
 *     so query/rubric-analysis logging never has to happen twice at
 *     the call site. Deliberately NOT used for read-only routes (GET
 *     .../documents, GET .../chunks/:chunkId, the xlsx preview routes,
 *     /ingest) — this is an audit trail of what changed, not a request
 *     log of everything that was ever asked, and viewing a chunk's
 *     text in particular is explicitly excluded even though it's
 *     technically a GET like the others.
 *
 * Both files share the same storage shape: one JSON object per line
 * ("JSONL", also called NDJSON), with a new file starting automatically
 * each month, so no single file grows without bound and an old month
 * can be archived or deleted just by moving or removing that one file.
 * This is deliberately NOT the same "read the whole file, modify it in
 * memory, rewrite the whole file" pattern idealProposals.json and
 * store.json use elsewhere in this app — that pattern is fine for
 * something small and edited occasionally, but would mean
 * re-serializing an ever-growing array on every single write if used
 * here, getting slower as the log grows and risking the WHOLE log if a
 * write is interrupted partway. Appending one line is a single, cheap
 * write regardless of how big the log already is, and — since each
 * line is written via one fs.appendFileSync call — POSIX guarantees a
 * single write() to a file opened with O_APPEND (which Node's 'a' flag
 * uses) is atomic, so concurrent requests can never interleave and
 * corrupt each other's lines. The worst a crash mid-write can do is
 * leave one incomplete trailing line; every earlier line is untouched.
 *
 * Deliberately narrow field sets in both files: who (IP address), when,
 * which storage area, what happened, whether it succeeded, and — for
 * the query log specifically — which chunk IDs were retrieved. Neither
 * file includes retrieved chunks' own text, before/after snapshots of
 * anything that changed, or any other server-internal detail (retrieval
 * query text, token counts, per-batch breakdowns, etc.) that the rest
 * of this app tracks elsewhere — this is an audit trail (who did what,
 * when, and whether it worked), not a version-history/undo system, so
 * there's nothing here to reconstruct a prior state from. Keeping the
 * schema this narrow is also what keeps both files small.
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * @param {string} prefix - "activity" or "actions".
 * @param {Date} [date] - defaults to now; only ever passed explicitly
 *   by tests, so they can check month-rollover without waiting for a
 *   real month boundary.
 * @returns {string} absolute path to the log file this month's
 *   entries of that kind belong in, e.g. ".../logs/activity-2026-09.jsonl".
 */
function monthlyLogFilePath(prefix, date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return path.join(LOGS_DIR, `${prefix}-${year}-${month}.jsonl`);
}

/** @returns {string} this month's full-detail query/rubric-analysis log file path. */
function currentLogFilePath(date = new Date()) {
  return monthlyLogFilePath('activity', date);
}

/** @returns {string} this month's action-log file path. */
function currentActionLogFilePath(date = new Date()) {
  return monthlyLogFilePath('actions', date);
}

/**
 * Appends one raw record (as-is, plus an auto-added `timestamp`) to the
 * given log file. Never throws — a logging failure (disk full,
 * permissions, whatever) is reported to the server console instead.
 * Losing one audit-log line should never take down the actual request
 * it was describing, which by the time this runs has normally already
 * been answered (or is about to be) — the response the user sees must
 * not depend on this succeeding.
 * @param {string} filePath
 * @param {object} entry - plain object; `timestamp` is added automatically.
 */
function appendToLog(filePath, entry) {
  try {
    ensureLogsDir();
    const record = { timestamp: new Date().toISOString(), ...entry };
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error(`Failed to write log entry to ${filePath}:`, err.message);
  }
}

/** Appends one entry to this month's full-detail query/rubric-analysis log. */
function appendActivityLog(entry) {
  appendToLog(currentLogFilePath(), entry);
}

/** Appends one entry to this month's action log. */
function appendActionLog(entry) {
  appendToLog(currentActionLogFilePath(), entry);
}

/**
 * Logs one query or rubric-analysis request — full detail, into the
 * activity log — AND a terse one-line marker for the same request into
 * the action log (just enough to say a query or rubric analysis
 * happened, who/when/where, and whether it succeeded; not the question,
 * answer, or sourceChunkIds, which stay exclusive to the activity log
 * entry this same call writes). This is the single entry point both
 * /query and /query/stream call, at every exit point (completed
 * normally, "no documents in this workspace yet", aborted by the
 * client, or failed with an error) — not just successful requests — so
 * both logs reflect what actually happened. A request that never got
 * this far at all (a bad workspaceId, an unknown idealTopicId, a
 * missing question with no topic either) is NOT logged in either file:
 * those are rejected before anything meaningful was actually attempted
 * against a real workspace, so there's nothing worth recording yet.
 *
 * @param {object} params
 * @param {import('express').Request} params.req - used only for
 *   req.ip. On this app's normal setup (no reverse proxy in front of
 *   it) that's the real, direct peer address; if this server is ever
 *   put behind a proxy, Express's own `trust proxy` setting would need
 *   to be configured for req.ip to keep meaning the original caller
 *   rather than the proxy itself — not a concern today, but worth
 *   remembering if the deployment changes. It's also only ever as
 *   meaningful as "which machine," not "which person" — multiple
 *   people sharing one machine, or a NAT'd network where everyone
 *   looks like one router address, both collapse to the same IP here.
 * @param {string} params.workspaceId
 * @param {string} [params.question] - the raw text typed into the
 *   question box, if any. For a plain query this is the whole
 *   question; for a rubric analysis it's optional extra guidance typed
 *   on top of the selected topic (often '', when none was typed).
 * @param {{id: string, label: string}} [params.topic] - when set, this
 *   request is logged as a "rubricAnalysis" entry (with topicId/
 *   topicLabel) instead of a plain "query" entry. Pass the exact topic
 *   object /query and /query/stream already resolved via getTopic() —
 *   this function doesn't re-look it up.
 * @param {'completed'|'no-documents'|'aborted'|'error'} params.status
 *   - "completed": a real answer was generated and returned.
 *   - "no-documents": the workspace has nothing embedded yet, so the
 *     request short-circuited with an explanatory message instead of
 *     ever reaching the chat model — not a failure, just recorded
 *     distinctly from a real answer since there's no actual content to
 *     look back on later.
 *   - "aborted": the client disconnected (Stop button, closed tab,
 *     dropped connection) before a response was fully generated.
 *   - "error": something threw — Ollama unreachable, a bad chat-model
 *     name, etc.
 *   In the action log's terse marker, this collapses further into a
 *   plain `success` boolean (true for "completed"/"no-documents",
 *   false for "aborted"/"error") — the fuller distinction stays in the
 *   activity log entry, where there's room for it.
 * @param {string} [params.answer] - the final answer text for
 *   "completed"/"no-documents", or whatever partial text had already
 *   been generated before an "aborted"/"error" outcome, if any.
 *   Omitted from the logged line entirely (not written as `""`) when
 *   there's genuinely nothing yet — e.g. an error before the chat
 *   model ever produced its first token. Activity log only.
 * @param {string} [params.error] - the error message, only meaningful
 *   (and only passed) for status "error". Written to both logs.
 * @param {string[]} [params.sourceChunkIds] - the id of every chunk
 *   retrieved for this request, deduplicated, pooled across every
 *   batch for a multi-batch rubric analysis (see batchAttributes() in
 *   idealProposals.js) — NOT the chunks' own text; see this module's
 *   doc comment for why. Omitted from the logged line when empty.
 *   Activity log only.
 * @param {string} [params.chatModel] - the chat model that ACTUALLY
 *   answered this request, resolved by ollamaClient.js's chat() (its
 *   own built-in default when the caller didn't specify one — see the
 *   `model` field chat() now returns, and its `err.model` on a thrown
 *   error) — not simply whatever the caller happened to pass in, which
 *   may have been left blank. Omitted from the logged line when no
 *   chat call was ever actually reached (e.g. "no-documents", or an
 *   error/abort before the first chat() call resolved a model).
 *   Activity log only — the action log's marker doesn't need it.
 */
function logQueryActivity({ req, workspaceId, question, topic, status, answer, error, sourceChunkIds, chatModel }) {
  const type = topic ? 'rubricAnalysis' : 'query';

  appendActivityLog({
    type,
    ip: req.ip,
    workspaceId,
    ...(topic ? { topicId: topic.id, topicLabel: topic.label } : {}),
    question: question || '',
    status,
    ...(chatModel ? { chatModel } : {}),
    ...(answer ? { answer } : {}),
    ...(error ? { error } : {}),
    ...(sourceChunkIds && sourceChunkIds.length ? { sourceChunkIds } : {}),
  });

  appendActionLog({
    type,
    ip: req.ip,
    workspaceId,
    ...(topic ? { topicId: topic.id } : {}),
    success: status === 'completed' || status === 'no-documents',
    ...(error ? { error } : {}),
  });
}

/**
 * Logs one state-changing action to the action log — document
 * upload/embed, document delete, workspace delete, index rebuild, or a
 * rubric topic create/update/delete. Deliberately NOT called for any
 * read-only route (listing documents, viewing a chunk's text, the xlsx
 * preview routes, /ingest) — see this module's doc comment for why.
 * Queries and rubric analyses are logged here too, but through
 * logQueryActivity() above rather than this function directly, since
 * that's the one place both the full activity-log entry and this
 * log's terse marker need to stay in sync.
 *
 * Like appendActivityLog()/appendActionLog(), never throws — a logging
 * failure must not take down the real request it's describing.
 *
 * @param {object} params
 * @param {import('express').Request} params.req - used only for req.ip;
 *   see the matching param on logQueryActivity() above for the same
 *   caveats (machine, not person; req.ip assumes no reverse proxy).
 * @param {string} params.type - a short camelCase action name, e.g.
 *   "documentUpload", "documentEmbed", "documentDelete",
 *   "workspaceDelete", "indexRebuild", "rubricTopicCreate",
 *   "rubricTopicUpdate", "rubricTopicDelete".
 * @param {string} [params.workspaceId] - omitted for actions that
 *   aren't workspace-scoped (the rubric-topic actions apply across the
 *   whole app, not to one workspace).
 * @param {boolean} params.success - whether the action actually
 *   completed. Failures are logged here too (per the explicit decision
 *   to log failures, not just successes), with `error` set alongside.
 * @param {string} [params.error] - the error message, only meaningful
 *   (and only passed) when `success` is false.
 * @param {object} [params.details] - a handful of small, already-known
 *   identifying fields specific to this action (e.g. `sourceFile` for
 *   a document action, `topicId`/`label` for a rubric action) — kept
 *   deliberately minimal, same "efficient, don't take up space" intent
 *   as the rest of this module; never the changed content itself
 *   (document text, full rubric attribute lists, etc.), since this is
 *   an audit trail, not a version-history/undo system.
 */
function logAction({ req, type, workspaceId, success, error, details }) {
  appendActionLog({
    type,
    ip: req.ip,
    ...(workspaceId ? { workspaceId } : {}),
    success,
    ...(error ? { error } : {}),
    ...(details && Object.keys(details).length ? details : {}),
  });
}

module.exports = {
  appendActivityLog,
  appendActionLog,
  logQueryActivity,
  logAction,
  currentLogFilePath,
  currentActionLogFilePath,
  LOGS_DIR,
};
