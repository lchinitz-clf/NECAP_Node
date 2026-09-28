/**
 * Read-only support for the "Logs" tab — lets someone browse the
 * append-only JSONL files src/activityLog.js writes (logs/activity-
 * YYYY-MM.jsonl, logs/actions-YYYY-MM.jsonl) from the browser instead
 * of needing shell access to the server. This module never writes
 * anything; it only ever reads files activityLog.js already produced.
 *
 * Three levels of detail, matching the three things the UI needs, in
 * order of how much data they carry:
 *
 *   1. listLogFiles() - which files exist at all, for the file picker.
 *   2. summarizeLogFile() - one short, fixed-size object per line (the
 *      clickable list) - timestamp, type, and a couple of identifying
 *      fields, but never the full record and never `answer`.
 *   3. getLogEntry() - the FULL record for exactly one line, still
 *      with `answer` stripped out (see its own doc comment for why),
 *      shown inline once a summary line is clicked.
 *   4. getLogEntryAnswer() - just the `answer` field for one line,
 *      fetched only if someone explicitly asks to see it.
 *
 * This split exists so opening the tab, and even opening one entry's
 * detail, never pulls a long generated answer over the wire unless
 * it's specifically asked for — the same "fetch the heavy part only on
 * request" shape store.js's getChunk() already uses for block text
 * (see the chunk-viewer modal in the browser), just applied to log
 * entries instead of retrieved chunks.
 *
 * Line IDENTITY: a log line is addressed by its 0-based position in
 * the file (the order appendFileSync() actually wrote it in). This is
 * safe to treat as a stable id — not just a fragile "row number that
 * might shift" — specifically because these files are strictly
 * append-only (see activityLog.js's own module doc comment): nothing
 * ever inserts, reorders, or removes an earlier line, so a line index
 * captured from one summarizeLogFile() call still points at the exact
 * same entry even if the server has appended more lines to that same
 * file in the meantime (they can only land AFTER it).
 *
 * Malformed lines: activityLog.js's own doc comment already
 * acknowledges the one failure mode an append-only file is exposed to
 * — a crash mid-write leaving one incomplete trailing line. A single
 * line that fails JSON.parse must not take the rest of an otherwise
 * perfectly good file down with it (nobody wants "log viewer broken"
 * on top of whatever crashed), so every line is parsed individually
 * and a bad one becomes a clearly-marked `broken` entry carrying its
 * raw text, rather than throwing and failing the whole request.
 */

const fs = require('fs');
const path = require('path');
const { LOGS_DIR } = require('./activityLog');

// Matches exactly what monthlyLogFilePath() in activityLog.js produces
// — "activity" or "actions", a 4-digit year, a 2-digit month. Anchored
// at both ends and checked before ANY filesystem call below touches a
// caller-supplied filename, same "strict allowlist before it ever
// touches the filesystem" posture isValidWorkspaceId() in workspace.js
// uses for workspaceId — the whole point is that a path-traversal-
// shaped name ("../../etc/passwd") simply never matches this pattern,
// so it's rejected before path.join() ever sees it, not merely
// "unlikely to resolve to something sensitive."
const LOG_FILE_NAME_PATTERN = /^(activity|actions)-(\d{4})-(\d{2})\.jsonl$/;

/** @returns {boolean} */
function isValidLogFileName(name) {
  return typeof name === 'string' && LOG_FILE_NAME_PATTERN.test(name);
}

/**
 * Resolves (but does not read) a log file's path. Throws on an invalid
 * name — callers check isValidLogFileName() first to turn that into a
 * clean 400 instead of a 500, same convention workspaceDir() in
 * workspace.js follows for workspaceId.
 * @param {string} name
 * @returns {string}
 */
function logFilePath(name) {
  if (!isValidLogFileName(name)) {
    throw new Error(`Invalid log file name "${name}".`);
  }
  return path.join(LOGS_DIR, name);
}

/**
 * Every log file actually present on disk, newest month first (ties
 * broken alphabetically by kind, so "actions" and "activity" for the
 * same month sort consistently rather than depending on directory
 * listing order). Never throws — a missing logs/ directory (a brand
 * new install that hasn't logged anything yet) or an unreadable
 * individual file just means fewer/no entries, not an error.
 * @returns {Array<{name: string, kind: 'activity'|'actions', year: number, month: number, lineCount: number, mtimeMs: number}>}
 */
function listLogFiles() {
  let names;
  try {
    names = fs.readdirSync(LOGS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const name of names) {
    const m = LOG_FILE_NAME_PATTERN.exec(name);
    if (!m) continue; // ignore anything in logs/ that isn't one of ours
    const [, kind, yearStr, monthStr] = m;
    try {
      const filePath = path.join(LOGS_DIR, name);
      const stat = fs.statSync(filePath);
      const text = fs.readFileSync(filePath, 'utf8');
      const lineCount = text.split('\n').filter((l) => l.trim()).length;
      files.push({ name, kind, year: Number(yearStr), month: Number(monthStr), lineCount, mtimeMs: stat.mtimeMs });
    } catch (err) {
      // Skip a file that vanished or became unreadable between
      // readdirSync and here rather than failing the whole listing
      // over one file.
      console.error(`Could not read log file ${name}:`, err.message);
    }
  }

  files.sort((a, b) => (b.year - a.year) || (b.month - a.month) || a.kind.localeCompare(b.kind));
  return files;
}

/**
 * Reads and parses every line of one log file, in the order they were
 * written (index 0 = first/oldest entry) — see this module's own doc
 * comment for why that index is a safe, stable id to build the rest of
 * this module's API around. Returns `null` if the file doesn't exist
 * (callers turn that into a 404); throws if `name` itself is invalid
 * (callers turn THAT into a 400 — see isValidLogFileName()).
 * @param {string} name
 * @returns {Array<{ok: true, entry: object} | {ok: false, raw: string}> | null}
 */
function readLogFileLines(name) {
  const filePath = logFilePath(name); // throws on a malformed name
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((raw) => {
      try {
        return { ok: true, entry: JSON.parse(raw) };
      } catch (err) {
        // See this module's doc comment: a truncated trailing line
        // from a crash mid-write is an expected, non-fatal possibility
        // here, not a bug to propagate as a 500.
        return { ok: false, raw };
      }
    });
}

/**
 * Builds the compact, fixed-shape summary for one already-parsed line
 * — deliberately NOT the full record (see summarizeLogFile() below for
 * why the list stays this narrow) and never `answer`, even by
 * accident, which is why this pulls out a small named allowlist of
 * fields rather than spreading the entry and deleting one key back
 * out. `hasAnswer` tells the detail view whether a "Show answer"
 * button is even meaningful for this entry (most aren't — only a
 * completed/no-documents activity-log entry ever carries one; action-
 * log entries, and an aborted or errored activity entry with nothing
 * generated yet, never do).
 * @param {object} entry
 * @param {number} line
 * @returns {object}
 */
function summarizeEntry(entry, line) {
  const summary = { line, timestamp: entry.timestamp, type: entry.type };
  // Same "who" convention activityLog.js's own doc comment describes
  // (see logQueryActivity()/logAction() in that file): a real username
  // when Basic Auth is configured with named users, the caller's IP
  // address otherwise. Both are included here (rather than collapsing
  // to one field) so the list can show `user` when it's meaningfully a
  // person and fall back to `ip` only when that's genuinely all this
  // server knows — same as the full detail view already does via
  // getLogEntry().
  if (entry.user) summary.user = entry.user;
  if (entry.ip) summary.ip = entry.ip;
  if (entry.workspaceId) summary.workspaceId = entry.workspaceId;
  if (entry.topicId) summary.topicId = entry.topicId;
  if (entry.topicLabel) summary.topicLabel = entry.topicLabel;
  if (entry.sourceFile) summary.sourceFile = entry.sourceFile;
  if (entry.status) summary.status = entry.status; // activity-log entries
  if (typeof entry.success === 'boolean') summary.success = entry.success; // action-log entries
  summary.hasAnswer = typeof entry.answer === 'string' && entry.answer.length > 0;
  return summary;
}

/**
 * The compact per-line list for one log file's "Logs" tab view —
 * newest entry first, since "what just happened" is normally what
 * someone opening a log is after. Each item is summarizeEntry()'s
 * narrow shape (or a `broken: true` placeholder for an unparseable
 * line — see readLogFileLines()); nothing here is ever the full
 * record, so opening this list costs the same small amount of data
 * whether the file has ten lines or ten thousand.
 * @param {string} name
 * @returns {{name: string, lineCount: number, summaries: Array<object>} | null} null if the file doesn't exist
 */
function summarizeLogFile(name) {
  const lines = readLogFileLines(name); // throws on invalid name, same as below
  if (lines === null) return null;

  const summaries = lines.map((line, i) =>
    line.ok
      ? summarizeEntry(line.entry, i)
      : { line: i, broken: true, timestamp: null, type: '(unreadable line)' }
  );
  summaries.reverse(); // newest first for display; each item still carries its own true `line` index

  return { name, lineCount: lines.length, summaries };
}

/**
 * The full record for exactly one line, with `answer` removed (see
 * getLogEntryAnswer() below for the only way to actually get it) —
 * everything else the line contains (timestamp, ip, user, workspaceId,
 * question, status, chatModel, error, sourceChunkIds, or whatever an
 * action-log entry's own `details` added) comes through as-is, per the
 * "show everything except the answer" design this tab was built
 * around.
 * @param {string} name
 * @param {number} line - 0-based index into the file, as handed back
 *   by summarizeLogFile() above.
 * @returns {object | null} null if the file or that line doesn't exist
 */
function getLogEntry(name, line) {
  const lines = readLogFileLines(name); // throws on invalid name
  if (lines === null) return null;
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;

  const row = lines[line];
  if (!row.ok) {
    return { line, broken: true, raw: row.raw };
  }

  const { answer, ...rest } = row.entry;
  return { line, ...rest, hasAnswer: typeof answer === 'string' && answer.length > 0 };
}

/**
 * Just the `answer` text for one line — the one thing getLogEntry()
 * above deliberately leaves out. Called only when someone clicks
 * "Show answer" on an entry whose `hasAnswer` was true; a caller that
 * asks for a line with no answer at all gets `null` back (turned into
 * a 404 by the route — see its own comment for why that's not expected
 * to happen in normal use, only via a hand-built request).
 * @param {string} name
 * @param {number} line
 * @returns {string | null} null if the file/line doesn't exist, the
 *   line is unparseable, or it has no non-empty `answer` field.
 */
function getLogEntryAnswer(name, line) {
  const lines = readLogFileLines(name); // throws on invalid name
  if (lines === null) return null;
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;

  const row = lines[line];
  if (!row.ok) return null;
  return typeof row.entry.answer === 'string' && row.entry.answer.length > 0 ? row.entry.answer : null;
}

module.exports = {
  isValidLogFileName,
  listLogFiles,
  summarizeLogFile,
  getLogEntry,
  getLogEntryAnswer,
};
