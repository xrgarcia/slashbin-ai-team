/**
 * Where a bot's own repository keeps the files the harness reads, by runtime.
 *
 * Each runtime has a native layout, and a repo converted to one keeps only that
 * one. A Codex repo holds its constitution in AGENTS.md (the CLI loads it from
 * the working directory itself), its workflows in .agents/skills/ and its
 * configuration in .codex/; it has no .claude tree and no CLAUDE.md. Reading the
 * Claude paths there finds nothing, and nothing errors: the overrides and the
 * channel's instructions simply stop reaching the prompt.
 *
 * The selected runtime picks the layout, and only that layout is read. There is
 * no fallback to the other runtime's paths: a Codex bot never picks up a stale
 * .claude/system-prompt-overrides.md, and a Claude bot never reads .codex/.
 * Claude's paths are the ones it has always read, unchanged.
 */
const { join } = require("path");

const LAYOUTS = {
  claude: {
    // Either location loads; the first is the one the fleet uses.
    instructions: ["CLAUDE.md", join(".claude", "CLAUDE.md")],
    overrides: join(".claude", "system-prompt-overrides.md"),
    channelPrompts: join(".claude", "channel-prompts"),
    // [directory, suffix] — a command is a file named with the suffix, a skill a directory.
    commands: [[join(".claude", "commands"), ".md"], [join(".claude", "skills"), ""]],
  },
  codex: {
    // AGENTS.md is native; codexArgs names CLAUDE.md as Codex's own fallback
    // project doc, which it reads only when AGENTS.md is absent.
    instructions: ["AGENTS.md", "CLAUDE.md"],
    overrides: join(".codex", "system-prompt-overrides.md"),
    channelPrompts: join(".codex", "channel-prompts"),
    commands: [[join(".agents", "skills"), ""]],
  },
};

/**
 * @param {string} runtime "claude" | "codex"
 * @param {string} cwd the bot's repository
 * @returns {{ instructions: string[], overrides: string, channelPrompts: string, commands: [string, string][] }} absolute paths
 */
function repoLayout(runtime, cwd) {
  const l = LAYOUTS[runtime];
  if (!l) throw new Error(`no repository layout for runtime "${runtime}"`);
  return {
    instructions: l.instructions.map((f) => join(cwd, f)),
    overrides: join(cwd, l.overrides),
    channelPrompts: join(cwd, l.channelPrompts),
    commands: l.commands.map(([dir, suffix]) => [join(cwd, dir), suffix]),
  };
}

module.exports = { LAYOUTS, repoLayout };
