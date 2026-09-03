/**
 * Thin wrapper around Ollama's local HTTP API. Nothing fancy — just
 * plain fetch calls to the same endpoints AnythingLLM has been using
 * under the hood this whole time (http://localhost:11434).
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

/**
 * Embeds a single string of text into a vector.
 *
 * Ollama's embedding endpoint defaults to a 512-token context window,
 * regardless of what the model itself supports (nomic-embed-text can
 * handle up to 8192). Unlike chat models, this does NOT appear to be
 * overridable per-request — passing options.num_ctx here is harmless
 * to leave in (in case a future Ollama version or a different
 * embedding model does respect it) but should NOT be relied on. The
 * real fix is upstream: chunker.js's default chunk size is kept
 * comfortably under 512 tokens so we never hit this ceiling at all.
 *
 * @param {string} text
 * @param {string} model - e.g. "nomic-embed-text"
 * @param {number} numCtx - context window to request, in tokens (see caveat above).
 * @param {AbortSignal} [signal] - lets a caller cancel this call
 *   in-flight (e.g. /query/stream in index.js wires this to the
 *   client's own connection closing — see the comment on that route).
 *   Passed straight through to fetch(); an aborted call rejects with
 *   an AbortError, which is deliberately rethrown as-is below rather
 *   than wrapped in the "could not reach Ollama" message, since a
 *   cancellation isn't a connection failure.
 * @returns {Promise<number[]>}
 */
async function embed(text, model = 'nomic-embed-text', numCtx = 2048, signal) {
  let res;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text, options: { num_ctx: numCtx } }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(
      `Could not reach Ollama at ${OLLAMA_BASE_URL}. Is "ollama serve" running? (${err.message})`
    );
  }

  if (!res.ok) {
    throw new Error(`Ollama /api/embeddings failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.embedding;
}

/**
 * Sends a chat-style request to a local Ollama model and returns the
 * full generated text.
 *
 * By default this waits for the whole response (stream: false) — fine
 * for scripted/PowerShell use, where you just want one JSON object
 * back. Pass onToken to switch to Ollama's streaming mode instead:
 * Ollama then sends the answer back as a series of small NDJSON lines
 * (each one a fragment of the message) as the model generates them,
 * and onToken(piece) is called once per fragment as they arrive — this
 * is what makes a live "typing" UI possible instead of one long silent
 * wait. Either way, the function's return value is the same: the full
 * answer text, accumulated from the fragments in streaming mode.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} opts
 * @param {string} [opts.model] - e.g. "llama3.1:8b"
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens] - caps how many tokens the model may
 *   generate, passed through as Ollama's `num_predict`. Left out of the
 *   request entirely when omitted (rather than defaulted here), so
 *   Ollama's own default (-1, meaning "no explicit cap, generate until
 *   a natural stop or the model's context window runs out") applies —
 *   same "absence means don't override" convention temperature would
 *   ideally follow too, though temperature's default of 0.2 predates
 *   this and is left as-is to avoid changing existing behavior.
 * @param {(piece: string) => void} [opts.onToken] - if provided, switches
 *   to streaming mode and is called once per fragment of generated text.
 * @param {boolean} [opts.think] - for reasoning models (deepseek-r1,
 *   qwen3, and others Ollama recognizes as "thinking" models): whether
 *   the model may work through a chain-of-thought before answering.
 *   Left out of the request entirely when omitted, same "absence means
 *   don't override" convention maxTokens follows above — Ollama's own
 *   default is to leave thinking ON for models that support it, same as
 *   `ollama run` does, so omitting this preserves that. Passing `false`
 *   explicitly is a genuine skip, not just a hidden/discarded step: per
 *   Ollama's docs the model runs in a non-thinking mode and never
 *   generates those tokens at all, so it's a real speed/compute win, not
 *   only a display filter. This is a TOP-LEVEL field on the request body
 *   below (a sibling of `model`/`messages`/`options`) — Ollama does NOT
 *   treat it as a model runtime parameter the way temperature/num_predict
 *   are, so it deliberately does not go inside `options`. Models that
 *   don't support thinking at all just ignore it either way. Worth
 *   knowing: `maxTokens`/`num_predict` above caps thinking and answer
 *   tokens TOGETHER as one shared budget, not separately — a verbose
 *   thinker can in principle exhaust the whole cap before producing any
 *   real answer content, surfacing as `doneReason: "length"` with an
 *   empty or truncated `text` despite `thinking` being non-empty. There
 *   is currently no way to bound thinking on its own.
 * @param {(piece: string) => void} [opts.onThinking] - streaming mode
 *   only (has no effect without onToken too): called once per fragment
 *   of the model's reasoning trace, kept entirely separate from onToken
 *   — Ollama itself streams `message.thinking` deltas apart from
 *   `message.content` deltas, reasoning first, then the actual answer.
 * @param {AbortSignal} [opts.signal] - lets a caller cancel generation
 *   in-flight, at Ollama itself, not just stop reading the response.
 *   /query/stream in index.js wires this to the client's own HTTP
 *   connection closing (see that route's comment for the full chain).
 *   Passed straight through to fetch(); aborting mid-stream makes the
 *   pending `reader.read()` below reject with an AbortError, which
 *   propagates out of this function uncaught — same "let it surface
 *   as-is" treatment the initial-connect catch block below gives it.
 * @returns {Promise<{text: string, thinking: string, doneReason: string|undefined}>}
 *   `text` is the full answer, same as this always returned before.
 *   `thinking` is the full reasoning trace accumulated from
 *   `message.thinking` fragments — an empty string for a model that
 *   doesn't produce one, or when `think: false` was passed. `doneReason`
 *   is Ollama's own explanation for why generation stopped — normally
 *   `"stop"` (the model reached a natural end, e.g. hit its own
 *   end-of-turn token), or `"length"` if it was cut off by a limit
 *   instead: either `maxTokens`/`num_predict` above if that was set, OR,
 *   just as commonly, Ollama's `num_ctx` context-window ceiling being
 *   exhausted by the prompt + answer combined — that one is NOT
 *   controlled by maxTokens at all, isn't set anywhere in this file, and
 *   so is silently using Ollama's own default (2048 tokens for many
 *   models unless the Modelfile says otherwise) regardless of what the
 *   model itself could support. A caller can't tell those two "length"
 *   causes apart from doneReason alone — only from whether it itself
 *   passed maxTokens. (See the `think` param above for a third
 *   "length" cause specific to reasoning models: the shared
 *   thinking+answer token budget being exhausted by thinking alone.)
 */
async function chat(messages, { model = 'llama3.1:8b', temperature = 0.2, maxTokens, onToken, think, onThinking, signal } = {}) {
  const streaming = typeof onToken === 'function';
  const options = { temperature };
  if (maxTokens !== undefined) options.num_predict = maxTokens;
  const body = { model, messages, stream: streaming, options };
  // Top-level, not inside `options` — see the `think` doc comment above
  // for why. Omitted entirely (not even `think: undefined`, which
  // JSON.stringify would drop anyway, but being explicit about the
  // reasoning here) unless the caller took a position on it.
  if (think !== undefined) body.think = think;
  let res;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(
      `Could not reach Ollama at ${OLLAMA_BASE_URL}. Is "ollama serve" running? (${err.message})`
    );
  }

  if (!res.ok) {
    throw new Error(`Ollama /api/chat failed: ${res.status} ${await res.text()}`);
  }

  if (!streaming) {
    const data = await res.json();
    return {
      text: data.message.content,
      thinking: (data.message && data.message.thinking) || '',
      doneReason: data.done_reason,
    };
  }

  // Streaming mode: Ollama's response body is itself newline-delimited
  // JSON, one object per fragment, e.g.
  //   {"message":{"role":"assistant","content":"","thinking":"First,"},"done":false}
  //   {"message":{"role":"assistant","content":"","thinking":" the"},"done":false}
  //   ...
  //   {"message":{"role":"assistant","content":"Off"},"done":false}
  //   {"message":{"role":"assistant","content":"shore"},"done":false}
  //   ...
  //   {"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop",...}
  // Ollama streams the reasoning first (as message.thinking deltas),
  // then the answer (as message.content deltas) — a fragment is never
  // both. Same "buffer partial lines across reads" approach as the
  // /embed streaming route on our own server — a chunk from the
  // network can split a JSON line in the middle, so we only parse
  // once we've seen a full line.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let fullThinking = '';
  let doneReason;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      const obj = JSON.parse(line);
      const thinkingPiece = obj.message && obj.message.thinking;
      if (thinkingPiece) {
        fullThinking += thinkingPiece;
        if (onThinking) onThinking(thinkingPiece);
      }
      const piece = obj.message && obj.message.content;
      if (piece) {
        full += piece;
        onToken(piece);
      }
      if (obj.done) doneReason = obj.done_reason;
    }
  }

  return { text: full, thinking: fullThinking, doneReason };
}

/**
 * Lists models currently pulled in this Ollama installation (via
 * `ollama pull`) — this is what lets a UI offer a real, accurate list
 * of chat models instead of a hardcoded guess. Ollama doesn't expose
 * "this one's for chat, that one's for embeddings" as metadata, so
 * this returns everything you've pulled, embedding models included;
 * picking an embedding model here as a chat model will just fail
 * loudly when you try to use it, since it was never built to generate
 * text.
 * @returns {Promise<string[]>}
 */
async function listModels() {
  let res;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  } catch (err) {
    throw new Error(
      `Could not reach Ollama at ${OLLAMA_BASE_URL}. Is "ollama serve" running? (${err.message})`
    );
  }

  if (!res.ok) {
    throw new Error(`Ollama /api/tags failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

module.exports = { embed, chat, listModels };
