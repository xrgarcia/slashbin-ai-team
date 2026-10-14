/**
 * Per-channel system-prompt layering.
 *
 * One bot serves several audiences off one brain. The repo-level overrides name
 * exactly one of them — read in the wrong channel they address the wrong person
 * in the wrong register, which is the failure this feature exists to prevent.
 *
 * Two properties have to hold and neither is visible by reading the prompt once:
 *   1. The channel block rides at the HEAD. The whole prompt is ONE argv string
 *      against a kernel ceiling, and clampArgs() cuts from the END — a block
 *      appended last is exactly what a busy day deletes, silently.
 *   2. The channel block comes AFTER the repo overrides, so the narrower file is
 *      the later word on anything both of them touch.
 *
 * Asserted against the real bot.js source — the file cannot be require()d,
 * importing it logs a live bot into Discord.
 */
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const assert = require("assert");

const SRC = readFileSync(join(__dirname, "..", "bot.js"), "utf8");

function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in bot.js`);
  let i = SRC.indexOf("(", start), paren = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "(") paren++;
    else if (SRC[i] === ")" && --paren === 0) break;
  }
  let depth = 0;
  i = SRC.indexOf("{", i);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

// The function reads CLAUDE_CWD and logs; supply both from the harness so the
// real body runs against a real directory rather than a reimplementation.
const { repoLayout } = require("../lib/runtime/layout");
function loadFn(name, cwd, runtime = "claude") {
  const logged = [];
  const fn = new Function(
    "join", "existsSync", "readFileSync", "CLAUDE_CWD", "LAYOUT", "log",
    `${extractFn(name)}; return ${name};`
  )(
    join,
    require("fs").existsSync,
    readFileSync,
    cwd,
    repoLayout(runtime, cwd),
    { info: (o, m) => logged.push([m, o]), warn: (o, m) => logged.push([m, o]) }
  );
  return { fn, logged };
}
const loadChannelPrompt = (cwd, runtime) => loadFn("channelPrompt", cwd, runtime);

let pass = 0, fail = 0;
function check(label, body) {
  try { body(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

const root = mkdtempSync(join(tmpdir(), "channel-prompt-"));
const dir = join(root, ".claude", "channel-prompts");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "123456789012345678.md"), "Address the customer, not the owner.\n");
writeFileSync(join(dir, "by-name.md"), "Named file.\n");
writeFileSync(join(dir, "empty.md"), "   \n");

const { fn: channelPrompt } = loadChannelPrompt(root);

check("a channel with no file contributes nothing", () => {
  assert.strictEqual(channelPrompt("999", "engineering"), "");
});

check("the ID file is found and its text carried through", () => {
  const out = channelPrompt("123456789012345678", "acme-support");
  assert.ok(out.includes("Address the customer, not the owner."), "channel text missing");
  assert.ok(out.includes("#acme-support"), "channel name not named in the header");
});

check("ID wins over name — a rename must not detach the instructions", () => {
  writeFileSync(join(dir, "renamed.md"), "WRONG — name file should not win.\n");
  const out = channelPrompt("123456789012345678", "renamed");
  assert.ok(out.includes("Address the customer, not the owner."), "ID file did not win");
  assert.ok(!out.includes("WRONG"), "name file shadowed the ID file");
});

check("the name file is the fallback when no ID file exists", () => {
  const out = channelPrompt("no-such-id", "by-name");
  assert.ok(out.includes("Named file."), "name fallback did not load");
});

check("an empty file is not a prompt", () => {
  assert.strictEqual(channelPrompt("no-such-id", "empty"), "");
});

check("the block declares that it outranks what precedes it", () => {
  const out = channelPrompt("123456789012345678", "acme-support");
  assert.ok(/these win/i.test(out), "precedence over the repo overrides is not stated");
});

// --- Assembly, asserted on the source ---
// These are the two properties a passing unit test above would still not prove.

check("the channel block is assembled into the prompt HEAD, where clamping cannot reach it", () => {
  assert.ok(
    SRC.slice(SRC.indexOf("const head ="), SRC.indexOf("let systemPrompt;"))
      .includes("channelPrompt(opts.promptChannel ?? channelId, channelName)"),
    "channelPrompt not called at assembly"
  );
  // From the declaration onward: the head's own definition is a template literal
  // too, and it is the one thing that cannot be required to contain itself.
  const assembly = SRC.slice(SRC.indexOf("let systemPrompt;"), SRC.search(/const args = (CODEX \? \[\] : )?\[/));
  // Every template literal systemPrompt can be assigned — both ternary arms
  // included — has to open with the head. One that does not is a path where the
  // channel's instructions are appended last and clamped away first.
  const literals = assembly.match(/`\$\{[^`]*\}`/g) || [];
  assert.ok(literals.length >= 3, `expected every assignment arm, found ${literals.length}`);
  for (const lit of literals) {
    assert.ok(lit.startsWith("`${head}"), `a prompt assembly does not start with the head: ${lit}`);
  }
});

check("repo overrides precede the channel block", () => {
  const head = SRC.slice(SRC.indexOf("const head ="), SRC.indexOf("let systemPrompt;"));
  assert.ok(
    head.indexOf("systemPromptOverrides()") < head.indexOf("channelPrompt("),
    "the channel block must come after the repo overrides, so the narrower file is the later word"
  );
});

check("both files are read per request, not cached at startup", () => {
  const assembly = SRC.slice(SRC.indexOf("function spawnClaude("), SRC.indexOf("const args = ["));
  assert.ok(assembly.includes("systemPromptOverrides()"), "overrides hoisted out of the request path");
  assert.ok(assembly.includes("channelPrompt("), "channel prompt hoisted out of the request path");
});

rmSync(root, { recursive: true, force: true });


// --- A Codex repository: AGENTS.md, .agents/skills, .codex — no .claude, no CLAUDE.md ---
// The selected runtime's layout and only that one: a stale Claude file in a
// Codex repo must not reach the prompt, and the reverse.

const cx = mkdtempSync(join(tmpdir(), "channel-prompt-codex-"));
mkdirSync(join(cx, ".codex", "channel-prompts"), { recursive: true });
writeFileSync(join(cx, "AGENTS.md"), "# Role\n");
writeFileSync(join(cx, ".codex", "system-prompt-overrides.md"), "Codex overrides.\n");
writeFileSync(join(cx, ".codex", "channel-prompts", "strategy.md"), "Codex channel.\n");

check("Codex: the channel prompt is read from .codex/channel-prompts", () => {
  const out = loadChannelPrompt(cx, "codex").fn("1", "strategy");
  assert.ok(out.includes("Codex channel."), "Codex channel prompt not loaded");
});

check("Codex: the repo overrides are read from .codex/system-prompt-overrides.md", () => {
  const out = loadFn("systemPromptOverrides", cx, "codex").fn();
  assert.ok(out.startsWith("Codex overrides."), "Codex overrides not loaded");
});

check("Codex: a .claude file is never read — no fallback to the unselected runtime", () => {
  mkdirSync(join(cx, ".claude", "channel-prompts"), { recursive: true });
  writeFileSync(join(cx, ".claude", "system-prompt-overrides.md"), "STALE CLAUDE.\n");
  writeFileSync(join(cx, ".claude", "channel-prompts", "other.md"), "STALE CLAUDE.\n");
  assert.ok(!loadFn("systemPromptOverrides", cx, "codex").fn().includes("STALE"), "Codex read .claude overrides");
  assert.strictEqual(loadChannelPrompt(cx, "codex").fn("1", "other"), "", "Codex read a .claude channel prompt");
  rmSync(join(cx, ".claude"), { recursive: true, force: true });
});

check("Claude: a .codex file is never read", () => {
  assert.strictEqual(loadFn("systemPromptOverrides", cx, "claude").fn(), "", "Claude read .codex overrides");
  assert.strictEqual(loadChannelPrompt(cx, "claude").fn("1", "strategy"), "", "Claude read a .codex channel prompt");
});

check("Codex: a reserved name in .agents/skills is reported as shadowed", () => {
  mkdirSync(join(cx, ".agents", "skills", "status"), { recursive: true });
  mkdirSync(join(cx, ".agents", "skills", "roadmap"), { recursive: true });
  const fn = new Function("readdirSync", "join", "LAYOUT", "RESERVED_COMMANDS", `${extractFn("shadowedCommands")}; return shadowedCommands;`)(
    require("fs").readdirSync, join, repoLayout("codex", cx), ["fresh", "status", "stop"]);
  assert.deepStrictEqual(fn(), [join(cx, ".agents", "skills", "status")]);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
