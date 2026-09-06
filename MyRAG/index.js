const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractText, SUPPORTED_EXTENSIONS } = require('./src/extract');
const { chunkText } = require('./src/chunker');
const { embed, chat, listModels } = require('./src/ollamaClient');
const { search, listDocuments, getChunk, deleteDocument } = require('./src/store');
const { embedDocumentIntoWorkspace, rebuildWorkspaceIndex } = require('./src/embedPipeline');
const { isValidWorkspaceId, listWorkspaces, ensureUploadsDir, deleteWorkspace } = require('./src/workspace');
const { listTopicSummaries, getTopic, composeComparisonQuestion } = require('./src/idealProposals');

const app = express();
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
    const documents = listDocuments(workspaceId);
    const totalChunks = documents.reduce((sum, d) => sum + d.chunks, 0);
    res.json({ workspaceId, documents, totalChunks });
  } catch (err) {
    console.error(err);
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
    res.json({ workspaceId, sourceFile, ...result });
  } catch (err) {
    console.error(err);
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
    res.json({ workspaceId, ...result });
  } catch (err) {
    console.error(err);
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
    send({ type: 'done', ...result });
  } catch (err) {
    console.error(err);
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
    res.json(result);
  } catch (err) {
    console.error(err);
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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — generous for a text-heavy document, not unlimited.
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
      send({ type: 'done', ...result, originalName: req.file.originalname });
    } catch (err) {
      console.error(err);
      send({ type: 'error', error: err.message });
    } finally {
      res.end();
    }
  });
});

/**
 * POST /query
 * Body: { "question": "...", "workspaceId": "ma-climate-plan", "topK": 5, "chatModel": "llama3.1:8b", "embedModel": "nomic-embed-text", "temperature": 0.2, "maxTokens": 500, "numCtx": 8192, "idealTopicId": "offshore-wind" }
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
 * Embeds the question, finds the most similar chunks stored in the
 * given workspace, and asks the chat model to answer using only that
 * retrieved context. Returns both the generated answer AND the raw
 * list of chunks/sources used, so you can see exactly what grounded
 * the answer rather than trusting the model's prose to mention it.
 */
/**
 * Builds the system+user messages array for a RAG answer, shared by
 * both /query and /query/stream so the prompt only exists in one
 * place.
 */
function buildRagMessages(question, matches) {
  const contextBlock = matches
    .map((m) => `[Source: ${m.sourceFile}, chunk ${m.chunkIndex}]\n${m.text}`)
    .join('\n\n---\n\n');

  return [
    {
      role: 'system',
      content:
        'Answer the question using ONLY the context provided below. ' +
        'Do not use any outside knowledge. If the answer is not contained ' +
        'in the context, say clearly that you don\'t have that information ' +
        'in the provided documents rather than guessing.\n\n' +
        `Context:\n${contextBlock}`,
    },
    { role: 'user', content: question },
  ];
}

function sourcesSummary(matches) {
  return matches.map((m) => ({
    id: m.id,
    sourceFile: m.sourceFile,
    chunkIndex: m.chunkIndex,
    score: m.score,
  }));
}

app.post('/query', async (req, res) => {
  const { question, workspaceId, topK = 5, chatModel, embedModel, temperature, maxTokens, numCtx, idealTopicId, think } = req.body;
  const wsErr = workspaceIdError(workspaceId);
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
  }

  if (!question && !topic) {
    return res.status(400).json({ error: 'question is required (or select an ideal-proposal topic to compare against)' });
  }

  // See composeComparisonQuestion()'s big comment in
  // src/idealProposals.js: when a topic is selected, ITS text (plus
  // whatever the user additionally typed) becomes the actual question
  // — driving both retrieval below and the prompt sent to the chat
  // model, not just an instruction layered on top after the fact.
  const effectiveQuestion = topic ? composeComparisonQuestion(topic, question) : question;

  try {
    const queryVector = await embed(effectiveQuestion, embedModel);
    const matches = search(workspaceId, queryVector, topK);

    if (matches.length === 0) {
      return res.json({
        answer: `No documents have been embedded yet in workspace "${workspaceId}". Run /embed first.`,
        sources: [],
      });
    }

    const messages = buildRagMessages(effectiveQuestion, matches);
    // doneReason ("stop" vs "length") is Ollama's own account of why
    // generation ended — see the long comment on chat()'s return value
    // in ollamaClient.js. Passed straight through here rather than
    // interpreted, since only the caller knows whether it itself set
    // maxTokens (in which case "length" was requested) or not (in
    // which case "length" means Ollama's own context window ran out).
    const { text: answer, thinking, doneReason } = await chat(messages, { model: chatModel, temperature, maxTokens, numCtx, think });

    // `thinking` is only included when non-empty — a model that
    // doesn't support it (or was asked not to via `think: false`)
    // shouldn't clutter every response with an empty field.
    res.json({ answer, sources: sourcesSummary(matches), doneReason, ...(thinking ? { thinking } : {}) });
  } catch (err) {
    console.error(err);
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
 *   {"type":"sources","sources":[...]}
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
 */
app.post('/query/stream', async (req, res) => {
  const { question, workspaceId, topK = 5, chatModel, embedModel, temperature, maxTokens, numCtx, idealTopicId, think } = req.body;
  const wsErr = workspaceIdError(workspaceId);
  if (wsErr) return res.status(400).json({ error: wsErr });

  // Same topic-resolution rules as /query above — kept before anything
  // streams, so a bad idealTopicId or a broken idealProposals.json
  // still comes back as a clean HTTP error rather than a stream event.
  let topic;
  if (idealTopicId) {
    try {
      topic = getTopic(idealTopicId);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: `Could not load idealProposals.json: ${err.message}` });
    }
    if (!topic) return res.status(400).json({ error: `Unknown ideal-proposal topic id: "${idealTopicId}"` });
  }

  if (!question && !topic) {
    return res.status(400).json({ error: 'question is required (or select an ideal-proposal topic to compare against)' });
  }

  const effectiveQuestion = topic ? composeComparisonQuestion(topic, question) : question;

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

  let matches;
  try {
    const queryVector = await embed(effectiveQuestion, embedModel, undefined, controller.signal);
    matches = search(workspaceId, queryVector, topK);
  } catch (err) {
    if (clientGone) return; // stopped before retrieval even finished — no one to report back to
    console.error(err);
    return res.status(500).json({ error: err.message });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  if (res.flushHeaders) res.flushHeaders();
  const send = (event) => res.write(JSON.stringify(event) + '\n');

  if (matches.length === 0) {
    send({
      type: 'done',
      answer: `No documents have been embedded yet in workspace "${workspaceId}". Run /embed first.`,
      sources: [],
    });
    return res.end();
  }

  send({ type: 'sources', sources: sourcesSummary(matches) });

  try {
    const messages = buildRagMessages(effectiveQuestion, matches);
    const { text: answer, thinking, doneReason } = await chat(messages, {
      model: chatModel,
      temperature,
      maxTokens,
      numCtx,
      think,
      signal: controller.signal,
      onToken: (piece) => send({ type: 'token', text: piece }),
      onThinking: (piece) => send({ type: 'thinking', text: piece }),
    });
    // `thinking` in "done" mirrors /query's response: only included
    // when non-empty, for a caller that reconnected mid-stream or
    // otherwise missed the individual "thinking" events above.
    send({ type: 'done', answer, sources: sourcesSummary(matches), doneReason, ...(thinking ? { thinking } : {}) });
  } catch (err) {
    if (clientGone) {
      console.log(`[query/stream] [${workspaceId}] stopped by client before finishing`);
    } else {
      console.error(err);
      send({ type: 'error', error: err.message });
    }
  } finally {
    if (!clientGone) res.end();
  }
});

const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`local-rag server listening on http://localhost:${PORT}`);
});
