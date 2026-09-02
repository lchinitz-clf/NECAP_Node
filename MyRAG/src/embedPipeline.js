/**
 * The actual extract -> chunk -> embed -> store pipeline, factored out
 * of index.js so it exists in exactly one place. Two routes use this:
 * POST /embed (path to a file already on the server, single JSON
 * response — meant for scripting/PowerShell) and
 * POST /workspaces/:id/upload-and-embed (an uploaded file, progress
 * streamed back live — meant for the browser UI). Both just call this
 * function; only how filePath gets populated, and whether progress is
 * observed, differs between them.
 */

const path = require('path');
const { extractText, SUPPORTED_EXTENSIONS } = require('./extract');
const { chunkText } = require('./chunker');
const { embed } = require('./ollamaClient');
const { appendRecords } = require('./store');

/**
 * @param {string} workspaceId
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
 * @param {boolean} [opts.isUpload] - set by the upload route ONLY,
 *   never by /embed. When true, filePath is recorded on every chunk as
 *   `uploadPath`, so DELETE /workspaces/:id/documents/:sourceFile can
 *   later delete the actual file, not just its index entries — see
 *   deleteDocument() in store.js. Left unset (and uploadPath therefore
 *   absent) for /embed's path-based documents, since those can point
 *   anywhere on the server's disk and this app has no business ever
 *   deleting a file there on its own initiative.
 * @param {(event: object) => void} [opts.onProgress] - optional callback,
 *   called once with { type: 'start', sourceFile, numPages, totalChunks }
 *   right after chunking finishes, then once per chunk with
 *   { type: 'progress', chunksEmbedded, totalChunks }. Omit for silent use.
 * @returns {Promise<{workspaceId: string, filePath: string, sourceFile: string, numPages: number|null, chunksEmbedded: number, totalStored: number}>}
 */
async function embedDocumentIntoWorkspace(workspaceId, filePath, opts = {}) {
  const { maxWords, overlapWords, embedModel, onProgress, isUpload } = opts;

  const { text, numPages } = await extractText(filePath);
  const chunks = chunkText(text, { maxWords, overlapWords });
  const sourceFile = opts.sourceFile || path.basename(filePath);

  console.log(`[embed] [${workspaceId}] ${sourceFile}: ${chunks.length} chunks to embed...`);
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
      console.log(`[embed] [${workspaceId}] ${sourceFile}: ${i + 1}/${chunks.length} chunks embedded`);
    }
    if (onProgress) onProgress({ type: 'progress', chunksEmbedded: i + 1, totalChunks: chunks.length });
  }

  const totalStored = appendRecords(workspaceId, records);

  return { workspaceId, filePath, sourceFile, numPages, chunksEmbedded: records.length, totalStored };
}

module.exports = { embedDocumentIntoWorkspace, SUPPORTED_EXTENSIONS };
