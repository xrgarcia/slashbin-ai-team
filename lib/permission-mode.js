/**
 * One resolution of the tool-permission mode, for every process that needs it.
 *
 * Two processes decide this — bot.js for a session, summarize.js for a standalone
 * summarization run — and they used to decide it separately, each reading
 * `process.env.BOT_PERMISSION_MODE` with its own inline fallback. That is the same
 * duplication documented at the top of summarize-core.js, where adding this very
 * setting once needed three identical edits. A second resolution site is how a
 * fleet default gets honoured in one process and silently ignored in the other.
 *
 * ## Precedence
 *
 *   1. `BOT_PERMISSION_MODE`          — this bot. Always wins.
 *   2. `BOT_PERMISSION_MODE_DEFAULT`  — every bot on this host that sets no mode.
 *   3. `"restricted"`                 — the built-in default.
 *
 * The fleet variable exists because the per-bot one is the only control there was,
 * and on a multi-bot host that means writing the same line into every app entry.
 * Measured on a real fleet: 8 bots, 8 identical edits, and the failure mode of
 * missing one is a bot that still answers questions and has quietly lost the
 * ability to write a file — nothing errors, so nobody notices.
 *
 * Two variables rather than one because by the time a bot is running, a per-bot
 * value and a host value are both just environment. Only distinct names can tell
 * "this bot chose restricted" apart from "nobody said anything."
 *
 * Nothing here changes an existing install: with neither variable set the answer
 * is still `restricted`, and a bot that sets `BOT_PERMISSION_MODE` is unaffected
 * by any host default.
 */

/** The only two answers. An unrecognised mode is a startup failure, never a guess. */
const VALID_MODES = ["bypass", "restricted"];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mode: string, source: string }} `source` names where the value came
 *   from, so the startup log can distinguish an explicit `restricted` from an
 *   unset one — the question a fleet operator asks when one bot behaves
 *   differently from its siblings.
 */
function resolvePermissionMode(env = process.env) {
  const perBot = (env.BOT_PERMISSION_MODE || "").trim();
  if (perBot) return { mode: perBot, source: "BOT_PERMISSION_MODE" };

  const fleet = (env.BOT_PERMISSION_MODE_DEFAULT || "").trim();
  if (fleet) return { mode: fleet, source: "BOT_PERMISSION_MODE_DEFAULT (host default)" };

  return { mode: "restricted", source: "built-in default" };
}

module.exports = { resolvePermissionMode, VALID_MODES };
