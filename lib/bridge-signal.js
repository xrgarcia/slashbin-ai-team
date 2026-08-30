/**
 * Who may say "this happened", and what they are allowed to say.
 *
 * A signal is the one bridge message that starts a Claude run rather than
 * posting text, so it is the one that needs a credential. The rules live here,
 * away from the socket, because they are the security boundary and every one of
 * them has to be provable in a test — bot.js cannot be required (importing it
 * logs a live bot into Discord).
 *
 * The deeper boundary is not in this file: a signal carries a NAME, never a
 * prompt, and can only release a follow-up the bot itself booked for a channel
 * it itself chose. That is what makes it safe to hand to a CI job.
 */

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
// Opaque to the harness. It never interprets a name — that is what keeps this
// generic rather than a list of integrations someone has to extend.
const SIGNAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Constant-time where it matters; a length mismatch is not a secret. */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  if (a.length !== b.length) return false;
  // Lazily required so this module stays cheap to import in a test.
  return require("crypto").timingSafeEqual(a, b);
}

/**
 * @returns {string|null} why the signal is refused, or null when it is allowed
 */
function signalRefusal({ token, host, expectedToken }) {
  // An operator who set a token meant it — honour it even on loopback.
  if (expectedToken) {
    return tokenMatches(token, expectedToken) ? null : "signal refused: bad or missing token";
  }
  if (!LOOPBACK.includes(host)) {
    return `signal refused: the bridge is bound to ${host}, so anything that can reach it could start a run. Set BRIDGE_TOKEN and send it with the signal, or bind the bridge to loopback.`;
  }
  return null;
}

/**
 * Validate the name; truncate the payload rather than reject it.
 *
 * A notifier that attaches a whole build log should still WAKE the bot — losing
 * the wake-up over an oversized attachment would be the feature failing at the
 * only moment it matters. The bot is told the text was cut.
 *
 * @returns {{name:string,data:string|null}|{error:string}}
 */
function normalizeSignal({ name, data }, { max = 2000 } = {}) {
  if (!SIGNAL_NAME_RE.test(String(name ?? ""))) {
    return { error: "signal refused: a name must be 1-64 characters of letters, digits, dot, dash, underscore or colon" };
  }
  let text = data === undefined || data === null ? null : String(data);
  if (text !== null && text.length > max) {
    text = `${text.slice(0, max)}\n[…truncated at ${max} characters]`;
  }
  return { name: String(name), data: text };
}

module.exports = { signalRefusal, normalizeSignal, tokenMatches, SIGNAL_NAME_RE, LOOPBACK };
