/**
 * "Best Practices Comparison" tab — ALL of this tab's behavior lives in
 * this one file, deliberately kept separate from script.js's monolith
 * per an explicit request: this tab should stay "very separate from
 * all of the other functionality." Concretely that means:
 *
 *   - This file defines its own DOM lookups, its own fetch/streaming
 *     loop against POST /query/stream, and its own results renderer.
 *     It does NOT call queryWithStream() or renderAttributeResults(),
 *     and keeps its own entirely separate batch-accumulator array
 *     (this file's own `latestBatches`, not script.js's module-level
 *     one of the same name — two different variables in two different
 *     closures that happen to share a name).
 *   - The CSV/HTML export buttons below DO call buildAttributeResultsCsv()
 *     and buildAttributeResultsHtml() — but those are plain top-level
 *     `function` declarations in script.js/reportHtml.js, which makes
 *     them `window.*` globals in a classic <script> page exactly like
 *     any browser global (same mechanism jQuery or any other
 *     non-module script relies on) — not a call into script.js's own
 *     closed-over state or UI logic. reportHtml.js's own doc comment
 *     explains why it's written this way on purpose: src/emailNotify.js
 *     already requires those same functions from Node for the
 *     completion-email attachment, so they're deliberately
 *     self-contained, DOM-free, reusable-from-anywhere utilities, not
 *     script.js internals — reusing them here is exactly the reuse
 *     they're designed for, not an exception to this file's isolation.
 *   - The pieces of shared app state this file reads are the
 *     storage-area name typed into the global #workspace input at the
 *     top of the page, and the Query and Response tab's own #chatModel
 *     dropdown (see index.html) — every workspace-scoped tab already
 *     shares #workspace, and #chatModel is read for the same reason:
 *     it's the one place in the whole app where a chat model is
 *     chosen, so re-reading its current value here (rather than
 *     silently defaulting to whatever chat()'s own hardcoded fallback
 *     is server-side -- see src/ollamaClient.js) means a Best
 *     Practices run always uses whatever model you most recently
 *     picked for Query and Response, even if you never visit that tab
 *     again this session (the dropdown's selection persists in the DOM
 *     across tab switches -- see TAB_IDS' doc comment in script.js).
 *     Nothing here ever writes to either field, and nothing here calls
 *     a script.js FUNCTION -- these are two plain DOM reads of shared
 *     page state, same category as any other tab sharing #workspace.
 *   - The only touch outside this file is registering the tab id
 *     itself ('bestPractices') in script.js's TAB_IDS/TAB_LABELS, so
 *     the existing hamburger-menu/tab-switching machinery knows this
 *     panel exists — see that file's own comment at the point of the
 *     change for why that one small touch couldn't be avoided.
 *
 * Backend contract (see index.js and src/bestPractices.js /
 * src/bestPracticesFilter.js):
 *   - GET /best-practices/filters -> { hazards: string[], states: string[] }
 *     populated straight from whatever bestPractices.json actually
 *     contains (empty arrays, or a 500, if that file hasn't been
 *     generated yet on this install — handled below as "feature
 *     unavailable," not a hard error).
 *   - POST /query/stream with { workspaceId, bestPracticesFilter:
 *     {hazard, state?}, attributesPerCall } reuses the EXACT SAME
 *     comparison engine Rubric Control's idealTopicId path already
 *     runs through server-side (see buildBestPracticesTopic() in
 *     index.js) — this file just has to speak the same ndjson stream
 *     protocol /query/stream always speaks: a "sources" event per
 *     batch, then a "batch-done" event per batch (carrying that
 *     batch's {name, proposal, resultText, category} records), then
 *     one final "done" event, or an "error" event at any point.
 */

(function () {
  let hazardSelect, stateSelect, attributesPerCallInput;
  let compareBtn, stopBtn;
  let statusEl, progressWrap, progressBar, errorEl;
  let resultWrap, resultSummaryEl, resultsBody;
  let chatModelNoteEl;
  let downloadCsvBtn, downloadHtmlBtn;

  let abortController = null;
  let rowsRendered = 0;
  // Same shape per entry as script.js's own latestBatches — see
  // buildAttributeResultsCsv()/buildAttributeResultsHtml()'s own doc
  // comments for exactly what each one reads — accumulated the same
  // way, batch by batch, purely so the two export buttons below have
  // something to hand those shared functions. Reset at the start of
  // every run; never read by anything except the two export handlers.
  let latestBatches = [];
  // performance.now() at the start of the run currently in flight (or
  // the most recently finished one) and the elapsed-ms it produced —
  // same purpose as script.js's queryStartTime/lastRunElapsedMs, kept
  // here instead so Export HTML's "Run time" row has something to show
  // for a Best Practices run specifically.
  let runStartedAt = null;
  let lastElapsedMs = null;

  /**
   * Reads the shared storage-area field — see this file's own doc
   * comment above for why this single read is fine.
   * @returns {string}
   */
  function getWorkspaceId() {
    const input = document.getElementById('workspace');
    return input ? input.value.trim() : '';
  }

  /**
   * Reads the Query and Response tab's #chatModel dropdown directly —
   * see this file's own doc comment above for why. Returns undefined
   * (rather than '') when that select doesn't exist, hasn't loaded its
   * options yet, or is showing a disabled placeholder option (no
   * models found / failed to load — see refreshModels() in script.js),
   * so the request body omits `chatModel` entirely in those cases and
   * the server falls back to its own default exactly as if this tab
   * had never read the field at all, rather than sending an empty
   * string that would mean something different.
   * @returns {string|undefined}
   */
  function getChatModel() {
    const select = document.getElementById('chatModel');
    if (!select || !select.value) return undefined;
    const selectedOption = select.options[select.selectedIndex];
    if (selectedOption && selectedOption.disabled) return undefined;
    return select.value;
  }

  /**
   * Keeps the read-only "Chat model: ..." line on this panel in sync
   * with the Query and Response tab's dropdown. Called on init, on
   * that dropdown's own 'change' event, whenever its option list is
   * rebuilt by refreshModels() in script.js (via the MutationObserver
   * set up in initBestPracticesTab() below — refreshModels() populates
   * the list programmatically, which never fires 'change'), and
   * whenever this tab is opened from the hamburger menu, so the note
   * is accurate however the selection most recently changed.
   */
  function refreshChatModelNote() {
    if (!chatModelNoteEl) return;
    const model = getChatModel();
    chatModelNoteEl.textContent = model
      ? `Chat model: ${model} (set on the Query and Response tab)`
      : 'Chat model: not yet loaded (set on the Query and Response tab) — using the server default for now.';
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = message ? 'block' : 'none';
  }

  function setRunning(running) {
    compareBtn.disabled = running;
    stopBtn.style.display = running ? '' : 'none';
    hazardSelect.disabled = running;
    stateSelect.disabled = running;
    attributesPerCallInput.disabled = running;
    progressWrap.style.display = running ? '' : 'none';
    // Exporting mid-run would just export whatever's accumulated so
    // far, frozen at a moment that's about to change — simplest to
    // disable both until the run settles, same as the Hazard/State
    // controls above.
    downloadCsvBtn.disabled = running;
    downloadHtmlBtn.disabled = running;
  }

  /**
   * Populates the Hazard/State dropdowns from GET /best-practices/filters.
   * An empty hazards list (missing or empty bestPractices.json — see
   * loadBestPracticeAttributes()'s own doc comment in
   * src/bestPractices.js) is treated as "this feature isn't set up on
   * this install yet," not an error: the tab stays visible but
   * explains itself and disables Compare, rather than showing a
   * confusing empty dropdown a click does nothing useful with.
   */
  async function loadFilters() {
    hazardSelect.innerHTML = '<option value="">Loading hazards...</option>';
    stateSelect.innerHTML = '<option value="">All states</option>';

    try {
      const res = await fetch('/best-practices/filters');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Best Practices filters');

      const hazards = data.hazards || [];
      const states = data.states || [];

      if (hazards.length === 0) {
        hazardSelect.innerHTML = '<option value="">(none available)</option>';
        compareBtn.disabled = true;
        showError(
          'No Best Practices data is loaded on this server yet -- ' +
          'bestPractices.json is missing or empty. Generate it with ' +
          'best_practices_to_json.py and place it at the project root, ' +
          'then reload this page.'
        );
        return;
      }

      hazardSelect.innerHTML = '<option value="">Select a hazard...</option>';
      for (const hazard of hazards) {
        const opt = document.createElement('option');
        opt.value = hazard;
        opt.textContent = hazard;
        hazardSelect.appendChild(opt);
      }

      for (const state of states) {
        const opt = document.createElement('option');
        opt.value = state;
        opt.textContent = state;
        stateSelect.appendChild(opt);
      }

      compareBtn.disabled = false;
      showError('');
    } catch (err) {
      hazardSelect.innerHTML = '<option value="">(failed to load)</option>';
      compareBtn.disabled = true;
      showError(`Could not load Best Practices filters: ${err.message}`);
    }
  }

  /**
   * Appends one batch's worth of comparison records to the results
   * table as soon as that batch finishes -- streamed in progressively
   * rather than held until the very end, since a hazard with a lot of
   * matching entries (see best_practices_to_json.py's "Cross Cutting:
   * 288 entries" stats this feature was sized against) means a run can
   * legitimately take a while, batch by batch.
   * @param {Array<{name: string, proposal: string, resultText: string, category: string}>} records
   * @param {Array<{sourceFile: string, chunkIndex: number}>} sources
   */
  function appendRecords(records, sources) {
    const sourceText = (sources || [])
      .map((s) => `${s.sourceFile} #${s.chunkIndex}`)
      .join(', ');

    for (const record of records) {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = record.name;
      tr.appendChild(nameTd);

      const categoryTd = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'bp-category-badge';
      badge.textContent = record.category || '(unparsed)';
      categoryTd.appendChild(badge);
      tr.appendChild(categoryTd);

      const resultTd = document.createElement('td');
      resultTd.textContent = record.resultText || '';
      tr.appendChild(resultTd);

      const sourcesTd = document.createElement('td');
      sourcesTd.textContent = sourceText;
      sourcesTd.className = 'bp-sources-cell';
      tr.appendChild(sourcesTd);

      resultsBody.appendChild(tr);
      rowsRendered += 1;
    }

    resultWrap.style.display = rowsRendered > 0 ? '' : 'none';
  }

  /**
   * Runs one Best Practices comparison end to end: validates the
   * shared workspace field and the Hazard dropdown, then speaks
   * /query/stream's ndjson protocol directly (see this file's own doc
   * comment for why this isn't routed through script.js's
   * queryWithStream()).
   */
  async function runComparison() {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) {
      showError('Enter or pick a storage area name above first.');
      return;
    }

    const hazard = hazardSelect.value;
    if (!hazard) {
      showError('Pick a hazard first.');
      return;
    }
    const state = stateSelect.value || undefined;

    const rawAttributesPerCall = parseInt(attributesPerCallInput.value, 10);
    const attributesPerCall = Number.isFinite(rawAttributesPerCall) && rawAttributesPerCall > 0
      ? rawAttributesPerCall
      : 1;

    showError('');
    resultsBody.innerHTML = '';
    rowsRendered = 0;
    latestBatches = [];
    lastElapsedMs = null;
    resultWrap.style.display = 'none';
    resultSummaryEl.textContent = '';
    statusEl.textContent = 'Starting...';
    setRunning(true);

    runStartedAt = performance.now();
    abortController = new AbortController();

    try {
      const res = await fetch('/query/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          bestPracticesFilter: { hazard, state },
          attributesPerCall,
          chatModel: getChatModel(),
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        let message = `Request failed: ${res.status}`;
        try {
          const data = await res.json();
          message = data.error || message;
        } catch {
          // Not JSON -- fall back to the generic message above.
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

          if (event.type === 'sources') {
            statusEl.textContent = `Batch ${event.batchIndex + 1} of ${event.totalBatches}: retrieved, asking the model...`;
          } else if (event.type === 'batch-done') {
            statusEl.textContent = `Batch ${event.batchIndex + 1} of ${event.totalBatches} done.`;
            latestBatches.push({
              batchIndex: event.batchIndex,
              totalBatches: event.totalBatches,
              records: event.records || [],
              sources: event.sources || [],
              promptTokens: event.promptTokens,
              answerTokens: event.answerTokens,
              doneReason: event.doneReason,
            });
            appendRecords(event.records || [], event.sources || []);
          } else if (event.type === 'done' || event.type === 'error') {
            finalEvent = event;
          }
        }
      }

      if (!finalEvent) throw new Error('Server closed the connection before finishing.');
      if (finalEvent.type === 'error') throw new Error(finalEvent.error);

      lastElapsedMs = performance.now() - runStartedAt;
      statusEl.textContent = `Done -- ${rowsRendered} entr${rowsRendered === 1 ? 'y' : 'ies'} compared across ${finalEvent.totalBatches} batch${finalEvent.totalBatches === 1 ? '' : 'es'}.`;
      resultSummaryEl.textContent =
        `Hazard: ${hazard}` + (state ? `, State: ${state}` : ' (all states)') +
        ` -- ${rowsRendered} benchmark entr${rowsRendered === 1 ? 'y' : 'ies'} compared against "${workspaceId}".`;
    } catch (err) {
      if (err.name === 'AbortError') {
        statusEl.textContent = `Stopped after ${rowsRendered} entr${rowsRendered === 1 ? 'y' : 'ies'}.`;
      } else {
        showError(err.message);
        statusEl.textContent = '';
      }
    } finally {
      setRunning(false);
      abortController = null;
    }
  }

  function stopComparison() {
    if (abortController) abortController.abort();
  }

  /**
   * Builds the `meta` object both export functions take — reads every
   * field live from the page at export time (hazard/state/attributes-
   * per-call/chat-model/workspace/app name), same "don't bother
   * threading a separate settings object through the whole run just
   * for this" convention script.js's own downloadHtmlBtn handler uses.
   * `topicLabel` is the one deliberate rename: there's no literal
   * "ideal-proposal topic" in a Best Practices run, so this describes
   * the hazard/state filter instead -- reportHtml.js's meta row is
   * still labeled "Ideal-proposal topic" either way (that label lives
   * in the shared report builder, used by three call sites, so it's
   * not changed here), but the VALUE shown next to it is always
   * accurate for what actually ran.
   * @returns {Object}
   */
  function buildExportMeta() {
    const hazard = hazardSelect.value || undefined;
    const state = stateSelect.value || undefined;
    const rawAttributesPerCall = parseInt(attributesPerCallInput.value, 10);
    const attributesPerCall = Number.isFinite(rawAttributesPerCall) && rawAttributesPerCall > 0
      ? rawAttributesPerCall
      : undefined;
    const appNameEl = document.getElementById('appNameHeading');
    return {
      workspaceId: getWorkspaceId() || undefined,
      topicLabel: hazard
        ? `Best Practices — ${hazard}${state ? ` (${state})` : ' (all states)'}`
        : undefined,
      chatModel: getChatModel(),
      attributesPerCall,
      appName: (appNameEl && appNameEl.textContent.trim()) || undefined,
      elapsedMs: lastElapsedMs != null ? lastElapsedMs : undefined,
    };
  }

  function downloadCsv() {
    if (!latestBatches.some((b) => b.records && b.records.length)) return;
    const csv = buildAttributeResultsCsv(latestBatches);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getWorkspaceId() || 'results'}-best-practices.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadHtmlReport() {
    if (!latestBatches.some((b) => b.records && b.records.length)) return;
    const html = buildAttributeResultsHtml(latestBatches, buildExportMeta());
    const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getWorkspaceId() || 'results'}-best-practices.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function initBestPracticesTab() {
    hazardSelect = document.getElementById('bpHazard');
    stateSelect = document.getElementById('bpState');
    attributesPerCallInput = document.getElementById('bpAttributesPerCall');
    compareBtn = document.getElementById('bpCompareBtn');
    stopBtn = document.getElementById('bpStopBtn');
    statusEl = document.getElementById('bpStatus');
    progressWrap = document.getElementById('bpProgressWrap');
    progressBar = document.getElementById('bpProgressBar');
    errorEl = document.getElementById('bpError');
    resultWrap = document.getElementById('bpResultWrap');
    resultSummaryEl = document.getElementById('bpResultSummary');
    resultsBody = document.getElementById('bpResultsBody');
    chatModelNoteEl = document.getElementById('bpChatModelNote');
    downloadCsvBtn = document.getElementById('bpDownloadCsvBtn');
    downloadHtmlBtn = document.getElementById('bpDownloadHtmlBtn');

    // Any element missing means this page doesn't have the Best
    // Practices panel at all (e.g. an older index.html) -- bail out
    // quietly rather than throwing on a null lookup above.
    if (!hazardSelect || !compareBtn) return;

    compareBtn.addEventListener('click', runComparison);
    stopBtn.addEventListener('click', stopComparison);
    downloadCsvBtn.addEventListener('click', downloadCsv);
    downloadHtmlBtn.addEventListener('click', downloadHtmlReport);

    loadFilters();

    // Keep the "Chat model: ..." note in sync with the Query and
    // Response tab's #chatModel dropdown -- see getChatModel()'s and
    // refreshChatModelNote()'s own doc comments above for why this
    // needs three separate triggers rather than just one.
    refreshChatModelNote();
    const chatModelSelect = document.getElementById('chatModel');
    if (chatModelSelect) {
      chatModelSelect.addEventListener('change', refreshChatModelNote);
      // refreshModels() in script.js rebuilds this select's <option>
      // list programmatically (on page load, and if ever re-run) --
      // that never fires 'change', so this is what actually catches
      // the initial model list showing up shortly after page load.
      new MutationObserver(refreshChatModelNote).observe(chatModelSelect, { childList: true });
    }
    const bestPracticesMenuItem = document.querySelector('.tab-menu-item[data-tab="bestPractices"]');
    if (bestPracticesMenuItem) {
      bestPracticesMenuItem.addEventListener('click', refreshChatModelNote);
    }
  }

  // Exposed the same way script.js's own init() is: called from
  // <body onload="..."> in index.html once the page's markup (and this
  // script, loaded in <head> above it) both exist -- see this file's
  // doc comment for why this is its own call rather than being folded
  // into script.js's init().
  window.initBestPracticesTab = initBestPracticesTab;
})();
