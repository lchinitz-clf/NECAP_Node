/**
 * Minimal HTTP Basic Auth gate for the whole app.
 *
 * Deliberately the lightest-weight option that still gives real
 * username/password access control: no login page, no session store,
 * no cookies, no new dependency. The browser itself supplies the
 * credential prompt (that native gray dialog) the moment it gets a 401
 * with a `WWW-Authenticate: Basic` header back, and then silently
 * resends the same `Authorization: Basic <base64(user:pass)>` header
 * on every later request for the rest of that browser session — so in
 * practice this feels like "log in once per browser launch," with no
 * code here needed to make that happen.
 *
 * Credentials are read from the environment, never hardcoded here, so
 * a real password is never sitting in a file that might get copied,
 * emailed, or reviewed by someone else. Two ways to set them, checked
 * in this order:
 *   - AUTH_USERS="alice:secret1,bob:secret2" - one or more
 *     username:password pairs, comma-separated. Use this for more than
 *     one named login.
 *   - AUTH_USER / AUTH_PASSWORD - a single username/password pair;
 *     simpler to set when only one shared login is needed. Ignored if
 *     AUTH_USERS is also set.
 * If NEITHER is set, the server intentionally runs with NO access
 * control at all (every request passes straight through) rather than
 * refusing to start or falling back to some hardcoded default — a
 * built-in default credential would itself be a real vulnerability if
 * anyone forgot to override it before exposing the app, so "unprotected
 * unless you deliberately configure it" is the safer failure mode. This
 * also means local, everyday testing keeps working with zero config,
 * exactly as it did before this file existed. A clear, one-time warning
 * is printed to the server console in that case specifically so
 * "forgot to set the env vars before launching this on AWS" doesn't
 * fail silently.
 *
 * Honest limitations, worth remembering before relying on this beyond
 * a trusted network:
 *   - Basic Auth only base64-*encodes* the credential, it does not
 *     encrypt it — base64 is trivially reversible. Over plain HTTP (as
 *     this app runs today), anyone who can observe the network traffic
 *     between a browser and this server can recover the password. This
 *     is fine on localhost or a genuinely trusted LAN; it stops being
 *     fine the moment this server is reachable from a network you don't
 *     trust. Pairing this with HTTPS closes that gap (the credential is
 *     then protected by TLS the same way the rest of the traffic is);
 *     see the "Access control" section in README.md for that
 *     discussion.
 *   - There's no real "log out" — the browser holds onto the entered
 *     credential until it's fully closed (or its saved site password is
 *     cleared), not just until a tab closes.
 *   - This gates the WHOLE app uniformly (every route, including
 *     static files and /health) — there's no per-route or per-user
 *     permission model here, just "known credential or not."
 */

const crypto = require('crypto');

/**
 * Parses AUTH_USERS (preferred, supports multiple logins) or
 * AUTH_USER/AUTH_PASSWORD (a single login) from the environment into a
 * `username -> password` Map. Read once at module load — like the rest
 * of this app's config (OLLAMA_BASE_URL, PORT), these aren't expected
 * to change while the server is running.
 * @returns {Map<string, string>}
 */
function parseConfiguredUsers() {
  const users = new Map();

  if (process.env.AUTH_USERS) {
    for (const rawPair of process.env.AUTH_USERS.split(',')) {
      const pair = rawPair.trim();
      if (!pair) continue;
      const sep = pair.indexOf(':');
      if (sep === -1) {
        console.warn(`[auth] Ignoring malformed AUTH_USERS entry (expected "username:password"): "${pair}"`);
        continue;
      }
      const username = pair.slice(0, sep).trim();
      const password = pair.slice(sep + 1);
      if (!username) continue;
      users.set(username, password);
    }
  } else if (process.env.AUTH_USER && process.env.AUTH_PASSWORD) {
    users.set(process.env.AUTH_USER, process.env.AUTH_PASSWORD);
  }

  return users;
}

const configuredUsers = parseConfiguredUsers();

if (configuredUsers.size === 0) {
  console.warn(
    '[auth] No AUTH_USER/AUTH_PASSWORD or AUTH_USERS set in the environment - ' +
    'this server is running with NO access control. Set one of those before ' +
    'launching this anywhere reachable beyond your own trusted network.'
  );
} else {
  console.log(`[auth] Basic Auth enabled for ${configuredUsers.size} account(s).`);
}

/**
 * Constant-time comparison of two strings, so a wrong password takes
 * the same time to reject regardless of how many leading characters
 * happened to match — closes a very small, but real, timing
 * side-channel that a plain `===` comparison leaves open.
 * crypto.timingSafeEqual() itself requires equal-length buffers, so a
 * length mismatch is handled by comparing against a same-length dummy
 * first (still constant-time relative to the actual secret) rather
 * than short-circuiting immediately on `.length` — a naive early
 * return there would itself leak the correct password's length.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function sendAuthRequired(res) {
  // The realm string is just a label the browser may show alongside
  // its credential prompt - not a secret, not read by this app itself.
  res.set('WWW-Authenticate', 'Basic realm="local-rag", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

/**
 * Express middleware. Mounted as the very first `app.use()` in
 * index.js - ahead of express.json(), express.static(), and every
 * route - so nothing (static files, /health included) is reachable
 * without a valid credential once one is configured. When no
 * credentials are configured at all (see parseConfiguredUsers() above)
 * this is a no-op that always calls next() immediately.
 *
 * On success, sets `req.authUser` to the authenticated username, so a
 * later feature (e.g. the activity log in src/activityLog.js, which
 * today only has req.ip to say "who") has a real identity available to
 * use without this middleware needing to change again.
 */
function basicAuth(req, res, next) {
  if (configuredUsers.size === 0) return next();

  const header = req.headers.authorization || '';
  const spaceIdx = header.indexOf(' ');
  const scheme = spaceIdx === -1 ? header : header.slice(0, spaceIdx);
  const encoded = spaceIdx === -1 ? '' : header.slice(spaceIdx + 1);

  if (scheme === 'Basic' && encoded) {
    let decoded;
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return sendAuthRequired(res);
    }
    const sep = decoded.indexOf(':');
    if (sep !== -1) {
      const username = decoded.slice(0, sep);
      const password = decoded.slice(sep + 1);
      const expectedPassword = configuredUsers.get(username);
      if (expectedPassword !== undefined && timingSafeStringEqual(password, expectedPassword)) {
        req.authUser = username;
        return next();
      }
    }
  }

  sendAuthRequired(res);
}

module.exports = { basicAuth };
