// Loads public/config.json — a small, separate file kept deliberately
// outside this HTML so renaming the app doesn't mean hand-editing
// markup. { "appName": "..." } is the only field read today; the
// "local-rag" in <title> and <h1> in index.html is just the fallback
// shown if this fetch fails or the file's missing, not a second place
// that needs updating. Called from init() below, first thing on page
// load.
// Read by applyConfig() below and, from then on, by anything else that
// needs the app's configured name rather than the "local-rag" fallback
// baked into index.html/reportHtml.js — currently just the "Generated
// by ..." footer in the "Export HTML" report (see the downloadHtmlBtn
// handler further down), passed through as `meta.appName`.
let currentAppName = 'local-rag';

async function applyConfig() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    const config = await res.json();
    if (config.appName) {
      currentAppName = config.appName;
      document.title = config.appName;
      document.getElementById('appNameHeading').textContent = config.appName;
    }
  } catch (err) {
    console.warn('Could not load config.json, using default name:', err);
  }
}

let introContentEl;

// Fills the Introduction tab with the fragment from intro.html —
// plain HTML, not Markdown, served as a static file alongside this
// script. Kept out of index.html entirely so that tab's content can
// be edited (even by someone not comfortable with the rest of this
// app's markup) without touching any code, same reasoning
// config.json's own doc comment above gives for keeping appName out
// of index.html. Called once from init(), below applyConfig() in the
// "Initial data loads" section.
async function loadIntroContent() {
  try {
    const res = await fetch('/intro.html', { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    introContentEl.innerHTML = await res.text();
  } catch (err) {
    console.warn('Could not load intro.html:', err);
    introContentEl.innerHTML =
      '<p class="error">Couldn\'t load the introduction text (intro.html). The rest of the app is unaffected.</p>';
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
const SERVER_DEFAULT_CHAT_MODEL = 'qwen2.5:14b';

// Model families known to document their OWN preference for a higher
// "Consistency" (temperature) setting than this app's own default of
// 0.2 — DeepSeek-R1 is the one that prompted this: its model card
// recommends 0.5-0.7 and specifically warns that lower values (this
// app's default among them) can send it into repetitive, looping
// answers, not just "more deterministic" the way low temperature
// behaves for most other models (see the "deepseek-r1:8b" discussion
// that led here). Matched with a plain case-insensitive substring
// against the model's own name/tag as Ollama reports it (see
// refreshModels() below) rather than a curated exact-name list, so a
// differently-tagged pull of the same family (say, a custom Modelfile
// named "my-deepseek-8b") still matches. A list rather than a single
// hardcoded check specifically so another reasoning-model family with
// the same documented quirk can be added later (another entry here)
// without touching any of the logic that reads it below.
const REASONING_TEMPERATURE_SUGGESTIONS = [
  {
    pattern: /deepseek/i,
    label: 'DeepSeek-R1',
    recommendedTemperature: 0.6,
    reason:
      'DeepSeek’s own documentation recommends this range and warns that lower values ' +
      'can cause repetitive, looping answers — a low "Consistency" setting is good for ' +
      'most models, but not this one.',
  },
];

/**
 * @param {string} modelName
 * @returns {object|undefined} the first entry in
 *   REASONING_TEMPERATURE_SUGGESTIONS above whose pattern matches, or
 *   undefined if the model name (as selected in the chat-model
 *   dropdown) doesn't match any of them.
 */
function matchReasoningTemperatureSuggestion(modelName) {
  return REASONING_TEMPERATURE_SUGGESTIONS.find((s) => s.pattern.test(modelName || ''));
}

let chatModelSelect, chatModelHint;
let temperatureInput, temperatureSuggestionWrap, temperatureSuggestionText, temperatureSuggestionApplyBtn;
let queryAdvancedSettings;
// The Advanced settings panel the Consistency field itself lives
// inside (see index.html) — collapsed by default. Its own doc comment
// on details.advanced in style.css says why: "the more technical
// controls ... don't clutter the page until someone specifically wants
// them." Closed <details> content in Chromium isn't hidden with plain
// CSS `display:none` (which a descendant's own inline style, like the
// one updateTemperatureSuggestion() below sets, could in principle
// fight with) — it's excluded from rendering and hit-testing at the
// engine level, full stop, regardless of anything set on a nested
// element. So a suggestion box nested inside a still-collapsed panel
// is invisible and unclickable no matter what its own `style.display`
// says; updateTemperatureSuggestion() below opens this panel directly
// whenever it has something to show, so the suggestion is never
// silently inert behind a summary the person never happened to click.

// Tracks which chat-model selection the suggestion box was last
// dismissed for (see the Dismiss button's handler in init() below) —
// re-picking the SAME reasoning model after dismissing it won't bring
// the box back nagging you again, but switching to a different model
// and back, or reloading the page, will re-evaluate from scratch.
// null means "nothing dismissed since the last model change."
let temperatureSuggestionDismissedFor = null;

/**
 * Shows or hides the "this model tends to loop at low Consistency"
 * callout next to the temperature field, based on the currently
 * selected chat model and the field's current value — called after
 * the model list loads, on every chat-model selection change, and
 * whenever the Consistency field itself changes (so raising it past
 * the recommendation, or lowering it back below, both react live).
 * Purely advisory: this never touches the field's value on its own —
 * only the Apply button in the box it shows does that, and only when
 * clicked. See REASONING_TEMPERATURE_SUGGESTIONS above for the match
 * table this reads.
 */
function updateTemperatureSuggestion() {
  const match = matchReasoningTemperatureSuggestion(chatModelSelect.value);
  const currentTemperature = Number(temperatureInput.value);
  const shouldShow =
    match &&
    chatModelSelect.value !== temperatureSuggestionDismissedFor &&
    // Not >= : if it's already at or above what the model itself
    // recommends, there's nothing useful to suggest — this also means
    // clicking Apply below hides the box on its own, since the field's
    // new value no longer qualifies, with no extra bookkeeping needed.
    (Number.isNaN(currentTemperature) || currentTemperature < match.recommendedTemperature);

  if (!shouldShow) {
    temperatureSuggestionWrap.style.display = 'none';
    return;
  }

  temperatureSuggestionText.textContent = `${match.label} models like this one work best around ${match.recommendedTemperature}, not the ${currentTemperature} currently set. ${match.reason}`;
  temperatureSuggestionApplyBtn.textContent = `Use ${match.recommendedTemperature}`;
  temperatureSuggestionApplyBtn.dataset.recommendedTemperature = String(match.recommendedTemperature);
  temperatureSuggestionWrap.style.display = 'block';
  // See queryAdvancedSettings's own doc comment above: a closed
  // <details> hides its content at the rendering-engine level, which
  // the `display: block` set right above cannot fight its way past —
  // without this, someone who has never opened "Advanced settings"
  // would have a suggestion box that's technically in the DOM and
  // technically "visible" by its own style, and still completely
  // unseen and unclickable.
  queryAdvancedSettings.open = true;
}

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
      updateTemperatureSuggestion();
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
    // The dropdown's selection can change right above (falling back to
    // SERVER_DEFAULT_CHAT_MODEL, or just landing on whatever option
    // ended up first) without any 'change' event ever firing — that
    // only fires on a user-driven selection — so this needs its own
    // explicit check rather than relying on the listener wired up in
    // init().
    updateTemperatureSuggestion();
  } catch (err) {
    console.warn('Could not load model list:', err);
    chatModelSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.textContent = 'Could not load models';
    opt.disabled = true;
    opt.selected = true;
    chatModelSelect.appendChild(opt);
    chatModelHint.textContent = 'Is Ollama running? Falling back to the server default if you ask a question anyway.';
    updateTemperatureSuggestion();
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
      // The plain label, undecorated by the description appended above —
      // kept as its own attribute so a caller that just wants "Offshore
      // Wind" for a report header (see buildAttributeResultsHtml() and
      // the downloadHtmlBtn handler) doesn't have to re-parse it back out
      // of the combined display text.
      opt.dataset.label = topic.label;
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

let documentsWrap, documentsEmpty, documentsBody, documentsError, documentsExcludedNote;
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
      documentsExcludedNote.style.display = 'none';
      resetBlockLookup();
      return;
    }

    documentsEmpty.textContent = '';
    // Surfaces excluded documents even to someone who never opens this
    // table's Include column — e.g. the Query tab's own status line
    // has no equivalent reminder, so a document excluded weeks ago
    // (by anyone — this is a shared, persisted workspace setting, not
    // a personal one; see setIncluded()'s own doc comment in
    // src/documentMeta.js) doesn't silently and invisibly stay missing
    // from every answer. Only shown at all when at least one document
    // actually is excluded — the common case (everything included)
    // shows nothing extra here.
    const excludedCount = data.documents.filter((doc) => doc.included === false).length;
    if (excludedCount > 0) {
      documentsExcludedNote.textContent = `${excludedCount} of ${data.documents.length} document${data.documents.length === 1 ? '' : 's'} excluded from search (unchecked below).`;
      documentsExcludedNote.style.display = 'block';
    } else {
      documentsExcludedNote.style.display = 'none';
    }

    for (const doc of data.documents) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(doc.sourceFile)}</td>
        <td class="doc-included-cell"></td>
        <td class="doc-description-cell"></td>
        <td>${doc.chunks}</td>
        <td>${doc.numPages != null ? doc.numPages : '—'}</td>
        <td><button type="button" class="btn-remove" data-source="${escapeHtml(doc.sourceFile)}">Remove</button></td>
      `;

      // Built via createElement + property assignment, not the
      // innerHTML template above, specifically so doc.sourceFile and
      // doc.description never have to go through escapeHtml() at all
      // — that function only escapes &/</>, not a literal `"`, which
      // would otherwise be able to break out of an HTML attribute
      // (see escapeHtml()'s own doc comment in reportHtml.js). Setting
      // .value and .dataset.source as plain JS properties sidesteps
      // that risk entirely, for both the filename and whatever text
      // someone types into the description.
      const descInput = document.createElement('textarea');
      descInput.className = 'doc-description-input';
      descInput.placeholder = 'Add a description…';
      descInput.rows = 3;
      descInput.value = doc.description || '';
      descInput.dataset.source = doc.sourceFile;
      // Baseline for saveDocumentDescription()'s "did this actually
      // change" check below — set here, at render time, rather than
      // only after a first successful save, so typing something and
      // then retyping the exact original text before clicking away
      // correctly saves nothing.
      descInput.dataset.savedValue = doc.description || '';
      // Editable for admin only — see applyRolePermissions()'s own
      // doc comment for why this (like every other role-based control
      // in this app so far) is UI-only, backed up by
      // saveDocumentDescription()'s own currentRole re-check below,
      // and ultimately by nothing at all server-side (see the doc
      // comment on PUT .../description in index.js). `currentRole`
      // defaults to 'admin' until GET /auth/me resolves (see its own
      // doc comment), same fail-open behavior every other role check
      // in this file already has.
      descInput.readOnly = currentRole !== 'admin';
      tr.querySelector('.doc-description-cell').appendChild(descInput);

      // Checked by default (doc.included is `true` for any document
      // with no explicit exclusion, including every brand-new one —
      // see isDocumentIncluded() in src/documentMeta.js), unchecked
      // only for a document someone has deliberately excluded. Saved
      // immediately on change (see the delegated 'change' listener
      // below), not on a separate explicit save step the way the
      // description textarea needs one — a checkbox's own click/toggle
      // already IS the deliberate action here, there's no "still
      // typing" state to wait out first.
      const includedCheckbox = document.createElement('input');
      includedCheckbox.type = 'checkbox';
      includedCheckbox.className = 'doc-included-checkbox';
      includedCheckbox.checked = doc.included !== false;
      includedCheckbox.dataset.source = doc.sourceFile;
      // Same admin-only editing posture as the description field right
      // above, and the same "not a security boundary" caveat (see the
      // doc comment on PUT .../included in index.js).
      includedCheckbox.disabled = currentRole !== 'admin';
      tr.querySelector('.doc-included-cell').appendChild(includedCheckbox);

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

/**
 * Saves one document's description — called from the delegated
 * 'focusout' listener below once a .doc-description-input (a
 * <textarea> — see refreshDocuments()) loses focus (Ctrl/Cmd+Enter
 * just blurs the field to get here through the same path; see the
 * delegated 'keydown' listener, and its own comment for why plain
 * Enter is deliberately left alone here). Only actually sends a
 * request if the value changed since the last save (tracked via
 * `dataset.savedValue`, refreshed both at render time in
 * refreshDocuments() and after every successful save here) — calling
 * this on an unchanged value, e.g. tabbing through the field without
 * typing anything, is a harmless no-op rather than a wasted request.
 * @param {HTMLTextAreaElement} input
 */
async function saveDocumentDescription(input) {
  // Belt-and-suspenders, same posture as submitRubricForm()'s own
  // early-return guard: the field is already readOnly for anything
  // but 'admin' (see refreshDocuments() and applyRolePermissions()
  // above), which alone already stops this from ever being reached —
  // this is only here in case that's ever bypassed some other way.
  // Not a security boundary; see applyRolePermissions()'s own doc
  // comment, and the doc comment on PUT .../description in index.js.
  if (currentRole !== 'admin') return;

  const sourceFile = input.dataset.source;
  const workspaceId = getWorkspaceId();
  if (!workspaceId || !sourceFile) return;

  if (input.value === (input.dataset.savedValue || '')) return; // unchanged

  try {
    const res = await fetch(
      `/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(sourceFile)}/description`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: input.value }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);

    // The server trims whitespace (see setDescription() in
    // src/documentMeta.js) — reflect that back into the field so
    // what's shown always matches what's actually stored, and so the
    // next focusout's "did this change" check compares against the
    // real saved value, not whatever untrimmed text was typed.
    input.value = data.description;
    input.dataset.savedValue = data.description;
    input.classList.remove('doc-description-error');
    input.title = '';
  } catch (err) {
    console.warn('Could not save document description:', err);
    input.classList.add('doc-description-error');
    input.title = `Could not save this description: ${err.message}`;
  }
}

/**
 * Saves one document's inclusion flag — called from the delegated
 * 'change' listener below as soon as a .doc-included-checkbox (see
 * refreshDocuments()) is toggled. Unlike saveDocumentDescription()
 * above, there's no "did this actually change" guard to apply first:
 * a checkbox only ever fires 'change' when its state actually
 * flipped, so every call here is already a real, deliberate toggle.
 * @param {HTMLInputElement} checkbox
 */
async function saveDocumentIncluded(checkbox) {
  // Belt-and-suspenders, same posture as saveDocumentDescription()'s
  // own early-return guard above: the checkbox is already disabled
  // for anything but 'admin' (see refreshDocuments() and
  // applyRolePermissions()), which alone already stops this from
  // ever being reached. Not a security boundary; see the doc comment
  // on PUT .../included in index.js.
  if (currentRole !== 'admin') return;

  const sourceFile = checkbox.dataset.source;
  const workspaceId = getWorkspaceId();
  if (!workspaceId || !sourceFile) return;

  const wantIncluded = checkbox.checked;
  checkbox.disabled = true;

  try {
    const res = await fetch(
      `/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(sourceFile)}/included`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ included: wantIncluded }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
    checkbox.checked = data.included;
    checkbox.title = '';
    // Refreshes the "N of M documents excluded" note and re-renders
    // the whole table from the server's own now-current state —
    // simpler than patching just this one row's note count by hand,
    // and this request is already a full round-trip either way. That
    // rebuild replaces `checkbox` itself with a fresh node (correctly
    // re-enabled already), so there's nothing left to re-enable here
    // on the success path.
    refreshDocuments();
  } catch (err) {
    console.warn('Could not save document inclusion:', err);
    // Reverts the checkbox to what it was before this click, rather
    // than leaving it showing a state the server never actually
    // stored — a silent mismatch here would be worse than a visible
    // revert, given what this checkbox actually controls (which
    // documents get searched at all). The table isn't rebuilt on this
    // path, so this same node needs re-enabling by hand.
    checkbox.checked = !wantIncluded;
    checkbox.title = `Could not save this change: ${err.message}`;
    checkbox.disabled = currentRole !== 'admin';
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

let queryForm, statusEl, errorEl, resultEl, answerEl, lengthNote, sourcesBody, confidenceNote, tokenUsageNote, retrievalQueryNote;
let submitBtn, stopBtn, elapsedTimeEl, queryProgressWrap;
let thinkCheckbox, reasoningWrap, reasoningEl, notifyEmailCheckbox, notifyEmailToInput, notifyEmailToError;
let retryNotAddressedCheckbox;
let attributeResultsWrap, attributeResultsBody, downloadCsvBtn, downloadHtmlBtn;

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

// formatElapsedMs() now lives in reportHtml.js (loaded via <script>
// before this file in index.html, same as escapeHtml()/
// buildAttributeResultsHtml() elsewhere in this file) so the "Run
// time" row it formats in the standalone report (see the
// downloadHtmlBtn handler below, and src/emailNotify.js for the
// completion-email attachment) is worded identically to the live
// readout next to Ask/Stop that uses the very same function. Still
// just a plain global here, same as before.

// Set once a request settles (success, error, or Stop) to the exact
// millisecond value the live timer next to Ask/Stop just rendered its
// final frame from (see the `finally` block in the submit handler
// below) — this is "the time recorded by the timer" the standalone
// report's "Run time" row (see downloadHtmlBtn below) shows for the
// browser's own "Export HTML" download. Reset to null at the top of
// every new run (alongside latestBatches) so a stale number from a
// previous run can never end up attached to results it doesn't
// belong to.
let lastRunElapsedMs = null;

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

// Human labels for src/responseParser.js's five fixed category
// strings, mapped to the CSS classes in style.css that color-code them
// in the per-attribute results table — an unparsed/empty category (see
// that module's caveat about parsing reliability) intentionally gets
// no class and a plain, honest label instead of guessing. "Unverified
// match" is the one category never chosen by the model itself -- it's
// a downgrade this app's own parseComparisonAnswer() applies on top of
// a model-reported "Matches" that didn't carry a quote this app could
// independently verify (see that function's doc comment in
// responseParser.js) -- shown in its own color here so it never reads
// as an ordinary, fully-evidenced "Matches".
const CATEGORY_CLASS = {
  Exceeds: 'cat-exceeds',
  Matches: 'cat-matches',
  'Unverified match': 'cat-unverified-match',
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

// formatBatchSummary() — one line summarizing a single batch's own
// token usage and, when it got cut off, a warning flag — now lives in
// reportHtml.js (loaded via <script> before this file in index.html,
// same as escapeHtml()/buildAttributeResultsHtml() below), since the
// completion-email attachment (src/emailNotify.js) needs the exact
// same formatting server-side and that file has no DOM to depend on.
// Still just a plain global here, same as before.

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
/**
 * Escapes one CSV field: quoted (with internal quotes doubled) if it
 * contains a comma, quote, or newline, left bare otherwise. Shared by
 * every CSV export in this file — see buildAttributeResultsCsv() below
 * and buildRubricAttributesCsv() further down — so the escaping rule
 * only lives in one place.
 */
function csvEscape(value) {
  const str = value == null ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildAttributeResultsCsv(batches) {
  const rows = [['Attribute name', 'Proposal', 'LLM result', 'LLM analysis', 'Source document(s)']];
  for (const batch of batches) {
    const sourceRefs = (batch.sources || []).map((s) => `${s.sourceFile} #${s.chunkIndex}`).join('; ');
    for (const r of batch.records || []) {
      rows.push([r.name, r.proposal, r.resultText, r.category, sourceRefs]);
    }
  }
  return '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

// REPORT_BADGE_CLASS, renderResultTextHtml(), and
// buildAttributeResultsHtml() — the standalone HTML report builder for
// the Export HTML button below and, server-side, the completion-email
// attachment — now live in reportHtml.js (loaded via <script> before
// this file in index.html), for the same reason formatBatchSummary()
// moved there: src/emailNotify.js needs to build the identical report
// from Node, which has no DOM. Still plain globals here, same as
// before — see reportHtml.js's own module-level doc comment for how
// that works without a bundler.

/**
 * Turns a topic's raw attributes (as stored in idealProposals.json —
 * {name, proposal, included} entries) into CSV text: three columns,
 * "Name", "Ideal proposal", and "Include", matching the attribute
 * editor table's own headers. Every attribute is exported regardless
 * of its included/excluded state — this is a full dump of the topic's
 * attribute rows, not a preview of what an actual comparison run would
 * analyze, so the "Include" column is what tells a reader which rows
 * are currently excluded rather than the export silently dropping
 * them. `included` is written out as the literal strings "TRUE"/
 * "FALSE" (via isAttributeIncluded()'s same missing-means-true
 * default, so a pre-existing attribute with no `included` field at
 * all still exports as "TRUE") rather than a raw boolean, since CSV
 * has no native boolean type and this keeps the column unambiguous
 * however the file is later opened or re-imported. Deliberately does
 * NOT try to split a combined name back out into separate columns by
 * its " - " join separator (see JOIN_SEPARATOR in src/xlsxImport.js)
 * — that combining only ever happens on the way IN, from an xlsx
 * import; the export's job is just to hand back exactly what's
 * stored, with the same CSV escaping and leading BOM as
 * buildAttributeResultsCsv() above.
 */
function buildRubricAttributesCsv(attributes) {
  const rows = [['Name', 'Ideal proposal', 'Include']];
  for (const a of attributes || []) {
    rows.push([a.name, a.proposal, a.included !== false ? 'TRUE' : 'FALSE']);
  }
  return '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

// escapeHtml() now lives in reportHtml.js (loaded via <script> before
// this file in index.html) — used throughout this file exactly as
// before, just no longer defined here. See that file's doc comment for
// why it moved (a Node-safe implementation, not the DOM-based
// `div.textContent`/`innerHTML` trick this used to use, so the exact
// same function is usable from the server's completion-email code too).

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
// The page's sections are grouped into four always-present panel
// divs in index.html (#tabPanel-documents, #tabPanel-rubric,
// #tabPanel-query, #tabPanel-logs) — "Document Management," "Rubric
// Control," "Query and Response," and "Logs" respectively. Switching tabs only ever toggles
// each panel's own display:block/none; nothing inside a panel is
// re-rendered, rebuilt, or removed from the DOM when it's hidden, so
// in-progress state in a tab you switch away from (a half-typed
// question, an open Advanced settings section, a query still
// streaming in) is still exactly as you left it when you switch back.
// This is also why none of the existing element ids or event-handling
// code elsewhere in this file needed to change for tabs to exist —
// every element a handler looks up is still on the page, just
// sometimes inside a panel with display:none.
// 'intro' listed first specifically so TAB_IDS[0] — the fallback used
// below both when localStorage has no stored tab yet (a brand new
// visitor) and when it holds something unrecognized — lands a
// first-time visitor on the Introduction tab rather than the middle
// of the app. Anyone who has already used the app keeps whatever tab
// they were last on, same as always.
// 'bestPractices' registered here (and nowhere else in this file) so
// the existing hamburger-menu/tab-switching machinery below knows that
// panel exists. Its own behavior -- what's in the panel, what it does
// on click -- is intentionally NOT in this file; see
// public/bestPracticesTab.js's doc comment for why that's kept
// separate, and index.html's <body onload> for how it gets
// initialized without this file ever calling into it.
const TAB_IDS = ['intro', 'documents', 'rubric', 'query', 'bestPractices', 'logs'];
const TAB_LABELS = {
  intro: 'Introduction',
  documents: 'Document Management',
  rubric: 'Rubric Control',
  query: 'Query and Response',
  bestPractices: 'Best Practices Comparison',
  logs: 'Logs',
};
// Which tab was open persists across a reload, same
// localStorage-per-browser convention initSectionToggle() above uses
// for collapsible sections — a low-risk, easily-reversible nicety
// (falls back to the first tab if storage is unavailable or empty).
const TAB_STORAGE_KEY = 'local-rag:activeTab';

let tabMenuBtn, tabMenuList, tabMenuActiveLabel, appHeaderHints;

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

  // The Document storage area card only matters for Documents and
  // Query — both work within one storage area at a time. Rubric
  // topics (idealProposals.json) and the Logs tab are both global,
  // not scoped to any one storage area (none of the /ideal-proposals
  // routes in index.js take a workspaceId, same as /logs), so the
  // card would just be irrelevant filler on either of those tabs; the
  // Introduction tab is excluded for the same reason — it isn't
  // scoped to anything, it's just background reading (see
  // #introContent/loadIntroContent() below). Its slot at the top of
  // the page is reused for the log entry detail card while on Logs
  // specifically (see logEntryDetailWrap below), since that card
  // wants the same prominent, no-scrolling-needed position given how
  // long the entry list further down #tabPanel-logs can get; Rubric
  // and Introduction just leave that slot empty.
  // Guarded with `if` since setActiveTab() runs once during
  // initTabs(), before every element below it in init() has
  // necessarily been assigned yet in every possible init ordering.
  const workspaceScopedTab = tabId !== 'logs' && tabId !== 'rubric' && tabId !== 'intro';
  if (workspaceCard) workspaceCard.style.display = workspaceScopedTab ? '' : 'none';
  if (logEntryDetailWrap) logEntryDetailWrap.style.display = tabId === 'logs' ? '' : 'none';

  // The two "Everything below works within a single storage area..." /
  // "For more detail about any item..." lines in the header describe
  // how the OTHER tabs work — neither a storage area nor an
  // information-icon tip exists on the Introduction tab, so showing
  // them there is just confusing. See index.html's own comment on
  // #appHeaderHints.
  if (appHeaderHints) appHeaderHints.style.display = tabId === 'intro' ? 'none' : '';

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

// ---- Role (client-side-only; see GET /auth/me and src/basicAuth.js) ----
//
// Hides UI elements only — see src/basicAuth.js's own doc comment, and
// the README's "Access control" section, for why nothing server-side
// actually enforces any of this: every route behind a hidden button
// is still reachable by anyone willing to open devtools or build the
// request by hand. That's a deliberate, accepted tradeoff for now, not
// an oversight.
//
// Defaults to 'admin' (i.e. hide nothing) both before initRole() below
// resolves and if it fails to resolve at all — the same
// "unconfigured/unknown means unrestricted" default resolveRole() in
// src/basicAuth.js uses when no Basic Auth is configured, extended
// here to "a broken or missing /auth/me fetch" so a network hiccup
// never hides more of the page than it showed before this feature
// existed.
let currentRole = 'admin';

/**
 * Adds/removes "role-readonly"/"role-queryonly" on <body> — see the
 * matching ".role-readonly"/".role-queryonly" rules in style.css for
 * exactly what each one hides — and, for queryonly specifically, also
 * forces the Query and Response tab active even if a previous visit's
 * localStorage (see TAB_STORAGE_KEY above) still points somewhere
 * else, e.g. a stale "documents"/"rubric" value left over from before
 * this role existed, or from sharing a browser profile with an admin.
 * Safe to call any time after initTabs() has run — see initRole()
 * below for why that ordering is guaranteed without the two needing
 * to coordinate explicitly.
 *
 * The rubric Save button, and every already-rendered document
 * description field and Include checkbox, are handled here directly
 * (disabled/read-only outright) rather than through a CSS rule like
 * everything else, specifically so they stay that way rather than
 * depending on nothing else in the file ever touching
 * `.disabled`/`.readOnly` again — see submitRubricForm()'s,
 * saveDocumentDescription()'s, and saveDocumentIncluded()'s own
 * early-return guards for the second, independent check that backs
 * each of those up if the attribute is ever bypassed some other way
 * (devtools included — see this function's own "not a security
 * boundary" note above; those guards are about robustness, not
 * security). Re-applying to already-rendered fields here (rather than
 * only at render time in refreshDocuments()) covers the case where a
 * document list was drawn before this function's first call — GET
 * /auth/me resolving is a network round-trip, so it's entirely
 * possible someone picks a storage area before it finishes.
 * @param {'admin'|'readonly'|'queryonly'} role
 */
function applyRolePermissions(role) {
  currentRole = role;
  document.body.classList.remove('role-readonly', 'role-queryonly');
  rubricSaveBtn.disabled = role === 'readonly';
  for (const input of document.querySelectorAll('.doc-description-input')) {
    input.readOnly = role !== 'admin';
  }
  for (const checkbox of document.querySelectorAll('.doc-included-checkbox')) {
    checkbox.disabled = role !== 'admin';
  }
  if (role === 'readonly') document.body.classList.add('role-readonly');
  if (role === 'queryonly') {
    document.body.classList.add('role-queryonly');
    setActiveTab('query');
  }

  // Best Practices Comparison is admin-only (see the matching
  // .role-readonly/.role-queryonly rule in style.css hiding its menu
  // item). For queryonly the unconditional setActiveTab('query') call
  // above already moves off of it every time regardless, but readonly
  // has no forced tab of its own -- this covers the one case that
  // would otherwise slip through: a readonly user whose stored
  // last-active tab (see TAB_STORAGE_KEY above) is still
  // 'bestPractices' from before they were demoted from admin, or from
  // sharing a browser profile with an admin. Same "stale localStorage"
  // scenario this function's own doc comment already describes for
  // queryonly, just applied to this one tab for every non-admin role.
  if (role !== 'admin') {
    const activeItem = tabMenuList.querySelector('.tab-menu-item.active');
    if (activeItem && activeItem.dataset.tab === 'bestPractices') {
      setActiveTab('query');
    }
  }
}

/**
 * Finds out who's logged in, if anyone, and which role that resolves
 * to (GET /auth/me in index.js, backed by resolveRole() in
 * src/basicAuth.js), then applies it. Called from init() alongside its
 * other initial data loads — same fire-and-forget pattern
 * applyConfig()/refreshWorkspaces() there already use, not awaited —
 * so this resolving slightly after the rest of the page is already
 * interactive just means a brief moment before role-based hiding
 * kicks in, same tradeoff those other initial loads already accept.
 * This always resolves AFTER initTabs() has already run: a fetch's
 * continuation can't run until the current synchronous call stack —
 * all of init(), including its own initTabs() call — has finished, so
 * applyRolePermissions()'s setActiveTab() call above always finds
 * tabMenuList already assigned.
 */
async function initRole() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    applyRolePermissions(['admin', 'readonly', 'queryonly'].includes(data.role) ? data.role : 'admin');
  } catch (err) {
    // Network hiccup, or an older server without this route yet —
    // fail open to 'admin' (i.e. change nothing) rather than leaving
    // the page in some half-applied state.
    console.warn('Could not look up login role; showing full access.', err);
  }
}

// ---- Logs tab ----
//
// Backs #tabPanel-logs: pick a log file -> see a compact, newest-first
// list of its lines as clickable rows (summarizeLogFile() on the
// server never sends the full record, let alone `answer`, for every
// line at once) -> click one to see everything about that entry
// EXCEPT its answer (getLogEntry() strips that out server-side too)
// -> optionally click "Show answer" to fetch just that one field.
// Three separate fetches of increasing weight, same "don't pull the
// heavy part over the wire until it's actually asked for" shape
// showChunkModal() above already uses for block text.
//
// Per explicit user direction: the detail view is INLINE (not a
// modal), and every new detail render REPLACES logEntryDetailBody's
// content rather than appending to it — clicking a different entry,
// or reloading the row list, must never leave the page accumulating
// old detail sections. Filtering/searching the entry list is
// deliberately not implemented (also per that direction) — every
// entry in the selected file is always shown.
let logFileSelect, logFileHint, logsRefreshBtn, logsStatus, logsError;
let logEntriesBody;
let logEntryDetailWrap, logEntryDetailPlaceholder, logEntryDetailBody, logAnswerButtonRow, showLogAnswerBtn, logAnswerWrap, logAnswerBody;

// The Document storage area card at the top of the page (outside every
// tab panel, since Documents/Rubric/Query all need it) — hidden while
// the Logs tab is active, since Logs isn't scoped to a storage area at
// all, and its slot in the layout is reused for logEntryDetailWrap
// instead. See setActiveTab().
let workspaceCard;

// Which file/line the currently-shown detail (if any) belongs to —
// only used by the "Show answer" handler, so it knows what to fetch
// without re-reading it out of the DOM.
let currentLogLine = null;

// Friendly display names for the fields getLogEntry() can return.
// Anything not listed here still renders — just under its raw key
// name — so a future field activityLog.js starts writing shows up
// automatically instead of silently vanishing from the detail view.
const LOG_FIELD_LABELS = {
  timestamp: 'Time',
  type: 'Type',
  workspaceId: 'Storage area',
  topicId: 'Topic ID',
  topicLabel: 'Topic',
  sourceFile: 'Source file',
  question: 'Question',
  status: 'Status',
  chatModel: 'Chat model',
  error: 'Error',
  sourceChunkIds: 'Source blocks',
  success: 'Success',
  ip: 'IP address',
  user: 'User',
  to: 'Sent to',
};

function formatLogFieldValue(key, value) {
  if (key === 'timestamp') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

function logEntryScopeLabel(s) {
  if (s.workspaceId && s.topicLabel) return `${s.workspaceId} — ${s.topicLabel}`;
  if (s.workspaceId && s.topicId) return `${s.workspaceId} — ${s.topicId}`;
  if (s.workspaceId) return s.workspaceId;
  if (s.topicLabel) return s.topicLabel;
  if (s.topicId) return s.topicId;
  if (s.sourceFile) return s.sourceFile;
  return '';
}

// Same "who" convention as the README's "Activity log" section and
// logViewer.js's summarizeEntry(): a real username when Basic Auth is
// configured with named users, the IP address otherwise — whichever
// one this entry actually has.
function logEntryWhoLabel(s) {
  return s.user || s.ip || '';
}

function logEntryStatusLabel(s) {
  if (s.broken) return '(unreadable line)';
  if (s.status) return s.status;
  if (typeof s.success === 'boolean') return s.success ? 'success' : 'failed';
  return '';
}

/**
 * Renders the clickable per-line list for whichever file is currently
 * selected. Each row carries the line's own stable index in
 * data-line (see logViewer.js's doc comment on why that index is
 * safe to reuse later, even after more lines are appended) and a
 * .chunk-link-styled button in its first cell — the actual
 * "clickable link" the row is built around, with the whole row also
 * clickable via the delegated listener wired in init().
 */
function renderLogEntriesTable(summaries) {
  logEntriesBody.innerHTML = '';

  if (!summaries.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'muted';
    td.textContent = 'No entries in this log file yet.';
    tr.appendChild(td);
    logEntriesBody.appendChild(tr);
    return;
  }

  for (const s of summaries) {
    const tr = document.createElement('tr');
    tr.dataset.line = String(s.line);
    if (s.broken) tr.classList.add('log-row-broken');

    const timeTd = document.createElement('td');
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'chunk-link';
    link.textContent = s.timestamp ? new Date(s.timestamp).toLocaleString() : `Line ${s.line}`;
    timeTd.appendChild(link);
    tr.appendChild(timeTd);

    const whoTd = document.createElement('td');
    whoTd.textContent = logEntryWhoLabel(s);
    tr.appendChild(whoTd);

    const typeTd = document.createElement('td');
    typeTd.textContent = s.type || '';
    tr.appendChild(typeTd);

    const scopeTd = document.createElement('td');
    scopeTd.textContent = logEntryScopeLabel(s);
    tr.appendChild(scopeTd);

    const statusTd = document.createElement('td');
    statusTd.textContent = logEntryStatusLabel(s);
    tr.appendChild(statusTd);

    logEntriesBody.appendChild(tr);
  }
}

/**
 * Resets the entry-detail card back to its empty placeholder state —
 * used whenever the selected file changes, the file list is
 * refreshed, or there's simply nothing (yet) to show detail for. Also
 * drops the row highlighting and the last-shown-answer state, so
 * nothing from a previous file or entry can leak into whatever's
 * shown next. Note this does NOT hide logEntryDetailWrap itself — that
 * card's own visibility is tied to which tab is active (see
 * setActiveTab()), not to whether an entry is currently selected; this
 * only resets its content back to the "nothing selected yet" state.
 */
function resetLogEntryDetail() {
  logEntryDetailBody.innerHTML = '';
  logEntryDetailBody.style.display = 'none';
  logEntryDetailPlaceholder.style.display = 'block';
  logAnswerWrap.style.display = 'none';
  logAnswerBody.textContent = '';
  logAnswerButtonRow.style.display = 'none';
  showLogAnswerBtn.disabled = false;
  currentLogLine = null;
  for (const tr of logEntriesBody.querySelectorAll('tr[data-line]')) {
    tr.classList.remove('selected');
  }
}

/**
 * Fetches and shows the full detail (everything except `answer`) for
 * one line of the currently-selected file. Always starts by wiping
 * logEntryDetailBody's previous content — see this section's own
 * top-of-block comment for why that's a hard requirement here, not
 * just tidiness.
 * @param {number} line
 */
async function showLogEntryDetail(line) {
  const name = logFileSelect.value;
  if (!name) return;

  currentLogLine = line;

  logEntryDetailPlaceholder.style.display = 'none';
  logEntryDetailBody.style.display = 'grid';
  logEntryDetailBody.innerHTML = '';
  const loadingDt = document.createElement('dt');
  loadingDt.textContent = 'Loading…';
  logEntryDetailBody.appendChild(loadingDt);
  logAnswerWrap.style.display = 'none';
  logAnswerBody.textContent = '';
  logAnswerButtonRow.style.display = 'none';
  showLogAnswerBtn.disabled = false;

  for (const tr of logEntriesBody.querySelectorAll('tr[data-line]')) {
    tr.classList.toggle('selected', tr.dataset.line === String(line));
  }

  try {
    const res = await fetch(`/logs/${encodeURIComponent(name)}/lines/${line}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);

    logEntryDetailBody.innerHTML = '';

    if (data.broken) {
      const dt = document.createElement('dt');
      dt.textContent = 'This line could not be read';
      const dd = document.createElement('dd');
      dd.textContent = data.raw || '(no content)';
      logEntryDetailBody.appendChild(dt);
      logEntryDetailBody.appendChild(dd);
      return;
    }

    for (const key of Object.keys(data)) {
      // hasAnswer only drives the button below, not a row of its own;
      // line is already shown via the selected row itself.
      if (key === 'hasAnswer' || key === 'line') continue;
      const value = data[key];
      if (value === undefined || value === null || value === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = LOG_FIELD_LABELS[key] || key;
      const dd = document.createElement('dd');
      dd.textContent = formatLogFieldValue(key, value);
      logEntryDetailBody.appendChild(dt);
      logEntryDetailBody.appendChild(dd);
    }

    if (data.hasAnswer) {
      logAnswerButtonRow.style.display = 'block';
    }
  } catch (err) {
    logEntryDetailBody.innerHTML = '';
    const dt = document.createElement('dt');
    dt.textContent = 'Error';
    const dd = document.createElement('dd');
    dd.textContent = err.message;
    logEntryDetailBody.appendChild(dt);
    logEntryDetailBody.appendChild(dd);
  }
}

/**
 * Loads the compact per-line list for whichever file is now selected.
 * Always clears any open detail first — a detail view left over from
 * a different file would show a line index that means something else
 * entirely in this one.
 */
async function loadLogFileSummaries() {
  const name = logFileSelect.value;
  resetLogEntryDetail();
  logsError.style.display = 'none';

  if (!name) {
    logEntriesBody.innerHTML = '';
    logFileHint.textContent = '';
    return;
  }

  logsStatus.textContent = 'Loading…';
  try {
    const res = await fetch(`/logs/${encodeURIComponent(name)}/summaries`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);

    renderLogEntriesTable(data.summaries);
    logFileHint.textContent =
      `${data.lineCount} entr${data.lineCount === 1 ? 'y' : 'ies'} in this file, newest first.`;
    logsStatus.textContent = '';
  } catch (err) {
    logEntriesBody.innerHTML = '';
    logsError.textContent = err.message;
    logsError.style.display = 'block';
    logsStatus.textContent = '';
  }
}

/**
 * Loads which log files exist (GET /logs) and repopulates the file
 * picker, same refreshModels()-style pattern above. Keeps whatever
 * file was already selected if it's still there — a plain Refresh
 * shouldn't silently jump someone to a different file — otherwise
 * lands on the newest one.
 */
async function refreshLogFiles() {
  logsError.style.display = 'none';
  const previousSelection = logFileSelect.value;

  try {
    const res = await fetch('/logs');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load log files');

    const files = data.files || [];
    logFileSelect.innerHTML = '';

    if (files.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No log files yet';
      logFileSelect.appendChild(opt);
      logFileHint.textContent = '';
      logEntriesBody.innerHTML = '';
      resetLogEntryDetail();
      return;
    }

    for (const f of files) {
      const opt = document.createElement('option');
      opt.value = f.name;
      const kindLabel = f.kind === 'activity' ? 'Activity' : 'Actions';
      opt.textContent = `${kindLabel} — ${f.year}-${String(f.month).padStart(2, '0')} (${f.lineCount})`;
      logFileSelect.appendChild(opt);
    }

    logFileSelect.value =
      previousSelection && files.some((f) => f.name === previousSelection)
        ? previousSelection
        : files[0].name;

    await loadLogFileSummaries();
  } catch (err) {
    logsError.textContent = err.message;
    logsError.style.display = 'block';
  }
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
let rubricAttributesBody, rubricAddAttributeBtn, rubricIncludeAllBtn, rubricExcludeAllBtn;
let rubricXlsxFile, rubricXlsxFieldsRow, rubricXlsxSheet, rubricXlsxNameColumns, rubricXlsxProposalColumn, rubricXlsxImportBtn, rubricXlsxStatus, rubricXlsxError;
let rubricSaveBtn, rubricCancelEditBtn, rubricExportCsvBtn, rubricFormStatus, rubricFormError;

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
 * Appends one editable attribute row (name + proposal + include
 * checkbox + remove button). Both text fields are <textarea>s rather
 * than single-line <input>s — a name built from several joined
 * spreadsheet columns (see excel_to_json.py's JOIN_SEPARATOR) and
 * especially a proposal's ideal-condition text routinely run well past
 * what a single-line input can show at once, forcing horizontal
 * scrolling inside a tiny box to read or edit the whole thing. A
 * <textarea> wraps instead, showing several lines up front, and can
 * still be dragged taller via its own resize handle (see the CSS) for
 * anything longer than that. `rows` just sets the starting height —
 * normal textarea behavior, not a length limit; nothing about how the
 * value is read (still a single string, still trimmed) or saved
 * changes because of this.
 *
 * `included` defaults to true, matching isAttributeIncluded()'s
 * "missing means true" default in src/idealProposals.js — so both a
 * brand-new row (added via "Add attribute") and a row loaded from an
 * older saved attribute with no `included` field at all start out
 * checked.
 */
function addRubricAttributeRow(name = '', proposal = '', included = true) {
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

  const includedTd = document.createElement('td');
  includedTd.className = 'rubric-attr-included-cell';
  const includedInput = document.createElement('input');
  includedInput.type = 'checkbox';
  includedInput.className = 'rubric-attr-included';
  includedInput.checked = included !== false;
  includedTd.appendChild(includedInput);

  const actionsTd = document.createElement('td');
  actionsTd.className = 'rubric-attr-actions-cell';

  // Reordering is plain DOM manipulation (swap this row with its
  // neighbor) rather than anything touching a separate order/index
  // field — readRubricAttributeRows() below already reads attributes
  // back in whatever order the rows are actually in, and nothing
  // server-side or in the results table re-sorts them (see
  // batchAttributes()/getIncludedAttributes() in index.js and
  // responseParser.js's per-attribute splitting, both of which just
  // walk the array in order), so moving a row on screen is the whole
  // feature — there's nothing else to keep in sync.
  const moveUpBtn = document.createElement('button');
  moveUpBtn.type = 'button';
  moveUpBtn.className = 'btn-secondary rubric-attr-move rubric-attr-move-up';
  moveUpBtn.textContent = '▲';
  moveUpBtn.title = 'Move attribute up';
  moveUpBtn.setAttribute('aria-label', 'Move attribute up');
  moveUpBtn.addEventListener('click', () => {
    const prev = tr.previousElementSibling;
    if (!prev) return;
    rubricAttributesBody.insertBefore(tr, prev);
    updateRubricAttributeMoveButtons();
  });

  const moveDownBtn = document.createElement('button');
  moveDownBtn.type = 'button';
  moveDownBtn.className = 'btn-secondary rubric-attr-move rubric-attr-move-down';
  moveDownBtn.textContent = '▼';
  moveDownBtn.title = 'Move attribute down';
  moveDownBtn.setAttribute('aria-label', 'Move attribute down');
  moveDownBtn.addEventListener('click', () => {
    const next = tr.nextElementSibling;
    if (!next) return;
    rubricAttributesBody.insertBefore(next, tr);
    updateRubricAttributeMoveButtons();
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    tr.remove();
    updateRubricAttributeMoveButtons();
  });

  actionsTd.appendChild(moveUpBtn);
  actionsTd.appendChild(moveDownBtn);
  actionsTd.appendChild(removeBtn);

  tr.appendChild(nameTd);
  tr.appendChild(proposalTd);
  tr.appendChild(includedTd);
  tr.appendChild(actionsTd);
  rubricAttributesBody.appendChild(tr);
  updateRubricAttributeMoveButtons();
}

/**
 * Enables/disables each attribute row's up/down buttons based on its
 * current position — the first row can't move up, the last can't move
 * down. Called after every add, remove, or move, so a boundary button
 * never sits there clickable but a no-op.
 */
function updateRubricAttributeMoveButtons() {
  const rows = [...rubricAttributesBody.querySelectorAll('tr')];
  rows.forEach((row, i) => {
    const upBtn = row.querySelector('.rubric-attr-move-up');
    const downBtn = row.querySelector('.rubric-attr-move-down');
    if (upBtn) upBtn.disabled = i === 0;
    if (downBtn) downBtn.disabled = i === rows.length - 1;
  });
}

function clearRubricAttributeRows() {
  rubricAttributesBody.innerHTML = '';
}

/**
 * Reads the attribute editor's rows back into
 * `[{name, proposal, included}, ...]`. A row left completely blank
 * (added via "Add attribute" and never filled in) is silently dropped;
 * a row with only one of the two text fields filled in is kept as-is
 * so the server's own validation catches and reports it clearly,
 * rather than this function guessing whether that was a mistake worth
 * silently discarding. `included` always comes back as an explicit
 * boolean (the checkbox's own checked state), never omitted — the
 * server-side normalizeAttributesForSave() in index.js does the same
 * for any caller that skips this form entirely (e.g. a future API
 * client), but going through this function is how the editor itself
 * always saves an explicit value rather than leaning on the
 * missing-means-true fallback.
 */
function readRubricAttributeRows() {
  return [...rubricAttributesBody.querySelectorAll('tr')]
    .map((tr) => ({
      name: tr.querySelector('.rubric-attr-name').value.trim(),
      proposal: tr.querySelector('.rubric-attr-proposal').value.trim(),
      included: tr.querySelector('.rubric-attr-included').checked,
    }))
    .filter((a) => a.name || a.proposal);
}

/** Sets every attribute row's Include checkbox to `included`. */
function setAllRubricAttributesIncluded(included) {
  for (const cb of rubricAttributesBody.querySelectorAll('.rubric-attr-included')) {
    cb.checked = included;
  }
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
  rubricExportCsvBtn.style.display = 'none';
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
    rubricExportCsvBtn.style.display = '';

    clearRubricAttributeRows();
    const attrs = topic.attributes || [];
    if (attrs.length) {
      for (const a of attrs) addRubricAttributeRow(a.name, a.proposal, a.included !== false);
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
 * Exports the topic currently loaded for editing (rubricEditingTopicId)
 * as a "Name,Ideal proposal,Include" CSV, every attribute included
 * regardless of its own included/excluded state — see
 * buildRubricAttributesCsv() above for the exact shape.
 *
 * Deliberately re-fetches the topic from the server (GET
 * /ideal-proposals/:id) rather than reading whatever is currently
 * sitting in the attribute-rows editor: the form can hold unsaved
 * edits (a row added, a name/proposal tweaked, an xlsx import staged)
 * that haven't gone through Save yet, and this export is meant to
 * reflect exactly what's in idealProposals.json right now, not a
 * preview of in-progress changes — an explicit design decision, not an
 * oversight, so someone exporting mid-edit gets the last SAVED version
 * rather than being surprised by half-finished edits leaking into a
 * file they might hand to someone else.
 */
async function exportRubricCsv() {
  if (!rubricEditingTopicId) return; // button is hidden in this state anyway; guard defensively
  rubricFormError.style.display = 'none';
  try {
    const res = await fetch(`/ideal-proposals/${encodeURIComponent(rubricEditingTopicId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load topic for export');
    const topic = data.topic;

    const csv = buildRubricAttributesCsv(topic.attributes || []);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${topic.id}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    rubricFormError.textContent = err.message;
    rubricFormError.style.display = 'block';
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

  // Belt-and-suspenders: applyRolePermissions() above already
  // disables rubricSaveBtn for this role, which is normally enough on
  // its own to keep this function from ever being reached (a disabled
  // submit button fires neither a click nor the browser's own
  // implicit-submit-on-Enter). This check is here only in case that
  // ever stops being true some other way — it is NOT a security
  // boundary, since nothing stops a request straight to
  // POST/PUT /ideal-proposals either (see src/basicAuth.js's own doc
  // comment on this whole feature being UI-only).
  if (currentRole === 'readonly') {
    rubricFormError.textContent = 'Read-only access: rubric topics cannot be saved.';
    rubricFormError.style.display = 'block';
    return;
  }

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
 * @param {boolean} [notifyEmail] - the "Email me when this finishes"
 *   checkbox. Only has any effect when idealTopicId is also set,
 *   `notifyEmailTo` is a valid address (see below), and the run
 *   completes normally (not aborted/errored) — see
 *   sendRubricCompletionEmail() in src/emailNotify.js, called from
 *   /query/stream right after its own "done" event. False/omitted
 *   sends nothing, same as before this setting existed.
 * @param {string} [notifyEmailTo] - the recipient typed into the box
 *   next to that checkbox. The caller below already blocks submission
 *   unless this is checkbox-off or a validated address (see
 *   isValidEmailAddress() in public/validation.js), but the server
 *   independently re-validates it too before ever sending anything —
 *   see /query/stream in index.js — rather than trusting this fetch
 *   body, since a hand-built request (README.md's "Testing with
 *   PowerShell" section) skips this function, and this one, entirely.
 */
async function queryWithStream(workspaceId, question, topK, chatModel, temperature, maxTokens, numCtx, repeatPenalty, idealTopicId, attributesPerCall, think, notifyEmail, notifyEmailTo, threshold, retryNotAddressed, onEvent, signal) {
  const res = await fetch('/query/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // chatModel/temperature/maxTokens/numCtx/repeatPenalty/idealTopicId/attributesPerCall/think/notifyEmail/notifyEmailTo
    // undefined (nothing usable selected, or the field was cleared)
    // just omits that key from the JSON body entirely, and
    // /query/stream's own default takes over server-side — for
    // maxTokens that's "no cap," for numCtx that's "use the model's
    // own default," for repeatPenalty that's "use the model's own
    // default (usually 1.1)," for idealTopicId that's "answer
    // normally, no comparison," for attributesPerCall that's "ask
    // about every attribute in one call," for think that's "leave
    // Ollama's own default alone" (see the think param doc above),
    // for notifyEmail/notifyEmailTo that's "don't send anything."
    // `threshold` is sent here (unlike everywhere else it's used —
    // see renderSources()/renderSourceChips() above, purely
    // client-side display) specifically so /query/stream can gate the
    // "retry Not addressed with the next batch of chunks" feature on
    // it server-side; see that route's own comment for why. Sent
    // whenever this call is made at all, since it always has a real
    // value (the field always has a number in it, never blank) —
    // there's no "leave it out to get a default" meaning to preserve
    // the way there is for the others above. `retryNotAddressed` is
    // the "Retry Not addressed..." checkbox's plain boolean, off by
    // default; omitted entirely would be indistinguishable from
    // false, so it's always sent too.
    body: JSON.stringify({ question, workspaceId, topK, chatModel, temperature, maxTokens, numCtx, repeatPenalty, idealTopicId, attributesPerCall, think, notifyEmail, notifyEmailTo, threshold, retryNotAddressed }),
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
  introContentEl = document.getElementById('introContent');
  appHeaderHints = document.getElementById('appHeaderHints');

  workspaceCard = document.getElementById('workspaceCard');
  workspaceInput = document.getElementById('workspace');
  workspaceList = document.getElementById('workspaceList');

  chatModelSelect = document.getElementById('chatModel');
  chatModelHint = document.getElementById('chatModelHint');

  temperatureInput = document.getElementById('temperature');
  temperatureSuggestionWrap = document.getElementById('temperatureSuggestion');
  temperatureSuggestionText = document.getElementById('temperatureSuggestionText');
  temperatureSuggestionApplyBtn = document.getElementById('temperatureSuggestionApply');
  const temperatureSuggestionDismissBtn = document.getElementById('temperatureSuggestionDismiss');
  queryAdvancedSettings = document.getElementById('queryAdvancedSettings');

  // Re-evaluated on every chat-model change and every edit to the
  // field itself — see updateTemperatureSuggestion()'s own doc comment
  // above for why both matter. refreshModels() below (which can change
  // chatModelSelect.value once the pulled-models list loads) triggers
  // its own check once that fetch resolves.
  chatModelSelect.addEventListener('change', updateTemperatureSuggestion);
  temperatureInput.addEventListener('input', updateTemperatureSuggestion);
  temperatureSuggestionApplyBtn.addEventListener('click', () => {
    temperatureInput.value = temperatureSuggestionApplyBtn.dataset.recommendedTemperature;
    // Re-check rather than just hiding directly: the field's new value
    // no longer qualifies (see updateTemperatureSuggestion()'s
    // shouldShow check), so this naturally hides the box without
    // needing its own separate "hide" branch to stay in sync with that
    // logic.
    updateTemperatureSuggestion();
  });
  temperatureSuggestionDismissBtn.addEventListener('click', () => {
    temperatureSuggestionDismissedFor = chatModelSelect.value;
    updateTemperatureSuggestion();
  });

  idealTopicSelect = document.getElementById('idealTopic');
  idealTopicHint = document.getElementById('idealTopicHint');
  idealTopicHintDefault = idealTopicHint.textContent;

  documentsWrap = document.getElementById('documentsWrap');
  documentsEmpty = document.getElementById('documentsEmpty');
  documentsBody = document.getElementById('documentsBody');
  documentsError = document.getElementById('documentsError');
  documentsExcludedNote = document.getElementById('documentsExcludedNote');

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

  queryForm = document.getElementById('queryForm');
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
  retryNotAddressedCheckbox = document.getElementById('retryNotAddressed');
  notifyEmailCheckbox = document.getElementById('notifyEmail');
  notifyEmailToInput = document.getElementById('notifyEmailTo');
  notifyEmailToError = document.getElementById('notifyEmailToError');
  reasoningWrap = document.getElementById('reasoningWrap');
  reasoningEl = document.getElementById('reasoningEl');

  attributeResultsWrap = document.getElementById('attributeResultsWrap');
  attributeResultsBody = document.getElementById('attributeResultsBody');
  downloadCsvBtn = document.getElementById('downloadCsvBtn');
  downloadHtmlBtn = document.getElementById('downloadHtmlBtn');

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
  rubricIncludeAllBtn = document.getElementById('rubricIncludeAllBtn');
  rubricExcludeAllBtn = document.getElementById('rubricExcludeAllBtn');

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
  rubricExportCsvBtn = document.getElementById('rubricExportCsvBtn');
  rubricFormStatus = document.getElementById('rubricFormStatus');
  rubricFormError = document.getElementById('rubricFormError');

  logFileSelect = document.getElementById('logFileSelect');
  logFileHint = document.getElementById('logFileHint');
  logsRefreshBtn = document.getElementById('logsRefreshBtn');
  logsStatus = document.getElementById('logsStatus');
  logsError = document.getElementById('logsError');
  logEntriesBody = document.getElementById('logEntriesBody');
  logEntryDetailWrap = document.getElementById('logEntryDetailWrap');
  logEntryDetailPlaceholder = document.getElementById('logEntryDetailPlaceholder');
  logEntryDetailBody = document.getElementById('logEntryDetailBody');
  logAnswerButtonRow = document.getElementById('logAnswerButtonRow');
  showLogAnswerBtn = document.getElementById('showLogAnswerBtn');
  logAnswerWrap = document.getElementById('logAnswerWrap');
  logAnswerBody = document.getElementById('logAnswerBody');

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

  // Saves a document's description once its field loses focus.
  // 'focusout' (unlike plain 'blur') bubbles, so one delegated
  // listener here covers every row, including ones added by a later
  // refreshDocuments() — same reasoning the Remove-button listener
  // above already relies on.
  documentsBody.addEventListener('focusout', (e) => {
    const input = e.target.closest('.doc-description-input');
    if (!input) return;
    saveDocumentDescription(input);
  });

  // Saves a document's Include checkbox the moment it's toggled — see
  // saveDocumentIncluded()'s own doc comment for why this fires on
  // 'change' (not 'focusout', the description field's own save
  // trigger): a checkbox's toggle already IS the deliberate action,
  // there's no "still typing" state to wait out first. Same delegated-
  // listener reasoning as every other one here: covers every row,
  // including ones added by a later refreshDocuments().
  documentsBody.addEventListener('change', (e) => {
    const checkbox = e.target.closest('.doc-included-checkbox');
    if (!checkbox) return;
    saveDocumentIncluded(checkbox);
  });

  // Plain Enter inserts a newline, same as any multi-line textarea —
  // deliberately NOT intercepted here, unlike the single-line fields
  // elsewhere in this app that submit on Enter. Ctrl/Cmd+Enter (the
  // same "done, but let plain Enter stay a newline" convention several
  // other multi-line text boxes use) blurs the field instead, to reach
  // the same 'focusout' save path above without having to click away
  // first.
  documentsBody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const input = e.target.closest('.doc-description-input');
    if (!input) return;
    e.preventDefault();
    input.blur();
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

  // ---- Logs tab ----

  logFileSelect.addEventListener('change', loadLogFileSummaries);
  logsRefreshBtn.addEventListener('click', refreshLogFiles);

  // One delegated listener for every row, same pattern documentsBody's
  // Remove buttons and rubricTopicsBody's Edit/Delete buttons use above
  // — rows added by a later refresh need no re-attachment.
  logEntriesBody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-line]');
    if (!tr) return;
    showLogEntryDetail(Number(tr.dataset.line));
  });

  showLogAnswerBtn.addEventListener('click', async () => {
    const name = logFileSelect.value;
    if (!name || currentLogLine == null) return;

    showLogAnswerBtn.disabled = true;
    logAnswerBody.textContent = 'Loading…';
    logAnswerWrap.style.display = 'block';

    try {
      const res = await fetch(`/logs/${encodeURIComponent(name)}/lines/${currentLogLine}/answer`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);

      logAnswerBody.textContent = data.answer;
      // Revealing it is a one-time action per entry — the button's job
      // is done, and it stays gone until a different entry (with its
      // own hasAnswer check) is clicked, per showLogEntryDetail()/
      // resetLogEntryDetail() above.
      logAnswerButtonRow.style.display = 'none';
    } catch (err) {
      logAnswerBody.textContent = `Could not load answer: ${err.message}`;
      showLogAnswerBtn.disabled = false;
    }
  });

  // ---- Rubric Control ----

  rubricAddAttributeBtn.addEventListener('click', () => addRubricAttributeRow());
  rubricIncludeAllBtn.addEventListener('click', () => setAllRubricAttributesIncluded(true));
  rubricExcludeAllBtn.addEventListener('click', () => setAllRubricAttributesIncluded(false));

  rubricForm.addEventListener('submit', submitRubricForm);

  rubricCancelEditBtn.addEventListener('click', () => resetRubricForm());
  rubricExportCsvBtn.addEventListener('click', () => exportRubricCsv());

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

  downloadHtmlBtn.addEventListener('click', () => {
    const hasRecords = latestBatches.some((b) => b.records && b.records.length);
    if (!hasRecords) return; // shouldn't be clickable when there's nothing to export, but guard anyway

    // Read the same form fields the submit handler does, at export time
    // rather than from any state captured back when the query actually
    // ran — this is just for the report's header, and re-reading live
    // avoids needing to plumb a separate "what were the settings for
    // this answer" object through every batch-done event. Same
    // blank-means-omit / 0-is-meaningful conventions as the submit
    // handler above for each field — see its own comments for why.
    const topK = Number(document.getElementById('topK').value) || 5;
    const rawTemperature = document.getElementById('temperature').value;
    const temperature = rawTemperature === '' || Number.isNaN(Number(rawTemperature))
      ? undefined
      : Number(rawTemperature);
    const rawRepeatPenalty = document.getElementById('repeatPenalty').value;
    const repeatPenalty = rawRepeatPenalty === '' || Number.isNaN(Number(rawRepeatPenalty))
      ? undefined
      : Number(rawRepeatPenalty);
    const rawMaxTokens = document.getElementById('maxTokens').value;
    const maxTokens = rawMaxTokens === '' || Number.isNaN(Number(rawMaxTokens))
      ? undefined
      : Number(rawMaxTokens);
    const rawNumCtx = document.getElementById('numCtx').value;
    const numCtx = rawNumCtx === '' || Number.isNaN(Number(rawNumCtx)) ? undefined : Number(rawNumCtx);
    const rawAttributesPerCall = document.getElementById('attributesPerCall').value;
    const attributesPerCall = rawAttributesPerCall === '' || Number.isNaN(Number(rawAttributesPerCall))
      ? undefined
      : Number(rawAttributesPerCall);
    const think = thinkCheckbox.checked ? undefined : false;
    const selectedTopicOpt = idealTopicSelect.selectedOptions[0];
    const meta = {
      workspaceId: getWorkspaceId() || undefined,
      topicLabel: idealTopicSelect.value ? (selectedTopicOpt?.dataset.label || selectedTopicOpt?.text) : null,
      question: document.getElementById('question').value.trim() || undefined,
      chatModel: chatModelSelect.value || undefined,
      topK,
      temperature,
      repeatPenalty,
      maxTokens,
      numCtx,
      think,
      attributesPerCall,
      appName: currentAppName,
      // Unlike the fields above, NOT re-read live — there's no live
      // form field for "how long did that run take." lastRunElapsedMs
      // is set once, right when the run this data came from actually
      // finished (see the submit handler's `finally` block above), and
      // reset to null at the start of the next one, same lifecycle as
      // latestBatches itself.
      elapsedMs: lastRunElapsedMs != null ? lastRunElapsedMs : undefined,
    };

    const html = buildAttributeResultsHtml(latestBatches, meta);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const workspaceId = getWorkspaceId() || 'results';
    a.download = `${workspaceId}-comparison.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  queryForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    errorEl.style.display = 'none';
    notifyEmailToError.style.display = 'none';
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
    lastRunElapsedMs = null;
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
    // Sent as-is (true or false) rather than the undefined-when-off
    // convention think/maxTokens/etc. use above — the server only ever
    // treats this as a plain boolean gate ("send an email once this
    // finishes, yes or no"), with no separate "leave some other
    // default alone" meaning for a missing value to preserve.
    const notifyEmail = notifyEmailCheckbox.checked;
    const notifyEmailTo = notifyEmailToInput.value.trim();

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

    // Checked here, before the run even starts, rather than only
    // server-side — there's no server-configured fallback recipient
    // (see src/emailNotify.js), so a blank or malformed address here
    // would otherwise mean the whole analysis runs and finishes with
    // nothing to show for the checkbox at all. Blocking submission up
    // front means that's caught immediately instead of discovered
    // afterward. The server independently re-validates the same way
    // (isValidEmailAddress() in public/validation.js, shared by both)
    // before ever actually sending anything — see queryWithStream()'s
    // own doc comment above for why this check alone isn't sufficient
    // on its own.
    if (notifyEmail && !isValidEmailAddress(notifyEmailTo)) {
      notifyEmailToError.textContent = notifyEmailTo
        ? `"${notifyEmailTo}" doesn't look like a valid email address.`
        : 'Enter an email address, or uncheck "Email me when this finishes".';
      notifyEmailToError.style.display = 'block';
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
      const finalEvent = await queryWithStream(workspaceId, question, topK, chatModel, temperature, maxTokens, numCtx, repeatPenalty, idealTopicId, attributesPerCall, think, notifyEmail, notifyEmailTo, threshold, retryNotAddressedCheckbox.checked, (event) => {
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

      // Swap the answer box's text for its verified version, now that
      // the full, final answer is in. Every "Quote: "..." [file, chunk
      // N]" citation the model wrote gets upgraded in place to the real
      // file/chunk it was actually found in (never just the model's own
      // claim) plus a ✓/⚠ marker — see verifyQuotesInPlace() in
      // src/responseParser.js. The verification itself has to happen
      // server-side, where the full retrieved chunk text lives; the
      // browser only ever gets sourceFile/chunkIndex/score up front (see
      // sourcesSummary() in index.js), never enough to check a quote
      // against. `verifiedAnswer` is only set for a plain (non-topic)
      // question — a rubric/comparison run leaves it unset and this is
      // simply skipped, since that flow already verifies quotes its own
      // way (the per-attribute results table below).
      if (finalEvent.verifiedAnswer) {
        answerEl.textContent = finalEvent.verifiedAnswer;
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
      // Computed once and reused for both the live readout and
      // lastRunElapsedMs, rather than calling performance.now() twice —
      // this is the exact number the "Run time" row in the standalone
      // report (see downloadHtmlBtn below) shows when this run's
      // results are exported, so the two can never disagree by even a
      // fraction of a millisecond.
      const finalElapsedMs = performance.now() - queryStartTime;
      elapsedTimeEl.textContent = formatElapsedMs(finalElapsedMs);
      lastRunElapsedMs = finalElapsedMs;
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
  loadIntroContent();
  initRole();
  refreshWorkspaces();
  refreshModels();
  refreshIdealTopics();
  resetRubricForm();
  refreshRubricTopics();
  refreshLogFiles();
}
