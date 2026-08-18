/**
 * Does this scheduled-job reply say nothing?
 *
 * A polling job whose honest answer is "nothing happened" cannot simply say
 * nothing: the model cannot emit a truly empty turn — the harness re-prompts it —
 * so it reaches for a placeholder instead ("[no output]", ".", "none"), and every
 * one of those became a Discord ping. A job that fires hourly trains people to
 * ignore it, which costs you the one message that mattered.
 *
 * Deciding this here rather than by prompting makes it deterministic. Prompting a
 * model to "reply with nothing" is asking it to do the one thing it structurally
 * cannot.
 *
 * ## Why the match is anchored at both ends
 *
 * That anchoring is the whole safety property. "No changes since Tuesday" is a
 * real report a human would want; a bare "no changes" is the model padding. Only
 * a message that is ENTIRELY a placeholder is suppressed.
 *
 * Brackets and parens are treated as a wrapper, never as a reason. An earlier
 * version matched any fully-bracketed message, which would have silently
 * swallowed a terse alert like "[DISK FULL]".
 *
 * Scheduled jobs only. An interactive reply is never filtered — a human asked a
 * question, and silence reads as the bot being broken.
 */

const NOTHING_TO_REPORT = new RegExp(
  "^\\s*[\\[(]?\\s*(?:" +
    "[.•\\-–—]+" +                                                  // a lone punctuation placeholder
    "|n/?a|nil|none|empty|null|undefined" +                         // bare negatives
    "|nothing(?:\\s+(?:to\\s+report|new|found|happened|here))?" +   // "nothing", "nothing to report"
    "|no\\s+(?:output|content|response|changes?|updates?|news|" +
      "activity|results?|items?|messages?|errors?|open\\s+prs?|new\\s+[\\w-]+)" +
  ")\\s*[\\])]?\\s*[.!]?\\s*$",
  "i",
);

/**
 * @param {unknown} content the reply a scheduled job produced
 * @returns {boolean} true when it carries no information and should not be posted
 */
function isNothingToReport(content) {
  if (content == null) return true;
  const text = String(content).trim();
  if (!text) return true;
  return NOTHING_TO_REPORT.test(text);
}

module.exports = { isNothingToReport, NOTHING_TO_REPORT };
