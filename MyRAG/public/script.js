// Loads public/config.json — a small, separate file kept deliberately
// outside this HTML so renaming the app doesn't mean hand-editing
// markup. { "appName": "..." } is the only field read today; the
// "local-rag" in <title> and <h1> in index.html is just the fallback
// shown if this fetch fails or the file's missing, not a second place
// that needs updating. Called from init() below, first thing on page
// load.
async function applyConfig() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    const config = await res.json();
    if (config.appName) {
      document.title = config.appName;
      document.getElementById('appNameHeading').textContent = config.appName;
    }
  } catch (err) {
    console.warn('Could not load config.json, using default name:', err);
  }
}

let workspaceInput, workspaceList;

// Loads the list of existing workspaces into the datalist, so the
// workspace field behaves like a combo box: pick one that's there,
// or just type a name that isn't yet and it'll be created on first
// embed. Called from init() on page load, and again after a
// successful embed (which may have just created a brand new
// workspace) or a workspace deletion.
async function refreshWorkspaces() {
  try {
    const res = await fetch('/workspaces');
    const data = await res.json();
    workspaceList.innerHTML = '';
    for (const id of data.workspaces || []) {
      const opt = document.createElement('option');
      opt.value = id;
      workspaceList.appendChild(opt);
    }
  } catch (err) {
    // Non-fatal — the field still works as a plain text input even
    // if this fetch fails (e.g. server briefly restarting).
    console.warn('Could not load workspace list:', err);
  }
}

// The server's own hardcoded fallback (see ollamaClient.js's chat()
// default) — pre-selecting it when it's in the pulled-models list
// just makes the picker's starting state match what would happen
// anyway if you left it alone.
const SERVER_DEFAULT_CHAT_MODEL = 'llama3.1:8b';

let chatModelSelect, chatModelHint;

// Loads models actually pulled into this Ollama installation (GET
// /models -> Ollama's /api/tags) into the chat-model dropdown. This
// list includes embedding models too — Ollama doesn't label which
// is which — so nomic-embed-text (or similar) may show up here; it's
// harmless to leave in since Ollama will just error clearly if you
// try to use it as a chat model, this UI doesn't try to guess.
async function refreshModels() {
  try {
    const res = await fetch('/models');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load models');

    const models = data.models || [];
    chatModelSelect.innerHTML = '';

    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No models found — pull one with "ollama pull"';
      opt.disabled = true;
      opt.selected = true;
      chatModelSelect.appendChild(opt);
      chatModelHint.textContent = '';
      return;
    }

    for (const name of models) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      chatModelSelect.appendChild(opt);
    }

    if (models.includes(SERVER_DEFAULT_CHAT_MODEL)) {
      chatModelSelect.value = SERVER_DEFAULT_CHAT_MODEL;
    }
    chatModelHint.textContent = '';
  } catch (err) {
    console.warn('Could not load model list:', err);
    chatModelSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.textContent = 'Could not load models';
    opt.disabled = true;
    opt.selected = true;
    chatModelSelect.appendChild(opt);
    chatModelHint.textContent = 'Is Ollama running? Falling back to the server default if you ask a question anyway.';
  }
}

let idealTopicSelect, idealTopicHint;
// The full hint text set in index.html's markup — restored whenever
// the dropdown is populated successfully, since the failure branch
// below temporarily replaces it with an error-specific message
// instead. Captured in init(), once idealTopicHint itself has been
// assigned from the DOM.
let idealTopicHintDefault;

// Loads the topics defined in idealProposals.json (GET /ideal-proposals)
// into the compare-mode dropdown, same pattern as refreshModels()
// above. Unlike the chat-model list, an empty result here is a
// perfectly normal, expected state (nobody's populated
// idealProposals.json yet, or it's deliberately empty) — not
// something to warn about — so the "None" option this starts with is
// simply left as the only choice rather than showing a disabled
// placeholder row the way refreshModels() does for "no models found."
async function refreshIdealTopics() {
  try {
    const res = await fetch('/ideal-proposals');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load ideal-proposal topics');

    const topics = data.topics || [];
    const previousValue = idealTopicSelect.value;

    idealTopicSelect.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None — answer normally from the document(s) above';
    idealTopicSelect.appendChild(noneOpt);

    for (const topic of topics) {
      const opt = document.createElement('option');
      opt.value = topic.id;
      opt.textContent = topic.description ? `${topic.label} — ${topic.description}` : topic.label;
      idealTopicSelect.appendChild(opt);
    }

    // Preserve whatever was selected across a refresh, same courtesy
    // refreshWorkspaces()/refreshDocuments() give elsewhere — only
    // matters if this ever gets called more than once per page load,
    // but costs nothing to handle now.
    if (topics.some((t) => t.id === previousValue)) {
      idealTopicSelect.value = previousValue;
    }
    idealTopicHint.textContent = idealTopicHintDefault;
  } catch (err) {
    console.warn('Could not load ideal-proposal topics:', err);
    idealTopicHint.textContent =
      'Could not load ideal-proposal topics — compare mode is unavailable right now; plain Q&A above still works.';
  }
}

function getWorkspaceId() {
  return workspaceInput.value.trim();
}

function requireWorkspace(errorEl) {
  const id = getWorkspaceId();
  if (!id) {
    errorEl.textContent = 'Enter or pick a storage area name above first.';
    errorEl.style.display = 'block';
    return null;
  }
  return id;
}

// ---- Documents-in-workspace list ----

let documentsWrap, documentsEmpty, documentsBody, documentsError;
let blockLookupDocument, blockLookupIndex, blockLookupBtn, blockLookupError;
let blockLookupChunks = []; // the currently-selected document's {chunkIndex, id} list, once loaded

// Shows what's actually embedded (grouped by source filename) in
// whatever workspace is currently entered above, with a Remove
// button per document. Also doubles as the easiest way to spot an
// accidental duplicate embed: the same document showing roughly
// double its usual chunk count is that happening.
async function refreshDocuments() {
  const id = getWorkspaceId();
  if (!id) {
    documentsWrap.style.display = 'none';
    resetBlockLookup();
    return;
  }

  try {
    const res = await fetch(`/workspaces/${encodeURIComponent(id)}/documents`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load documents');

    documentsWrap.style.display = 'block';
    documentsBody.innerHTML = '';
    documentsError.style.display = 'none';

    if (data.documents.length === 0) {
      documentsEmpty.textContent = `No documents imported into "${id}" yet.`;
      resetBlockLookup();
      return;
    }

    documentsEmpty.textContent = '';
    for (const doc of data.documents) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(doc.sourceFile)}</td>
        <td>${doc.chunks}</td>
        <td>${doc.numPages != null ? doc.numPages : '—'}</td>
        <td><button type="button" class="btn-remove" data-source="${escapeHtml(doc.sourceFile)}">Remove</button></td>
      `;
      documentsBody.appendChild(tr);
    }
    populateBlockLookupDocuments(data.documents);
  } catch (err) {
    // Non-fatal — an invalid/incomplete workspace name typed
    // mid-edit will 400 here transiently, which is fine; just hide
    // the section rather than showing an error for that.
    console.warn('Could not load documents:', err);
    documentsWrap.style.display = 'none';
    resetBlockLookup();
  }
}

// ---- Block lookup tool (Documents in this area panel) ----
//
// Lets someone pick a document, then a specific block number, and
// view that block's exact text on demand — reachable directly from
// the "Documents in this area" panel rather than only via a source
// citation's block-number link after running a query. Populated from
// GET /workspaces/:workspaceId/documents/:sourceFile/chunks (see
// listChunksForDocument() in src/store.js), which returns each
// block's {chunkIndex, id} — the `id` is exactly what showChunkModal()
// below needs, so no client-side id construction
// (`${sourceFile}::${chunkIndex}`) happens here at all.
//
// Always says "block," never "chunk," to the user — same UI language
// as the rest of this app (Block size/overlap on the import form, the
// Blocks column above, the block-view modal); "chunk" stays purely an
// internal/API word, matching store.js and index.js.

/** Clears both selects back to their empty/disabled starting state. */
function resetBlockLookup() {
  blockLookupDocument.innerHTML = '<option value="">Select a document…</option>';
  blockLookupDocument.disabled = true;
  resetBlockLookupIndex();
  blockLookupError.style.display = 'none';
  blockLookupError.textContent = '';
}

/** Clears just the block select — used both on reset and whenever the chosen document changes. */
function resetBlockLookupIndex() {
  blockLookupChunks = [];
  blockLookupIndex.innerHTML = '<option value="">Select a document first…</option>';
  blockLookupIndex.disabled = true;
  blockLookupBtn.disabled = true;
}

/**
 * Rebuilds the document dropdown from the same document list
 * refreshDocuments() just loaded for the table above, so the two stay
 * in sync automatically on every refresh — no separate fetch. Keeps
 * the previous selection (and re-loads its block list) across a
 * refresh when that document is still present, rather than always
 * resetting to blank, so re-checking a workspace mid-lookup doesn't
 * throw away what was picked.
 */
function populateBlockLookupDocuments(documents) {
  const previousValue = blockLookupDocument.value;
  blockLookupDocument.innerHTML = '<option value="">Select a document…</option>' +
    documents.map((d) => `<option value="${escapeHtml(d.sourceFile)}">${escapeHtml(d.sourceFile)} (${d.chunks} block${d.chunks === 1 ? '' : 's'})</option>`).join('');
  blockLookupDocument.disabled = false;

  if (previousValue && documents.some((d) => d.sourceFile === previousValue)) {
    blockLookupDocument.value = previousValue;
    loadBlockLookupIndex(previousValue);
  } else {
    resetBlockLookupIndex();
  }
}

/** Loads the block list for one document into the block select. */
async function loadBlockLookupIndex(sourceFile) {
  resetBlockLookupIndex();
  if (!sourceFile) return;

  const workspaceId = getWorkspaceId();
  if (!workspaceId) return;

  blockLookupIndex.innerHTML = '<option value="">Loading…</option>';
  blockLookupError.style.display = 'none';

  try {
    const res = await fetch(
      `/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(sourceFile)}/chunks`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);

    blockLookupChunks = data.chunks;
    if (blockLookupChunks.length === 0) {
      blockLookupIndex.innerHTML = '<option value="">No blocks found</option>';
      return;
    }

    blockLookupIndex.innerHTML = '<option value="">Select a block…</option>' +
      blockLookupChunks.map((c) => `<option value="${c.chunkIndex}">Block ${c.chunkIndex}</option>`).join('');
    blockLookupIndex.disabled = false;
  } catch (err) {
    blockLookupIndex.innerHTML = '<option value="">Could not load blocks</option>';
    blockLookupError.textContent = `Could not load blocks: ${err.message}`;
    blockLookupError.style.display = 'block';
  }
}

// Debounced on typing (rather than firing on every keystroke), and
// also handles picking a suggestion from the workspace datalist,
// since selecting one fires an "input" event too — see the listener
// wired up in init() below.
let documentsDebounce = null;

// ---- Workspace maintenance: delete workspace / rebuild index ----
//
// Two blunt recovery tools, both requiring their own confirmation
// dialog since neither can be undone: wipe a workspace entirely
// (DELETE /workspaces/:id), or discard store.json and rebuild it
// from whatever's actually in the workspace's uploads folder (POST
// /workspaces/:id/rebuild-index). See the hint text next to each
// button, and the README, for what each one can and can't recover.

let deleteWorkspaceBtn, deleteWorkspaceStatus, deleteWorkspaceError;
let rebuildIndexBtn, rebuildStatus, rebuildError, rebuildProgressWrap, rebuildProgressBar;

/**
 * Same NDJSON-over-fetch pattern as embedWithProgress() below, but a
 * plain JSON POST body (no file to upload — the server reads
 * whatever's already in the workspace's uploads/ folder) and events
 * that also include a "file-start"/"file-done" pair wrapping each
 * document, since a rebuild processes a whole folder of files, not
 * just one.
 */
async function rebuildWithProgress(workspaceId, onEvent) {
  const res = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/rebuild-index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {
      // Body wasn't JSON — fall back to the generic message above.
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalEvent = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      onEvent(event);
      if (event.type === 'done' || event.type === 'error') finalEvent = event;
    }
  }

  if (!finalEvent) throw new Error('Server closed the connection before finishing.');
  if (finalEvent.type === 'error') throw new Error(finalEvent.error);
  return finalEvent;
}

// ---- Embed form ----

let embedForm, embedStatus, embedError, embedResult, embedSubmitBtn, embedProgressWrap, embedProgressBar;

/**
 * Uploads a file to /workspaces/:id/upload-and-embed and reads back
 * the streamed newline-delimited JSON progress events as they
 * arrive, calling onEvent() for each one. The server can only fail
 * cleanly (a normal HTTP error status) *before* it starts streaming
 * — a bad workspace id, wrong file type, etc. Once streaming has
 * begun, a failure shows up as one of the events themselves
 * ({type: "error"}), not as an HTTP error, since the response
 * headers already committed to 200. This function surfaces both
 * cases the same way: by throwing.
 */
async function embedWithProgress(workspaceId, file, maxWords, overlapWords, onEvent) {
  const formData = new FormData();
  formData.append('file', file);
  // Omit blank/cleared fields entirely rather than sending an empty
  // string — the server treats a missing field as "use chunker.js's
  // own default," same convention /query's chatModel/temperature use
  // for a JSON body.
  if (maxWords !== undefined) formData.append('maxWords', maxWords);
  if (overlapWords !== undefined) formData.append('overlapWords', overlapWords);

  const res = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/upload-and-embed`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {
      // Body wasn't JSON — fall back to the generic message above.
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalEvent = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      onEvent(event);
      if (event.type === 'done' || event.type === 'error') finalEvent = event;
    }
  }

  if (!finalEvent) throw new Error('Server closed the connection before finishing.');
  if (finalEvent.type === 'error') throw new Error(finalEvent.error);
  return finalEvent;
}

// ---- Query form ----

let form, statusEl, errorEl, resultEl, answerEl, lengthNote, sourcesBody, confidenceNote, tokenUsageNote, retrievalQueryNote;
let submitBtn, stopBtn, elapsedTimeEl, queryProgressWrap;
let thinkCheckbox, reasoningWrap, reasoningEl;
let attributeResultsWrap, attributeResultsBody, downloadCsvBtn;

// queryStartTime/queryTimerHandle track the elapsed-time display next
// to Ask/Stop. performance.now() rather than Date.now() — monotonic,
// so a system clock change mid-request can't produce a nonsensical
// (or negative) elapsed time, and it's precise enough for tenths of a
// second. The interval just re-renders the running total every
// 100ms; the actual timing is always derived fresh from
// performance.now() - queryStartTime each render, so a delayed tick
// (e.g. the tab was backgrounded) never leaves the display stale by
// more than one interval — it always catches up to the true elapsed
// time on its next tick.
let queryStartTime = null;
let queryTimerHandle = null;

/** @param {number} ms @returns {string} e.g. "4.2s" or "1m 05s" */
function formatElapsedMs(ms) {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  // Round the total once and derive minutes/seconds from that single
  // integer, rather than flooring minutes and separately rounding
  // the remainder — rounding each independently can carry the
  // seconds up to 60 without it rolling over into the next minute
  // (e.g. 59m 59.6s would render as the nonsensical "59m 60s").
  const roundedTotalSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedTotalSeconds / 60);
  const seconds = roundedTotalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

// Holds the AbortController for whichever /query/stream request is
// currently in flight, or null when none is. stopBtn's click handler
// (wired up in init()) aborts it; the submit handler creates a fresh
// one per request and clears this back to null once that request
// settles (success, error, or stop) — see both below.
let currentQueryController = null;

// Backs the Download CSV button, which lives outside the submit
// handler's own scope (it can be clicked any time after a query
// finishes, not just in the moment it finishes) — holds one entry per
// batch that has finished so far (a plain document question, or an
// ideal-proposal comparison left at "all" attributes per call, is
// always exactly zero-or-one entries; a batched comparison grows this
// one entry at a time as each batch's "batch-done" event arrives).
// Each entry is
// { batchIndex, totalBatches, records, sources, promptTokens,
//   answerTokens, doneReason }
// — records are this batch's own parsed per-attribute rows (see
// parseComparisonAnswer() in src/responseParser.js), sources are every
// block retrieved for this batch's question (see sourcesSummary() in
// index.js), and the token/doneReason fields are what let the table
// show this batch's own usage and cutoff status, not just a combined
// total. Reset at the start of every new query, same as the other
// per-query display state below.
let latestBatches = [];

// The threshold is a purely client-side display filter: the server
// always returns its topK closest chunks regardless of how weak the
// match is (this is intentional — see /query in index.js). This UI
// is what decides, for display purposes, which of those returned
// chunks are worth calling "confident" matches versus noise the
// model was still handed as context. It doesn't change what the
// model saw, only how we label the sources here.
//
// `topK` (the value actually submitted for this request, not just
// whatever the input currently shows) is used for one extra nudge:
// if every single retrieved block cleared the relevance bar, that's
// a sign the area may hold more relevant material than got pulled
// in — but only when retrieval was actually capped by topK. If the
// area simply doesn't have topK blocks total, sources.length comes
// back smaller than topK and there's nothing more to raise topK to
// reach, so the suggestion is withheld in that case.
/**
 * Turns one source's `matchedBy` array (see hybridSearch() in
 * src/hybridSearch.js — `["vector"]`, `["keyword"]`, or both) into a
 * short human label for the "Found by" column: "Vector + keyword"
 * when both retrieval methods independently surfaced this chunk,
 * "Keyword only" when just the BM25 keyword layer did (this is the
 * case hybrid search was specifically added for — a chunk containing
 * the exact words searched for, that plain embedding-similarity
 * search ranked too low to reach), or "Vector only" when just
 * embedding similarity did. Falls back to an em dash for a response
 * from before this field existed, rather than guessing.
 */
function formatMatchedBy(matchedBy) {
  if (!matchedBy || matchedBy.length === 0) return '—';
  const hasVector = matchedBy.includes('vector');
  const hasKeyword = matchedBy.includes('keyword');
  if (hasVector && hasKeyword) return 'Vector + keyword';
  if (hasKeyword) return 'Keyword only';
  if (hasVector) return 'Vector only';
  return '—';
}

function renderSources(sources, threshold, topK) {
  sourcesBody.innerHTML = '';
  const meets = sources.filter((s) => s.score >= threshold);

  if (sources.length === 0) {
    confidenceNote.textContent = 'No documents have been imported into this area yet.';
  } else if (meets.length === 0) {
    confidenceNote.textContent =
      `None of the ${sources.length} retrieved blocks met your relevance setting ` +
      `(${threshold.toFixed(2)}) — treat this answer with caution, it may be based on weak or irrelevant matches.`;
  } else {
    confidenceNote.textContent =
      `${meets.length} of ${sources.length} retrieved blocks met your relevance setting (${threshold.toFixed(2)}).`;
    if (meets.length === sources.length && sources.length === topK) {
      confidenceNote.textContent +=
        ' All of the retrieved blocks cleared the bar, so there may be more relevant material in this area ' +
        'than got pulled in — consider raising "Blocks to search" in Advanced settings to search further.';
    }
  }

  for (const s of sources) {
    const tr = document.createElement('tr');
    const ok = s.score >= threshold;
    tr.className = ok ? 'meets' : 'below';
    // s.id ("<sourceFile>::<chunkIndex>") is what /workspaces/:id/chunks/:chunkId
    // looks chunks up by — see getChunk() in store.js. Falls back to a
    // plain (non-clickable) number if it's ever missing, e.g. a server
    // that hasn't been updated to include it yet.
    const chunkCell = s.id
      ? `<button type="button" class="chunk-link" data-chunk-id="${escapeHtml(s.id)}" data-source-file="${escapeHtml(s.sourceFile)}" data-chunk-index="${s.chunkIndex}">${s.chunkIndex}</button>`
      : `${s.chunkIndex}`;
    tr.innerHTML = `
      <td>${escapeHtml(s.sourceFile)}</td>
      <td>${chunkCell}</td>
      <td class="${ok ? 'score-meets' : 'score-below'}">${s.score.toFixed(4)}</td>
      <td>${escapeHtml(formatMatchedBy(s.matchedBy))}</td>
    `;
    sourcesBody.appendChild(tr);
  }

  resultEl.style.display = 'block';
}

// promptTokens/answerTokens are Ollama's own counts for this exact
// request (see the doc on chat()'s return value in ollamaClient.js) —
// not an estimate computed here. promptTokens is left undefined for
// the "no documents embedded yet" canned-answer case (chat() was
// never even called) and, in principle, for an older Ollama version
// that doesn't return these fields at all; either way this just shows
// nothing rather than a confusing "undefined tokens" message.
//
// Phrasing depends on whether Request size (numCtx) was set for this
// request: with a known ceiling, the count can be shown as "used X of
// your Y," which is the more useful framing since it says how close
// you are to the wall this app already warns about elsewhere; left
// blank, there's no known ceiling from the browser's side to compare
// against (only Ollama knows the model's own default), so this falls
// back to just stating the raw counts.
//
// `totalBatches` (see the "Attributes per call" Advanced setting)
// changes this further: numCtx is a per-call ceiling, not a shared
// budget across batches, so once there's more than one batch the "used
// X of your Y" framing would misleadingly suggest a single shared
// limit that isn't actually how it works — each batch is checked
// against that same ceiling independently. The totals are still shown
// (summed across every batch), just without implying they share one
// Y-token wall.
// `totalBatches` (see the "Attributes per call" Advanced setting)
// changes the phrasing again once there's more than one: the combined
// total across every batch no longer says much about how close any
// one call came to running out of room (a run with 40 attributes and
// 14 batches could total 35,000+ tokens while every individual batch
// was nowhere near its own limit) — the number that actually answers
// "was any single call under stress" is the AVERAGE per batch, so
// that's what leads here, with the combined total kept alongside in
// parentheses for reference. See the per-attribute results table for
// each batch's own individual numbers (and a cutoff flag on whichever
// batch, if any, actually hit the limit) rather than just the average.
function renderTokenUsage(promptTokens, answerTokens, numCtx, totalBatches) {
  if (promptTokens === undefined) {
    tokenUsageNote.textContent = '';
    return;
  }
  const promptText = promptTokens.toLocaleString();
  const answerText = (answerTokens || 0).toLocaleString();

  if (totalBatches && totalBatches > 1) {
    const avgPromptText = Math.round(promptTokens / totalBatches).toLocaleString();
    const avgAnswerText = Math.round((answerTokens || 0) / totalBatches).toLocaleString();
    tokenUsageNote.textContent = numCtx !== undefined
      ? `Across ${totalBatches} batches, retrieval averaged ${avgPromptText} of your ${numCtx.toLocaleString()}-token Request size per call (${promptText} total); answers averaged ${avgAnswerText} tokens per call (${answerText} total). See the per-attribute table below for each batch's own numbers.`
      : `Across ${totalBatches} batches, retrieval averaged ${avgPromptText} tokens per call (${promptText} total); answers averaged ${avgAnswerText} tokens per call (${answerText} total). See the per-attribute table below for each batch's own numbers.`;
    return;
  }

  tokenUsageNote.textContent = numCtx !== undefined
    ? `Used ${promptText} of your ${numCtx.toLocaleString()}-token Request size for the question and retrieved blocks, plus ${answerText} more for the answer.`
    : `Your question and the retrieved blocks used ${promptText} tokens; the answer used ${answerText} more.`;
}

// Human labels for src/responseParser.js's four fixed category
// strings, mapped to the CSS classes in style.css that color-code them
// in the per-attribute results table — an unparsed/empty category (see
// that module's caveat about parsing reliability) intentionally gets
// no class and a plain, honest label instead of guessing.
const CATEGORY_CLASS = {
  Exceeds: 'cat-exceeds',
  Matches: 'cat-matches',
  'Falls short': 'cat-falls-short',
  'Not addressed': 'cat-not-addressed',
};

/**
 * Renders every source retrieved for one batch as a row of small
 * clickable pills (or plain, non-clickable ones if a source is
 * somehow missing its chunk id — an older server), color-differentiated
 * by the same relevance-threshold convention as the main sources table
 * below. Every row belonging to that batch shows this same list: the
 * model is only ever told which blocks it was given for the whole
 * batch, not which one backed which specific attribute (see the hint
 * text next to the table in index.html), so that's the most honest
 * thing to show per row.
 */
function renderSourceChips(sources, threshold) {
  if (!sources || sources.length === 0) return '<span class="hint">—</span>';
  return sources
    .map((s) => {
      const ok = threshold === undefined || s.score >= threshold;
      const scoreClass = ok ? 'score-meets' : 'score-below';
      // Chunk number only, not the source file name too — with several
      // chips per row this column got too cramped once file names were
      // included (especially long, real-world document names). The
      // file name isn't lost: it's on the chip as a hover title, and
      // shown as the modal's subtitle once you click through to the
      // block text — same as the main sources table already handles
      // this trade-off, just applied here for a row that can carry
      // several chips at once instead of one file name per row.
      const label = `#${s.chunkIndex}`;
      const sourceFile = escapeHtml(s.sourceFile);
      // The hover title adds "Found by" info (see formatMatchedBy()
      // above) alongside the file name; data-source-file stays the
      // plain file name, since that's what feeds the block-view
      // modal's subtitle (see showChunkModal()) — it shouldn't pick
      // up the extra tooltip text.
      const title = escapeHtml(`${s.sourceFile} — ${formatMatchedBy(s.matchedBy)}`);
      return s.id
        ? `<button type="button" class="chunk-link chip ${scoreClass}" title="${title}" data-chunk-id="${escapeHtml(s.id)}" data-source-file="${sourceFile}" data-chunk-index="${s.chunkIndex}">${label}</button>`
        : `<span class="chip" title="${title}">${label}</span>`;
    })
    .join(' ');
}

/**
 * One line summarizing a single batch's own token usage (against the
 * Request size ceiling, when set) and, when this specific batch got
 * cut off before finishing, a warning flag — see renderTokenUsage()
 * above for why the aggregate line alone stopped being useful once a
 * comparison runs many batches, and the doc comment on latestBatches
 * for what each batch object carries.
 */
function formatBatchSummary(batch, numCtx) {
  const label = batch.totalBatches
    ? `Batch ${batch.batchIndex + 1} of ${batch.totalBatches}`
    : `Batch ${batch.batchIndex + 1}`;
  let text = label;
  if (batch.promptTokens !== undefined) {
    const promptText = batch.promptTokens.toLocaleString();
    const answerText = (batch.answerTokens || 0).toLocaleString();
    text += numCtx !== undefined
      ? ` — used ${promptText} of your ${numCtx.toLocaleString()}-token Request size, plus ${answerText} for the answer.`
      : ` — used ${promptText} tokens for the question and retrieved blocks, plus ${answerText} for the answer.`;
  } else {
    text += '.';
  }
  if (batch.doneReason === 'length') {
    text += ' ⚠ Cut off — hit the length limit for this batch.';
  }
  return text;
}

// Renders every batch accumulated so far (each batch contributing its
// own rows, plus — once there's more than one batch — a full-width
// summary row after them, see formatBatchSummary() above) into the
// results table, and shows/hides that whole section depending on
// whether there's anything to show — a plain document question never
// populates this at all, since parseComparisonAnswer() is only ever
// run for a topic-comparison batch (see the "batch-done" handling in
// the query form's submit handler below).
function renderAttributeResults(batches, numCtx, threshold) {
  attributeResultsBody.innerHTML = '';
  const showBatchRows = batches.length > 1;
  let anyRecords = false;

  for (const batch of batches) {
    const sourcesHtml = renderSourceChips(batch.sources, threshold);
    for (const r of batch.records || []) {
      anyRecords = true;
      const tr = document.createElement('tr');
      const catClass = CATEGORY_CLASS[r.category] || '';
      tr.innerHTML = `
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.proposal)}</td>
        <td>${escapeHtml(r.resultText)}</td>
        <td class="${catClass}">${escapeHtml(r.category || '(unparsed — see answer above)')}</td>
        <td class="sources-cell">${sourcesHtml}</td>
      `;
      attributeResultsBody.appendChild(tr);
    }

    if (showBatchRows && batch.records && batch.records.length) {
      const tr = document.createElement('tr');
      tr.className = 'batch-summary-row';
      tr.innerHTML = `<td colspan="5">${escapeHtml(formatBatchSummary(batch, numCtx))}</td>`;
      attributeResultsBody.appendChild(tr);
    }
  }

  attributeResultsWrap.style.display = anyRecords ? 'block' : 'none';
}

/**
 * Turns the accumulated batches into CSV text: Attribute name,
 * Proposal, LLM result, LLM analysis, Source document(s) — the five
 * columns for the Excel/CSV export, in that order. The last column
 * lists every block retrieved for that row's batch (see the doc
 * comment on renderSourceChips() above for why it's the whole batch's
 * sources, not an attribute-specific subset), as
 * "<file> #<block>" pairs separated by "; " — page numbers aren't
 * tracked per block today (see extract.js), so a document/block
 * reference is the most specific citation available. A field
 * containing a comma, quote, or newline is quoted and any internal
 * quotes doubled, per the standard CSV escaping rule; everything else
 * is left bare for readability. A leading UTF-8 BOM is included so
 * Excel opens the file with correct characters instead of guessing
 * the encoding wrong.
 */
function buildAttributeResultsCsv(batches) {
  const csvEscape = (value) => {
    const str = value == null ? '' : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const rows = [['Attribute name', 'Proposal', 'LLM result', 'LLM analysis', 'Source document(s)']];
  for (const batch of batches) {
    const sourceRefs = (batch.sources || []).map((s) => `${s.sourceFile} #${s.chunkIndex}`).join('; ');
    for (const r of batch.records || []) {
      rows.push([r.name, r.proposal, r.resultText, r.category, sourceRefs]);
    }
  }
  return '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Chunk-text modal ----
//
// Clicking a chunk number in the sources table fetches that one
// chunk's full text on demand from GET
// /workspaces/:workspaceId/chunks/:chunkId (rather than the query
// response carrying every retrieved chunk's full text up front) and
// shows it in a modal. See getChunk() in store.js for the reasoning.

let chunkModalBackdrop, chunkModalTitle, chunkModalSubtitle, chunkModalBody, chunkModalClose;

function openChunkModal() {
  chunkModalBackdrop.classList.add('open');
}

function closeChunkModal() {
  chunkModalBackdrop.classList.remove('open');
}

/**
 * Fetches one chunk's full text and shows it in the modal — the
 * click-handling logic shared by both the main sources table and the
 * per-attribute results table's Sources column (see
 * wireChunkLinkDelegate() below), since both just want the same
 * "look up this block, show it in the modal" behavior on click.
 */
async function showChunkModal(chunkId, sourceFile, chunkIndex) {
  const workspaceId = getWorkspaceId();
  if (!workspaceId) return;

  chunkModalTitle.textContent = `Block ${chunkIndex}`;
  chunkModalSubtitle.textContent = sourceFile;
  chunkModalBody.className = 'modal-body muted';
  chunkModalBody.textContent = 'Loading…';
  openChunkModal();

  try {
    const res = await fetch(
      `/workspaces/${encodeURIComponent(workspaceId)}/chunks/${encodeURIComponent(chunkId)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);

    chunkModalBody.className = 'modal-body';
    chunkModalBody.textContent = data.text;
  } catch (err) {
    chunkModalBody.className = 'modal-body muted';
    chunkModalBody.textContent = `Could not load block text: ${err.message}`;
  }
}

/**
 * One delegated click listener on a container that may hold any
 * number of chunk-link buttons (data-chunk-id/data-source-file/
 * data-chunk-index), handling all of them — including ones added by a
 * later query or batch — with no per-button re-attachment needed. Used
 * for both the main sources table and the per-attribute results
 * table's Sources column.
 */
function wireChunkLinkDelegate(container) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.chunk-link');
    if (!btn) return;
    showChunkModal(btn.dataset.chunkId, btn.dataset.sourceFile, btn.dataset.chunkIndex);
  });
}

// ---- Collapsible section toggles ----
//
// Backs the four <details class="section-toggle"> wrappers in
// index.html (Import a document, Documents in this area, the answer
// text block, and the per-attribute results table) — plain native
// <details>/<summary> elements, so no library is needed for the
// collapse/expand behavior
// itself. What this adds on top:
//
//   1. Persistence: whichever state someone leaves a section in
//      (open or closed) is remembered per browser via localStorage,
//      and restored the next time this page loads — but only for a
//      genuine click on the <summary>. A <details> element's "toggle"
//      event fires for BOTH a real click AND a script-driven change
//      to its .open property, with no way to tell them apart from the
//      event itself — see point 2.
//   2. forceOpen(): lets other code (the submit handler, for the
//      answer section specifically — see its call below) force a
//      section open without that being mistaken for, or overwriting,
//      someone's own stored preference. It works by setting a
//      one-shot "suppress" flag immediately before changing .open;
//      the very next "toggle" event consumes that flag and returns
//      without persisting anything, rather than trying to guess
//      real-click-vs-script from timing.
//
// localStorage failing outright (blocked cookies/storage, private
// browsing in some browsers) is handled by just leaving the section at
// whatever index.html's own `open` attribute already set — a missing
// or unreadable preference is never treated as an error, just as "no
// preference recorded yet."
function initSectionToggle(details, storageKey) {
  const state = { suppress: false };

  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === '0') details.open = false;
    else if (stored === '1') details.open = true;
  } catch (err) {
    // Storage unavailable — leave index.html's own `open` default alone.
  }

  details.addEventListener('toggle', () => {
    if (state.suppress) {
      state.suppress = false;
      return;
    }
    try {
      localStorage.setItem(storageKey, details.open ? '1' : '0');
    } catch (err) {
      // Non-fatal — the toggle itself still worked, it just won't be
      // remembered next visit.
    }
  });

  return {
    forceOpen() {
      if (details.open) return; // already open — nothing to force, and no event will fire to suppress
      state.suppress = true;
      details.open = true;
    },
  };
}

let documentsDetails, answerDetails, attributeResultsDetails, importDetails, rubricDetails;
let answerToggle;

// ---- Tabs (hamburger menu) ----
//
// The page's sections are grouped into three always-present panel
// divs in index.html (#tabPanel-documents, #tabPanel-rubric,
// #tabPanel-query) — "Document Management," "Rubric Control," and
// "Query and Response" respectively. Switching tabs only ever toggles
// each panel's own display:block/none; nothing inside a panel is
// re-rendered, rebuilt, or removed from the DOM when it's hidden, so
// in-progress state in a tab you switch away from (a half-typed
// question, an open Advanced settings section, a query still
// streaming in) is still exactly as you left it when you switch back.
// This is also why none of the existing element ids or event-handling
// code elsewhere in this file needed to change for tabs to exist —
// every element a handler looks up is still on the page, just
// sometimes inside a panel with display:none.
const TAB_IDS = ['documents', 'rubric', 'query'];
const TAB_LABELS = {
  documents: 'Document Management',
  rubric: 'Rubric Control',
  query: 'Query and Response',
};
// Which tab was open persists across a reload, same
// localStorage-per-browser convention initSectionToggle() above uses
// for collapsible sections — a low-risk, easily-reversible nicety
// (falls back to the first tab if storage is unavailable or empty).
const TAB_STORAGE_KEY = 'local-rag:activeTab';

let tabMenuBtn, tabMenuList, tabMenuActiveLabel;

/**
 * Shows the given tab's panel and hides the other two, updates the
 * hamburger menu's active-item highlighting and its button label (the
 * approved "active-tab indicator"), and remembers the choice for next
 * visit.
 * @param {string} tabId - one of TAB_IDS; falls back to the first tab
 *   if not recognized (e.g. a stale/corrupt localStorage value).
 */
function setActiveTab(tabId) {
  if (!TAB_IDS.includes(tabId)) tabId = TAB_IDS[0];

  for (const id of TAB_IDS) {
    const panel = document.getElementById(`tabPanel-${id}`);
    if (panel) panel.style.display = id === tabId ? '' : 'none';
  }
  for (const item of tabMenuList.querySelectorAll('.tab-menu-item')) {
    item.classList.toggle('active', item.dataset.tab === tabId);
  }
  tabMenuActiveLabel.textContent = TAB_LABELS[tabId];

  try {
    localStorage.setItem(TAB_STORAGE_KEY, tabId);
  } catch (err) {
    // Non-fatal — the switch itself still worked, it just won't be
    // remembered next visit.
  }
}

function initTabs() {
  tabMenuBtn = document.getElementById('tabMenuBtn');
  tabMenuList = document.getElementById('tabMenuList');
  tabMenuActiveLabel = document.getElementById('tabMenuActiveLabel');

  tabMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let this click immediately re-close the menu via the document listener below
    const open = tabMenuList.classList.toggle('open');
    tabMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  tabMenuList.addEventListener('click', (e) => {
    const item = e.target.closest('.tab-menu-item');
    if (!item) return;
    setActiveTab(item.dataset.tab);
    tabMenuList.classList.remove('open');
    tabMenuBtn.setAttribute('aria-expanded', 'false');
  });

  // Clicking anywhere else on the page closes the menu if it's open —
  // standard dropdown behavior. Harmless when the menu's already
  // closed (classList.remove on an already-absent class is a no-op).
  document.addEventListener('click', () => {
    tabMenuList.classList.remove('open');
    tabMenuBtn.setAttribute('aria-expanded', 'false');
  });

  let initialTab = TAB_IDS[0];
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    if (stored && TAB_IDS.includes(stored)) initialTab = stored;
  } catch (err) {
    // Storage unavailable — fall back to the first tab.
  }
  setActiveTab(initialTab);
}

// ---- Rubric Control ----
//
// UI for managing idealProposals.json's topics — the "ideal proposal"
// comparison data the Query and Response tab's compare-mode dropdown
// offers (see refreshIdealTopics() above and src/idealProposals.js).
// Previously this file could only be edited by hand or via the
// standalone excel_to_json.py script; this section is the in-app
// replacement for both, talking to the CRUD routes added alongside it
// in index.js (GET/POST/PUT/DELETE /ideal-proposals[...]) and the
// native xlsx-import routes backed by src/xlsxImport.js.
//
// A topic's id is fixed once created (no rename support, by design —
// see the routes' own doc comments in index.js) — rubricEditingTopicId
// below tracks whether the form is currently creating a brand new
// topic (null) or overwriting an existing one (that topic's id, with
// the id field itself locked). Saving an edit always fully replaces
// the topic's label/description/attributes, never merges.

let rubricTopicsBody, rubricTopicsEmpty, rubricTopicsError;
let rubricForm, rubricFormHeading, rubricFormHint;
let rubricTopicId, rubricTopicIdHint, rubricTopicLabel, rubricTopicDescription, rubricCompareInstruction;
let rubricAttributesBody, rubricAddAttributeBtn;
let rubricXlsxFile, rubricXlsxFieldsRow, rubricXlsxSheet, rubricXlsxNameColumns, rubricXlsxProposalColumn, rubricXlsxImportBtn, rubricXlsxStatus, rubricXlsxError;
let rubricSaveBtn, rubricCancelEditBtn, rubricFormStatus, rubricFormError;

let rubricEditingTopicId = null;
// The File object from the last workbook picked for import — kept
// around so "Load attributes from workbook" (which may be clicked
// after changing the sheet/column dropdowns a few times) can resend
// the same file to /ideal-proposals/import-xlsx without asking the
// person to re-pick it; a browser File object can be attached to more
// than one FormData/fetch call without issue.
let rubricXlsxSelectedFile = null;

/**
 * (Re)loads the Rubric Control tab's topic list from GET
 * /ideal-proposals. Called on init, and again after any create/edit/
 * delete so the table always reflects what's actually saved.
 */
async function refreshRubricTopics() {
  rubricTopicsError.style.display = 'none';
  try {
    const res = await fetch('/ideal-proposals');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load topics');

    const topics = data.topics || [];
    rubricTopicsBody.innerHTML = '';
    rubricTopicsEmpty.textContent = topics.length
      ? ''
      : 'No topics yet — add one below, or import attributes from an Excel workbook.';

    for (const topic of topics) {
      const attrWord = topic.attributeCount === 1 ? 'attribute' : 'attributes';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(topic.label)}<div class="hint">${escapeHtml(topic.id)}</div></td>
        <td>${escapeHtml(topic.description || '')}</td>
        <td>${topic.attributeCount} ${attrWord}</td>
        <td class="rubric-topic-actions">
          <button type="button" class="btn-secondary rubric-edit-btn" data-id="${escapeHtml(topic.id)}">Edit</button>
          <button type="button" class="btn-remove rubric-delete-btn" data-id="${escapeHtml(topic.id)}">Delete</button>
        </td>
      `;
      rubricTopicsBody.appendChild(tr);
    }
  } catch (err) {
    rubricTopicsError.textContent = err.message;
    rubricTopicsError.style.display = 'block';
  }
}

/**
 * Appends one editable attribute row (name + proposal + remove
 * button). Both fields are <textarea>s rather than single-line
 * <input>s — a name built from several joined spreadsheet columns
 * (see excel_to_json.py's JOIN_SEPARATOR) and especially a proposal's
 * ideal-condition text routinely run well past what a single-line
 * input can show at once, forcing horizontal scrolling inside a tiny
 * box to read or edit the whole thing. A <textarea> wraps instead,
 * showing several lines up front, and can still be dragged taller via
 * its own resize handle (see the CSS) for anything longer than that.
 * `rows` just sets the starting height — normal textarea behavior,
 * not a length limit; nothing about how the value is read (still a
 * single string, still trimmed) or saved changes because of this.
 */
function addRubricAttributeRow(name = '', proposal = '') {
  const tr = document.createElement('tr');

  const nameTd = document.createElement('td');
  const nameInput = document.createElement('textarea');
  nameInput.rows = 2;
  nameInput.className = 'rubric-attr-name';
  nameInput.placeholder = 'Attribute name';
  nameInput.value = name;
  nameTd.appendChild(nameInput);

  const proposalTd = document.createElement('td');
  const proposalInput = document.createElement('textarea');
  proposalInput.rows = 4;
  proposalInput.className = 'rubric-attr-proposal';
  proposalInput.placeholder = 'Ideal proposal text';
  proposalInput.value = proposal;
  proposalTd.appendChild(proposalInput);

  const removeTd = document.createElement('td');
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => tr.remove());
  removeTd.appendChild(removeBtn);

  tr.appendChild(nameTd);
  tr.appendChild(proposalTd);
  tr.appendChild(removeTd);
  rubricAttributesBody.appendChild(tr);
}

function clearRubricAttributeRows() {
  rubricAttributesBody.innerHTML = '';
}

/**
 * Reads the attribute editor's rows back into
 * `[{name, proposal}, ...]`. A row left completely blank (added via
 * "Add attribute" and never filled in) is silently dropped; a row
 * with only one of the two fields filled in is kept as-is so the
 * server's own validation catches and reports it clearly, rather than
 * this function guessing whether that was a mistake worth silently
 * discarding.
 */
function readRubricAttributeRows() {
  return [...rubricAttributesBody.querySelectorAll('tr')]
    .map((tr) => ({
      name: tr.querySelector('.rubric-attr-name').value.trim(),
      proposal: tr.querySelector('.rubric-attr-proposal').value.trim(),
    }))
    .filter((a) => a.name || a.proposal);
}

/** Clears the xlsx-import sub-form back to its initial, nothing-picked-yet state. */
function resetRubricXlsxImport() {
  rubricXlsxSelectedFile = null;
  rubricXlsxFile.value = '';
  rubricXlsxFieldsRow.style.display = 'none';
  rubricXlsxImportBtn.style.display = 'none';
  rubricXlsxSheet.innerHTML = '';
  rubricXlsxNameColumns.innerHTML = '';
  rubricXlsxProposalColumn.innerHTML = '';
  rubricXlsxStatus.textContent = '';
  rubricXlsxError.style.display = 'none';
}

/**
 * Resets the whole Rubric Control form to "creating a brand new
 * topic" — called on init, after a successful save, and when Cancel
 * edit is clicked.
 */
function resetRubricForm() {
  rubricEditingTopicId = null;
  rubricForm.reset();
  rubricTopicId.disabled = false;
  rubricTopicIdHint.textContent =
    'Letters, numbers, hyphens, and underscores only. This cannot be changed once the topic is created.';
  rubricFormHeading.textContent = 'Add a new topic';
  rubricFormHint.textContent =
    'Fill in a topic id, label, and at least one attribute, or import attributes from an Excel workbook below.';
  rubricSaveBtn.textContent = 'Save topic';
  rubricCancelEditBtn.style.display = 'none';
  clearRubricAttributeRows();
  addRubricAttributeRow();
  resetRubricXlsxImport();
  rubricFormError.style.display = 'none';
  rubricFormStatus.textContent = '';
}

/**
 * Loads one existing topic's full detail (GET /ideal-proposals/:id —
 * not the resolved-fallback getTopic() shape; see that route's own
 * doc comment in index.js) into the form for editing. The id field is
 * locked, since overwriting is the only supported edit — there's no
 * rename.
 */
async function loadRubricTopicForEdit(topicId) {
  rubricFormError.style.display = 'none';
  rubricFormStatus.textContent = 'Loading…';
  try {
    const res = await fetch(`/ideal-proposals/${encodeURIComponent(topicId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load topic');
    const topic = data.topic;

    rubricEditingTopicId = topic.id;
    rubricTopicId.value = topic.id;
    rubricTopicId.disabled = true;
    rubricTopicIdHint.textContent = "Fixed — a topic's id cannot be changed once created.";
    rubricTopicLabel.value = topic.label || '';
    rubricTopicDescription.value = topic.description || '';
    // compareInstruction may be a plain string or an array of
    // paragraphs (see resolveInstructionText() in idealProposals.js);
    // the edit form only ever writes it back as a single string, same
    // as the routes' own body shape expects.
    rubricCompareInstruction.value = Array.isArray(topic.compareInstruction)
      ? topic.compareInstruction.join('\n\n')
      : (topic.compareInstruction || '');

    rubricFormHeading.textContent = `Editing "${topic.label}"`;
    rubricFormHint.textContent = "Saving replaces this topic's label, description, and attributes entirely.";
    rubricSaveBtn.textContent = 'Save changes';
    rubricCancelEditBtn.style.display = '';

    clearRubricAttributeRows();
    const attrs = topic.attributes || [];
    if (attrs.length) {
      for (const a of attrs) addRubricAttributeRow(a.name, a.proposal);
    } else {
      addRubricAttributeRow();
    }
    resetRubricXlsxImport();
    rubricFormStatus.textContent = '';

    rubricForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    rubricFormError.textContent = err.message;
    rubricFormError.style.display = 'block';
    rubricFormStatus.textContent = '';
  }
}

/**
 * Reads the chosen workbook's sheets/columns (POST
 * /ideal-proposals/xlsx-inspect) and populates the sheet/name-columns/
 * proposal-column dropdowns, so picking what to import is a matter of
 * choosing from real options rather than typing exact names from
 * memory the way excel_to_json.py's CLI required.
 */
async function inspectRubricXlsxFile(file) {
  rubricXlsxError.style.display = 'none';
  rubricXlsxStatus.textContent = 'Reading workbook…';
  rubricXlsxFieldsRow.style.display = 'none';
  rubricXlsxImportBtn.style.display = 'none';

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/ideal-proposals/xlsx-inspect', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to read workbook');

    const sheets = data.sheets || [];
    if (!sheets.length) throw new Error('This workbook has no sheets.');

    rubricXlsxSheet.innerHTML = '';
    for (const sheet of sheets) {
      const opt = document.createElement('option');
      opt.value = sheet.name;
      opt.textContent = sheet.name;
      rubricXlsxSheet.appendChild(opt);
    }

    const populateColumnChoices = () => {
      const sheet = sheets.find((s) => s.name === rubricXlsxSheet.value);
      const columns = sheet ? sheet.columns : [];

      rubricXlsxNameColumns.innerHTML = '';
      rubricXlsxProposalColumn.innerHTML = '';
      for (const col of columns) {
        const nameOpt = document.createElement('option');
        nameOpt.value = col;
        nameOpt.textContent = col;
        rubricXlsxNameColumns.appendChild(nameOpt);

        const proposalOpt = document.createElement('option');
        proposalOpt.value = col;
        proposalOpt.textContent = col;
        rubricXlsxProposalColumn.appendChild(proposalOpt);
      }
    };
    rubricXlsxSheet.onchange = populateColumnChoices;
    populateColumnChoices();

    rubricXlsxFieldsRow.style.display = '';
    rubricXlsxImportBtn.style.display = '';
    rubricXlsxStatus.textContent = `Found ${sheets.length} sheet(s) — pick a sheet and columns, then load attributes.`;
  } catch (err) {
    rubricXlsxError.textContent = err.message;
    rubricXlsxError.style.display = 'block';
    rubricXlsxStatus.textContent = '';
  }
}

/**
 * Runs the actual conversion (POST /ideal-proposals/import-xlsx) for
 * whichever sheet/columns are currently selected, and loads the
 * result into the attribute editor, REPLACING whatever rows were
 * there — matches the "xlsx import always fully replaces, never
 * merges" decision, applied here at load-into-editor time as well as
 * at save time, so what's shown in the editor is always exactly what
 * Save would write.
 */
async function importRubricXlsxAttributes() {
  rubricXlsxError.style.display = 'none';
  if (!rubricXlsxSelectedFile) {
    rubricXlsxError.textContent = 'Choose a workbook first.';
    rubricXlsxError.style.display = 'block';
    return;
  }

  const sheet = rubricXlsxSheet.value;
  const nameColumns = [...rubricXlsxNameColumns.selectedOptions].map((o) => o.value);
  const proposalColumn = rubricXlsxProposalColumn.value;

  if (!sheet || !nameColumns.length || !proposalColumn) {
    rubricXlsxError.textContent = 'Pick a sheet, at least one name column, and a proposal column.';
    rubricXlsxError.style.display = 'block';
    return;
  }

  rubricXlsxImportBtn.disabled = true;
  rubricXlsxStatus.textContent = 'Loading attributes…';

  try {
    const formData = new FormData();
    formData.append('file', rubricXlsxSelectedFile);
    formData.append('sheet', sheet);
    formData.append('nameColumns', nameColumns.join(','));
    formData.append('proposalColumn', proposalColumn);
    const res = await fetch('/ideal-proposals/import-xlsx', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to import workbook');

    const attributes = data.attributes || [];
    clearRubricAttributeRows();
    if (attributes.length) {
      for (const a of attributes) addRubricAttributeRow(a.name, a.proposal);
    } else {
      addRubricAttributeRow();
    }

    rubricXlsxStatus.textContent =
      `Loaded ${attributes.length} attribute(s) into the editor below` +
      (data.skippedRows ? ` (skipped ${data.skippedRows} row(s) with an empty proposal or name column(s))` : '') +
      ' — review, then Save.';
  } catch (err) {
    rubricXlsxError.textContent = err.message;
    rubricXlsxError.style.display = 'block';
    rubricXlsxStatus.textContent = '';
  } finally {
    rubricXlsxImportBtn.disabled = false;
  }
}

/**
 * Creates a new topic (POST /ideal-proposals) or overwrites the one
 * currently being edited (PUT /ideal-proposals/:id), then refreshes
 * both the Rubric Control table AND the Query and Response tab's
 * compare-mode dropdown — the latter is what keeps a just-added or
 * just-edited topic usable immediately, with no page reload.
 */
async function submitRubricForm(e) {
  e.preventDefault();
  rubricFormError.style.display = 'none';

  const id = rubricTopicId.value.trim();
  const label = rubricTopicLabel.value.trim();
  const description = rubricTopicDescription.value.trim();
  const compareInstruction = rubricCompareInstruction.value.trim();
  const attributes = readRubricAttributeRows();

  if (!rubricEditingTopicId && !id) {
    rubricFormError.textContent = 'Topic id is required.';
    rubricFormError.style.display = 'block';
    return;
  }
  if (!label) {
    rubricFormError.textContent = 'Label is required.';
    rubricFormError.style.display = 'block';
    return;
  }
  if (!attributes.length) {
    rubricFormError.textContent = 'At least one attribute (name + proposal) is required.';
    rubricFormError.style.display = 'block';
    return;
  }

  // Saving while rubricEditingTopicId is set always goes to PUT
  // /ideal-proposals/:topicId, which fully replaces that topic's
  // label, description, and attributes — never a merge (see that
  // route's own doc comment in index.js). That's the one case a Save
  // here can actually destroy existing data, most easily overlooked
  // right after an xlsx import replaced every attribute row at once —
  // so confirm before it happens rather than after. Creating a brand
  // new topic (rubricEditingTopicId null) never reaches this branch:
  // POST /ideal-proposals already rejects a duplicate id outright
  // rather than silently overwriting, so there's nothing to confirm
  // there.
  if (rubricEditingTopicId) {
    const attrWord = attributes.length === 1 ? 'attribute' : 'attributes';
    const confirmed = confirm(
      `Save changes to "${label}"?\n\n` +
      `This overwrites the existing topic (id: "${rubricEditingTopicId}") — its label, description, and attributes will be replaced with what's shown in the form now (${attributes.length} ${attrWord}). This cannot be undone.`
    );
    if (!confirmed) return;
  }

  rubricSaveBtn.disabled = true;
  rubricFormStatus.textContent = 'Saving…';

  try {
    const body = { label, description, attributes, compareInstruction };
    const res = rubricEditingTopicId
      ? await fetch(`/ideal-proposals/${encodeURIComponent(rubricEditingTopicId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await fetch('/ideal-proposals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, ...body }),
        });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save topic');

    // resetRubricForm() clears rubricFormStatus as part of putting the
    // form back into "add a new topic" state — so the success message
    // has to be set AFTER it runs, not before, or it would be wiped
    // out before anyone sees it.
    const savedLabel = data.topic.label;
    resetRubricForm();
    rubricFormStatus.textContent = `Saved "${savedLabel}".`;
    refreshRubricTopics();
    refreshIdealTopics();
  } catch (err) {
    rubricFormError.textContent = err.message;
    rubricFormError.style.display = 'block';
    rubricFormStatus.textContent = '';
  } finally {
    rubricSaveBtn.disabled = false;
  }
}

/**
 * Same NDJSON-over-fetch pattern as embedWithProgress() above,
 * pointed at /query/stream instead. onEvent fires for each line as
 * it arrives: {type:"sources",...}, then for a reasoning model with
 * thinking on, a run of {type:"thinking",...} (its reasoning trace,
 * streamed separately from and before the answer), then a run of
 * {type:"token",...} as the answer itself is generated, ending in
 * {type:"done",...} or {type:"error",...}.
 *
 * @param {boolean} [think] - true (or omitted) leaves thinking at
 *   whatever Ollama's own default is for this model (on, for
 *   supported models — same as thinkCheckbox defaulting checked);
 *   false explicitly skips it. See the `think` param on chat() in
 *   ollamaClient.js for why this is a real skip, not just a display
 *   filter.
 * @param {number} [numCtx] - the "Request size" Advanced setting —
 *   passed straight through to Ollama's `num_ctx` (see the doc on
 *   chat()'s `numCtx` option in ollamaClient.js for what this
 *   actually controls). Undefined when left blank, same "absence
 *   means don't override" convention maxTokens follows.
 * @param {number} [repeatPenalty] - the "Repeat penalty" Advanced
 *   setting — passed straight through to Ollama's `repeat_penalty`
 *   (see the doc on chat()'s `repeatPenalty` option in
 *   ollamaClient.js for what this actually controls, and why it
 *   exists: a weaker/smaller model getting stuck restating slight
 *   variants of the same answer instead of stopping). Undefined when
 *   left blank, same "absence means don't override" convention
 *   maxTokens/numCtx follow.
 * @param {number} [attributesPerCall] - the "Attributes per call"
 *   Advanced setting. Only has any effect when `idealTopicId` is also
 *   set — see batchAttributes() in src/idealProposals.js. Undefined
 *   when left blank, same convention as maxTokens/numCtx: ask about
 *   every attribute in one call, as before this setting existed.
 * @param {AbortSignal} [signal] - wired to stopBtn in init(). Aborting
 *   this closes the fetch, which the /query/stream route on the
 *   server notices (via Express's `res.on('close', ...)`) and uses
 *   to cancel its own in-flight request to Ollama — so Stop actually
 *   halts generation server-side, not just this tab's display of it.
 *   When aborted, this function rejects with an AbortError (the
 *   fetch spec's own name for it) rather than the usual thrown
 *   Error; the caller below checks err.name to tell the two apart.
 */
async function queryWithStream(workspaceId, question, topK, chatModel, temperature, maxTokens, numCtx, repeatPenalty, idealTopicId, attributesPerCall, think, onEvent, signal) {
  const res = await fetch('/query/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // chatModel/temperature/maxTokens/numCtx/repeatPenalty/idealTopicId/attributesPerCall/think
    // undefined (nothing usable selected, or the field was cleared)
    // just omits that key from the JSON body entirely, and
    // /query/stream's own default takes over server-side — for
    // maxTokens that's "no cap," for numCtx that's "use the model's
    // own default," for repeatPenalty that's "use the model's own
    // default (usually 1.1)," for idealTopicId that's "answer
    // normally, no comparison," for attributesPerCall that's "ask
    // about every attribute in one call," for think that's "leave
    // Ollama's own default alone" (see the think param doc above).
    body: JSON.stringify({ question, workspaceId, topK, chatModel, temperature, maxTokens, numCtx, repeatPenalty, idealTopicId, attributesPerCall, think }),
    signal,
  });

  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {
      // Not JSON — fall back to the generic message above.
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalEvent = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      onEvent(event);
      if (event.type === 'done' || event.type === 'error') finalEvent = event;
    }
  }

  if (!finalEvent) throw new Error('Server closed the connection before finishing.');
  if (finalEvent.type === 'error') throw new Error(finalEvent.error);
  return finalEvent;
}

/**
 * Wires up every DOM reference and event listener this page needs,
 * and kicks off the initial data loads (config, workspaces, models,
 * ideal-proposal topics). Split out from top-level script code and
 * called via <body onload="init()"> in index.html, so every element
 * looked up here (via document.getElementById) is guaranteed to
 * already exist — style.css and script.js are loaded from <head>,
 * before the page's own markup below it has been parsed, so running
 * any of this at plain top-level script scope would be too early.
 */
function init() {
  workspaceInput = document.getElementById('workspace');
  workspaceList = document.getElementById('workspaceList');

  chatModelSelect = document.getElementById('chatModel');
  chatModelHint = document.getElementById('chatModelHint');

  idealTopicSelect = document.getElementById('idealTopic');
  idealTopicHint = document.getElementById('idealTopicHint');
  idealTopicHintDefault = idealTopicHint.textContent;

  documentsWrap = document.getElementById('documentsWrap');
  documentsEmpty = document.getElementById('documentsEmpty');
  documentsBody = document.getElementById('documentsBody');
  documentsError = document.getElementById('documentsError');

  blockLookupDocument = document.getElementById('blockLookupDocument');
  blockLookupIndex = document.getElementById('blockLookupIndex');
  blockLookupBtn = document.getElementById('blockLookupBtn');
  blockLookupError = document.getElementById('blockLookupError');

  deleteWorkspaceBtn = document.getElementById('deleteWorkspaceBtn');
  deleteWorkspaceStatus = document.getElementById('deleteWorkspaceStatus');
  deleteWorkspaceError = document.getElementById('deleteWorkspaceError');

  rebuildIndexBtn = document.getElementById('rebuildIndexBtn');
  rebuildStatus = document.getElementById('rebuildStatus');
  rebuildError = document.getElementById('rebuildError');
  rebuildProgressWrap = document.getElementById('rebuildProgressWrap');
  rebuildProgressBar = document.getElementById('rebuildProgressBar');

  embedForm = document.getElementById('embedForm');
  embedStatus = document.getElementById('embedStatus');
  embedError = document.getElementById('embedError');
  embedResult = document.getElementById('embedResult');
  embedSubmitBtn = document.getElementById('embedSubmitBtn');
  embedProgressWrap = document.getElementById('embedProgressWrap');
  embedProgressBar = document.getElementById('embedProgressBar');

  form = document.getElementById('queryForm');
  statusEl = document.getElementById('status');
  errorEl = document.getElementById('error');
  resultEl = document.getElementById('result');
  answerEl = document.getElementById('answer');
  lengthNote = document.getElementById('lengthNote');
  sourcesBody = document.getElementById('sourcesBody');
  confidenceNote = document.getElementById('confidenceNote');
  retrievalQueryNote = document.getElementById('retrievalQueryNote');
  tokenUsageNote = document.getElementById('tokenUsageNote');
  submitBtn = document.getElementById('submitBtn');
  stopBtn = document.getElementById('stopBtn');
  elapsedTimeEl = document.getElementById('elapsedTime');
  queryProgressWrap = document.getElementById('queryProgressWrap');
  thinkCheckbox = document.getElementById('thinkEnabled');
  reasoningWrap = document.getElementById('reasoningWrap');
  reasoningEl = document.getElementById('reasoningEl');

  attributeResultsWrap = document.getElementById('attributeResultsWrap');
  attributeResultsBody = document.getElementById('attributeResultsBody');
  downloadCsvBtn = document.getElementById('downloadCsvBtn');

  chunkModalBackdrop = document.getElementById('chunkModalBackdrop');
  chunkModalTitle = document.getElementById('chunkModalTitle');
  chunkModalSubtitle = document.getElementById('chunkModalSubtitle');
  chunkModalBody = document.getElementById('chunkModalBody');
  chunkModalClose = document.getElementById('chunkModalClose');

  documentsDetails = document.getElementById('documentsDetails');
  answerDetails = document.getElementById('answerDetails');
  attributeResultsDetails = document.getElementById('attributeResultsDetails');
  importDetails = document.getElementById('importDetails');
  rubricDetails = document.getElementById('rubricDetails');

  rubricTopicsBody = document.getElementById('rubricTopicsBody');
  rubricTopicsEmpty = document.getElementById('rubricTopicsEmpty');
  rubricTopicsError = document.getElementById('rubricTopicsError');

  rubricForm = document.getElementById('rubricForm');
  rubricFormHeading = document.getElementById('rubricFormHeading');
  rubricFormHint = document.getElementById('rubricFormHint');
  rubricTopicId = document.getElementById('rubricTopicId');
  rubricTopicIdHint = document.getElementById('rubricTopicIdHint');
  rubricTopicLabel = document.getElementById('rubricTopicLabel');
  rubricTopicDescription = document.getElementById('rubricTopicDescription');
  rubricCompareInstruction = document.getElementById('rubricCompareInstruction');

  rubricAttributesBody = document.getElementById('rubricAttributesBody');
  rubricAddAttributeBtn = document.getElementById('rubricAddAttributeBtn');

  rubricXlsxFile = document.getElementById('rubricXlsxFile');
  rubricXlsxFieldsRow = document.getElementById('rubricXlsxFieldsRow');
  rubricXlsxSheet = document.getElementById('rubricXlsxSheet');
  rubricXlsxNameColumns = document.getElementById('rubricXlsxNameColumns');
  rubricXlsxProposalColumn = document.getElementById('rubricXlsxProposalColumn');
  rubricXlsxImportBtn = document.getElementById('rubricXlsxImportBtn');
  rubricXlsxStatus = document.getElementById('rubricXlsxStatus');
  rubricXlsxError = document.getElementById('rubricXlsxError');

  rubricSaveBtn = document.getElementById('rubricSaveBtn');
  rubricCancelEditBtn = document.getElementById('rubricCancelEditBtn');
  rubricFormStatus = document.getElementById('rubricFormStatus');
  rubricFormError = document.getElementById('rubricFormError');

  // ---- Collapsible section toggles ----
  // Documents-in-this-area and the per-attribute results table just
  // need plain persistence; the answer section additionally gets
  // force-opened at the start of every new query (see the submit
  // handler below), so its own return value is kept.
  initSectionToggle(documentsDetails, 'local-rag:documentsOpen');
  answerToggle = initSectionToggle(answerDetails, 'local-rag:answerOpen');
  initSectionToggle(attributeResultsDetails, 'local-rag:attributeResultsOpen');
  initSectionToggle(importDetails, 'local-rag:importOpen');
  initSectionToggle(rubricDetails, 'local-rag:rubricOpen');

  // ---- Tabs ----
  initTabs();

  // ---- Event listeners ----

  // Debounced on typing (rather than firing on every keystroke), and
  // also handles picking a suggestion from the workspace datalist,
  // since selecting one fires an "input" event too.
  workspaceInput.addEventListener('input', () => {
    clearTimeout(documentsDebounce);
    documentsDebounce = setTimeout(refreshDocuments, 400);
  });

  blockLookupDocument.addEventListener('change', () => {
    loadBlockLookupIndex(blockLookupDocument.value);
  });

  blockLookupIndex.addEventListener('change', () => {
    blockLookupBtn.disabled = !blockLookupIndex.value;
  });

  blockLookupBtn.addEventListener('click', () => {
    const sourceFile = blockLookupDocument.value;
    const chunkIndex = blockLookupIndex.value;
    if (!sourceFile || chunkIndex === '') return;
    // blockLookupIndex's option values are chunkIndex numbers rendered
    // as strings by the DOM, so compare as strings here rather than
    // coercing back to Number — avoids any edge case with a
    // non-integer chunkIndex (shouldn't happen — see embedPipeline.js
    // — but this comparison doesn't need to assume it never will).
    const entry = blockLookupChunks.find((c) => String(c.chunkIndex) === chunkIndex);
    if (!entry) return;
    showChunkModal(entry.id, sourceFile, entry.chunkIndex);
  });

  // One delegated listener on the table body handles every Remove
  // button, including ones added after a later refresh — no need to
  // re-attach a handler per row.
  documentsBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-remove');
    if (!btn) return;

    const sourceFile = btn.dataset.source;
    const workspaceId = getWorkspaceId();
    if (!workspaceId) return;

    if (!confirm(
      `Remove "${sourceFile}" from this area?\n\n` +
      `This deletes its blocks from the search index. If it was uploaded ` +
      `through this app, its file is deleted too. If it was added another ` +
      `way (for example, from a script), only the index entries are ` +
      `removed — the original file is left alone.`
    )) {
      return;
    }

    btn.disabled = true;
    documentsError.style.display = 'none';

    try {
      const res = await fetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(sourceFile)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
      // The delete itself succeeded either way, but a recorded upload
      // path that somehow failed to resolve inside this workspace's
      // uploads/ directory (or failed to unlink for some other reason)
      // is surfaced rather than silently swallowed — see fileErrors on
      // deleteDocument() in src/store.js.
      if (data.fileErrors && data.fileErrors.length) {
        documentsError.textContent = data.fileErrors.join(' ');
        documentsError.style.display = 'block';
      }
      refreshDocuments();
    } catch (err) {
      documentsError.textContent = err.message;
      documentsError.style.display = 'block';
      btn.disabled = false;
    }
  });

  deleteWorkspaceBtn.addEventListener('click', async () => {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) return;

    if (!confirm(
      `Permanently delete this entire storage area, "${workspaceId}"?\n\n` +
      `This removes every document, every block in its search index, ` +
      `and every uploaded file — the area itself will no longer exist. ` +
      `This cannot be undone.`
    )) {
      return;
    }

    deleteWorkspaceBtn.disabled = true;
    deleteWorkspaceError.style.display = 'none';
    deleteWorkspaceStatus.textContent = 'Deleting area…';

    try {
      const res = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);

      deleteWorkspaceStatus.textContent = `Storage area "${workspaceId}" deleted.`;
      // The workspace is gone — clear the field so the UI doesn't sit
      // there pointed at something that no longer exists, and refresh
      // the (now shorter) list of workspaces below it.
      workspaceInput.value = '';
      documentsWrap.style.display = 'none';
      refreshWorkspaces();
    } catch (err) {
      deleteWorkspaceError.textContent = err.message;
      deleteWorkspaceError.style.display = 'block';
    } finally {
      deleteWorkspaceBtn.disabled = false;
    }
  });

  rebuildIndexBtn.addEventListener('click', async () => {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) return;

    if (!confirm(
      `Rebuild the block index for "${workspaceId}" from its uploaded ` +
      `files?\n\n` +
      `This rebuilds the internal record of what's in this area using ` +
      `only the files still uploaded here. Documents added another way ` +
      `(not imported through this app) will NOT be restored. This ` +
      `cannot be undone.`
    )) {
      return;
    }

    rebuildIndexBtn.disabled = true;
    rebuildError.style.display = 'none';
    rebuildProgressWrap.style.display = 'block';
    rebuildProgressBar.removeAttribute('value'); // indeterminate until the first file's "start" event arrives
    rebuildStatus.textContent = 'Rebuilding…';

    try {
      const result = await rebuildWithProgress(workspaceId, (event) => {
        if (event.type === 'file-start') {
          rebuildStatus.textContent = `File ${event.fileIndex} / ${event.totalFiles}: extracting "${event.sourceFile}"…`;
        } else if (event.type === 'start') {
          rebuildProgressBar.max = event.totalChunks;
          rebuildProgressBar.value = 0;
          rebuildStatus.textContent = `Importing "${event.sourceFile}": 0 / ${event.totalChunks} blocks`;
        } else if (event.type === 'progress') {
          rebuildProgressBar.value = event.chunksEmbedded;
          rebuildStatus.textContent = `Importing "${event.sourceFile || ''}": ${event.chunksEmbedded} / ${event.totalChunks} blocks`;
        }
      });

      rebuildStatus.textContent =
        `Rebuilt: ${result.filesProcessed} file(s), ${result.totalChunks} blocks total.`;
      rebuildProgressWrap.style.display = 'none';
      refreshDocuments();
    } catch (err) {
      rebuildError.textContent = err.message;
      rebuildError.style.display = 'block';
      rebuildProgressWrap.style.display = 'none';
    } finally {
      rebuildIndexBtn.disabled = false;
    }
  });

  embedForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    embedError.style.display = 'none';
    embedResult.style.display = 'none';

    const workspaceId = requireWorkspace(embedError);
    if (!workspaceId) return;

    const fileInput = document.getElementById('pdfFile');
    const file = fileInput.files[0];
    if (!file) {
      embedError.textContent = 'Choose a file first.';
      embedError.style.display = 'block';
      return;
    }

    // Same "blank/non-numeric field means let the server default
    // apply" convention as temperature below, for the same reason: an
    // empty string sent as-is would either be silently coerced to a
    // useless 0 or rejected, neither of which is "no opinion, just use
    // chunker.js's default."
    const readOptionalPositiveInt = (id) => {
      const raw = document.getElementById(id).value;
      return raw === '' || Number.isNaN(Number(raw)) ? undefined : Number(raw);
    };
    const maxWords = readOptionalPositiveInt('maxWords');
    const overlapWords = readOptionalPositiveInt('overlapWords');

    embedSubmitBtn.disabled = true;
    embedProgressWrap.style.display = 'block';
    embedProgressBar.removeAttribute('value'); // indeterminate until "start" arrives
    embedStatus.textContent = 'Uploading and extracting text…';

    try {
      const result = await embedWithProgress(workspaceId, file, maxWords, overlapWords, (event) => {
        if (event.type === 'start') {
          embedProgressBar.max = event.totalChunks;
          embedProgressBar.value = 0;
          // numPages is null for file types without a real page count
          // (.docx, .txt) — only PDFs have one.
          const pageInfo = event.numPages != null ? ` (${event.numPages} pages)` : '';
          embedStatus.textContent =
            `Importing "${event.sourceFile}"${pageInfo}: 0 / ${event.totalChunks} blocks`;
        } else if (event.type === 'progress') {
          embedProgressBar.value = event.chunksEmbedded;
          const pct = Math.round((event.chunksEmbedded / event.totalChunks) * 100);
          embedStatus.textContent =
            `Importing: ${event.chunksEmbedded} / ${event.totalChunks} blocks (${pct}%)`;
        }
      });

      const resultPageInfo = result.numPages != null ? ` (${result.numPages} pages)` : '';
      embedResult.textContent =
        `Imported ${result.chunksEmbedded} blocks from "${result.originalName}"${resultPageInfo} ` +
        `into "${result.workspaceId}". ` +
        `This area now has ${result.totalStored} blocks total.`;
      embedResult.style.display = 'block';
      embedStatus.textContent = '';
      fileInput.value = '';
      refreshWorkspaces();
      refreshDocuments();
    } catch (err) {
      embedError.textContent = err.message;
      embedError.style.display = 'block';
      embedStatus.textContent = '';
    } finally {
      embedSubmitBtn.disabled = false;
      embedProgressWrap.style.display = 'none';
    }
  });

  chunkModalClose.addEventListener('click', closeChunkModal);
  chunkModalBackdrop.addEventListener('click', (e) => {
    if (e.target === chunkModalBackdrop) closeChunkModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chunkModalBackdrop.classList.contains('open')) closeChunkModal();
  });

  // ---- Rubric Control ----

  rubricAddAttributeBtn.addEventListener('click', () => addRubricAttributeRow());

  rubricForm.addEventListener('submit', submitRubricForm);

  rubricCancelEditBtn.addEventListener('click', () => resetRubricForm());

  // One delegated listener handles every row's Edit/Delete buttons,
  // same pattern documentsBody's Remove buttons use above — no need
  // to re-attach a handler after each refreshRubricTopics() rebuild.
  rubricTopicsBody.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.rubric-edit-btn');
    if (editBtn) {
      loadRubricTopicForEdit(editBtn.dataset.id);
      return;
    }

    const deleteBtn = e.target.closest('.rubric-delete-btn');
    if (deleteBtn) {
      const topicId = deleteBtn.dataset.id;
      if (!confirm(`Permanently delete the topic "${topicId}"? This cannot be undone.`)) return;

      deleteBtn.disabled = true;
      rubricTopicsError.style.display = 'none';
      try {
        const res = await fetch(`/ideal-proposals/${encodeURIComponent(topicId)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to delete topic');

        // If the topic just deleted was mid-edit in the form, drop
        // back to "add a new topic" rather than leaving a dangling
        // edit-in-progress for something that no longer exists.
        if (rubricEditingTopicId === topicId) resetRubricForm();

        refreshRubricTopics();
        refreshIdealTopics();
      } catch (err) {
        rubricTopicsError.textContent = err.message;
        rubricTopicsError.style.display = 'block';
        deleteBtn.disabled = false;
      }
    }
  });

  rubricXlsxFile.addEventListener('change', () => {
    const file = rubricXlsxFile.files && rubricXlsxFile.files[0];
    if (!file) return;
    rubricXlsxSelectedFile = file;
    inspectRubricXlsxFile(file);
  });

  rubricXlsxImportBtn.addEventListener('click', () => importRubricXlsxAttributes());

  // Same shared delegate on both the main sources table and the
  // per-attribute results table's Sources column — see
  // wireChunkLinkDelegate()'s doc comment above.
  wireChunkLinkDelegate(sourcesBody);
  wireChunkLinkDelegate(attributeResultsBody);

  downloadCsvBtn.addEventListener('click', () => {
    const hasRecords = latestBatches.some((b) => b.records && b.records.length);
    if (!hasRecords) return; // shouldn't be clickable when there's nothing to export, but guard anyway
    const csv = buildAttributeResultsCsv(latestBatches);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const workspaceId = getWorkspaceId() || 'results';
    a.download = `${workspaceId}-comparison.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    errorEl.style.display = 'none';
    resultEl.style.display = 'none';
    sourcesBody.innerHTML = '';
    confidenceNote.textContent = '';
    tokenUsageNote.textContent = '';
    retrievalQueryNote.innerHTML = '';
    answerEl.textContent = '';
    lengthNote.style.display = 'none';
    lengthNote.textContent = '';
    elapsedTimeEl.textContent = '';
    reasoningEl.textContent = '';
    reasoningWrap.style.display = 'none';
    reasoningWrap.open = false; // collapsed by default each new query, regardless of whether it was left open last time
    latestBatches = [];
    attributeResultsBody.innerHTML = '';
    attributeResultsWrap.style.display = 'none';
    // The answer section specifically is forced open for every new
    // query — see initSectionToggle()'s doc comment above for why this
    // doesn't clobber someone's own stored preference for next time.
    answerToggle.forceOpen();

    const workspaceId = requireWorkspace(errorEl);
    if (!workspaceId) return;

    const question = document.getElementById('question').value.trim();
    const topK = Number(document.getElementById('topK').value) || 5;
    const threshold = Number(document.getElementById('threshold').value) || 0;
    const chatModel = chatModelSelect.value || undefined;
    // Unlike topK/threshold, 0 is a meaningful, valid temperature (as
    // deterministic as the model gets) — so this can't fall back to a
    // default with `|| ...` the way those do, since `0 || x` would
    // wrongly become x. An empty or non-numeric field instead becomes
    // undefined, which omits the key from the request body and lets
    // the server's own default apply.
    const rawTemperature = document.getElementById('temperature').value;
    const temperature = rawTemperature === '' || Number.isNaN(Number(rawTemperature))
      ? undefined
      : Number(rawTemperature);
    // Blank is the normal state here (no placeholder value to fall
    // back on) and means exactly what it looks like: no cap.
    const rawMaxTokens = document.getElementById('maxTokens').value;
    const maxTokens = rawMaxTokens === '' || Number.isNaN(Number(rawMaxTokens))
      ? undefined
      : Number(rawMaxTokens);
    // Same blank-means-omit convention as maxTokens above: an empty
    // field lets the model's own default context window apply,
    // rather than this app silently picking a number on your behalf.
    const rawNumCtx = document.getElementById('numCtx').value;
    const numCtx = rawNumCtx === '' || Number.isNaN(Number(rawNumCtx))
      ? undefined
      : Number(rawNumCtx);
    // Same blank-means-omit convention as maxTokens/numCtx above: an
    // empty field leaves Ollama's own repeat_penalty default (usually
    // 1.1) in place, rather than this app silently picking a value.
    const rawRepeatPenalty = document.getElementById('repeatPenalty').value;
    const repeatPenalty = rawRepeatPenalty === '' || Number.isNaN(Number(rawRepeatPenalty))
      ? undefined
      : Number(rawRepeatPenalty);
    const idealTopicId = idealTopicSelect.value || undefined;
    // Same blank-means-omit convention as maxTokens/numCtx above: left
    // blank, every attribute of the selected topic goes into a single
    // call, exactly as before this setting existed. Only matters when
    // idealTopicId is also set — see batchAttributes() in
    // src/idealProposals.js.
    const rawAttributesPerCall = document.getElementById('attributesPerCall').value;
    const attributesPerCall = rawAttributesPerCall === '' || Number.isNaN(Number(rawAttributesPerCall))
      ? undefined
      : Number(rawAttributesPerCall);
    // Checked (the default) omits `think` entirely, leaving Ollama's
    // own default in place (thinking on, for models that support it) —
    // unchecked explicitly requests `think: false`. See the think
    // param doc on queryWithStream() above and chat() in
    // ollamaClient.js for why "checked" isn't the same as sending
    // `think: true` — there's no need to, and omitting is more honest
    // about what this checkbox actually controls (not overriding vs.
    // overriding).
    const think = thinkCheckbox.checked ? undefined : false;

    // The question textarea is no longer `required` in the markup,
    // since a selected topic is enough on its own — see
    // composeComparisonQuestion() in src/idealProposals.js, which
    // builds a full question from the topic even with none typed here.
    // So this has to be checked explicitly now, with a visible error,
    // rather than relying on the browser to block submission.
    if (!question && !idealTopicId) {
      errorEl.textContent = 'Enter a question, or select an ideal-proposal topic to compare against.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    stopBtn.disabled = false;
    statusEl.textContent = 'Searching your documents…';

    // Started here, right as the request actually begins, so it
    // measures the same "time to final answer" a person watching the
    // Ask button experiences — including the retrieval step before any
    // token arrives, not just the generation step. Runs the whole time
    // this request is in flight, live-updating elapsedTimeEl, and gets
    // stopped in the `finally` block below no matter how the request
    // ends (success, error, or Stop) — see that block for why `finally`
    // is the right place rather than tying this to some other
    // in-between event.
    queryStartTime = performance.now();
    elapsedTimeEl.textContent = formatElapsedMs(0);
    queryTimerHandle = setInterval(() => {
      elapsedTimeEl.textContent = formatElapsedMs(performance.now() - queryStartTime);
    }, 100);

    let gotAnyToken = false;
    let gotAnyThinking = false;
    const controller = new AbortController();
    currentQueryController = controller;

    // Accumulates sources across every batch (keyed by chunk id, or a
    // fallback key when one's missing) rather than replacing the table
    // each batch, so a multi-batch comparison ends up showing the full
    // set of evidence used across all of them, not just whichever
    // batch happened to run last. Kept to the higher of two scores if
    // the same block is retrieved by more than one batch.
    const sourcesById = new Map();
    const addSources = (sources) => {
      for (const s of sources) {
        const key = s.id || `${s.sourceFile}::${s.chunkIndex}`;
        const existing = sourcesById.get(key);
        if (!existing || s.score > existing.score) sourcesById.set(key, s);
      }
      renderSources(Array.from(sourcesById.values()), threshold, topK);
    };

    // Batching status phrasing only mentions batches at all once
    // there's more than one — a plain question or a comparison left at
    // "all" attributes per call never shows "batch 1 of 1" noise.
    const batchSuffix = (event) =>
      event.totalBatches && event.totalBatches > 1 ? ` (batch ${event.batchIndex + 1} of ${event.totalBatches})` : '';

    try {
      const finalEvent = await queryWithStream(workspaceId, question, topK, chatModel, temperature, maxTokens, numCtx, repeatPenalty, idealTopicId, attributesPerCall, think, (event) => {
        if (event.type === 'sources') {
          // Retrieval is fast — this fires almost immediately, well
          // before the answer is ready, so the sources table (and the
          // confidence-threshold coloring) shows up right away instead
          // of waiting on generation too.
          //
          // A separator is inserted into the answer box right here,
          // just before a second-or-later batch's tokens start
          // arriving, so each batch's text is visually set apart
          // instead of running straight into the previous batch's.
          if (event.batchIndex > 0 && answerEl.textContent) {
            answerEl.textContent += '\n\n———\n\n';
          }
          addSources(event.sources);

          // Shows exactly what text was embedded to retrieve this
          // batch's sources — the fastest way to check, directly in
          // the UI, whether a comparison run and a plain question that
          // "should" retrieve the same way are actually searching with
          // the same text. See the "sources" event's retrievalQuery
          // field in index.js and composeRetrievalQuery() in
          // src/idealProposals.js. One line per batch, in case
          // different batches (different attribute subsets) searched
          // with different text.
          if (event.retrievalQuery) {
            const label = event.totalBatches && event.totalBatches > 1
              ? `Retrieval query used (batch ${event.batchIndex + 1} of ${event.totalBatches}): `
              : 'Retrieval query used: ';
            const line = `<strong>${escapeHtml(label)}</strong>${escapeHtml(event.retrievalQuery)}`;
            retrievalQueryNote.innerHTML = retrievalQueryNote.innerHTML
              ? `${retrievalQueryNote.innerHTML}<br>${line}`
              : line;
          }
          if (event.sources.length) {
            statusEl.textContent = `Generating answer…${batchSuffix(event)}`;
            // There's an unavoidable gap here — however long the model
            // takes to produce its first fragment — with no percentage
            // to show (we don't know the answer's eventual length), so
            // this is an indeterminate bar: not "X% done," just "still
            // alive, still working." It's for that gap specifically;
            // once real text (thinking or the answer itself) starts
            // appearing below, that's a stronger liveness signal than
            // any bar, so it disappears then.
            queryProgressWrap.style.display = 'block';
          } else {
            statusEl.textContent = '';
          }
        } else if (event.type === 'thinking') {
          // Reasoning models stream their chain-of-thought separately
          // from, and before, the actual answer — collected here into
          // the collapsible section above the answer, collapsed by
          // default (see #reasoningWrap's CSS) so it's available
          // without taking up space unless someone opens it.
          gotAnyThinking = true;
          queryProgressWrap.style.display = 'none';
          statusEl.textContent = `Model is thinking…${batchSuffix(event)}`;
          reasoningWrap.style.display = 'block';
          reasoningEl.textContent += event.text;
        } else if (event.type === 'token') {
          // Live "typing" effect: each fragment Ollama generates gets
          // appended as it arrives, instead of the answer box staying
          // blank until everything is done.
          gotAnyToken = true;
          queryProgressWrap.style.display = 'none';
          statusEl.textContent = `Generating answer…${batchSuffix(event)}`;
          answerEl.textContent += event.text;
          resultEl.style.display = 'block';
        } else if (event.type === 'batch-done') {
          // Parsed per-attribute rows for this batch (see
          // parseComparisonAnswer() in src/responseParser.js) — appended
          // and re-rendered immediately, rather than waiting for every
          // batch to finish, so the results table (and what the Download
          // CSV button would export) grows the same way the answer text
          // above it does. Empty for a plain document question or for a
          // batch that had no attributes.
          latestBatches.push({
            batchIndex: event.batchIndex,
            totalBatches: event.totalBatches,
            records: event.records || [],
            sources: event.sources || [],
            promptTokens: event.promptTokens,
            answerTokens: event.answerTokens,
            doneReason: event.doneReason,
          });
          renderAttributeResults(latestBatches, numCtx, threshold);
        }
      }, controller.signal);

      // Covers the "no documents embedded yet" case: "done" fires with
      // a ready-made answer and no sources/tokens were ever streamed.
      if (!gotAnyToken) {
        answerEl.textContent = finalEvent.answer;
        renderSources(finalEvent.sources || [], threshold, topK);
      }

      // Fallback for the unlikely case where "done" carries records
      // that "batch-done" handling above somehow missed (e.g. an
      // older/differently-behaving server) — never double-counts,
      // since it only fills in when nothing was accumulated already.
      if (!latestBatches.length && finalEvent.records && finalEvent.records.length) {
        latestBatches = [{
          batchIndex: 0,
          totalBatches: finalEvent.totalBatches || 1,
          records: finalEvent.records,
          sources: finalEvent.sources || [],
          promptTokens: finalEvent.promptTokens,
          answerTokens: finalEvent.answerTokens,
          doneReason: finalEvent.doneReason,
        }];
        renderAttributeResults(latestBatches, numCtx, threshold);
      }

      // doneReason "length" means Ollama cut generation short instead of
      // reaching a natural stop — but that has two possible causes that
      // look identical from here, so distinguish them using whatever
      // this request itself sent: if maxTokens was set, that's almost
      // certainly why (working as configured); if it was left blank
      // ("no limit" — nothing was sent), the far more likely explanation
      // is the model's context window (Request size, if set — otherwise
      // its own default) being exhausted by the prompt + retrieved
      // chunks + answer combined, which isn't the same thing as
      // maxTokens at all.
      if (finalEvent.doneReason === 'length') {
        lengthNote.textContent = maxTokens !== undefined
          ? `Cut off at the answer length limit you set. Raise or clear "Max answer length" in Advanced settings for a longer answer.`
          : 'Cut off before finishing, even with no answer length limit set — this usually means the AI ran out of room to work with. Try raising "Request size" in Advanced settings, or lowering "Blocks to search" to leave more room for the answer within the room it already has.';
        lengthNote.style.display = 'block';
      }

      renderTokenUsage(finalEvent.promptTokens, finalEvent.answerTokens, numCtx, finalEvent.totalBatches);

      statusEl.textContent = '';
      queryProgressWrap.style.display = 'none';
    } catch (err) {
      if (err.name === 'AbortError') {
        // Stopped via stopBtn below — not an error, so no red error
        // box. Whatever partial answer (and partial reasoning) had
        // already streamed in is deliberately left in place rather
        // than cleared, same as Claude Desktop keeps a partial
        // response after Stop.
        if (gotAnyToken) {
          statusEl.textContent = 'Stopped — the partial answer above is everything Ollama had generated so far.';
        } else if (gotAnyThinking) {
          // A real, distinct case worth its own message: the model was
          // still working through its reasoning and never got to an
          // actual answer — otherwise this would look identical to
          // "stopped before anything happened at all," which it isn't.
          // Auto-expand the reasoning section here specifically, since
          // it's the only content this request actually produced — no
          // reason to make someone click to find that out.
          reasoningWrap.open = true;
          statusEl.textContent = 'Stopped while the model was still thinking — no answer was generated. See the reasoning above for what it had worked through so far.';
        } else {
          statusEl.textContent = 'Stopped before an answer was generated.';
        }
      } else {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        statusEl.textContent = '';
      }
      queryProgressWrap.style.display = 'none';
    } finally {
      submitBtn.disabled = false;
      stopBtn.disabled = true;
      currentQueryController = null;
      // Stop the live clock and render its final value — runs for
      // every way this request can end (success, error, or Stop), so
      // the displayed time is always "how long until this request
      // actually settled," not just "how long until the answer
      // started." One last render here rather than trusting the most
      // recent 100ms-interval tick, since that tick could be up to
      // 100ms stale by the time execution actually reaches here.
      clearInterval(queryTimerHandle);
      queryTimerHandle = null;
      elapsedTimeEl.textContent = formatElapsedMs(performance.now() - queryStartTime);
    }
  });

  // stopBtn only aborts the browser's own fetch — but /query/stream on
  // the server is listening for exactly that disconnect (via Express's
  // res.on('close', ...)) and uses it to cancel its own in-flight
  // request to Ollama, so this actually halts generation server-side,
  // not just this tab's view of it. See the comment on that route in
  // index.js.
  stopBtn.addEventListener('click', () => {
    if (!currentQueryController) return;
    stopBtn.disabled = true; // avoid double-clicks while the abort is still settling
    statusEl.textContent = 'Stopping…';
    currentQueryController.abort();
  });

  // ---- Initial data loads ----

  applyConfig();
  refreshWorkspaces();
  refreshModels();
  refreshIdealTopics();
  resetRubricForm();
  refreshRubricTopics();
}
