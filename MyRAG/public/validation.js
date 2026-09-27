/**
 * Small validation helpers shared between the browser and the server —
 * currently just email-address format checking, used by both the
 * "Email me when this finishes" recipient field (script.js, validated
 * client-side before a rubric analysis is even started) and the
 * server's own independent check right before actually sending
 * (src/emailNotify.js) — a request built by hand (see the "Testing
 * with PowerShell" section of README.md) bypasses the browser
 * entirely, so the server can never just trust that the client already
 * validated this.
 *
 * Isomorphic for the same reason public/reportHtml.js is: loaded as a
 * plain <script> in the browser (before script.js in index.html, so
 * its function declarations become globals script.js calls directly)
 * AND require()'d from Node (src/emailNotify.js) — no DOM APIs
 * anywhere in here, and the module.exports guard at the bottom is a
 * no-op in the browser. One implementation, used both places, so the
 * client-side "is this even worth submitting" check and the
 * server-side "is this actually safe to send to" check can never
 * quietly drift apart and disagree with each other.
 */

// Deliberately a practical, common-case check — NOT a full RFC 5322
// implementation (which permits far stranger addresses than anyone
// actually uses, like quoted local parts or bare IP-literal domains).
// This is the same "one @, no whitespace, at least one dot in the
// domain part" shape a browser's own `type="email"` input roughly
// enforces, which is exactly the level of strictness that matters
// here: catching a typo'd or empty field before an analysis runs and
// nothing gets sent, not being a mail-server-grade validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {string} value
 * @returns {boolean} true only for a non-empty string matching the
 *   practical shape above, after trimming surrounding whitespace.
 */
function isValidEmailAddress(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

// No-op in a browser classic <script> (where `module` is undefined) —
// see public/reportHtml.js's doc comment for the full explanation of
// this pattern.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isValidEmailAddress };
}
