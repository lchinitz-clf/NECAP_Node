/**
 * Per-document metadata that lives OUTSIDE store.json, on purpose.
 *
 * store.json (see store.js) is a flat array of CHUNK records, wholly
 * rebuilt by "Re-initialize this area" (rebuildWorkspaceIndex() in
 * embedPipeline.js) and fully replaced every time a document is
 * re-embedded. A free-text note about a document — today just a
 * description, typed in from the Documents tab — has no natural home
 * in that array: it isn't tied to any one chunk, and it would
 * otherwise get silently wiped out the next time that document's
 * chunks happen to be regenerated. Keeping it in its own small file,
 * workspaces/<id>/documentMeta.json, means it survives exactly the
 * operations it should survive (rebuilding or re-embedding the same
 * document) and only ever goes away on purpose — see
 * deleteDescription() below, called when the document itself is
 * removed.
 *
 * Shape on disk: `{ "<sourceFile>": { "description": "...", "included": false }, ... }` —
 * one small object per sourceFile rather than a bare string, so a
 * later per-document field doesn't need a schema migration (exactly
 * what let `included` get added here later with no migration at
 * all). `included` follows the same "only the exception is stored"
 * minimalism as `description`: it's only ever written as the literal
 * `false`, and only for a document someone has explicitly excluded —
 * a document with no entry here at all, or an entry with no
 * `included` key, is included by default (see isDocumentIncluded()
 * below). That default matters for more than just "the common case
 * stays a no-op write": it's also what makes a brand-new document
 * (just embedded, never had an entry here) start out included with
 * zero code needed to say so.
 *
 * Same "plain JSON file you can open yourself" philosophy store.js's
 * own doc comment describes, and the same workspaceId validation
 * (via workspaceDir() in workspace.js, which every function below
 * goes through before touching the filesystem).
 */

const fs = require('fs');
const path = require('path');
const { workspaceDir, ensureWorkspaceDir } = require('./workspace');

/** @param {string} workspaceId @returns {string} */
function metaPath(workspaceId) {
  return path.join(workspaceDir(workspaceId), 'documentMeta.json'); // workspaceDir() throws on an invalid id
}

function loadMeta(workspaceId) {
  const p = metaPath(workspaceId);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    // Same "don't take the whole feature down over one bad file"
    // posture logViewer.js takes toward a corrupt log line — a
    // hand-edited or truncated documentMeta.json just means no
    // descriptions are available until it's fixed, not a 500.
    console.error(`Could not parse ${p}, treating as empty:`, err.message);
    return {};
  }
}

function saveMeta(workspaceId, meta) {
  ensureWorkspaceDir(workspaceId);
  fs.writeFileSync(metaPath(workspaceId), JSON.stringify(meta, null, 2));
}

/**
 * Every description actually set in this workspace, for GET
 * /workspaces/:workspaceId/documents to merge into its per-document
 * list. Only includes entries that have a real, non-empty
 * description — a document that's never had one set has no key here
 * at all, rather than an empty string, so the UI's own "no description
 * yet" placeholder logic doesn't have to special-case `''`.
 * @param {string} workspaceId
 * @returns {Object<string, string>} sourceFile -> description
 */
function getAllDescriptions(workspaceId) {
  const meta = loadMeta(workspaceId);
  const result = {};
  for (const [sourceFile, entry] of Object.entries(meta)) {
    if (entry && typeof entry.description === 'string' && entry.description) {
      result[sourceFile] = entry.description;
    }
  }
  return result;
}

/**
 * Sets, or — given an empty/whitespace-only string — clears, one
 * document's description. Clearing removes the entry entirely rather
 * than storing `""`, so an otherwise-empty documentMeta.json really is
 * `{}`, not a file full of placeholder objects.
 * @param {string} workspaceId
 * @param {string} sourceFile
 * @param {string} description
 * @returns {string} the description actually stored, after trimming
 */
function setDescription(workspaceId, sourceFile, description) {
  const meta = loadMeta(workspaceId);
  const trimmed = String(description || '').trim();

  if (trimmed) {
    meta[sourceFile] = { description: trimmed };
  } else {
    delete meta[sourceFile];
  }

  saveMeta(workspaceId, meta);
  return trimmed;
}

/**
 * Whether a document counts as included in retrieval — true unless an
 * entry explicitly says otherwise, so a document with no entry at all
 * (the common case, and always true for a just-embedded document) and
 * one with an entry that only ever set a description are both
 * included by default. Same "missing means true" convention
 * isAttributeIncluded() in src/idealProposals.js already uses for a
 * Rubric Control attribute's own Include checkbox.
 * @param {{included?: boolean}|undefined} entry
 * @returns {boolean}
 */
function isDocumentIncluded(entry) {
  return !entry || entry.included !== false;
}

/**
 * Every document explicitly excluded (unchecked) in this workspace —
 * for GET /workspaces/:workspaceId/documents to report each
 * document's current state, and for hybridSearch() in
 * src/hybridSearch.js to actually filter retrieval by. Only documents
 * with a real, explicit exclusion come back here, not a Set of every
 * OTHER document's sourceFile — same "absence means default" shape
 * getAllDescriptions() above already follows, and the right shape for
 * a caller that just wants to test `excluded.has(sourceFile)` either
 * way.
 * @param {string} workspaceId
 * @returns {Set<string>} excluded sourceFiles
 */
function getExcludedSourceFiles(workspaceId) {
  const meta = loadMeta(workspaceId);
  const excluded = new Set();
  for (const [sourceFile, entry] of Object.entries(meta)) {
    if (!isDocumentIncluded(entry)) excluded.add(sourceFile);
  }
  return excluded;
}

/**
 * Sets, or — given `true`, the default — clears, one document's
 * inclusion flag. Mirrors setDescription()'s own shape: only a real
 * exclusion is ever actually written (`{ included: false }`),
 * clearing it back out entirely once a document is re-included rather
 * than leaving a redundant `included: true` sitting in the file
 * forever. Preserves whatever description entry already exists for
 * this sourceFile either way, since the two fields share one entry
 * per the module doc comment above.
 * @param {string} workspaceId
 * @param {string} sourceFile
 * @param {boolean} included
 * @returns {boolean} the included state actually stored
 */
function setIncluded(workspaceId, sourceFile, included) {
  const meta = loadMeta(workspaceId);
  const wantIncluded = included !== false; // anything but an explicit false means "included"

  if (wantIncluded) {
    if (meta[sourceFile]) {
      delete meta[sourceFile].included;
      if (Object.keys(meta[sourceFile]).length === 0) delete meta[sourceFile];
    }
  } else {
    meta[sourceFile] = { ...meta[sourceFile], included: false };
  }

  saveMeta(workspaceId, meta);
  return wantIncluded;
}

/**
 * Removes a document's metadata entirely — both its description AND
 * its inclusion flag. Called from DELETE
 * /workspaces/:workspaceId/documents/:sourceFile in index.js right
 * after the document's chunks are removed, so a later document that
 * happens to reuse the same filename never inherits a stale
 * description, or a stale exclusion, left over from whatever used to
 * be there — it starts fresh, included by default, same as any other
 * brand-new document.
 * @param {string} workspaceId
 * @param {string} sourceFile
 */
function deleteDescription(workspaceId, sourceFile) {
  const meta = loadMeta(workspaceId);
  if (meta[sourceFile]) {
    delete meta[sourceFile];
    saveMeta(workspaceId, meta);
  }
}

module.exports = {
  getAllDescriptions,
  setDescription,
  deleteDescription,
  isDocumentIncluded,
  getExcludedSourceFiles,
  setIncluded,
};
