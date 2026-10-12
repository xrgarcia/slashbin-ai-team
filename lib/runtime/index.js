/**
 * Which agent CLI this bot runs on. One bot, one runtime: every run it makes —
 * Discord, reactions, wakes, scheduled jobs, summaries, Paperclip tasks — goes
 * to the same CLI, and doctor checks only that one. There is no fallback from
 * one runtime to the other and no moving a session between them: a bot set to
 * `codex` never starts `claude`, and the reverse.
 *
 * `claude` (the default) is the harness as it has always been, argument for
 * argument. `codex` is OpenAI's Codex CLI behind the same harness; see
 * lib/runtime/codex.js for how each Claude control is expressed there.
 */
const RUNTIMES = ["claude", "codex"];

/**
 * Settings written in Claude Code's own syntax — tool names, permission rules,
 * a settings file — that Codex has no way to honor. A Codex bot with one set
 * refuses to start: the operator asked for a control the runtime would drop.
 */
const CLAUDE_ONLY_SETTINGS = [
  "BOT_ALLOWED_TOOLS", "BOT_PERMISSION_ALLOW", "BOT_PERMISSION_DENY", "BOT_SETTINGS",
  "BOT_SUMMARIZER_TOOLS", "BOT_BOARD_TOOLS", "BOT_BOARD_ENGINEERING_TOOLS",
  "BOT_BOARD_PERMISSION_ALLOW", "CLAUDE_MODEL",
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name: string, source: string, bin: string, model: string|null, summaryModel: string|null, problems: string[] }}
 */
function resolveRuntime(env = process.env) {
  const raw = (env.BOT_RUNTIME || "").trim();
  const name = raw || "claude";
  const problems = [];
  if (!RUNTIMES.includes(name)) problems.push(`BOT_RUNTIME="${raw}" is not one of ${RUNTIMES.join(", ")}`);
  const codex = name === "codex";
  if (codex) {
    for (const key of CLAUDE_ONLY_SETTINGS) {
      if ((env[key] || "").trim()) problems.push(`${key} is Claude Code syntax and has no Codex equivalent — unset it, or set BOT_RUNTIME=claude`);
    }
  }
  // BOT_MODEL names the model for whichever runtime is selected. CLAUDE_MODEL
  // stays as its alias on Claude, so an existing bot changes nothing.
  const model = (env.BOT_MODEL || "").trim() || (codex ? "" : (env.CLAUDE_MODEL || "").trim()) || null;
  return {
    name,
    source: raw ? "BOT_RUNTIME" : "built-in default",
    bin: codex ? (env.CODEX_BIN || "codex") : (env.CLAUDE_BIN || "claude"),
    model,
    summaryModel: (env.SUMMARIZE_MODEL || "").trim() || model,
    problems,
  };
}

module.exports = { RUNTIMES, CLAUDE_ONLY_SETTINGS, resolveRuntime };
