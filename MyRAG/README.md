# local-rag

A hand-rolled local RAG pipeline: extract text from a document (PDF,
DOCX, or TXT — see `src/extract.js`), chunk it, embed each chunk via
Ollama, store the vectors, and answer questions by retrieving the
closest chunks and asking a local chat model to answer using only that
context.

The name "local-rag" everywhere in the UI (browser tab title, page
heading) comes from `public/config.json`, not from the HTML itself —
edit that one file's `appName` field to rename it to whatever you like.
It's served as a plain static file, so a change takes effect on the
next page load, no server restart needed.

Everything lives inside a **workspace** — a named, isolated document
set with its own index (`workspaces/<id>/store.json`). Use separate
workspaces to keep unrelated document sets from ever being searched
together (e.g. a Massachusetts climate plan workspace and a Vermont
climate plan workspace) — a query against one can never retrieve
chunks from another. A workspace doesn't need to be explicitly
created; it comes into existence the first time you `/embed`
something into it.

Endpoints:

- `GET /health` — sanity check.
- `GET /workspaces` — lists existing workspace ids, e.g. `{ "workspaces": ["ma-climate-plan", "vt-climate-plan"] }`.
- `GET /models` — lists models currently pulled in your Ollama
  installation (via Ollama's own `/api/tags`), e.g.
  `{ "models": ["llama3.1:8b", "llama3.2:3b", "nomic-embed-text"] }`.
  This includes embedding models too — Ollama doesn't label which is
  which — so `nomic-embed-text` will show up here alongside real chat
  models; picking it as a chat model just errors clearly rather than
  doing anything harmful.
- `GET /ideal-proposals` — lists the comparison topics defined in
  `idealProposals.json` (id/label/description only), for the Ask
  form's compare-mode dropdown. See "Comparing against an ideal
  proposal" below.
- `GET /workspaces/:workspaceId/documents` — lists the documents
  actually embedded in a workspace, grouped by source filename, with a
  chunk count and page count per document, e.g.
  `{ "documents": [{ "sourceFile": "ma-plan.pdf", "chunks": 236, "numPages": 127 }], "totalChunks": 236 }`.
  `numPages` is `null` for file types without a real page count
  (`.docx`, `.txt`) — only PDFs have one. This is what backs the
  "Documents in this workspace" section in the UI.
- `GET /workspaces/:workspaceId/chunks/:chunkId` — fetches one chunk's
  full text on demand, e.g.
  `{ "id": "ma-plan.pdf::42", "sourceFile": "ma-plan.pdf", "chunkIndex": 42, "text": "...", "numPages": 127 }`.
  `:chunkId` is the `"<sourceFile>::<chunkIndex>"` id that every source
  in a `/query`/`/query/stream` response's `sources` list now carries,
  and must be URL-encoded (the UI does this automatically). 404s with a
  clear error if no chunk with that id exists in the workspace. This is
  what backs the "click a chunk number to view its text" modal in the
  UI — see "Viewing a chunk's text" below for why this is a
  fetch-on-demand endpoint rather than the query response carrying
  every retrieved chunk's full text up front.
- `DELETE /workspaces/:workspaceId/documents/:sourceFile` — removes
  every chunk belonging to one document from a workspace's search
  index (`:sourceFile` must be URL-encoded — the UI does this
  automatically). If that document was uploaded through this app, its
  underlying file in `workspaces/<id>/uploads/` is deleted too, since
  this app owns that copy and it exists for exactly this purpose. If
  it was embedded from a path on the server (via `/embed`), only the
  index entries are removed — the original file could be anywhere on
  disk, so it's never touched. The response includes `wasUpload` and
  `fileDeleted` so a caller can tell which happened. See the comment
  on `deleteDocument()` in `src/store.js` for the full reasoning and
  the path-containment guardrail around the actual unlink.
- `DELETE /workspaces/:workspaceId` — wipes an entire workspace: every
  chunk in its store.json, every uploaded file under
  `workspaces/<id>/uploads/`, and the workspace directory itself, e.g.
  `{ "workspaceId": "ma-climate-plan", "existed": true }` (`existed` is
  `false`, not an error, if that workspace id had no directory to begin
  with). This is the blunt "start this workspace over from nothing"
  recovery tool — see "Workspace maintenance" below. There is no
  confirmation built into the endpoint itself; the browser UI asks
  before ever sending this request.
- `POST /workspaces/:workspaceId/rebuild-index` — discards store.json
  and rebuilds it from scratch by re-extracting, re-chunking, and
  re-embedding every file currently sitting in
  `workspaces/<id>/uploads/`. Body is optional JSON:
  `{ "embedModel": "...", "maxWords": 300, "overlapWords": 40 }`
  (same meaning and defaults as `/embed`). Streamed as
  newline-delimited JSON, same pattern as
  `/workspaces/:id/upload-and-embed` — see "Workspace maintenance"
  below for the full event shapes, the two real limitations on what
  this can recover, and the all-or-nothing guarantee around when
  store.json actually gets overwritten.
- `POST /ingest` — extract + chunk a document, no embeddings, no
  workspace needed (useful for inspecting chunk boundaries before
  committing to embedding a document).
- `POST /embed` — extract + chunk + embed a document **already on the
  server's disk**, appends the results to the given workspace's store.
  Requires `workspaceId` and `filePath`. Returns one JSON object once
  everything's done — meant for scripting (PowerShell, etc.), not the
  browser.
- `POST /workspaces/:workspaceId/upload-and-embed` — the browser-UI
  equivalent: send the actual file as a `multipart/form-data` upload
  (field name `file`, plus optional `maxWords`/`overlapWords` text
  fields — see `chunkText()` in `chunker.js`, omit either to use its
  default) instead of a path, and it's saved under
  `workspaces/<id>/uploads/` before running through the same
  extract/chunk/embed pipeline `/embed` uses. Unlike `/embed`, the
  response is streamed as newline-delimited JSON (one JSON object per
  line) so a UI can show live progress — see the comment above this
  route in `index.js` for the exact event shapes and an important
  caveat about how errors show up once streaming has started. A
  `maxWords`/`overlapWords` field that's present but not a valid
  positive whole number 400s cleanly (and the already-saved upload is
  deleted, so a typo doesn't leave an orphaned file behind) rather than
  producing broken chunks.
- `POST /query` — embed a question, find the closest chunks stored in
  the given workspace, ask the chat model to answer using only that
  context. Returns one JSON object with the answer plus exactly which
  chunks/sources were used. Requires `workspaceId`. `question` is
  required unless `idealTopicId` is given — see "Comparing against an
  ideal proposal" below. Accepts an optional `think` boolean — see
  "Reasoning models and the 'thinking' trace" below — and, when the
  model produced one, the response includes a `thinking` field
  alongside `answer` (omitted entirely when there's nothing to show).
  Meant for scripting.
- `POST /query/stream` — the browser-UI equivalent of `/query`, same
  body. Sends the retrieved sources back immediately (retrieval is
  fast), then — for a reasoning model with thinking on — streams its
  reasoning trace as its own run of events, then streams the answer
  itself back live, fragment by fragment, as newline-delimited JSON —
  see the comment above this route in `index.js` for the exact event
  shapes.

`workspaceId` must be 1-64 characters: letters, numbers, hyphens, and
underscores only (enforced server-side in `src/workspace.js`) — this
isn't just tidiness, it's what stops a workspace name like
`../../etc` from ever being usable to read or write outside the
`workspaces/` folder. That matters more than it looks like it should
right now, because this was built with "this may eventually run
somewhere other than your own machine" in mind from the start.

**Supported file types:** `.pdf`, `.docx` (Word/OOXML — not the older
binary `.doc`), and `.txt` (assumed UTF-8). This applies everywhere a
document goes in — `/ingest`, `/embed`, and the upload route — since
all three dispatch through the same `extractText()` in `src/extract.js`,
which picks an extractor by file extension. Anything else is rejected
before it's read.

`/query` and `/query/stream` both take an optional `chatModel` in the
body, defaulting to `llama3.1:8b` if omitted — this is what the UI's
"Chat model" dropdown sets per question. There's deliberately no
equivalent `embedModel` picker anywhere in the UI: every chunk in a
workspace's store has to come from the same embedding model (different
models produce incompatible, sometimes differently-sized vectors), so
letting that vary per-request would just invite silently broken
similarity scores. See the comment on `embedModel` in
`src/embedPipeline.js` for the full reasoning.

## Setup

Requires Node.js (v18+) and a running Ollama with `nomic-embed-text`
pulled for embeddings, plus at least one chat model (e.g. `llama3.1:8b`
or `llama3.2:3b`) pulled for answering.

```
npm install
```

## Run

```
npm start
```

Defaults to port 3500. Set `PORT=<something else>` in your environment
first if 3500 is already in use on your machine.

## Using the browser UI

Once the server's running, open `http://localhost:3500/` in a browser
— that serves `public/index.html`. It has four parts: a workspace
picker at the top (type an existing name or a new one), a "Documents
in this workspace" list — showing each document's name, chunk count,
and page count, with a Remove button per document — that updates as
you type a workspace name or finish an embed, an "Embed a document"
form, and an "Ask a question" form with a chat-model dropdown
(populated from `GET /models` — whatever you've actually pulled into
Ollama), a topK setting, a temperature setting (0 = deterministic and
literal, higher = more varied phrasing but more prone to drifting from
the retrieved text — low is usually right for document Q&A; passed
straight through to Ollama's `/api/chat`, same as chatModel), a max
answer length setting in tokens (blank/omitted = no cap, same as
today's behavior — passed through as Ollama's `num_predict` when set,
useful for bounding generation time on modest hardware or reining in a
model that likes to ramble), and a configurable confidence-threshold
display (see the comment at the top of that file for how the threshold
works — it's a client-side display filter only, the server always
returns its top-K closest chunks regardless of quality).

The embed form also has a chunk size and chunk overlap setting, in
words (defaults 300/40, matching `chunker.js`). These apply only to
the document being embedded right now — documents already in a
workspace keep whatever size they were embedded with, and workspaces
don't enforce one consistent chunk size the way they do embedding
model. **Note:** raising chunk size doesn't raise it without limit —
`chunkText()` also enforces a separate, fixed 1800-character ceiling
per chunk (not exposed here or anywhere else) to stay safely under
Ollama's embedding endpoint's hard 512-token context limit; see the
comment at the top of `chunker.js`. That ceiling binds first on
ordinary prose well before ~300-400 words, so cranking chunk size much
higher than that doesn't actually produce bigger chunks — it's only
useful for requesting *smaller* chunks than that (more precise
retrieval, less context per match).

Removing a document asks for confirmation first (a plain
`window.confirm()`, nothing fancier), and its dialog says plainly what
will happen: for an uploaded document, both its index entries and its
file under `workspaces/<id>/uploads/` are deleted; for one embedded
from a server path via `/embed`, only the index entries are — the
original file is left alone.

The embed form is a real file picker — choose a PDF, DOCX, or TXT file
from your own computer and click "Embed into workspace." Under the
hood this uploads
the file to `POST /workspaces/:id/upload-and-embed`, which streams
progress back as it works, so the button's status line updates live
("Embedding: 142 / 236 chunks (60%)") instead of the page just sitting
there while the server console does all the talking. Uploaded files
land in `workspaces/<id>/uploads/` on the server, renamed with a
timestamp prefix to avoid collisions — the original filename is still
what shows up everywhere else (query sources, the embed result
message), only the on-disk copy is renamed.

The "Ask a question" form is live too, via `/query/stream`: the
sources table appears almost immediately (retrieval is fast — no
model generation involved), then the answer types itself out as
Ollama generates it, instead of the page sitting on one static "this
can take a while" line with nothing else to look at.

A "Stop" button next to "Ask" is enabled for exactly as long as a
request is in flight. Clicking it doesn't just make the browser stop
displaying more tokens — it actually cancels generation on the Ollama
side too, so a slow model on modest hardware really does stop burning
CPU/GPU the moment you click it, rather than finishing an answer
nobody's going to see. This works because `/query/stream` keeps one
HTTP connection open for the whole request: the browser aborts its own
fetch, Express notices the connection close (via `res.on('close', ...)`
on the response — not `req`, whose own `'close'` event fires as soon as
the request body arrives and says nothing about whether the client is
still around, which turned out to be an early false start while
building this), and that in turn aborts the server's own in-flight
request to Ollama, for both the question-embedding step and the answer
generation step, whichever is running when you click Stop. Whatever
partial answer had already streamed in stays on screen — it isn't
cleared — the same way stopping a response in Claude Desktop leaves the
partial text in place. See the comment on the `/query/stream` route in
`index.js` for the full mechanics.

### Reasoning models and the "thinking" trace

Some models — DeepSeek-R1 is the common local one, Qwen 3 and others
also qualify — are "reasoning models": trained to work through an
explicit chain-of-thought before committing to a final answer, the
same idea as OpenAI's o1/o3. Ollama recognizes these and, by default,
generates that reasoning on every request (same as `ollama run` does
at the CLI) — this app was originally throwing it away unread, since
`chat()` in `ollamaClient.js` only looked at `message.content`. It
doesn't anymore.

An "Enable thinking" checkbox sits next to temperature/max-answer-length
in the Ask form, checked by default (matching Ollama's own default).
Unchecking it sends `think: false` to Ollama, which is a genuine skip —
per Ollama's docs the model runs in a non-thinking mode and never
generates those tokens at all, not just a hidden-but-still-generated
step — so it's a real speed/compute win on modest hardware, not only a
display filter. Leaving it checked doesn't send `think` at all, letting
Ollama's own default apply; there's no need to send `think: true`
explicitly for the same effect. A model that doesn't support thinking
(llama3.1, for instance) just ignores the setting either way.

When thinking is on and the model actually produces a trace, it
appears in a collapsible "Show reasoning" section above the answer —
collapsed by default, so it costs nothing on screen unless you open it,
same principle as the chunk-text modal below. It fills in live as the
model reasons, streamed via its own `{"type":"thinking",...}` events on
`/query/stream`, entirely separate from the `{"type":"token",...}`
events that carry the actual answer — Ollama streams reasoning first,
then content, never both in the same fragment. Stopping mid-thought
(via the Stop button above) auto-expands the section and says so
plainly, since the reasoning trace is the only thing that request
actually produced.

One gotcha worth knowing, and part of why this is worth controlling
rather than just quietly showing: `maxTokens` (Ollama's `num_predict`)
caps thinking and answer tokens *together*, as one shared budget, not
separately. A verbose thinker can in principle exhaust the whole
budget on reasoning alone, cutting off with `doneReason: "length"` and
an empty or truncated answer despite having generated plenty of
`thinking` — which would otherwise look like this app's own max-answer-
length feature malfunctioning. There's currently no way in Ollama to
bound thinking on its own; disabling thinking entirely (or raising
`maxTokens`) are the two available workarounds.

### Viewing a chunk's text

Each row in the sources table shows which chunk of which document was
retrieved, by chunk number — and that number is a clickable link. Click
it and a modal opens showing that chunk's full text, fetched live from
`GET /workspaces/:workspaceId/chunks/:chunkId` (see the endpoint list
above). Close it with the × button, the Escape key, or by clicking
outside the modal.

This is deliberately fetch-on-demand rather than something the query
response carries up front: a typical query only retrieves a handful of
chunks (`topK`, usually 5-10), but sending every one's full text with
every `/query`/`/query/stream` response would bloat every single
answer — including the vast majority a reviewer never actually opens —
with text that's only useful the moment someone actually wants to read
it. Fetching it lazily, one chunk at a time, only when someone clicks,
keeps normal query responses lean and costs nothing extra for the
common case of never opening a single source.

### Workspace maintenance

The "Documents in this workspace" section has a "Workspace
maintenance" area below its table with two blunt, destructive recovery
tools, each requiring its own confirmation dialog before it does
anything (there's no server-side confirmation — the UI is what asks):

- **Delete this entire workspace** (`DELETE /workspaces/:workspaceId`)
  removes everything — every chunk, every uploaded file, the workspace
  directory itself. Use this when you'd rather just start a workspace
  over than trust anything already in it.
- **Rebuild index from uploaded files**
  (`POST /workspaces/:workspaceId/rebuild-index`) discards store.json
  and rebuilds it from scratch, by re-extracting, re-chunking, and
  re-embedding every file already sitting in
  `workspaces/<id>/uploads/`. Use this when store.json is missing,
  looks corrupted, or you just don't trust that it still matches
  what's actually here — as long as the documents themselves are still
  uploaded, this puts the index back in sync with them.

Two real limitations on what a rebuild can recover, worth knowing
before relying on it:

1. It only recovers documents that were **uploaded** through this app.
   A document embedded via `POST /embed` (a path elsewhere on the
   server) was never copied into the workspace's `uploads/` folder —
   this app doesn't own that file and has no record of where it was
   once store.json itself is gone. Those documents simply won't come
   back. If you only ever use the browser UI's "Embed a document" form
   (not the `/embed` API directly), this doesn't apply to you — the
   upload form always exercises the uploaded-file path.
2. Every uploaded file's original name is sanitized before being saved
   to disk (non-alphanumeric characters become underscores — see the
   upload route's `multer` config in `index.js`) and prefixed with a
   timestamp; the literal original filename was only ever recorded in
   store.json, not preserved on disk anywhere. A rebuild reconstructs
   each document's name from its sanitized on-disk filename with the
   timestamp prefix stripped off, so a document whose original name had
   spaces or punctuation will come back with underscores in their place
   instead. This is a real, unavoidable limitation of the
   sanitize-on-upload design, not a bug.

A rebuild is deliberately **all-or-nothing**: every file in the
uploads folder is processed first, and store.json is only actually
overwritten once, at the very end, after every file has succeeded. If
something fails partway through (say, Ollama goes down while embedding
the third of five files), the OLD store.json is left completely
untouched rather than replaced with a half-finished index — the whole
point of this feature is ending up with something trustworthy, so a
rebuild that could silently leave a workspace worse off than before it
ran would defeat that. See `rebuildWorkspaceIndex()` in
`src/embedPipeline.js` for the implementation.

Like uploading, a rebuild can take a while (every chunk of every file
gets re-embedded from scratch), so its response streams back progress
as newline-delimited JSON rather than one blocking response:
```
{"type":"file-start","sourceFile":"...","fileIndex":1,"totalFiles":3}
{"type":"start","sourceFile":"...","numPages":12,"totalChunks":40}
{"type":"progress","chunksEmbedded":1,"totalChunks":40}
...
{"type":"file-done","sourceFile":"...","chunksEmbedded":40}
... (repeats per file)
{"type":"done","workspaceId":"...","filesProcessed":3,"totalChunks":118,"documents":[...]}
```
or, if something fails partway through, `{"type":"error","error":"..."}`
— which, per the all-or-nothing guarantee above, means the rebuild
didn't happen at all, not that it happened incompletely.

## Comparing against an ideal proposal

Beyond plain "what does this document say about X" Q&A, the Ask form
has an optional second mode: instead of asking a question, compare the
document(s) in a workspace against a predefined set of "ideal"
criteria for a topic — e.g. "how does this offshore wind proposal
measure up against an ideal one." The "Compare against ideal proposal"
dropdown on the Ask form (backed by `GET /ideal-proposals`) lists
whatever topics are defined in **`idealProposals.json`** at the
project root; selecting "None" (the default) leaves the form working
exactly as plain Q&A always has.

### `idealProposals.json` schema

A single JSON file, hand-edited directly (no UI for authoring it, by
design — same "just a file you can open" philosophy as `store.json`).
A missing file just means an empty dropdown, not an error; this
feature is entirely optional.

Whether an edit needs a page reload depends on *what* changed. Editing
an existing topic's content — `attributes`, `compareInstruction`,
`defaultCompareInstruction` — takes effect on your very next query,
no reload or restart needed: `getTopic()` re-reads the file fresh from
disk on every single request (see `loadTopics()` in
`src/idealProposals.js`; nothing here is cached). But *which topics
exist* — a new `id`, a renamed `label`, a removed topic — only reaches
the dropdown itself when the browser re-fetches `GET /ideal-proposals`,
which currently happens exactly once, on page load (`refreshIdealTopics()`
in `public/index.html`). So: tweaking an existing topic's criteria →
just ask your next question; adding, removing, or renaming a topic →
reload the page once first.

```json
{
  "defaultCompareInstruction": "Compare and contrast the proposal under review with the ideal proposal described above. ...",
  "topics": [
    {
      "id": "offshore-wind",
      "label": "Offshore Wind",
      "description": "Ideal conditions for an offshore wind development proposal.",
      "attributes": [
        { "name": "Turbine setback distance", "proposal": "..." },
        { "name": "Environmental review process", "proposal": "..." }
      ]
    }
  ]
}
```

- `defaultCompareInstruction` *(optional, top-level — a sibling of
  `topics`, not inside any one topic)* — the general instruction that
  applies to every topic that doesn't set its own. This is the field
  you'll normally tune: one hand-editable place to change how
  comparisons are phrased across the board, rather than repeating
  (and risking drifting) the same instruction inside every topic.
- `id` — stable identifier, submitted back as `idealTopicId` on
  `/query`/`/query/stream` and used as the dropdown's option value.
  Keep these to lowercase letters, digits, and hyphens (same character
  class `workspaceId` already enforces elsewhere in this app).
- `label` — shown in the dropdown.
- `description` *(optional)* — a one-line note on what the topic
  covers. Informative only — shown alongside the label in the dropdown
  and returned by `GET /ideal-proposals`, never sent to the model.
- `compareInstruction` *(optional, per topic)* — overrides
  `defaultCompareInstruction` for this one topic specifically. Meant
  for the rare case where one topic genuinely needs different phrasing
  from every other topic (e.g. "does it meet or exceed" instead of
  "does it match") — most topics shouldn't need this at all; leave it
  out and let `defaultCompareInstruction` apply. `getTopic()` in
  `src/idealProposals.js` resolves the full fallback chain — this
  topic's own `compareInstruction`, else the file's
  `defaultCompareInstruction`, else one final hardcoded string in the
  code itself for the edge case where the file defines neither.
- `attributes` — the actual substance: an array of `{name, proposal}`
  pairs, one per ideal condition to check the reviewed document
  against. `proposal` is deliberately a different field name from the
  topic-level `description` above — the two mean genuinely different
  things (one's a note to yourself, the other is the specific content
  that gets sent to the model) and reusing one word for both invited
  exactly the kind of mix-up worth avoiding in a hand-edited file.

### How it works: approach 1 — fold into the question (implemented)

This is what's actually wired up right now. When a request includes
`idealTopicId`, `composeComparisonQuestion()` in
`src/idealProposals.js` builds a block of text from that topic's
attributes plus its `compareInstruction` — and *that becomes the
question* (with whatever you also typed in the question box appended
as "additional guidance from the reviewer," narrowing scope rather
than replacing the topic's content). Critically, this composed text is
what gets embedded for retrieval (`embed()` in `index.js`'s `/query`
and `/query/stream`) as well as what's sent to the chat model — so
selecting a topic doesn't just change how the model is *told* to
respond, it changes *which chunks get retrieved* from the document
under review in the first place, steering search toward passages
relevant to the ideal attributes rather than retrieving whatever a
generic or empty question would have pulled.

The tradeoff: retrieval is still driven by one embedding of the whole
combined block, not one retrieval per attribute — so a topic with
several distinct attributes isn't guaranteed to get a well-matched
chunk for *each* one; some may simply not surface among the top-K
results, and the model (correctly, per the system prompt) will report
those as not addressed in the retrieved context even if the reviewed
document actually covers them elsewhere. Raising `topK` for a
comparison (more of the reviewed document's content in front of the
model to begin with) is the main lever against this today — and,
because more retrieved context also means a bigger prompt, this is
exactly where the context-window ceiling in "A second gotcha" above
becomes relevant; watch `doneReason` on a comparison's response for
`"length"` the same way you would for a long factual answer.

### Approach 2 — inject into the system prompt instead (documented, not built)

If approach 1's retrieval steering doesn't hold up well in practice —
attributes getting silently dropped from retrieval feels like the
bigger problem than anything about how the model phrases its
comparison — the alternative is to leave retrieval alone (driven only
by whatever the user actually typed, or a generic default question if
nothing was typed) and instead fold the topic's attributes and
`compareInstruction` into the **system** message that `buildRagMessages()`
builds in `index.js`, alongside its existing "answer using ONLY the
context provided" instruction. The model would then have the ideal
criteria available when reasoning over whatever got retrieved, without
the topic influencing what got retrieved in the first place.

That's the core tradeoff between the two: approach 1 lets a topic
actively steer retrieval (better odds of surfacing the right evidence
for each attribute, at the cost of one blended-embedding retrieval
sometimes missing an attribute entirely) versus approach 2 keeping
retrieval "pure" — driven only by an explicit question — while still
giving the model the comparison criteria to reason with (simpler
mental model, but if the plain question underneath is generic or
absent, retrieval has no signal at all about which of the topic's
attributes matter, likely surfacing *less* relevant context than
approach 1, not more). Neither one is strictly better; which one
actually produces better comparisons is an empirical question worth
testing against real documents once `idealProposals.json` has real
content in it.

Switching would mean: `buildRagMessages()` gains a parameter for
topic-derived system-prompt text (kept separate from its existing
grounding instruction, not replacing it); `/query` and `/query/stream`
would stop calling `composeComparisonQuestion()` to build the
`question` itself and instead pass the topic through to
`buildRagMessages()` directly, while retrieval (`embed()`/`search()`)
goes back to using only the literal `question` field. `getTopic()` and
the rest of `src/idealProposals.js` wouldn't need to change at all —
only how its output gets used downstream.

A further option beyond either of these, if a topic ends up with many
distinct attributes and a single blended retrieval keeps missing some
of them regardless of which approach above is used: a structured,
multi-step comparison — first ask the model to enumerate the topic's
attributes (already known, since they're structured data here, so
this step may not even be needed), then run one retrieval + one
targeted question **per attribute** against the reviewed document, and
assemble the individual verdicts into a final report. This scales
better to a topic with a dozen attributes than either single-shot
approach above, at the cost of being a genuinely different, multi-call
pipeline rather than a variation on `/query` — worth considering if
comparisons on topics with many attributes turn out to be the common
case rather than the exception.

## Testing with PowerShell

All examples use `Invoke-RestMethod`, which avoids the JSON-escaping
headaches we ran into with `curl`. Adjust the port if you're not using
the default 3500.

**Health check:**

```powershell
Invoke-RestMethod http://localhost:3500/health
```

**Embed a document** — this is the step that actually builds your
searchable index. It calls Ollama once per chunk, so for a long
document (dozens to over a hundred chunks) this can take a little
while — watch the server's own terminal window for progress logs
(`[embed] ... N/total chunks embedded`).

```powershell
$body = @{ workspaceId = "ma-climate-plan"; filePath = "C:\path\to\your\document.pdf" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3500/embed" -Method POST -ContentType "application/json" -Body $body
```

Returns something like:

```json
{ "workspaceId": "ma-climate-plan", "filePath": "...", "sourceFile": "document.pdf", "numPages": 127, "chunksEmbedded": 125, "totalStored": 125 }
```

Run this once per document you want searchable. Each call appends to
that workspace's store — running `/embed` again on a *different* file
with the *same* `workspaceId` adds to that workspace rather than
replacing it, so you can embed multiple documents into one shared
workspace this way. Use a different `workspaceId` to keep a document
set fully separate instead (e.g. `vt-climate-plan`).

**Ask a question:**

```powershell
$body = @{ question = "What does the plan say about offshore wind?"; workspaceId = "ma-climate-plan" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3500/query" -Method POST -ContentType "application/json" -Body $body
```

Returns:

```json
{
  "answer": "...",
  "sources": [
    { "sourceFile": "document.pdf", "chunkIndex": 42, "score": 0.81 },
    ...
  ]
}
```

The `sources` array is the part worth paying attention to — it tells
you exactly which chunks the answer was actually grounded in (and how
similar each was to your question), independent of whatever the
generated prose does or doesn't mention. That's the same distinction we
kept running into with AnythingLLM's citations panel, just now fully
visible since you own the code.

Optional body parameters for `/query`: `topK` (how many chunks to
retrieve, default 5), `chatModel` (default `llama3.1:8b`), `embedModel`
(default `nomic-embed-text`), `temperature` (default 0.2), `maxTokens`
(caps generation length via Ollama's `num_predict`; omit for no cap,
the existing default behavior). Same parameters for `/query/stream`.

## A gotcha worth knowing about: embedding context length

Ollama's embedding endpoint defaults to a 512-token context window,
regardless of what the model actually supports (`nomic-embed-text` can
handle up to 8192). A chunk longer than that gets flat-out rejected
with `"input length exceeds the context length"` rather than silently
truncated — and unlike chat models, this does **not** appear to be
overridable per-request via `options.num_ctx` (we tried; same error).

The first fix attempt — dropping the chunk size to 300 words — reduced
the problem but didn't eliminate it, because **word count is a lossy
proxy for token count.** The actual root cause: `chunker.js` splits on
whitespace, and PDF text sometimes contains long runs of characters
with *no* whitespace in them at all — table-of-contents dot-leaders
(`Executive Summary ................................. xi`), years
glued together from a chart axis, that kind of thing. Each of those
counts as a single "word" toward the 300-word budget, but can be 100+
characters long, which blows the assumption that 300 words stays
comfortably under 512 tokens. This specific document's table of
contents was the worst offender: one chunk was 300 words but 4125
characters, more than double the ~2000-character median for an
otherwise-normal 300-word chunk.

Two fixes, both now in place:

1. **`extract.js`** strips dot-leader runs (4+ periods, with or without
   spaces between them) out of the text right after extraction, before
   it ever reaches the chunker. This also just makes the ToC read as
   normal text instead of noise, which is a win for retrieval quality
   too — nobody's question is going to be answered by a wall of dots.
2. **`chunker.js`** now enforces a hard `maxChars` ceiling (default
   1800) per chunk, checked word-by-word as each chunk is built, in
   addition to the `maxWords` limit. Whichever limit is hit first ends
   the chunk. This is the real backstop: it doesn't depend on the
   words-≈-tokens estimate holding, so even text with unusually long
   glued-together tokens (that cleanup step doesn't happen to catch)
   can't produce an oversized chunk. Verified against this document
   after the fix: 236 chunks, none over 1800 characters.

If you ever see the "exceeds context length" error again on a
different document, that's the signal some other pattern of
whitespace-free-but-long text is slipping through — lower `maxChars`
(and/or `maxWords`) further, either as the default in `chunker.js` or
per-request via the request body.

## A second gotcha: chat context length (not the same as maxTokens)

An answer can get cut off mid-sentence for two completely different
reasons that look identical in the UI, and it's worth knowing which
one you're looking at:

1. **`maxTokens` was set** and generation hit that cap. Working as
   configured — raise it or clear the field for a longer answer.
2. **Ollama's own `num_ctx` context window ran out**, even with
   `maxTokens` left blank ("no limit"). This is a *completely separate*
   setting from `maxTokens`/`num_predict` — it's the total budget
   (prompt + retrieved chunks + system instructions + the answer being
   generated, all together) the model is allowed to use, and Ollama
   defaults it to a fairly small value (commonly 2048 tokens) for many
   models regardless of what that model could actually support. This
   app never sets `num_ctx` anywhere, so every request uses whatever
   Ollama's own default is. The bigger `topK` is, or the bigger your
   chunk size, the more of that budget the retrieved context alone
   eats up before the model even starts answering — leaving less room
   for the answer, not more.

To tell these apart, `/query` and `/query/stream` both now return a
`doneReason` field straight from Ollama: `"stop"` means the model
reached a natural end on its own; `"length"` means it was cut off. The
browser UI reads this and shows a note under the answer explaining
which of the two above it was, based on whether *that request* itself
sent `maxTokens`. If you keep hitting case 2, the practical fixes are:
lower `topK` (fewer retrieved chunks = smaller prompt) or chunk size,
or raise the model's `num_ctx` yourself — Ollama supports this per
`Modelfile` (`PARAMETER num_ctx 8192`, for a model that supports it) or
per-request; this app doesn't expose the latter as a setting yet.

## Inspecting the store

Each workspace's `workspaces/<id>/store.json` is just a plain JSON
array — open it directly if you want to see exactly what got embedded
into that workspace, or delete that one file to start that workspace
over with an empty index (the other workspaces are untouched).

If you used the pipeline before workspaces existed, you may have a
leftover `store.json` sitting in the project root — that one is no
longer read by anything. Move whatever's in it into a named workspace
by re-running `/embed` with a `workspaceId`, then delete the old file.

## What's not here yet

- **No auth.** Anyone who can reach the server can list, embed into,
  and query any workspace, and now upload files into any workspace
  too. Fine for a single user on their own machine; a real requirement
  before this is ever exposed on the internet.
- **No upload size/quota management beyond the 50MB-per-file cap** on
  `/workspaces/:id/upload-and-embed`. Removing a document via `DELETE
  /workspaces/:id/documents/:sourceFile` now deletes its uploaded file
  along with its chunks (see that route above), so the "old uploads
  pile up forever" gap only applies to uploads nobody ever explicitly
  removes — an upload that's replaced, abandoned mid-workflow, or just
  never revisited still sits in `workspaces/<id>/uploads/` with no
  automatic cleanup.
- No de-duplication if you embed the same file into the same workspace
  twice — nothing blocks it or warns you first, it just quietly
  doubles that document's chunks in the store (uploaded files
  themselves never physically collide or overwrite — each upload gets
  a unique on-disk name — it's the store that ends up with the
  duplication, not the file). The "Documents in this workspace" list
  is the best way to catch this after the fact — a document showing
  roughly double its expected chunk count is exactly what a duplicate
  embed looks like there — and now that removal exists, the fix is a
  Remove click followed by re-embedding cleanly, rather than hand-
  editing `store.json`.
- No handling for documents so large that a single chunk's embedding
  call fails or times out.
- The path-based `/embed` (still there for PowerShell/scripting) has
  the same "arbitrary server file path" issue the upload route was
  built to avoid — fine for local scripting use, not something to
  expose without auth once this runs somewhere remote.

Worth tackling in roughly that order as the tool moves from "just for
me, on my machine" toward "other people, somewhere else."
