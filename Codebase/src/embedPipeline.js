/**
 * The actual extract -> chunk -> embed -> store pipeline, factored out
 * of index.js so it exists in exactly one place. Two routes use
 * embedDocumentIntoWorkspace() below: POST /embed (path to a file
 * already on the server, single JSON response — meant for
 * scripting/PowerShell) and POST /workspaces/:id/upload-and-embed (an
 * uploaded file, progress streamed back live — meant for the browser
 * UI). Both just call that function; only how filePath gets populated,
 * and whether progress is observed, differs between them.
 *
 * A third entry point, rebuildWorkspaceIndex() near the bottom of this
 * file, reuses the same extract -> chunk -> embed step (factored out
 * as extractChunkEmbed()) but deliberately does NOT go through
 * appendRecords() per file — see its own doc comment for why a bulk
 * rebuild needs different persistence semantics than a single upload.
 */

const fs = require('fs');
const path = require('path');
const { extractText, SUPPORTED_EXTENSIONS } = require('./extract');
const { chunkText } = require('./chunker');
const { embed } = require('./ollamaClient');
const { appendRecords, saveStore } = require('./store');
const { uploadsDir } = require('./workspace');

/**
 * The actual extract -> chunk -> embed work, with NO store.json
 * involvement at all — factored out so rebuildWorkspaceIndex() below
 * can call it per file and hold every file's records in memory before
 * deciding whether to persist any of it, the same way
 * embedDocumentIntoWorkspace() calls it for a single document and then
 * immediately appends the result.
 *
 * @param {string} filePath - path to a document (.pdf, .docx, or .txt
 *   — see extract.js's SUPPORTED_EXTENSIONS) already on this server's
 *   disk.
 * @param {object} [opts]
 * @param {number} [opts.maxWords]
 * @param {number} [opts.overlapWords]
 * @param {string} [opts.embedModel] - which Ollama model turns each
 *   chunk into a vector. Unlike the chat model (freely choosable per
 *   query — see /models and /query's chatModel param), this is
 *   deliberately NOT exposed as a UI choice. Every chunk in a
 *   workspace's store has to come from the SAME embedding model:
 *   different models produce vectors in different, incompatible
 *   spaces (and sometimes even different vector lengths outright), so
 *   a workspace embedded partly with one model and partly with another
 *   would silently produce meaningless or broken similarity scores —
 *   not an error, just quietly wrong results. Changing embedModel here
 *   safely requires re-embedding that workspace's documents from
 *   scratch with the new model, which is a bigger, more deliberate
 *   action than a dropdown next to the question box should invite.
 * @param {string} [opts.sourceFile] - the name to record as this
 *   document's source (shown later in /query's sources list). Defaults
 *   to filePath's own basename. Pass this explicitly when filePath
 *   points at an on-disk name that isn't human-friendly — e.g. the
 *   upload route saves files as "<timestamp>-<originalname>" to avoid
 *   collisions, but wants the *original* name recorded, not that
 *   disk-safe one.
 * @param {boolean} [opts.isUpload] - set for uploaded documents only
 *   (both the single-upload route and a rebuild, which by definition
 *   only ever processes files already sitting in a workspace's
 *   uploads/ folder). When true, filePath is recorded on every chunk
 *   as `uploadPath`, so DELETE /workspaces/:id/documents/:sourceFile
 *   can later delete the actual file, not just its index entries — see
 *   deleteDocument() in store.js. Left unset (and uploadPath therefore
 *   absent) for /embed's path-based documents, since those can point
 *   anywhere on the server's disk and this app has no business ever
 *   deleting a file there on its own initiative.
 * @param {(event: object) => void} [opts.onProgress] - optional callback,
 *   called once with { type: 'start', sourceFile, numPages, totalChunks }
 *   right after chunking finishes, then once per chunk with
 *   { type: 'progress', chunksEmbedded, totalChunks }. Omit for silent use.
 * @returns {Promise<{sourceFile: string, numPages: number|null, records: Array<object>}>}
 */
async function extractChunkEmbed(filePath, opts = {}) {
  const { maxWords, overlapWords, embedModel, onProgress, isUpload } = opts;

  const { text, numPages } = await extractText(filePath);
  const chunks = chunkText(text, { maxWords, overlapWords });
  const sourceFile = opts.sourceFile || path.basename(filePath);

  console.log(`[embed] ${sourceFile}: ${chunks.length} chunks to embed...`);
  if (onProgress) onProgress({ type: 'start', sourceFile, numPages, totalChunks: chunks.length });

  const records = [];
  for (let i = 0; i < chunks.length; i++) {
    const vector = await embed(chunks[i], embedModel);
    records.push({
      id: `${sourceFile}::${i}`,
      sourceFile,
      chunkIndex: i,
      text: chunks[i],
      vector,
      // Same value on every chunk of this document — a little
      // redundant, but it's what lets GET /workspaces/:id/documents
      // show a page count per document without a separate metadata
      // file to keep in sync.
      numPages,
      // See the opts.isUpload doc above — only present for uploaded
      // documents, and (like numPages) intentionally redundant across
      // every chunk of the same document rather than kept in a
      // separate metadata file.
      ...(isUpload ? { uploadPath: filePath } : {}),
    });
    if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
      console.log(`[embed] ${sourceFile}: ${i + 1}/${chunks.length} chunks embedded`);
    }
    if (onProgress) onProgress({ type: 'progress', chunksEmbedded: i + 1, totalChunks: chunks.length });
  }

  return { sourceFile, numPages, records };
}

/**
 * @param {string} workspaceId
 * @param {string} filePath - see extractChunkEmbed()'s doc comment.
 * @param {object} [opts] - see extractChunkEmbed()'s doc comment; all
 *   the same options apply here, since this is just that function plus
 *   persistence.
 * @returns {Promise<{workspaceId: string, filePath: string, sourceFile: string, numPages: number|null, chunksEmbedded: number, totalStored: number}>}
 */
async function embedDocumentIntoWorkspace(workspaceId, filePath, opts = {}) {
  const { sourceFile, numPages, records } = await extractChunkEmbed(filePath, opts);
  const totalStored = appendRecords(workspaceId, records);
  return { workspaceId, filePath, sourceFile, numPages, chunksEmbedded: records.length, totalStored };
}

/**
 * Rebuilds a workspace's entire store.json from scratch, based solely
 * on whatever files are actually sitting in that workspace's
 * uploads/ directory right now — the recovery path for "store.json is
 * missing, corrupted, or I just don't trust that it still matches
 * what's really here." Every file there gets re-extracted, re-chunked,
 * and re-embedded exactly as if it were being uploaded fresh.
 *
 * Two real limitations, both worth knowing before relying on this:
 *
 * 1. This can only recover documents that were UPLOADED through this
 *    app. A document embedded via POST /embed (a path elsewhere on the
 *    server) was never copied into this workspace's uploads/ folder —
 *    this app doesn't own that file and has no record of where it was
 *    once store.json itself is gone. Those documents are simply not
 *    recoverable this way; they won't reappear after a rebuild.
 *
 * 2. Every uploaded file's original name was sanitized before being
 *    saved to disk (see the upload route's multer `filename()` in
 *    index.js — non-alphanumeric characters become underscores) and
 *    prefixed with a timestamp. The literal original filename was only
 *    ever recorded in store.json, not preserved on disk anywhere. So
 *    the sourceFile a rebuild assigns (the on-disk name with its
 *    "<timestamp>-" prefix stripped) is the best available
 *    reconstruction, not necessarily byte-for-byte what showed before
 *    — a name that had spaces or punctuation will come back with
 *    underscores in their place. This is a real, unavoidable
 *    limitation of the sanitize-on-upload design, not a bug here.
 *
 * Deliberately all-or-nothing: every file in the folder is processed
 * and its records held in memory first, and store.json is only
 * actually overwritten once, at the very end, after every file has
 * succeeded. A rebuild that fails partway through (say, Ollama goes
 * down while embedding the third of five files) leaves the OLD
 * store.json completely untouched rather than replacing it with a
 * half-finished index — the whole point of this feature is ending up
 * with something trustworthy, so a rebuild that can silently leave the
 * workspace WORSE off than before it ran would defeat that.
 *
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {string} [opts.embedModel]
 * @param {number} [opts.maxWords]
 * @param {number} [opts.overlapWords]
 * @param {(event: object) => void} [opts.onProgress] - called with
 *   { type: 'file-start', sourceFile, fileIndex, totalFiles } once per
 *   file, interleaved with the same { type: 'start' | 'progress', ... }
 *   events extractChunkEmbed() emits for that file's own
 *   chunking/embedding, then finally { type: 'file-done', sourceFile,
 *   chunksEmbedded }.
 * @returns {Promise<{workspaceId: string, filesProcessed: number, totalChunks: number, documents: Array<{sourceFile: string, chunks: number}>}>}
 */
async function rebuildWorkspaceIndex(workspaceId, opts = {}) {
  const { embedModel, maxWords, overlapWords, onProgress } = opts;
  const dir = uploadsDir(workspaceId);

  const fileNames = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort()
    : [];

  const allRecords = [];
  const documents = [];

  for (let i = 0; i < fileNames.length; i++) {
    const diskName = fileNames[i];
    const ext = path.extname(diskName).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue; // ignore anything that isn't a document this app can read

    // Strip the "<timestamp>-" prefix the upload route's multer
    // filename() adds — see the doc comment above re: this being a
    // best-effort reconstruction of the original name, not a perfect
    // one, since the on-disk name was already sanitized before the
    // timestamp was ever added.
    const sourceFile = diskName.replace(/^\d+-/, '');
    const filePath = path.join(dir, diskName);

    if (onProgress) onProgress({ type: 'file-start', sourceFile, fileIndex: i + 1, totalFiles: fileNames.length });

    const { records } = await extractChunkEmbed(filePath, {
      maxWords,
      overlapWords,
      embedModel,
      sourceFile,
      isUpload: true,
      onProgress,
    });

    allRecords.push(...records);
    documents.push({ sourceFile, chunks: records.length });
    if (onProgress) onProgress({ type: 'file-done', sourceFile, chunksEmbedded: records.length });
  }

  // The one and only write to store.json — see the doc comment above
  // for why every file has to succeed first.
  saveStore(workspaceId, allRecords);

  return {
    workspaceId,
    filesProcessed: documents.length,
    totalChunks: allRecords.length,
    documents,
  };
}

module.exports = { embedDocumentIntoWorkspace, rebuildWorkspaceIndex, SUPPORTED_EXTENSIONS };
