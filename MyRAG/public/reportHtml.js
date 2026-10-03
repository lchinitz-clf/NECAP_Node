/**
 * Builds the standalone, self-contained "comparison report" HTML
 * document (and its small supporting pieces) from an ideal-proposal
 * comparison's accumulated batch data — the same underlying shape
 * (`{sources, records, batchIndex, totalBatches, promptTokens,
 * answerTokens, doneReason}` per batch) that both the browser's live
 * "Export HTML" button and the server's completion-email attachment
 * (see src/emailNotify.js) need to turn into the same report.
 *
 * This file is deliberately ISOMORPHIC — loaded as a plain <script> in
 * the browser (see index.html, loaded before script.js so its function
 * declarations become globals script.js can call directly) AND
 * require()'d from Node (see src/emailNotify.js) — rather than living
 * only in public/script.js the way it did before the email feature
 * needed the exact same report server-side too. There's no bundler in
 * this project, so "share one file between a browser <script> tag and
 * a Node require()" specifically meant: no DOM APIs anywhere in here
 * (escapeHtml() below is a manual replace, not the
 * `div.textContent = ...; div.innerHTML` trick script.js used to use,
 * which only works in a browser), and every function declared as a
 * plain top-level `function` (never an arrow assigned to `const`) so
 * it becomes a `window.*` global for free in a classic script, the
 * same mechanism script.js's other top-level functions already rely
 * on. The module.exports guard at the very bottom is a no-op in the
 * browser (`module` is simply undefined there) and is what makes this
 * requireable from Node.
 */

// Maps src/responseParser.js's five fixed category strings to a badge
// color for the standalone HTML report below — same color meaning the
// on-screen results table already uses (green for a fully-evidenced
// Matches/Exceeds, blue for an Unverified match -- see
// parseComparisonAnswer()'s "Matches" -> "Unverified match" downgrade
// in responseParser.js -- amber for Falls short, red for Not
// addressed) but its own small set of class names, since the report is
// a fully self-contained document with its own inline <style> rather
// than a page that loads this app's style.css.
const REPORT_BADGE_CLASS = {
  Exceeds: 'badge-ok',
  Matches: 'badge-ok',
  'Unverified match': 'badge-info',
  'Falls short': 'badge-warn',
  'Not addressed': 'badge-bad',
};

/**
 * Escapes `&`, `<`, and `>` — deliberately NOT `"` or `'` — matching
 * exactly what a browser's own `div.textContent = str; div.innerHTML`
 * trick produces for a text node (quotes are only ever escaped when
 * serializing an ATTRIBUTE value, not text content, so the old
 * DOM-based version never touched them either). That equivalence
 * matters here specifically: renderResultTextHtml() below matches
 * literal `"` characters in already-escaped text to find quotes the
 * model wrote — escaping quotes here would silently break that regex.
 * `null`/`undefined` come back as `''` rather than the literal string
 * "undefined" the old DOM version would have produced (assigning
 * `undefined` to `.textContent` stringifies it) — every call site in
 * this file already guards against that, so this is a strictly safer
 * default, not a behavior change any of them depended on.
 * @param {*} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats a duration in milliseconds the same way for both the live
 * "elapsed time" readout next to Ask/Stop (script.js's interval timer,
 * which calls this every 100ms while a request is in flight) and the
 * "Run time" row in the standalone report below — one implementation,
 * so the two can never quietly disagree about what "2m 05s" means.
 * Lives here rather than only in script.js for the same reason
 * formatBatchSummary() below does: pure formatting, no DOM, needed
 * isomorphically.
 * @param {number} ms
 * @returns {string} e.g. "4.2s" or "1m 05s"
 */
function formatElapsedMs(ms) {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  // Round the total once and derive minutes/seconds from that single
  // integer, rather than flooring minutes and separately rounding the
  // remainder — rounding each independently can carry the seconds up
  // to 60 without it rolling over into the next minute (e.g.
  // 59m 59.6s would render as the nonsensical "59m 60s").
  const roundedTotalSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedTotalSeconds / 60);
  const seconds = roundedTotalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * One line summarizing a single batch's own token usage (against the
 * Request size ceiling, when set) and, when this specific batch got
 * cut off before finishing, a warning flag. Used both by the on-screen
 * per-attribute results table (see renderAttributeResults() in
 * script.js) and by the report's per-attribute batch-summary line
 * below — pure string formatting, no DOM, so it lives here rather than
 * being duplicated in both places.
 * @param {{batchIndex: number, totalBatches?: number, promptTokens?: number, answerTokens?: number, doneReason?: string}} batch
 * @param {number} [numCtx]
 * @returns {string}
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

/**
 * Renders one attribute's already-parsed resultText into report HTML,
 * escaping it for safety first (attribute names, proposal text, and a
 * model's own answer are all untrusted input) and then re-marking up
 * the specific shape spliceVerifiedQuotes() in src/responseParser.js
 * produces for each quote it found: a plain-text
 * `"<quote>" [<file>, chunk <N>] ✓ quote verified` (or the `⚠ quote
 * NOT found verbatim in any retrieved chunk` variant) run together
 * inline with the surrounding analysis prose. That's exactly what
 * makes the plain-text/CSV version hard to scan — a long quote and its
 * citation and verification marker all reading as just more sentence —
 * so here each one found is instead pulled out into its own visually
 * distinct <blockquote>, colored green or red by whether it verified,
 * with the citation and marker set apart as a small caption line under
 * the quoted text. Ordinary analysis prose in between is left as plain
 * text (newlines turned into <br> so paragraph breaks the model wrote
 * survive). A resultText with no quote-shaped match at all (a plain
 * question with compareInstruction's quote paragraph never added, or
 * every quote was a bare "none") comes back as just the escaped prose,
 * unchanged.
 *
 * @param {string} resultText
 * @returns {string} HTML
 */
function renderResultTextHtml(resultText) {
  const escaped = escapeHtml(resultText || '');
  // Mirrors exactly what renderQuoteMatch() in src/responseParser.js
  // writes: `"${quote}"` then, only when resolveCitation() actually
  // found something, ` [${file}, chunk ${index}]` then ` ✓ quote
  // verified` or ` ⚠ quote NOT found verbatim in any retrieved chunk`.
  // escapeHtml() above only touches &, <, and > — a literal `"` in
  // text content is never escaped by a browser's own serializer either
  // — so matching on `"` here still works post-escaping.
  const quoteRe = /"([^"]*)"(\s*\[[^\]]*\])?(\s*(?:✓ quote verified|⚠ quote NOT found verbatim in any retrieved chunk))?/g;
  let out = '';
  let cursor = 0;
  let m;
  // Set right after a blockquote is emitted, so the prose immediately
  // following it can have its leading punctuation stripped — the model's
  // own sentence-ending punctuation right after a citation bracket
  // ("...chunk 228]. Additionally...", see spliceVerifiedQuotes() in
  // src/responseParser.js, which does the same stripping for the same
  // reason) would otherwise read as a stray, floating ". " sitting right
  // outside the box that already visually closed that sentence. Never
  // applied to the very first slice of plain prose before any quote at
  // all, which is ordinary sentence-starting text, not a leftover.
  let afterQuote = false;
  while ((m = quoteRe.exec(escaped))) {
    let between = escaped.slice(cursor, m.index);
    if (afterQuote) between = between.replace(/^[\s.,;:\-–—]+/, '');
    out += between.replace(/\n/g, '<br>');
    const quoteInner = m[1];
    const citation = (m[2] || '').trim();
    const marker = (m[3] || '').trim();
    const verified = marker.startsWith('✓');
    const unverified = marker.startsWith('⚠');
    const cls = verified ? 'quote-verified' : unverified ? 'quote-unverified' : '';
    const caption = [citation, marker].filter(Boolean).join(' ');
    out += `<blockquote class="quote-block ${cls}">“${quoteInner}”`;
    if (caption) out += `<footer>${caption}</footer>`;
    out += '</blockquote>';
    afterQuote = true;
    cursor = quoteRe.lastIndex;
  }
  let trailing = escaped.slice(cursor);
  if (afterQuote) trailing = trailing.replace(/^[\s.,;:\-–—]+/, '');
  out += trailing.replace(/\n/g, '<br>');
  return out;
}

/**
 * Formats the "Settings" row: one small pill per Advanced-settings
 * field the run was made with, reusing the same `.chip` styling the
 * per-attribute Sources line already uses (see the summary/detail
 * sections in buildAttributeResultsHtml() below) so this reads as more
 * of the same report chrome rather than a new visual idiom. Each
 * field mirrors the exact label text next to it under the "Advanced
 * settings" arrow in index.html, and a field left blank there (which
 * means "use the model's own default," "no limit," or "all," per that
 * field's own placeholder — see index.html) is shown as that same
 * phrase here rather than as a blank or a "0", so the report never
 * implies a setting was left out when it was actually just left at
 * its default.
 *
 * Deliberately does NOT include Relevance (`threshold`): that field
 * never affects generation at all — it's a purely client-side filter
 * applied to already-returned sources for on-screen coloring — and
 * it's also never sent to the server in the first place, so the
 * server-rendered email-attachment report has no way to know its
 * value even if we wanted to show it here. Leaving it out keeps both
 * report call sites (the browser's own "Export HTML" and the
 * server's completion-email attachment, see src/emailNotify.js)
 * showing the exact same set of fields.
 *
 * Renders nothing at all (an empty string, so the caller's "Settings"
 * meta row is simply omitted) when `meta.topK` is undefined -- the
 * signal that this particular caller didn't supply settings data at
 * all, rather than supplying a real run's values.
 * @param {{topK?: number, temperature?: number, repeatPenalty?: number, maxTokens?: number, numCtx?: number, think?: boolean, attributesPerCall?: number}} meta
 * @returns {string} HTML, or '' if meta.topK is undefined
 */
function formatSettingsChips(meta) {
  if (meta.topK === undefined) return '';
  const items = [
    ['Blocks to search', meta.topK],
    ['Consistency', meta.temperature],
    ['Repeat penalty', meta.repeatPenalty !== undefined ? meta.repeatPenalty : 'model default (1.1)'],
    ['Max answer length', meta.maxTokens !== undefined ? meta.maxTokens : 'no limit'],
    ['Request size', meta.numCtx !== undefined ? meta.numCtx : 'model default'],
    // Mirrors exactly what the "Enable thinking" checkbox means server-side
    // (see the comment on thinkCheckbox in script.js's submit handler):
    // checked omits `think` entirely and leaves the model's own default in
    // place (thinking on, for models that support it) -- unchecked sends
    // `think: false` explicitly. There's no way to distinguish "checked"
    // from "this model doesn't support thinking at all" from meta alone,
    // so "on (default)" is deliberately non-committal about whether
    // thinking actually happened.
    ['Thinking', meta.think === false ? 'off' : 'on (default)'],
    ['Attributes per call', meta.attributesPerCall !== undefined ? meta.attributesPerCall : 'all'],
  ];
  return items.map(([label, value]) => `<span class="chip">${escapeHtml(label)}: ${escapeHtml(value)}</span>`).join(' ');
}

/**
 * Builds a complete, self-contained HTML report from a rubric
 * analysis's accumulated `batches` data — a standalone <!doctype html>
 * document (its own inline <style>, no dependency on this app's
 * style.css or any external file) meant to be opened directly in a
 * browser, printed to PDF, or (see src/emailNotify.js) attached to a
 * completion email, for exactly the case a spreadsheet cell handles
 * badly: a long, multi-quote answer per attribute that's hard to read
 * as one undifferentiated block of CSV text. Structure: a header with
 * the run's metadata, a one-glance summary table (attribute →
 * color-coded verdict badge, each linking down to its own section),
 * then a full detail section per attribute with the verdict badge
 * repeated, the criterion/ideal text, the answer with every quote
 * pulled out into its own verified/unverified blockquote (see
 * renderResultTextHtml() above), and the sources retrieved for that
 * attribute's batch.
 *
 * @param {Array<{sources?: Array<{sourceFile: string, chunkIndex: number}>, records?: Array<{name: string, proposal: string, resultText: string, category: string}>, batchIndex: number, totalBatches?: number, promptTokens?: number, answerTokens?: number, doneReason?: string}>} batches
 * @param {{workspaceId?: string, topicLabel?: string|null, question?: string, chatModel?: string, topK?: number, temperature?: number, repeatPenalty?: number, maxTokens?: number, numCtx?: number, think?: boolean, attributesPerCall?: number, elapsedMs?: number, appName?: string}} meta
 *   `topK` through `attributesPerCall` are the run's Advanced-settings
 *   values, rendered as the "Settings" chip row by formatSettingsChips()
 *   above -- see that function's own doc comment for exactly what each
 *   one means and why Relevance/`threshold` is deliberately not among
 *   them. Omitting `topK` specifically (rather than any other field
 *   here) omits the whole row, so a caller that predates this feature,
 *   or that genuinely has no settings to report, doesn't need to pass
 *   anything different than it already did.
 *   `elapsedMs` is the same run-duration number the on-screen timer
 *   next to Ask/Stop shows (script.js's `lastRunElapsedMs`) for the
 *   browser's own "Export HTML" download, or the server's own
 *   measured request-handling time for the completion-email
 *   attachment (see src/emailNotify.js) — omitted entirely (no "Run
 *   time" row at all) rather than shown as 0 or blank when not
 *   supplied. `appName` names the app in the footer below — pulled
 *   from public/config.json by each caller (see this file's own
 *   module doc comment for why that read happens there, not here) —
 *   and falls back to "local-rag" the same way index.html's own
 *   hardcoded heading does when config.json can't be read at all.
 * @returns {string} a full HTML document
 */
function buildAttributeResultsHtml(batches, meta) {
  const rows = [];
  batches.forEach((batch, batchIndex) => {
    const sourceRefs = (batch.sources || []).map((s) => `${escapeHtml(s.sourceFile)} #${s.chunkIndex}`);
    for (const r of batch.records || []) {
      rows.push({ ...r, sourceRefs, batch, batchIndex });
    }
  });

  const generatedAt = new Date().toLocaleString();
  const metaRows = [
    meta.workspaceId ? ['Workspace', escapeHtml(meta.workspaceId)] : null,
    meta.topicLabel ? ['Ideal-proposal topic', escapeHtml(meta.topicLabel)] : null,
    meta.question ? ['Question', escapeHtml(meta.question)] : null,
    meta.chatModel ? ['Model', escapeHtml(meta.chatModel)] : null,
    // Not run through escapeHtml() like the other rows here -- this one's
    // value is already-safe markup (a run of <span class="chip"> pills)
    // built entirely from escapeHtml()'d pieces inside formatSettingsChips()
    // itself, not a plain string that would need escaping again.
    (() => { const chips = formatSettingsChips(meta); return chips ? ['Settings', chips] : null; })(),
    ['Generated', escapeHtml(generatedAt)],
    // != null (not a truthiness check): 0ms is a real, if unlikely,
    // elapsed time and should still render as "0.0s" rather than
    // silently vanishing the way `meta.elapsedMs &&` would.
    meta.elapsedMs != null ? ['Run time', escapeHtml(formatElapsedMs(meta.elapsedMs))] : null,
  ].filter(Boolean);

  const summaryRows = rows.map((r, i) => {
    const cls = REPORT_BADGE_CLASS[r.category] || 'badge-neutral';
    const label = r.category || 'Unparsed';
    return `<tr><td><a href="#attr-${i}">${escapeHtml(r.name)}</a></td><td><span class="badge ${cls}">${escapeHtml(label)}</span></td></tr>`;
  }).join('\n');

  const detailSections = rows.map((r, i) => {
    const cls = REPORT_BADGE_CLASS[r.category] || 'badge-neutral';
    const label = r.category || 'Unparsed — see answer text';
    const showBatchLine = batches.length > 1 && r.batch.totalBatches;
    const batchLine = showBatchLine
      ? `<p class="batch-line">${escapeHtml(formatBatchSummary(r.batch, meta.numCtx))}</p>`
      : '';
    const sources = r.sourceRefs.length
      ? `<p class="sources"><strong>Sources:</strong> ${r.sourceRefs.map((s) => `<span class="chip">${s}</span>`).join(' ')}</p>`
      : '';
    return `
    <article class="attribute" id="attr-${i}">
      <h3>${escapeHtml(r.name)} <span class="badge ${cls}">${escapeHtml(label)}</span></h3>
      <p class="proposal"><strong>Criterion / ideal:</strong> ${escapeHtml(r.proposal)}</p>
      <div class="result-text">${renderResultTextHtml(r.resultText)}</div>
      ${sources}
      ${batchLine}
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Comparison report${meta.topicLabel ? ' — ' + escapeHtml(meta.topicLabel) : ''}</title>
<style>
  :root {
    --border: #d4d4d8;
    --bg-soft: #f4f4f5;
    --muted: #71717a;
    --ok: #15803d; --ok-bg: #f0fdf4;
    --warn: #b45309; --warn-bg: #fffbeb;
    --bad: #b91c1c; --bad-bg: #fef2f2;
    --info: #1d4ed8; --info-bg: #eff6ff;
  }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1.25rem; color: #18181b; line-height: 1.5; }
  h1 { margin-bottom: 0.25rem; }
  h2 { margin-top: 2.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35rem; }
  h3 { margin-bottom: 0.5rem; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 1rem 0 2rem; }
  dl.meta dt { color: var(--muted); font-weight: 600; }
  dl.meta dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .badge { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px; font-size: 0.85em; font-weight: 600; }
  .badge-ok { color: var(--ok); background: var(--ok-bg); }
  .badge-warn { color: var(--warn); background: var(--warn-bg); }
  .badge-bad { color: var(--bad); background: var(--bad-bg); }
  .badge-info { color: var(--info); background: var(--info-bg); }
  .badge-neutral { color: var(--muted); background: var(--bg-soft); }
  .attribute { padding: 1.25rem 0; border-bottom: 1px solid var(--border); }
  .attribute:last-child { border-bottom: none; }
  .proposal { color: var(--muted); }
  .result-text { margin: 0.75rem 0; }
  blockquote.quote-block { margin: 0.6rem 0; padding: 0.5rem 0.9rem; border-left: 3px solid var(--border); background: var(--bg-soft); border-radius: 0 6px 6px 0; }
  blockquote.quote-block.quote-verified { border-left-color: var(--ok); background: var(--ok-bg); }
  blockquote.quote-block.quote-unverified { border-left-color: var(--bad); background: var(--bad-bg); }
  blockquote.quote-block footer { margin-top: 0.3rem; font-size: 0.85em; color: var(--muted); }
  blockquote.quote-block.quote-verified footer { color: var(--ok); }
  blockquote.quote-block.quote-unverified footer { color: var(--bad); }
  .sources { font-size: 0.9em; }
  .chip { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.55rem; margin: 0.1rem; font-size: 0.85em; }
  .batch-line { font-size: 0.85em; color: var(--muted); }
  footer.report-footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85em; }
  @media print {
    body { max-width: none; }
    .attribute { break-inside: avoid; }
  }
</style>
</head>
<body>
  <h1>Comparison report</h1>
  <dl class="meta">
    ${metaRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('\n')}
  </dl>

  <h2>Summary</h2>
  <table>
    <thead><tr><th>Attribute</th><th>Verdict</th></tr></thead>
    <tbody>
      ${summaryRows}
    </tbody>
  </table>

  <h2>Details</h2>
  ${detailSections}

  <footer class="report-footer">
    Generated by ${escapeHtml(meta.appName || 'local-rag')}. Best-effort parsing of a chat model's answer — always cross-check against the raw answer text for anything you're about to act on.
  </footer>
</body>
</html>`;
}

// No-op in a browser classic <script> (where `module` is simply
// undefined) — this is what makes the functions above requireable from
// Node (see src/emailNotify.js) without any bundler, while the browser
// keeps using them as the plain globals a classic script's top-level
// `function` declarations already become.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REPORT_BADGE_CLASS,
    escapeHtml,
    formatElapsedMs,
    formatBatchSummary,
    renderResultTextHtml,
    formatSettingsChips,
    buildAttributeResultsHtml,
  };
}
