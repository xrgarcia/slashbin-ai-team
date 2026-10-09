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

/**
 * The rule that lets a restricted session read the files people upload to it.
 * Attachments are saved under BOT_ATTACHMENTS_DIR, which is normally outside
 * CLAUDE_CWD, and dontAsk denies a Read outside the working directory unless a
 * rule names it — so without this an uploaded file is unreadable. `//` marks an
 * absolute path in a permission rule. Read only: nothing else is granted there.
 *
 * @param {string} dir the attachments directory
 * @returns {string}
 */
function attachmentReadRule(dir) {
  const abs = require("path").resolve(dir).replace(/\/+$/, "");
  return `Read(/${abs}/**)`;
}

/**
 * What a run whose reply leaves Discord (a Paperclip board task) must not reach.
 * Everything here is Discord conversation memory: the buffer and summaries, the
 * files people uploaded, which channels are live, and what scheduled jobs said
 * and will say. Keeping it out of the prompt is not enough — the recall skill
 * finds these stores through the environment, and the read tools reach them by
 * path. So a board run gets none of the variables, and a deny rule on each path,
 * which holds in every mode (deny beats allow, and bypass keeps deny rules).
 * Read rules do not bind the shell, so the shell runs in Claude Code's sandbox
 * with the same paths unreadable (boardSettings).
 */
const PRIVATE_MEMORY_ENV = ["BOT_SUMMARIES_DIR", "BOT_BUFFER_FILE", "BOT_ATTACHMENTS_DIR",
  "BOT_SESSIONS_FILE", "BOT_JOB_HISTORY_FILE", "BOT_SCHEDULES_FILE"];

/**
 * @param {string[]} paths the files and folders PRIVATE_MEMORY_ENV points at
 * @returns {string[]} Read deny rules covering each path and anything under it
 */
function privateMemoryDeny(paths) {
  return paths.flatMap((p) => {
    const abs = require("path").resolve(p).replace(/\/+$/, "");
    return [`Read(/${abs})`, `Read(/${abs}/**)`];
  });
}

/**
 * The settings for a board run: the bot's own settings (BOT_SETTINGS, already
 * parsed) with the shell sandboxed and every Discord memory path unreadable to
 * it. A shell outside the sandbox could read them with cat, so a command may not
 * leave it, and a host without the sandbox fails the run instead of running it
 * open. Network is left as the bot's settings have it — measured 2026-10-08 on
 * the bots' host: in the sandbox, cat of a denied file fails while curl and gh
 * still reach GitHub.
 *
 * @param {object|null} base the bot's settings, or null
 * @param {string[]} paths the paths PRIVATE_MEMORY_ENV points at
 * @returns {object}
 */
function boardSettings(base, paths) {
  const b = base ?? {};
  const fs = b.sandbox?.filesystem ?? {};
  const abs = paths.map((p) => require("path").resolve(p));
  return {
    ...b,
    sandbox: {
      ...b.sandbox,
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { ...fs, denyRead: [...(fs.denyRead ?? []), ...abs] },
    },
  };
}

/**
 * The flags for a summarization run, in EVERY mode. A summary is written from a
 * transcript already in its prompt, and that transcript is Discord text from
 * anyone in the channel. It never needs to write, execute or reach a server, so
 * bypass does not apply here: only the reading tools, nothing that prompts, no
 * MCP servers, and the bot's own deny rules and settings (BOT_SETTINGS) on top.
 *
 * @param {{ tools?: string, deny?: string, settings?: string }} [o]
 * @returns {string[]}
 */
function summarizerArgs({ tools = "Read", deny = "", settings = "" } = {}) {
  return [
    "--tools", tools,
    "--permission-mode", "dontAsk",
    "--strict-mcp-config",
    ...(deny ? ["--disallowedTools", deny] : []),
    ...(settings ? ["--settings", settings] : []),
  ];
}

module.exports = { resolvePermissionMode, VALID_MODES, attachmentReadRule, summarizerArgs, PRIVATE_MEMORY_ENV, privateMemoryDeny, boardSettings };
