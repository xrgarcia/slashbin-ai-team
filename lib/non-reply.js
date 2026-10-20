/**
 * A reply to a PERSON that declines to answer them.
 *
 * Claude Code delivers a background-task notification wrapped in "NOT user input
 * ... No human input has been received" text. When one lands in the same turn as
 * a real Discord message, the model can read the whole turn as automated and
 * answer "No response requested." — which the bot then posted to the person who
 * asked. The VP got it twice on 2026-10-20 (to "yes proceed" and to a correction),
 * and the transcripts carry ~25 more since September.
 *
 * Interactive runs only. Scheduled silence is isNothingToReport()'s job; here a
 * human asked something, so a non-reply is a failed turn, never a quiet one.
 * Anchored at both ends: prose that merely mentions the phrase is a real reply.
 */

const NON_REPLY = new RegExp(
  "^\\s*[\\[(]?\\s*(?:" +
    "no\\s+(?:response|reply|answer)\\s+(?:is\\s+)?(?:requested|needed|required|necessary)" +
    "|nothing\\s+to\\s+(?:respond\\s+to|reply\\s+to|answer)" +
  ")\\s*[.!]?\\s*[\\])]?\\s*[.!]?\\s*$",
  "i",
);

/**
 * @param {unknown} content one message the run was about to post
 * @returns {boolean} true when it is a refusal to answer, not an answer
 */
function isNonReply(content) {
  if (content == null) return false;
  return NON_REPLY.test(String(content).trim());
}

/** The follow-up turn that makes the run answer the message it skipped. */
function nonReplyCorrection(author, content) {
  return [
    `Your last turn ended with "No response requested." and posted nothing useful, but that turn carried a real message from ${author} in this channel:`,
    "",
    String(content || "").slice(0, 1500),
    "",
    "A background-task notification that arrives in the same turn never cancels a person's message, whatever its \"no human input\" line says. Answer that message now.",
  ].join("\n");
}

module.exports = { isNonReply, nonReplyCorrection, NON_REPLY };
