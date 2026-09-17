/**
 * The world's simplest vector store: one JSON file per workspace.
 *
 * At the scale of a handful of documents (hundreds to low thousands of
 * chunks), computing cosine similarity against every stored vector in
 * plain JavaScript at query time is completely fast enough — no need
 * for a real vector database yet. This also means each workspace's
 * "index" is just a JSON file you can open and read yourself.
 *
 * Every function here takes a workspaceId as its first argument and
 * operates only within that workspace's own store.json (see
 * workspace.js for how that path is resolved and validated) — there's
 * no longer a single shared store, so a Massachusetts workspace and a
 * Vermont workspace can never bleed into each other's search results.
 */

const fs = require('fs');
const path = require('path');
const { storePath, ensureWorkspaceDir, uploadsDir } = require('./workspace');

/**
 * @param {string} workspaceId
 * @returns {Array<{id: string, sourceFile: string, chunkIndex: number, text: string, vector: number[]}>}
 */
function loadStore(workspaceId) {
  const p = storePath(workspaceId);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveStore(workspaceId, records) {
  ensureWorkspaceDir(workspaceId);
  fs.writeFileSync(storePath(workspaceId), JSON.stringify(records));
}

/** Appends new records to a workspace's store and persists it. */
function appendRecords(workspaceId, newRecords) {
  const existing = loadStore(workspaceId);
  const combined = existing.concat(newRecords);
  saveStore(workspaceId, combined);
  return combined.length;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Finds the topK records in a workspace most similar to the given
 * query vector.
 * @param {string} workspaceId
 * @param {number[]} queryVector
 * @param {number} topK
 */
function search(workspaceId, queryVector, topK = 5) {
  const records = loadStore(workspaceId);
  return records
    .map((r) => ({ ...r, score: cosineSimilarity(queryVector, r.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Summarizes which documents are actually embedded in a workspace,
 * grouped by sourceFile, for a UI to show "what's in here" without
 * dumping every raw chunk from store.json. Two chunks sharing a
 * sourceFile are treated as one document — which is also exactly how
 * an accidental duplicate /embed of the same file shows up here: as
 * one row with roughly double the expected chunk count, not two
 * separate rows, since sourceFile is genuinely the same string both
 * times. (Nothing here stops that duplication from happening — see
 * the "What's not here yet" note in the README — this just makes it
 * visible after the fact.)
 * @param {string} workspaceId
 * @returns {Array<{sourceFile: string, chunks: number, numPages: number|null}>}
 */
function listDocuments(workspaceId) {
  const records = loadStore(workspaceId);
  const bySource = new Map();

  for (const r of records) {
    if (!bySource.has(r.sourceFile)) {
      // numPages was only added to the schema once this feature was
      // built — a record embedded before that has no numPages field,
      // hence the `?? null` fallback rather than assuming it's there.
      bySource.set(r.sourceFile, { sourceFile: r.sourceFile, chunks: 0, numPages: r.numPages ?? null });
    }
    bySource.get(r.sourceFile).chunks += 1;
  }

  return Array.from(bySource.values()).sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
}

/**
 * Looks up one chunk by its id (the `"<sourceFile>::<chunkIndex>"`
 * string embedPipeline.js assigns every record at embed time — see
 * that file's `records.push({ id: \`${sourceFile}::${i}\`, ... })`).
 * Used by GET /workspaces/:workspaceId/chunks/:chunkId so the browser
 * can fetch one chunk's full text on demand — e.g. for the "view
 * chunk" modal on the Ask form's sources table — without every query
 * response needing to carry every retrieved chunk's full text up
 * front (see sourcesSummary() in index.js, which deliberately doesn't).
 *
 * A linear scan, same as deleteDocument()'s filter above — fine at
 * this app's scale (the whole point of loadStore() being a plain
 * array is that hundreds-to-low-thousands of records is nothing to
 * scan in plain JS), and simpler than maintaining a separate id-keyed
 * index that could drift out of sync with store.json.
 *
 * @param {string} workspaceId
 * @param {string} chunkId
 * @returns {{id: string, sourceFile: string, chunkIndex: number, text: string, numPages: number|null}|undefined}
 */
function getChunk(workspaceId, chunkId) {
  const record = loadStore(workspaceId).find((r) => r.id === chunkId);
  if (!record) return undefined;
  // Deliberately excludes `vector` — a few hundred floats nobody asked
  // for and the browser has no use for, same reasoning sourcesSummary()
  // already applies to search results.
  const { id, sourceFile, chunkIndex, text, numPages } = record;
  return { id, sourceFile, chunkIndex, text, numPages: numPages ?? null };
}

/**
 * Lists every chunk recorded for one document in a workspace, sorted
 * by chunkIndex ascending — the data behind a "pick a document, then
 * pick a block" lookup tool (see GET
 * /workspaces/:workspaceId/documents/:sourceFile/chunks in index.js).
 * Each entry's `id` is exactly what getChunk() above expects, so a UI
 * can go straight from this list to fetching a specific block's full
 * text with no separate lookup step.
 *
 * Chunk indices are normally contiguous 0..N-1 (chunkIndex is assigned
 * as a plain array index at embed time — see embedPipeline.js), but
 * this reads the real records rather than assuming that and returning
 * a computed range, so the result can never drift out of sync with
 * what store.json actually contains (e.g. after a partial delete or a
 * store hand-edited outside this app).
 *
 * @param {string} workspaceId
 * @param {string} sourceFile
 * @returns {Array<{chunkIndex: number, id: string}>}
 */
function listChunksForDocument(workspaceId, sourceFile) {
  return loadStore(workspaceId)
    .filter((r) => r.sourceFile === sourceFile)
    .map((r) => ({ chunkIndex: r.chunkIndex, id: r.id }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/**
 * Removes every chunk belonging to one document (matched by exact
 * sourceFile) from a workspace's store, and — when that document was
 * uploaded through this app — deletes its underlying file too.
 *
 * The two ways a document gets into a workspace get different
 * treatment here, because they're not the same kind of thing:
 *   - Uploaded (via POST /workspaces/:id/upload-and-embed): every
 *     chunk carries an `uploadPath` recorded by embedPipeline.js,
 *     pointing at the file this app itself saved under
 *     workspaces/<id>/uploads/. This app owns that file, it lives
 *     nowhere else, and it exists for exactly this purpose — so
 *     removing the document deletes it too. Leaving it behind would
 *     just be an unfreed-disk-space bug, not a safety feature,
 *     especially once this runs somewhere without a shell into the
 *     server to clean it up by hand.
 *   - Path-based (via POST /embed): `filePath` could point ANYWHERE
 *     on the server's disk — a shared drive, a mounted folder,
 *     anything the caller happened to reference. This app doesn't own
 *     that file, so it never touches it here; these records have no
 *     `uploadPath` and nothing is unlinked for them.
 *
 * As a guardrail against ever trusting a recorded path blindly (in
 * case something upstream ever put a bad value there), an uploadPath
 * is only actually unlinked once it's resolved and confirmed to sit
 * inside this workspace's own uploads/ directory — anything else is
 * left alone and reported back via fileErrors instead.
 *
 * @param {string} workspaceId
 * @param {string} sourceFile
 * @returns {{removedChunks: number, remainingChunks: number, wasUpload: boolean, fileDeleted: boolean, fileErrors?: string[]}}
 */
function deleteDocument(workspaceId, sourceFile) {
  const records = loadStore(workspaceId);
  const removed = records.filter((r) => r.sourceFile === sourceFile);
  const kept = records.filter((r) => r.sourceFile !== sourceFile);
  saveStore(workspaceId, kept);

  // Normally every chunk of one document carries the same uploadPath —
  // deduped with a Set anyway, since nothing here needs to assume that.
  const uploadPaths = [...new Set(removed.map((r) => r.uploadPath).filter(Boolean))];
  const uploadsRoot = uploadsDir(workspaceId);

  let fileDeleted = false;
  const fileErrors = [];

  for (const uploadPath of uploadPaths) {
    const resolved = path.resolve(uploadPath);
    const rel = path.relative(uploadsRoot, resolved);
    const isInsideUploadsRoot = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!isInsideUploadsRoot) {
      fileErrors.push(`Recorded upload path "${uploadPath}" is outside this workspace's uploads directory — left on disk, not deleted.`);
      continue;
    }
    try {
      fs.unlinkSync(resolved);
      fileDeleted = true;
    } catch (err) {
      if (err.code === 'ENOENT') continue; // already gone — nothing to report
      fileErrors.push(`Failed to delete "${uploadPath}": ${err.message}`);
    }
  }

  return {
    removedChunks: records.length - kept.length,
    remainingChunks: kept.length,
    wasUpload: uploadPaths.length > 0,
    fileDeleted,
    ...(fileErrors.length ? { fileErrors } : {}),
  };
}

module.exports = { loadStore, saveStore, appendRecords, cosineSimilarity, search, listDocuments, getChunk, listChunksForDocument, deleteDocument };
