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
 *     {hazards: string[], states?: string[], jurisdictionGuidance?: string,
 *     analysisGuidance?: string}, attributesPerCall } reuses the EXACT
 *     SAME comparison engine Rubric Control's idealTopicId path already
 *     runs through server-side (see buildBestPracticesTopic() in
 *     index.js) — this file just has to speak the same ndjson stream
 *     protocol /query/stream always speaks: a "sources" event per
 *     batch, "token" events as the model's raw answer streams in (see
 *     the "Raw answer" box, #bpAnswer/#bpAnswerDetails in index.html),
 *     then a "batch-done" event per batch (carrying that batch's
 *     {name, proposal, resultText, category} records), then one final
 *     "done" event, or an "error" event at any point.
 *   - "Compare against" mode (see #bpCompareModeRow/#bpRubricTopicRow
 *     in index.html): "workspace" (the default, described just above)
 *     sends `workspaceId` exactly as before. "rubric" instead sends
 *     `compareAgainstRubricId` (a Rubric Control topic id, from a new
 *     GET /ideal-proposals-backed dropdown this file populates itself
 *     — see loadRubricTopics() below) and OMITS `workspaceId`
 *     entirely — that mode never touches a workspace at all, since the
 *     selected rubric's own attributes are compared against directly,
 *     with no retrieval step (see buildRubricMatches() in
 *     src/idealProposals.js). Every other field (bestPracticesFilter,
 *     attributesPerCall, chatModel) is sent exactly the same either
 *     way; the stream protocol is identical too, the only visible
 *     difference being that a rubric-mode run's "sources" events show
 *     the selected rubric's own attributes (one per "chunk") instead
 *     of retrieved document chunks.
 */

(function () {
  let hazardSelect, stateSelect, attributesPerCallInput, jurisdictionGuidanceInput, analysisGuidanceInput;
  let compareModeWorkspaceRadio, compareModeRubricRadio, rubricTopicRow, rubricTopicSelect;
  let compareBtn, stopBtn;
  let statusEl, progressWrap, progressBar, errorEl, elapsedTimeEl;
  let resultWrap, resultSummaryEl, resultsBody;
  let answerDetailsEl, answerEl;
  let chatModelNoteEl;
  let downloadCsvBtn, downloadHtmlBtn;
  let previewCountEl, showFullListBtn, previewListEl, previewDetailEl;

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
  // Live-updating timer handle -- same mechanism as script.js's
  // queryTimerHandle: a setInterval started alongside runStartedAt
  // above, re-rendering elapsedTimeEl every tick via the shared
  // formatElapsedMs() global (reportHtml.js), stopped and replaced with
  // the final elapsed time once the run settles (completed, stopped, or
  // errored -- see runComparison()'s finally block below).
  let runTimerHandle = null;
  // Whether any 'token' event has arrived yet for the run in progress --
  // same purpose as script.js's gotAnyToken: if the stream never sends
  // one (e.g. the "no documents embedded yet" short-circuit), the raw
  // answer box falls back to finalEvent.answer instead of staying
  // empty. Reset at the start of every run.
  let gotAnyToken = false;

  // Every matching Best Practices attribute object from the most
  // recent POST /best-practices/preview response (see refreshPreview()
  // below) -- the FULL data for each entry, not just its name, so a
  // later click on any one name in the rendered list (renderPreview()/
  // showPreviewDetail() below) can show its full text instantly with
  // no second round trip. Replaced wholesale on every selection
  // change; never mutated in place.
  let previewEntries = [];
  // Whether the name list is currently being shown in full despite
  // being at or above PREVIEW_AUTO_RENDER_THRESHOLD -- set only by
  // clicking showFullListBtn (see renderPreview() below), and reset to
  // false on every fresh Hazard/State selection so a later, smaller
  // selection doesn't inherit an unrelated "stay expanded" choice made
  // for a different, larger one.
  let previewListExpanded = false;
  // Monotonically increasing guard against a stale /best-practices/preview
  // response landing after a NEWER selection's request already
  // resolved -- a rapid shift-click drag across several options can
  // fire 'change' (and therefore a new preview fetch) several times in
  // quick succession; without this, a slow early response arriving
  // last could overwrite the correct, later one.
  let previewRequestToken = 0;
  let previewDebounceTimer = null;
  // Below this many matches, the name list renders automatically;
  // 200+ shows "Show full list?" first instead -- the threshold the
  // user asked for to keep a huge hazard (some match well over a
  // hundred entries on the real sheet) from dumping a giant list onto
  // the page unasked. Purely a client-side rendering choice -- see
  // POST /best-practices/preview's own doc comment in index.js for why
  // the full data is fetched either way.
  const PREVIEW_AUTO_RENDER_THRESHOLD = 200;

  // Maps src/responseParser.js's five fixed category strings to a
  // modifier class (see bestPracticesTab.css) that colors this tab's
  // own .bp-category-badge -- mirrors CATEGORY_CLASS in script.js's
  // main results table (same color meaning: green for a
  // fully-evidenced Matches/Exceeds, blue for an Unverified match --
  // a model-reported Matches downgraded by this app's own
  // post-processing because none of its cited quotes could be
  // verified, see parseComparisonAnswer() in src/responseParser.js --
  // amber for Falls short, red for Not addressed), just under this
  // tab's own bp-prefixed class names instead of reusing script.js's
  // cat- ones, per this file's isolation policy above. An
  // unparsed/empty category intentionally has no entry here, same as
  // CATEGORY_CLASS, leaving the badge in its plain neutral style.
  const BP_CATEGORY_MODIFIER_CLASS = {
    Exceeds: 'bp-cat-exceeds',
    Matches: 'bp-cat-matches',
    'Unverified match': 'bp-cat-unverified-match',
    'Falls short': 'bp-cat-falls-short',
    'Not addressed': 'bp-cat-not-addressed',
  };

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
    // Leading "ⓘ" is a plain text character, not markup -- this stays
    // a textContent assignment (no innerHTML, no escaping concerns)
    // the same way it always has; see bestPracticesTab.css for why
    // this note is styled as a status callout rather than a p.hint.
    chatModelNoteEl.textContent = model
      ? `ⓘ Chat model: ${model} (set on the Query and Response tab)`
      : 'ⓘ Chat model: not yet loaded (set on the Query and Response tab) — using the server default for now.';
  }

  /**
   * Which "document" this tab is currently set to compare the Best
   * Practices subset against — 'workspace' (the original behavior,
   * also the default) or 'rubric' (see #bpCompareModeRow in
   * index.html). Falls back to 'workspace' if the radio itself isn't
   * found for some reason, same defensive convention the rest of this
   * file's DOM lookups use.
   * @returns {'workspace'|'rubric'}
   */
  function getCompareMode() {
    return compareModeRubricRadio && compareModeRubricRadio.checked ? 'rubric' : 'workspace';
  }

  /** @returns {string} the selected #bpRubricTopic option's value, or '' if none. */
  function getRubricTopicId() {
    return rubricTopicSelect ? rubricTopicSelect.value : '';
  }

  /**
   * The selected rubric's plain label (not the "label — description"
   * combined display text) — same dataset.label convention
   * refreshIdealTopics() in script.js uses for its own #idealTopic
   * dropdown, so a report header reads "Offshore Wind" rather than the
   * longer combined option text. Returns `id` itself as a last-resort
   * fallback (e.g. if the option list hasn't loaded yet for some
   * reason) rather than an empty string, so a report never shows a
   * blank "compared against rubric: " line.
   * @param {string} id
   * @returns {string}
   */
  function getRubricTopicLabel(id) {
    if (!rubricTopicSelect || !id) return id || '';
    const opt = Array.from(rubricTopicSelect.options).find((o) => o.value === id);
    return (opt && (opt.dataset.label || opt.textContent)) || id;
  }

  /**
   * Shows/hides the rubric picker depending on the current "Compare
   * against" selection — called on init and on every radio 'change'.
   * Never touches the Hazard/State preview or anything else; those
   * apply identically to both modes.
   */
  function updateCompareModeVisibility() {
    if (!rubricTopicRow) return;
    rubricTopicRow.style.display = getCompareMode() === 'rubric' ? '' : 'none';
  }

  /**
   * Populates #bpRubricTopic from GET /ideal-proposals — the exact same
   * endpoint/response shape refreshIdealTopics() in script.js already
   * reads for the Query and Response tab's own #idealTopic dropdown
   * (see that function's own doc comment for the response shape), just
   * rendered into this tab's own select instead, per this file's
   * isolation policy (see this file's own top-of-file doc comment). An
   * empty topic list is a normal state (nobody's added a rubric in
   * Rubric Control yet) — shown as a disabled explanatory option, same
   * spirit as loadFilters()'s own "(none available)" handling above,
   * rather than an error.
   */
  async function loadRubricTopics() {
    if (!rubricTopicSelect) return;
    rubricTopicSelect.innerHTML = '<option value="" disabled selected>Loading rubrics...</option>';
    try {
      const res = await fetch('/ideal-proposals');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load rubric topics');

      const topics = data.topics || [];
      const previousValue = rubricTopicSelect.value;
      rubricTopicSelect.innerHTML = '';

      if (topics.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.selected = true;
        opt.textContent = '(no rubrics saved yet -- add one in Rubric Control)';
        rubricTopicSelect.appendChild(opt);
        return;
      }

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.textContent = 'Select a rubric...';
      rubricTopicSelect.appendChild(placeholder);

      for (const topic of topics) {
        const opt = document.createElement('option');
        opt.value = topic.id;
        opt.textContent = topic.description ? `${topic.label} — ${topic.description}` : topic.label;
        opt.dataset.label = topic.label;
        rubricTopicSelect.appendChild(opt);
      }

      // Preserve whatever was selected across a refresh (e.g. switching
      // to this tab again later in the session) -- same courtesy
      // refreshIdealTopics() in script.js gives its own dropdown. Falls
      // back to the placeholder (still selected from above) if the
      // previously-selected rubric no longer exists.
      const stillExists = Array.from(rubricTopicSelect.options).some((o) => o.value === previousValue);
      if (previousValue && stillExists) rubricTopicSelect.value = previousValue;
      else placeholder.selected = true;
    } catch (err) {
      rubricTopicSelect.innerHTML = `<option value="" disabled selected>(failed to load: ${err.message})</option>`;
    }
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
    if (compareModeWorkspaceRadio) compareModeWorkspaceRadio.disabled = running;
    if (compareModeRubricRadio) compareModeRubricRadio.disabled = running;
    if (rubricTopicSelect) rubricTopicSelect.disabled = running;
    progressWrap.style.display = running ? '' : 'none';
    // Exporting mid-run would just export whatever's accumulated so
    // far, frozen at a moment that's about to change — simplest to
    // disable both until the run settles, same as the Hazard/State
    // controls above.
    downloadCsvBtn.disabled = running;
    downloadHtmlBtn.disabled = running;
  }

  /**
   * Reads every selected option's value out of a <select multiple> --
   * both bpHazard and bpState are one now (see index.html), so Hazard/
   * State are no longer "pick exactly one, or the one blank placeholder
   * meaning 'unset'" — every selected option is a real value, and
   * "nothing selected" is simply an empty array, not a placeholder
   * option of its own. Used for both reading the live selection to
   * run a comparison (runComparison() below) and for the export-meta
   * labels (buildExportMeta() below).
   * @param {HTMLSelectElement} select
   * @returns {string[]} in the select's own option order (not
   *   necessarily the order the user clicked them in, same as the DOM's
   *   own `.selectedOptions` behaves).
   */
  function getSelectedValues(select) {
    return Array.from(select.selectedOptions || []).map((opt) => opt.value).filter(Boolean);
  }

  /**
   * Reads the "Jurisdiction guidance override" textarea -- parallel to
   * Rubric Control's own "Comparison instruction (optional)" textarea
   * (see #rubricCompareInstruction in index.html/script.js): blank
   * means "use BEST_PRACTICES_JURISDICTION_GUIDANCE, the built-in
   * default," so this returns undefined in that case (same convention
   * getChatModel() above already uses) rather than '', so the request
   * body omits `jurisdictionGuidance` entirely instead of sending an
   * empty string that would mean something different server-side. See
   * that constant's own doc comment in index.js for the full picture.
   * @returns {string|undefined}
   */
  function getJurisdictionGuidanceOverride() {
    const value = jurisdictionGuidanceInput && jurisdictionGuidanceInput.value.trim();
    return value || undefined;
  }

  /**
   * Reads the "Analysis guidance override" textarea -- same convention
   * as getJurisdictionGuidanceOverride() just above, but for
   * BEST_PRACTICES_ANALYSIS_GUIDANCE in index.js instead: blank means
   * "use the built-in default," so this returns undefined in that case
   * rather than ''.
   * @returns {string|undefined}
   */
  function getAnalysisGuidanceOverride() {
    const value = analysisGuidanceInput && analysisGuidanceInput.value.trim();
    return value || undefined;
  }

  /** Hides whatever entry's full text is currently shown in the detail panel. */
  function hidePreviewDetail() {
    previewDetailEl.style.display = 'none';
    previewDetailEl.innerHTML = '';
  }

  /**
   * Shows one matching entry's full text in the detail panel just
   * below the list -- instant, since `previewEntries` already holds
   * every matching entry's full data from the most recent
   * /best-practices/preview response (see that endpoint's own doc
   * comment in index.js for why it ships this eagerly rather than
   * lazily per click). Clicking a different name simply replaces
   * whatever was shown here; nothing here ever fetches anything.
   * @param {number} idx - index into `previewEntries`
   */
  function showPreviewDetail(idx) {
    const entry = previewEntries[idx];
    if (!entry) return;

    previewDetailEl.innerHTML = '';

    const title = document.createElement('h4');
    title.textContent = entry.name;
    previewDetailEl.appendChild(title);

    // A short "State: Maine • Hazard(s): Wildfire, Flooding • ..."
    // meta line -- only the fields that are actually present on this
    // entry (see best_practices_to_json.py's attribute shape; not
    // every field is populated for every row), joined with the same
    // "•" separator used elsewhere in this app for a compact one-line
    // summary of several small facts.
    const metaParts = [];
    if (entry.state) metaParts.push(`State: ${entry.state}`);
    if (entry.hazards && entry.hazards.length) metaParts.push(`Hazard(s): ${entry.hazards.join(', ')}`);
    if (entry.sectors && entry.sectors.length) metaParts.push(`Sector(s): ${entry.sectors.join(', ')}`);
    if (entry.status && entry.status.length) metaParts.push(`Status: ${entry.status.join(', ')}`);
    if (entry.commitmentLevels && entry.commitmentLevels.length) {
      metaParts.push(`Commitment: ${entry.commitmentLevels.join(', ')}`);
    }
    if (metaParts.length) {
      const metaP = document.createElement('p');
      metaP.className = 'bp-preview-detail-meta';
      metaP.textContent = metaParts.join(' • ');
      previewDetailEl.appendChild(metaP);
    }

    const proposalP = document.createElement('p');
    proposalP.textContent = entry.proposal || '(no description in this entry)';
    previewDetailEl.appendChild(proposalP);

    if (entry.notes) {
      const notesP = document.createElement('p');
      notesP.className = 'bp-preview-detail-meta';
      notesP.textContent = `Notes: ${entry.notes}`;
      previewDetailEl.appendChild(notesP);
    }

    if (entry.url) {
      const link = document.createElement('a');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.url;
      previewDetailEl.appendChild(link);
    }

    previewDetailEl.style.display = '';
    previewDetailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /**
   * Renders the "N items currently in the comparison list" line plus
   * either the clickable name list (under PREVIEW_AUTO_RENDER_THRESHOLD,
   * or once showFullListBtn has been clicked) or the "Show full list?"
   * button (at/above it) -- purely from `previewEntries` and
   * `previewListExpanded`, both already in hand; this never fetches
   * anything itself. Called right after a fresh /best-practices/preview
   * response lands (refreshPreview() below) and again when
   * showFullListBtn is clicked, so it never needs to know WHICH of
   * those triggered it.
   */
  function renderPreview() {
    const count = previewEntries.length;
    previewCountEl.textContent = `${count} item${count === 1 ? '' : 's'} currently in the comparison list.`;

    if (count === 0) {
      showFullListBtn.style.display = 'none';
      previewListEl.style.display = 'none';
      previewListEl.innerHTML = '';
      return;
    }

    if (count >= PREVIEW_AUTO_RENDER_THRESHOLD && !previewListExpanded) {
      showFullListBtn.style.display = '';
      showFullListBtn.textContent = `Show full list? (${count} items)`;
      previewListEl.style.display = 'none';
      previewListEl.innerHTML = '';
      return;
    }

    showFullListBtn.style.display = 'none';
    previewListEl.style.display = '';
    previewListEl.innerHTML = '';
    previewEntries.forEach((entry, idx) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-preview-item';
      btn.textContent = entry.name;
      btn.addEventListener('click', () => showPreviewDetail(idx));
      li.appendChild(btn);
      previewListEl.appendChild(li);
    });
  }

  /**
   * Re-fetches POST /best-practices/preview for whatever Hazard/State
   * selection is live RIGHT NOW and re-renders the count/list from the
   * result -- see that endpoint's own doc comment in index.js for the
   * request/response shape and why it ships every matching entry's
   * full data eagerly. Guarded against two races: `previewRequestToken`
   * so a slow, now-superseded response can never overwrite a newer
   * one's result (see that variable's own doc comment above), and a
   * zero-hazards selection short-circuits before ever reaching the
   * network, since the server would just reject it the same way
   * runComparison() already guards against submitting it.
   */
  async function refreshPreview() {
    const hazards = getSelectedValues(hazardSelect);
    const states = getSelectedValues(stateSelect);

    // Whatever was shown for the PREVIOUS selection is no longer
    // necessarily meaningful once the selection itself has changed --
    // its entries (and therefore its indices into `previewEntries`)
    // may be completely different now.
    hidePreviewDetail();
    previewListExpanded = false;

    if (hazards.length === 0) {
      previewRequestToken += 1; // invalidate any still-in-flight request
      previewEntries = [];
      previewCountEl.textContent = 'Pick at least one hazard to see how many benchmark entries would be compared.';
      showFullListBtn.style.display = 'none';
      previewListEl.style.display = 'none';
      previewListEl.innerHTML = '';
      return;
    }

    const myToken = ++previewRequestToken;
    previewCountEl.textContent = 'Checking how many benchmark entries match...';
    showFullListBtn.style.display = 'none';
    previewListEl.style.display = 'none';

    try {
      const res = await fetch('/best-practices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hazards, states }),
      });
      const data = await res.json();
      if (myToken !== previewRequestToken) return; // superseded by a newer selection -- discard
      if (!res.ok) throw new Error(data.error || 'Failed to preview Best Practices entries');

      previewEntries = data.entries || [];
      renderPreview();
    } catch (err) {
      if (myToken !== previewRequestToken) return;
      previewEntries = [];
      previewCountEl.textContent = `Could not preview matching entries: ${err.message}`;
    }
  }

  /**
   * Debounced entry point wired to both Hazard and State selects'
   * 'change' events (see initBestPracticesTab() below). A plain
   * multi-select only ever fires 'change' once per discrete click, not
   * per keystroke, but a fast shift-click drag across several options
   * can still fire it several times in a row -- this collapses a quick
   * burst of those into a single refreshPreview() call after things
   * settle, rather than firing one request per click.
   */
  function schedulePreviewRefresh() {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(refreshPreview, 200);
  }

  /**
   * Populates the Hazard/State dropdowns from GET /best-practices/filters.
   * An empty hazards list (missing or empty bestPractices.json — see
   * loadBestPracticeAttributes()'s own doc comment in
   * src/bestPractices.js) is treated as "this feature isn't set up on
   * this install yet," not an error: the tab stays visible but
   * explains itself and disables Compare, rather than showing a
   * confusing empty dropdown a click does nothing useful with.
   *
   * Neither select gets a blank placeholder option any more (see
   * index.html's own comment on the multi-select markup) — the one
   * exception is the "(none available)"/"(failed to load)" diagnostic
   * option below, added `disabled` specifically so it can't actually
   * be selected in a multi-select the way a plain unselected placeholder
   * used to just sit there doing nothing.
   */
  async function loadFilters() {
    hazardSelect.innerHTML = '<option value="" disabled>Loading hazards...</option>';
    stateSelect.innerHTML = '';

    try {
      const res = await fetch('/best-practices/filters');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Best Practices filters');

      const hazards = data.hazards || [];
      const states = data.states || [];

      if (hazards.length === 0) {
        hazardSelect.innerHTML = '<option value="" disabled>(none available)</option>';
        compareBtn.disabled = true;
        previewCountEl.textContent = '';
        showFullListBtn.style.display = 'none';
        previewListEl.style.display = 'none';
        showError(
          'No Best Practices data is loaded on this server yet -- ' +
          'bestPractices.json is missing or empty. Generate it with ' +
          'best_practices_to_json.py and place it at the project root, ' +
          'then reload this page.'
        );
        return;
      }

      hazardSelect.innerHTML = '';
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
      // Nothing is selected yet right after a fresh load, but this
      // still gives the preview area its correct initial message
      // ("Pick at least one hazard...") rather than leaving it blank
      // until the user's first click.
      refreshPreview();
    } catch (err) {
      hazardSelect.innerHTML = '<option value="" disabled>(failed to load)</option>';
      compareBtn.disabled = true;
      previewCountEl.textContent = '';
      showFullListBtn.style.display = 'none';
      previewListEl.style.display = 'none';
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
      const modifierClass = BP_CATEGORY_MODIFIER_CLASS[record.category];
      if (modifierClass) badge.classList.add(modifierClass);
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
    // Exactly one of these two ends up set below, matching whichever
    // "Compare against" mode is selected -- see getCompareMode()'s own
    // doc comment. Declared here (rather than inline in the fetch body
    // below) so the validation checks right below can return early
    // without duplicating which field they're validating.
    const compareMode = getCompareMode();
    let workspaceId = '';
    let rubricTopicId = '';
    if (compareMode === 'rubric') {
      rubricTopicId = getRubricTopicId();
      if (!rubricTopicId) {
        showError('Pick a rubric to compare against first.');
        return;
      }
    } else {
      workspaceId = getWorkspaceId();
      if (!workspaceId) {
        showError('Enter or pick a storage area name above first.');
        return;
      }
    }

    const hazards = getSelectedValues(hazardSelect);
    if (hazards.length === 0) {
      showError('Pick at least one hazard first.');
      return;
    }
    const states = getSelectedValues(stateSelect);
    const jurisdictionGuidance = getJurisdictionGuidanceOverride();
    const analysisGuidance = getAnalysisGuidanceOverride();

    const rawAttributesPerCall = parseInt(attributesPerCallInput.value, 10);
    const attributesPerCall = Number.isFinite(rawAttributesPerCall) && rawAttributesPerCall > 0
      ? rawAttributesPerCall
      : 1;

    showError('');
    resultsBody.innerHTML = '';
    rowsRendered = 0;
    latestBatches = [];
    lastElapsedMs = null;
    gotAnyToken = false;
    resultWrap.style.display = 'none';
    resultSummaryEl.textContent = '';
    answerEl.textContent = '';
    answerDetailsEl.style.display = 'none';
    statusEl.textContent = 'Starting...';
    setRunning(true);

    runStartedAt = performance.now();
    // Live-updating timer -- mirrors script.js's own queryStartTime/
    // queryTimerHandle pattern (see elapsedTimeEl's own declaration
    // above): ticks every 100ms using the shared formatElapsedMs()
    // global from reportHtml.js, stopped in the finally block below
    // once the run settles.
    elapsedTimeEl.textContent = formatElapsedMs(0);
    runTimerHandle = setInterval(() => {
      elapsedTimeEl.textContent = formatElapsedMs(performance.now() - runStartedAt);
    }, 100);
    abortController = new AbortController();

    try {
      const res = await fetch('/query/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Exactly one of these two is actually sent -- see this
          // function's own validation above and getCompareMode()'s doc
          // comment. 'rubric' mode omits workspaceId entirely rather
          // than sending an empty string, since the server treats its
          // mere presence as "validate/require a workspace" (see
          // /query/stream in index.js).
          ...(compareMode === 'rubric' ? { compareAgainstRubricId: rubricTopicId } : { workspaceId }),
          bestPracticesFilter: { hazards, states, jurisdictionGuidance, analysisGuidance },
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
            // Same separator convention as script.js's own answerEl
            // handling: inserted right before a second-or-later batch's
            // tokens start arriving, so each batch's raw text is
            // visually set apart instead of running straight into the
            // previous batch's.
            if (event.batchIndex > 0 && answerEl.textContent) {
              answerEl.textContent += '\n\n———\n\n';
            }
          } else if (event.type === 'token') {
            // Live "typing" effect for the raw, unparsed model output --
            // mirrors script.js's own #answer handling (see that file's
            // 'token' branch). This is what lets a thin-looking result
            // (e.g. a verdict and a quote but no real analysis) be
            // checked against what the model actually wrote, rather
            // than only the best-effort parse in the table below.
            gotAnyToken = true;
            answerDetailsEl.style.display = '';
            answerEl.textContent += event.text;
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

      // Covers the same "no documents embedded yet" short-circuit
      // script.js's own answerEl handling guards against: "done" fires
      // with a ready-made answer and no tokens were ever streamed.
      if (!gotAnyToken && finalEvent.answer) {
        answerEl.textContent = finalEvent.answer;
        answerDetailsEl.style.display = '';
      }

      lastElapsedMs = performance.now() - runStartedAt;
      statusEl.textContent = `Done -- ${rowsRendered} entr${rowsRendered === 1 ? 'y' : 'ies'} compared across ${finalEvent.totalBatches} batch${finalEvent.totalBatches === 1 ? '' : 'es'}.`;
      const comparedAgainstText = compareMode === 'rubric'
        ? `the rubric "${getRubricTopicLabel(rubricTopicId)}"`
        : `"${workspaceId}"`;
      resultSummaryEl.textContent =
        `Hazard${hazards.length === 1 ? '' : 's'}: ${hazards.join(', ')}` +
        (states.length ? `, State${states.length === 1 ? '' : 's'}: ${states.join(', ')}` : ' (all states)') +
        ` -- ${rowsRendered} benchmark entr${rowsRendered === 1 ? 'y' : 'ies'} compared against ${comparedAgainstText}.` +
        // Confirms each override actually took effect for THIS run --
        // without this, the only way to tell would be reading the
        // (not normally visible) prompt itself -- see this tab's own
        // doc comment above on why the actual prompt isn't shown.
        (jurisdictionGuidance ? ' Using a custom jurisdiction guidance override for this run.' : '') +
        (analysisGuidance ? ' Using a custom analysis guidance override for this run.' : '');
    } catch (err) {
      if (err.name === 'AbortError') {
        statusEl.textContent = `Stopped after ${rowsRendered} entr${rowsRendered === 1 ? 'y' : 'ies'}.`;
      } else {
        showError(err.message);
        statusEl.textContent = '';
      }
    } finally {
      clearInterval(runTimerHandle);
      runTimerHandle = null;
      // Mirrors script.js's own finally block: recomputed from
      // runStartedAt rather than reusing lastElapsedMs, so the
      // displayed time is correct even on an error/abort path above
      // that returns before lastElapsedMs is ever set.
      const finalElapsedMs = performance.now() - runStartedAt;
      elapsedTimeEl.textContent = formatElapsedMs(finalElapsedMs);
      lastElapsedMs = finalElapsedMs;
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
   * accurate for what actually ran. `workspaceId`/`rubricLabel` are
   * mutually exclusive, matching getCompareMode() -- a rubric-mode
   * export has no workspace at all (no "Workspace" row in the report),
   * and gets a new "Compared against rubric" row instead (see
   * `rubricLabel` in buildAttributeResultsHtml()'s own doc comment in
   * reportHtml.js).
   * @returns {Object}
   */
  function buildExportMeta() {
    const hazards = getSelectedValues(hazardSelect);
    const states = getSelectedValues(stateSelect);
    const rawAttributesPerCall = parseInt(attributesPerCallInput.value, 10);
    const attributesPerCall = Number.isFinite(rawAttributesPerCall) && rawAttributesPerCall > 0
      ? rawAttributesPerCall
      : undefined;
    const appNameEl = document.getElementById('appNameHeading');
    const compareMode = getCompareMode();
    return {
      workspaceId: compareMode === 'rubric' ? undefined : (getWorkspaceId() || undefined),
      rubricLabel: compareMode === 'rubric' ? getRubricTopicLabel(getRubricTopicId()) : undefined,
      topicLabel: hazards.length
        ? `Best Practices — ${hazards.join(', ')}${states.length ? ` (${states.join(', ')})` : ' (all states)'}`
        : undefined,
      chatModel: getChatModel(),
      attributesPerCall,
      appName: (appNameEl && appNameEl.textContent.trim()) || undefined,
      elapsedMs: lastElapsedMs != null ? lastElapsedMs : undefined,
    };
  }

  /**
   * A short, filesystem-safe-ish base name for the two downloads below
   * -- the workspace name in workspace mode (unchanged from before),
   * or the selected rubric's id in rubric mode (its id rather than its
   * label, since a label can contain spaces/punctuation a label alone
   * would make for an awkward filename; same 'results' fallback either
   * mode uses if nothing is actually selected, which shouldn't happen
   * in practice since both export buttons are disabled until a run has
   * produced at least one record).
   * @returns {string}
   */
  function getExportFileBase() {
    if (getCompareMode() === 'rubric') {
      const id = getRubricTopicId();
      return id ? `rubric-${id}` : 'results';
    }
    return getWorkspaceId() || 'results';
  }

  function downloadCsv() {
    if (!latestBatches.some((b) => b.records && b.records.length)) return;
    const csv = buildAttributeResultsCsv(latestBatches);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getExportFileBase()}-best-practices.csv`;
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
    a.download = `${getExportFileBase()}-best-practices.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function initBestPracticesTab() {
    hazardSelect = document.getElementById('bpHazard');
    stateSelect = document.getElementById('bpState');
    attributesPerCallInput = document.getElementById('bpAttributesPerCall');
    jurisdictionGuidanceInput = document.getElementById('bpJurisdictionGuidance');
    analysisGuidanceInput = document.getElementById('bpAnalysisGuidance');
    compareModeWorkspaceRadio = document.getElementById('bpCompareModeWorkspace');
    compareModeRubricRadio = document.getElementById('bpCompareModeRubric');
    rubricTopicRow = document.getElementById('bpRubricTopicRow');
    rubricTopicSelect = document.getElementById('bpRubricTopic');
    compareBtn = document.getElementById('bpCompareBtn');
    stopBtn = document.getElementById('bpStopBtn');
    statusEl = document.getElementById('bpStatus');
    elapsedTimeEl = document.getElementById('bpElapsedTime');
    progressWrap = document.getElementById('bpProgressWrap');
    progressBar = document.getElementById('bpProgressBar');
    errorEl = document.getElementById('bpError');
    answerDetailsEl = document.getElementById('bpAnswerDetails');
    answerEl = document.getElementById('bpAnswer');
    resultWrap = document.getElementById('bpResultWrap');
    resultSummaryEl = document.getElementById('bpResultSummary');
    resultsBody = document.getElementById('bpResultsBody');
    chatModelNoteEl = document.getElementById('bpChatModelNote');
    downloadCsvBtn = document.getElementById('bpDownloadCsvBtn');
    downloadHtmlBtn = document.getElementById('bpDownloadHtmlBtn');
    previewCountEl = document.getElementById('bpPreviewCount');
    showFullListBtn = document.getElementById('bpShowFullListBtn');
    previewListEl = document.getElementById('bpPreviewList');
    previewDetailEl = document.getElementById('bpPreviewDetail');

    // Any element missing means this page doesn't have the Best
    // Practices panel at all (e.g. an older index.html) -- bail out
    // quietly rather than throwing on a null lookup above.
    if (!hazardSelect || !compareBtn) return;

    compareBtn.addEventListener('click', runComparison);
    stopBtn.addEventListener('click', stopComparison);
    downloadCsvBtn.addEventListener('click', downloadCsv);
    downloadHtmlBtn.addEventListener('click', downloadHtmlReport);

    // Live preview (see refreshPreview()'s own doc comment above) --
    // every Hazard/State selection change schedules a re-check of how
    // many (and which) benchmark entries currently match, well before
    // Compare is ever clicked.
    hazardSelect.addEventListener('change', schedulePreviewRefresh);
    stateSelect.addEventListener('change', schedulePreviewRefresh);
    showFullListBtn.addEventListener('click', () => {
      previewListExpanded = true;
      renderPreview();
    });

    loadFilters();

    // "Compare against" mode toggle (see getCompareMode()'s own doc
    // comment above): shows/hides the rubric picker, and loads its
    // options the first time this tab initializes.
    if (compareModeWorkspaceRadio) compareModeWorkspaceRadio.addEventListener('change', updateCompareModeVisibility);
    if (compareModeRubricRadio) compareModeRubricRadio.addEventListener('change', updateCompareModeVisibility);
    updateCompareModeVisibility();
    loadRubricTopics();

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
      // Rubric Control topics can be created/edited/deleted on their
      // own tab at any point in the session -- re-fetching the list
      // every time someone switches to this tab keeps #bpRubricTopic
      // from showing a stale/deleted rubric, same reasoning as the
      // chat-model note refresh right above.
      bestPracticesMenuItem.addEventListener('click', loadRubricTopics);
    }
  }

  // Exposed the same way script.js's own init() is: called from
  // <body onload="..."> in index.html once the page's markup (and this
  // script, loaded in <head> above it) both exist -- see this file's
  // doc comment for why this is its own call rather than being folded
  // into script.js's init().
  window.initBestPracticesTab = initBestPracticesTab;
})();
