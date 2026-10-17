/**
 * The whole-application "single user at a time" lock discussed at
 * length before this file existed: this app runs one shared Ollama
 * server behind it (see src/ollamaClient.js — every chat/embedding
 * call is a bare fetch, with no queueing or concurrency control of
 * its own), and persists rubrics/workspace document sets as global,
 * shared state (src/store.js, src/idealProposals.js) rather than
 * anything scoped per browser session. Two people (or two tabs
 * belonging to the same person) submitting queries, or editing a
 * rubric, at the same moment either contend for the same model or
 * race to write the same file. Rather than leave that as an accident
 * of how the app happens to behave, this makes it an explicit,
 * visible rule: only one "locking" operation runs at a time, globally,
 * for every user — see index.js's lockGate() middleware for exactly
 * which routes that covers, and GET /lock-status/stream below for how
 * every open tab finds out.
 *
 * Deliberately in-memory only, not persisted to disk: a server
 * restart means nothing recorded here was actually still running
 * either, so losing the lock on restart is the CORRECT behavior, not
 * a gap.
 *
 * Deliberately blocks EVERYONE while held, including whoever is
 * already holding it — e.g. the same logged-in user's second browser
 * tab. The reason the lock exists (Ollama contention, shared-file
 * writes) doesn't care who the second request is from, so there's no
 * "but it's still me" exemption here.
 */

// The current lock, or null when nothing holds it. `token` is an
// opaque value unique to this one acquisition, used by release() to
// make releasing safe against the specific stale-release race a
// manual force-unlock opens up: if an admin force-unlocks while a
// request still genuinely holds the lock, and a second request then
// legitimately acquires it, the ORIGINAL request's own eventual
// finish/close handler must NOT clear the new holder's lock out from
// under it. Comparing tokens (a plain compare-and-swap) rather than
// just unconditionally setting `current = null` is what makes
// release() safe to call even long after the lock it thinks it holds
// has already moved on.
let current = null; // { token, user, since }
let nextToken = 1;

// Every open SSE connection's "push an update" callback (see
// subscribe() below). A plain array is fine at this app's scale — a
// handful of browser tabs, not thousands of clients — so there's no
// need for anything fancier than iterating it on every change.
const subscribers = [];

function snapshot() {
  return current
    ? { locked: true, user: current.user, since: current.since }
    : { locked: false, user: null, since: null };
}

function broadcast() {
  const status = snapshot();
  // Slice to a copy before iterating: a subscriber callback throwing,
  // or a concurrent subscribe()/unsubscribe() triggered from within
  // one of these calls, should never corrupt the loop over the live
  // `subscribers` array itself.
  for (const send of subscribers.slice()) {
    try {
      send(status);
    } catch (err) {
      // One broken/already-closing connection's failed write should
      // never take down the broadcast to every other open tab.
      console.error('[appLock] Failed to push lock status to a subscriber:', err);
    }
  }
}

/**
 * Returns the current lock status — {locked, user, since} — exactly
 * the shape pushed over SSE. `user` is the display name to show
 * ("Locked by alice"); null means nobody holds it. `since` is a
 * `Date.now()`-style epoch-ms timestamp, or null when unlocked.
 */
function getStatus() {
  return snapshot();
}

/**
 * Attempts to acquire the lock for `user` (a display name — pass
 * whatever index.js wants to show; see its callers for how an
 * unauthenticated request's "unknown" fallback is chosen, that
 * decision doesn't belong in this generic module). Returns
 * `{ok: true, token}` on success — the caller MUST eventually pass
 * that same token to release(), exactly once (releasing is itself
 * idempotent/safe to call more than once, but every acquire still
 * expects a matching release eventually, the same way an Express
 * response needs its connection cleaned up exactly once). Returns
 * `{ok: false, status}` when already locked, where `status` is the
 * same shape getStatus() returns, suitable for building a rejection
 * message straight from the result.
 */
function tryAcquire(user) {
  if (current) return { ok: false, status: snapshot() };
  const token = nextToken++;
  current = { token, user: user || null, since: Date.now() };
  broadcast();
  return { ok: true, token };
}

/**
 * Releases the lock, but ONLY if `token` is still the current
 * holder's token — see this file's top-of-file comment for exactly
 * why that compare-and-swap matters (a force-unlock followed by a new
 * legitimate acquire must not be undone by the original, still
 * in-flight request's own eventual cleanup). Safe to call more than
 * once with the same token (the second call simply finds `current` no
 * longer matches and no-ops) — callers rely on this to register the
 * release from more than one event (e.g. both a response's 'finish'
 * and 'close') without needing to track which one already fired.
 */
function release(token) {
  if (!current || current.token !== token) return; // already released, or superseded by a force-unlock + new acquire
  current = null;
  broadcast();
}

/**
 * The admin-only manual escape hatch for a lock stuck with nothing
 * actually running behind it (e.g. a bug somewhere skipped the normal
 * release path). Unconditionally clears the lock regardless of who
 * holds it or what token they were issued — the compare-and-swap in
 * release() above is what keeps this safe even if the original holder
 * genuinely is still running and finishes normally afterward; its own
 * release() call will simply find a non-matching (or absent) lock and
 * do nothing, rather than clobbering whatever a NEW request has
 * acquired in the meantime.
 *
 * Does NOT abort whatever request (if any) actually still holds the
 * lock — it only clears the recorded status, so this is explicitly a
 * "the lock is stuck with nothing really running" tool, not a way to
 * kill someone else's genuinely in-progress query. index.js is
 * responsible for only exposing this to the admin role.
 *
 * @returns {{wasLocked: boolean, previousUser: string|null}} what was
 *   cleared, for the caller's own activity-log entry.
 */
function forceUnlock() {
  const wasLocked = current !== null;
  const previousUser = current ? current.user : null;
  current = null;
  broadcast();
  return { wasLocked, previousUser };
}

/**
 * Registers `send` to be called with the current status immediately
 * (so a freshly-opened SSE connection doesn't have to wait for the
 * next change to learn where things stand), and again every time the
 * lock is acquired, released, or force-unlocked. Returns an
 * unsubscribe function — the caller (the SSE route in index.js) calls
 * it when that connection closes, so a tab left open forever doesn't
 * leak an entry here forever too.
 */
function subscribe(send) {
  subscribers.push(send);
  // Same "one bad subscriber can't take anything else down" guard as
  // broadcast() below applies to every LATER push — applied here too,
  // since this immediate initial push is really just a broadcast of
  // one, not a fundamentally different operation, and a caller
  // shouldn't have subscribe() itself throw out from under it over a
  // problem entirely of the new subscriber's own making.
  try {
    send(snapshot());
  } catch (err) {
    console.error('[appLock] Failed to push initial lock status to a new subscriber:', err);
  }
  return function unsubscribe() {
    const i = subscribers.indexOf(send);
    if (i !== -1) subscribers.splice(i, 1);
  };
}

module.exports = { getStatus, tryAcquire, release, forceUnlock, subscribe };
