/**
 * Sends the "rubric analysis finished" completion email — the email
 * side of the "Email me when this finishes" checkbox on the query
 * form (see index.html/script.js) and its documentation in README.md.
 *
 * This is deliberately the SIMPLE version: the run this reports on
 * must stay on one open /query/stream connection for its entire
 * duration, same as today — see the AbortController/`clientGone`
 * wiring in index.js, which the "Stop" button and a closed browser
 * tab both trigger identically. sendRubricCompletionEmail() below is
 * only ever called from inside that same request handler, right after
 * it finishes normally (never on an aborted or errored run — nothing
 * useful to report there yet). A genuinely decoupled "kick this off
 * and close the laptop" version would need batch execution moved out
 * of the request lifecycle entirely into a real background job — a
 * separate, considerably larger piece of work this module does not
 * attempt.
 *
 * Configuration is TWO environment variables (see .env, loaded by
 * dotenv at startup same as AUTH_USER/AUTH_PASSWORD elsewhere in this
 * app): GMAIL_USER and GMAIL_APP_PASSWORD — the sending Gmail account
 * (an App Password from myaccount.google.com/apppasswords, generated
 * with 2-Step Verification on, NOT the account's real password).
 * Leaving either unset is a supported, non-broken state:
 * sendRubricCompletionEmail() just no-ops with a one-time console
 * warning instead of sending anything, so checking the box without
 * configuring email never errors out the actual analysis.
 *
 * The RECIPIENT is deliberately NOT configuration at all — there is no
 * server-side default or fallback address here (an earlier version of
 * this feature had one, defaulting to GMAIL_USER itself; that's gone).
 * It comes from the `notifyEmailTo` argument below, which
 * /query/stream in index.js fills from the text box next to the
 * "Email me when this finishes" checkbox on the query form — a normal
 * user of this app types their own address there, they don't edit
 * .env on a server they may not even have shell access to. Every call
 * here independently re-validates that address (isValidEmailAddress()
 * in public/validation.js, the same function the browser already
 * checked with before even starting the run) and refuses to send
 * rather than guessing at a recipient if it's missing or malformed —
 * see the doc comment on sendRubricCompletionEmail() below for why
 * this can't just trust the client already did that check.
 *
 * Never throws, for the same reason src/activityLog.js's logging
 * functions never do: a failed or misconfigured email must not take
 * down, delay, or appear to have failed the real rubric analysis it's
 * reporting on. Every failure is caught, logged via console.error and
 * a terse logAction() marker (see src/activityLog.js) for the same
 * audit trail this app already keeps for uploads/deletes/rubric edits,
 * and swallowed.
 */

const nodemailer = require('nodemailer');
const { logAction } = require('./activityLog');
// The standalone HTML report builder — the exact same function the
// browser's "Export HTML" button calls (see public/script.js) —
// reused here so the email attachment and that download are always
// identical. Requireable from here specifically because
// public/reportHtml.js is written with no DOM dependency and a
// `module.exports` guard at its end; see that file's own doc comment.
const { buildAttributeResultsHtml } = require('../public/reportHtml.js');
// Same email-format check the browser already ran before letting this
// run start at all (see public/script.js's submit handler) — done
// again here, independently, because a hand-built request (see
// README.md's "Testing with PowerShell" section) never goes through
// that browser-side check in the first place.
const { isValidEmailAddress } = require('../public/validation.js');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAIL_FROM_NAME = process.env.NOTIFY_EMAIL_FROM_NAME || 'local-rag';

// Read once at module load, same as index.js does for AUTH_USER/
// AUTH_PASSWORD — a changed .env value needs a server restart to take
// effect either way (dotenv only loads once, at startup), so nothing
// is lost by not re-reading process.env on every send. Deliberately
// says nothing about the RECIPIENT — see this module's doc comment
// above — that's checked fresh on every single call instead, since it
// varies per request rather than being fixed server configuration.
const isConfigured = Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);

// Only logged once per server run rather than on every unconfigured
// attempt — someone who's checked the box without setting up .env
// yet, running several comparisons while they figure it out, shouldn't
// get the same warning spammed into the server log every time.
let warnedNotConfigured = false;

// Built lazily, once, on first actual use — not at module load, and
// not again per send. A server that's never had the checkbox ticked
// never pays for constructing a transporter it'll never use; one that
// has reuses the same authenticated connection pool nodemailer
// maintains internally rather than re-authenticating with Gmail every
// time.
let transporter = null;
function getTransporter() {
  if (!transporter) {
    // Nodemailer's "gmail" service preset resolves to the correct
    // host/port/TLS settings on its own (smtp.gmail.com, 465, implicit
    // TLS) — no need to hardcode or maintain those separately here.
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

/**
 * @param {object} params
 * @param {import('express').Request} params.req - used only for
 *   logAction()'s audit-trail marker (req.ip/req.authUser) — see
 *   logQueryActivity() in src/activityLog.js for the equivalent on the
 *   analysis's own log entry, written separately by the /query/stream
 *   caller regardless of whether this function is ever invoked.
 * @param {string} params.workspaceId
 * @param {string} params.topicLabel - the ideal-proposal topic's
 *   display label (topic.label in idealProposals.json), for the
 *   subject line and the report header.
 * @param {string} params.notifyEmailTo - the recipient address, as
 *   typed into the box next to the checkbox (see this module's doc
 *   comment for why there's no server-side fallback for this one).
 *   Missing or not a validly-formatted address: this function no-ops
 *   (after logging why) rather than guessing at where to send.
 * @param {Array<Object>} params.batches - same shape
 *   buildAttributeResultsHtml() in public/reportHtml.js expects: one
 *   entry per batch actually run, each with its own `records` and
 *   `sources`.
 * @param {string} [params.chatModel]
 * @param {number} [params.numCtx]
 * @returns {Promise<void>} always resolves — see this module's doc
 *   comment for why it never rejects.
 */
async function sendRubricCompletionEmail({ req, workspaceId, topicLabel, notifyEmailTo, batches, chatModel, numCtx }) {
  if (!isConfigured) {
    if (!warnedNotConfigured) {
      console.warn(
        '[emailNotify] "Email me when this finishes" was checked, but GMAIL_USER ' +
        'and/or GMAIL_APP_PASSWORD aren\'t set in .env — no email sent. ' +
        'See the "Email notifications" section of README.md.'
      );
      warnedNotConfigured = true;
    }
    return;
  }

  // Independently re-checked here — see this module's doc comment for
  // why the browser already having validated this isn't good enough on
  // its own. Logged every time rather than only once (unlike the
  // !isConfigured warning above): this is per-request data, not a
  // fixed server misconfiguration someone's already been told about,
  // so a caller bypassing the browser's own check (or a future bug in
  // it) stays visible each time it happens rather than only the first.
  if (!isValidEmailAddress(notifyEmailTo)) {
    console.warn(
      `[emailNotify] "Email me when this finishes" was checked for workspace "${workspaceId}" ` +
      `but the recipient ("${notifyEmailTo || ''}") isn't a valid email address — no email sent.`
    );
    logAction({
      req,
      type: 'emailNotifySent',
      workspaceId,
      success: false,
      error: 'invalid or missing recipient address',
      details: { topicLabel },
    });
    return;
  }

  try {
    const allRecords = batches.flatMap((b) => b.records || []);
    // A quick verdict-count line for the email body itself (e.g. "2
    // Matches, 1 Falls short") — the full per-attribute detail lives
    // in the attached report, not repeated here.
    const counts = {};
    for (const r of allRecords) {
      const label = r.category || 'Unparsed';
      counts[label] = (counts[label] || 0) + 1;
    }
    const summaryLine = Object.entries(counts)
      .map(([label, n]) => `${n} ${label}`)
      .join(', ') || 'no attributes could be parsed from the answer — see the attached report for the raw text';

    const html = buildAttributeResultsHtml(batches, { workspaceId, topicLabel, chatModel, numCtx });
    const subject = `Rubric analysis finished: ${topicLabel} (${workspaceId})`;
    // Plain text, not HTML, for the email body itself — deliberately
    // NOT trying to inline the styled report here: email clients are
    // notoriously inconsistent about <style> blocks (Gmail rewrites
    // and scopes CSS, Outlook mangles a lot of modern layout), so
    // rather than chase pixel-perfect rendering across mail clients,
    // the real report goes on as an attachment that opens perfectly in
    // any browser, and the body just says what happened.
    const text =
      `Your comparison against "${topicLabel}" in workspace "${workspaceId}" has finished.\n\n` +
      `${summaryLine}\n\n` +
      'The full report (with every quote verified against its source, same as the ' +
      '"Export HTML" button in the app) is attached.';

    await getTransporter().sendMail({
      from: `"${NOTIFY_EMAIL_FROM_NAME}" <${GMAIL_USER}>`,
      to: notifyEmailTo,
      subject,
      text,
      attachments: [
        { filename: `${workspaceId}-comparison.html`, content: html, contentType: 'text/html' },
      ],
    });

    logAction({ req, type: 'emailNotifySent', workspaceId, success: true, details: { topicLabel, to: notifyEmailTo } });
  } catch (err) {
    // Never rethrown — see this module's doc comment for why a failed
    // send must not affect the analysis it's reporting on.
    console.error('[emailNotify] failed to send completion email:', err);
    logAction({ req, type: 'emailNotifySent', workspaceId, success: false, error: err.message, details: { topicLabel, to: notifyEmailTo } });
  }
}

module.exports = { sendRubricCompletionEmail, isConfigured };
