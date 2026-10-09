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
 * Read rules do not bind the shell, so any shell a board run is allowed runs in
 * Claude Code's sandbox with the same paths unreadable (boardSettings).
 */
const PRIVATE_MEMORY_ENV = ["BOT_SUMMARIES_DIR", "BOT_BUFFER_FILE", "BOT_ATTACHMENTS_DIR",
  "BOT_SESSIONS_FILE", "BOT_JOB_HISTORY_FILE", "BOT_SCHEDULES_FILE"];

/**
 * The bot's own Discord credentials. A board run has no Discord channel to
 * answer in, and anything its shell can print can land in a reply every board
 * reader sees: with the bot token a reader could log in as the bot and read its
 * private channels; with the bridge token, post as it. The sandbox guards files,
 * not an inherited environment, so these are withheld from the run.
 */
const DISCORD_CREDENTIAL_ENV = ["DISCORD_TOKEN", "BRIDGE_TOKEN"];

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
 * The flags for a board run, in EVERY mode — bypass does not apply, as it does
 * not to a summary. A board is read by people who are not in the bot's Discord
 * channels, and a shell on a shared host can read far more than a list of
 * private paths can name (Claude's own transcripts, sibling bots' state). So a
 * board run gets least privilege: only `tools` (read-only built-ins by
 * default), dontAsk, which confines the read tools to the working directory,
 * and only what `allow` names on top.
 *
 * @param {{ tools: string, allow?: string, deny?: string[] }} o
 * @returns {string[]}
 */
function boardArgs({ tools, allow = "", deny = [] }) {
  return [
    "--tools", tools,
    "--permission-mode", "dontAsk",
    ...(allow ? ["--allowedTools", allow] : []),
    ...(deny.length ? ["--disallowedTools", ...deny] : []),
  ];
}

// What a sandboxed board shell may read besides its working directory: the
// system folders commands run from. Not /tmp, /var, /srv, /opt or /home, where
// another bot's buffer or state may sit.
const SYSTEM_READ = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/proc", "/dev", "/sys"];

/**
 * The settings for a board run: the bot's own settings (BOT_SETTINGS, already
 * parsed) with the shell sandboxed to the working directory. A shell a board
 * run is allowed reads nothing outside it but the system folders (SYSTEM_READ):
 * not the home folder, /tmp, or another bot's state wherever it sits. Nor the
 * Discord memory paths even where they sit inside the working directory, nor
 * any of them when the working directory is one (an allowRead is mounted back
 * over a denyRead, so one is never given for a denied path). A command may not
 * leave the sandbox, and a host without it fails the run instead of running it
 * open. Measured 2026-10-09 on the bots' host: inside the working directory cat
 * works and git runs; a file in /tmp, /var/tmp or elsewhere in the home folder
 * reads as missing. A tool kept outside the system folders (node under nvm or
 * ~/.local, gh's login) needs an allowRead in the bot's own settings.
 *
 * @param {object|null} base the bot's settings, or null
 * @param {string[]} paths the paths PRIVATE_MEMORY_ENV points at
 * @param {string} cwd the run's working directory
 * @returns {object}
 */
function boardSettings(base, paths, cwd) {
  const b = base ?? {};
  const fs = b.sandbox?.filesystem ?? {};
  const { resolve: abs, sep } = require("path");
  const resolve = (p) => abs(String(p).replace(/^~(?=\/|$)/, require("os").homedir()));
  // An allowRead is mounted back over a denyRead, so one that is a denied path,
  // or lies inside one, would reopen it: a working directory that IS the
  // harness folder gets no allowRead, and neither does such an entry of the bot's.
  const denied = paths.map(resolve);
  const reopens = (p) => denied.some((d) => resolve(p) === d || resolve(p).startsWith(d + sep));
  return {
    ...b,
    // Project auto-memory holds what Discord sessions in this folder saved, and
    // the CLI loads it at startup, where no sandbox or deny rule reaches.
    autoMemoryEnabled: false,
    sandbox: {
      ...b.sandbox,
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        ...fs,
        denyRead: [...(fs.denyRead ?? []), "/", ...paths.map(resolve)],
        allowRead: [...SYSTEM_READ, ...(fs.allowRead ?? []), resolve(cwd)].filter((p) => !reopens(p)),
      },
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

module.exports = { resolvePermissionMode, VALID_MODES, attachmentReadRule, summarizerArgs, PRIVATE_MEMORY_ENV, DISCORD_CREDENTIAL_ENV, privateMemoryDeny, boardArgs, boardSettings, SYSTEM_READ };
