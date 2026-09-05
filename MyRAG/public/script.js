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

// Shows what's actually embedded (grouped by source filename) in
// whatever workspace is currently entered above, with a Remove
// button per document. Also doubles as the easiest way to spot an
// accidental duplicate embed: the same document showing roughly
// double its usual chunk count is that happening.
async function refreshDocuments() {
  const id = getWorkspaceId();
  if (!id) {
    documentsWrap.style.display = 'none';
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
  } catch (err) {
    // Non-fatal — an invalid/incomplete workspace name typed
    // mid-edit will 400 here transiently, which is fine; just hide
    // the section rather than showing an error for that.
    console.warn('Could not load documents:', err);
    documentsWrap.style.display = 'none';
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

let form, statusEl, errorEl, resultEl, answerEl, lengthNote, sourcesBody, confidenceNote;
let submitBtn, stopBtn, elapsedTimeEl, queryProgressWrap;
let thinkCheckbox, reasoningWrap, reasoningEl;

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

// The threshold is a purely client-side display filter: the server
// always returns its topK closest chunks regardless of how weak the
// match is (this is intentional — see /query in index.js). This UI
// is what decides, for display purposes, which of those returned
// chunks are worth calling "confident" matches versus noise the
// model was still handed as context. It doesn't change what the
// model saw, only how we label the sources here.
function renderSources(sources, threshold) {
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
    `;
    sourcesBody.appendChild(tr);
  }

  resultEl.style.display = 'block';
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
 * @param {AbortSignal} [signal] - wired to stopBtn in init(). Aborting
 *   this closes the fetch, which the /query/stream route on the
 *   server notices (via Express's `res.on('close', ...)`) and uses
 *   to cancel its own in-flight request to Ollama — so Stop actually
 *   halts generation server-side, not just this tab's display of it.
 *   When aborted, this function rejects with an AbortError (the
 *   fetch spec's own name for it) rather than the usual thrown
 *   Error; the caller below checks err.name to tell the two apart.
 */
async function queryWithStream(workspaceId, question, topK, chatModel, temperature, maxTokens, idealTopicId, think, onEvent, signal) {
  const res = await fetch('/query/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // chatModel/temperature/maxTokens/idealTopicId/think undefined
    // (nothing usable selected, or the field was cleared) just omits
    // that key from the JSON body entirely, and /query/stream's own
    // default takes over server-side — for maxTokens that's "no
    // cap," for idealTopicId that's "answer normally, no
    // comparison," for think that's "leave Ollama's own default
    // alone" (see the think param doc above).
    body: JSON.stringify({ question, workspaceId, topK, chatModel, temperature, maxTokens, idealTopicId, think }),
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
  submitBtn = document.getElementById('submitBtn');
  stopBtn = document.getElementById('stopBtn');
  elapsedTimeEl = document.getElementById('elapsedTime');
  queryProgressWrap = document.getElementById('queryProgressWrap');
  thinkCheckbox = document.getElementById('thinkEnabled');
  reasoningWrap = document.getElementById('reasoningWrap');
  reasoningEl = document.getElementById('reasoningEl');

  chunkModalBackdrop = document.getElementById('chunkModalBackdrop');
  chunkModalTitle = document.getElementById('chunkModalTitle');
  chunkModalSubtitle = document.getElementById('chunkModalSubtitle');
  chunkModalBody = document.getElementById('chunkModalBody');
  chunkModalClose = document.getElementById('chunkModalClose');

  // ---- Event listeners ----

  // Debounced on typing (rather than firing on every keystroke), and
  // also handles picking a suggestion from the workspace datalist,
  // since selecting one fires an "input" event too.
  workspaceInput.addEventListener('input', () => {
    clearTimeout(documentsDebounce);
    documentsDebounce = setTimeout(refreshDocuments, 400);
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

  // One delegated listener on the sources table body, same pattern as
  // documentsBody's Remove-button handler above — handles every chunk
  // link, including ones added by later queries, with no per-row
  // re-attachment needed.
  sourcesBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.chunk-link');
    if (!btn) return;

    const chunkId = btn.dataset.chunkId;
    const sourceFile = btn.dataset.sourceFile;
    const chunkIndex = btn.dataset.chunkIndex;
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
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    errorEl.style.display = 'none';
    resultEl.style.display = 'none';
    sourcesBody.innerHTML = '';
    confidenceNote.textContent = '';
    answerEl.textContent = '';
    lengthNote.style.display = 'none';
    lengthNote.textContent = '';
    elapsedTimeEl.textContent = '';
    reasoningEl.textContent = '';
    reasoningWrap.style.display = 'none';
    reasoningWrap.open = false; // collapsed by default each new query, regardless of whether it was left open last time

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
    const idealTopicId = idealTopicSelect.value || undefined;
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

    try {
      const finalEvent = await queryWithStream(workspaceId, question, topK, chatModel, temperature, maxTokens, idealTopicId, think, (event) => {
        if (event.type === 'sources') {
          // Retrieval is fast — this fires almost immediately, well
          // before the answer is ready, so the sources table (and the
          // confidence-threshold coloring) shows up right away instead
          // of waiting on generation too.
          renderSources(event.sources, threshold);
          if (event.sources.length) {
            statusEl.textContent = 'Generating answer…';
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
          statusEl.textContent = 'Model is thinking…';
          reasoningWrap.style.display = 'block';
          reasoningEl.textContent += event.text;
        } else if (event.type === 'token') {
          // Live "typing" effect: each fragment Ollama generates gets
          // appended as it arrives, instead of the answer box staying
          // blank until everything is done.
          gotAnyToken = true;
          queryProgressWrap.style.display = 'none';
          statusEl.textContent = 'Generating answer…';
          answerEl.textContent += event.text;
          resultEl.style.display = 'block';
        }
      }, controller.signal);

      // Covers the "no documents embedded yet" case: "done" fires with
      // a ready-made answer and no sources/tokens were ever streamed.
      if (!gotAnyToken) {
        answerEl.textContent = finalEvent.answer;
        renderSources(finalEvent.sources || [], threshold);
      }

      // doneReason "length" means Ollama cut generation short instead of
      // reaching a natural stop — but that has two possible causes that
      // look identical from here, so distinguish them using whatever
      // this request itself sent: if maxTokens was set, that's almost
      // certainly why (working as configured); if it was left blank
      // ("no limit" — nothing was sent), the far more likely explanation
      // is Ollama's own num_ctx context-window ceiling being exhausted
      // by the prompt + retrieved chunks + answer combined, which this
      // app doesn't set and isn't the same thing as maxTokens at all.
      if (finalEvent.doneReason === 'length') {
        lengthNote.textContent = maxTokens !== undefined
          ? `Cut off at the answer length limit you set. Raise or clear "Max answer length" in Advanced settings for a longer answer.`
          : 'Cut off before finishing, even with no answer length limit set — this usually means the AI ran out of room to work with. Try lowering "Blocks to search" in Advanced settings to leave more room for the answer.';
        lengthNote.style.display = 'block';
      }

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
}
