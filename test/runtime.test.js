// The runtime choice: one bot, one agent CLI, Claude or Codex.
//
// Claude must be untouched by the choice — every run of a bot that sets no
// BOT_RUNTIME is the command line it always was. Codex must express each
// Claude control or refuse: a setting it cannot honor stops the bot at
// startup, and a board run it cannot isolate stays off. These run the pieces
// without a live CLI; the Codex profiles themselves were measured against
// Codex 0.162.1 with synthetic fixtures (lib/runtime/codex.js).

const assert = require("assert");
const { readFileSync, writeFileSync, mkdtempSync, chmodSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { resolveRuntime, CLAUDE_ONLY_SETTINGS } = require("../lib/runtime");
const cx = require("../lib/runtime/codex");
const { boardPolicyProblems, resolveBoardPolicy } = require("../lib/permission-mode");
const { MAX_ARG_BYTES } = require("../lib/argv-budget");
const summarizeCore = require("../lib/summarize-core");

let failures = 0, passes = 0;
let chain = Promise.resolve();
const section = (title) => { chain = chain.then(() => console.log(`\n${title}`)); };
function check(name, fn) {
  chain = chain.then(fn).then(() => {
    passes++;
    console.log(`  ok   ${name}`);
  }, (err) => {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  });
}

const ROOT = join(__dirname, "..");
const PACK = join(ROOT, "skill-pack");
const configs = (args) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
const has = (args, key) => configs(args).some((c) => c.startsWith(`${key}=`));
const value = (args, key) => configs(args).find((c) => c.startsWith(`${key}=`))?.slice(key.length + 1);

section("Runtime — which CLI a bot runs on");

check("nothing set is Claude, from the built-in default, with the bot's CLAUDE_BIN", () => {
  const rt = resolveRuntime({});
  assert.deepStrictEqual([rt.name, rt.source, rt.bin, rt.model, rt.problems], ["claude", "built-in default", "claude", null, []]);
  assert.strictEqual(resolveRuntime({ CLAUDE_BIN: "/opt/claude" }).bin, "/opt/claude");
});

check("on Claude, CLAUDE_MODEL still names the model, and BOT_MODEL wins over it", () => {
  assert.strictEqual(resolveRuntime({ CLAUDE_MODEL: "m-1" }).model, "m-1");
  assert.strictEqual(resolveRuntime({ CLAUDE_MODEL: "m-1", BOT_MODEL: "m-2" }).model, "m-2");
  assert.strictEqual(resolveRuntime({ CLAUDE_MODEL: "m-1", SUMMARIZE_MODEL: "s-1" }).summaryModel, "s-1");
  assert.strictEqual(resolveRuntime({ CLAUDE_MODEL: "m-1" }).summaryModel, "m-1");
});

check("BOT_RUNTIME=codex runs CODEX_BIN (or codex) with BOT_MODEL", () => {
  const rt = resolveRuntime({ BOT_RUNTIME: "codex", BOT_MODEL: "gpt-x", CODEX_BIN: "/opt/codex" });
  assert.deepStrictEqual([rt.name, rt.source, rt.bin, rt.model, rt.problems], ["codex", "BOT_RUNTIME", "/opt/codex", "gpt-x", []]);
  assert.strictEqual(resolveRuntime({ BOT_RUNTIME: "codex" }).bin, "codex");
});

check("an unknown runtime is a problem, never a silent Claude", () => {
  assert.match(resolveRuntime({ BOT_RUNTIME: "gemini" }).problems.join(), /BOT_RUNTIME="gemini" is not one of claude, codex/);
});

check("every Claude-only setting refuses a Codex bot, and none refuses a Claude bot", () => {
  for (const key of CLAUDE_ONLY_SETTINGS) {
    assert.match(resolveRuntime({ BOT_RUNTIME: "codex", [key]: "x" }).problems.join(), new RegExp(`${key} is Claude Code syntax`));
    assert.deepStrictEqual(resolveRuntime({ [key]: "x" }).problems, []);
  }
});

section("Codex — the command line for each kind of run");

const releaseDir = "/opt/codex-release";
const STATE = "/srv/state", HARNESS = "/srv/harness";
const boardFs = (execution, extra = {}) => cx.boardFilesystem({
  cwd: "/srv/repo", denied: ["/srv/repo/.bot-history", STATE, HARNESS, ...(extra.denied ?? [])],
  policy: { execution, readPaths: [], writePaths: [], network: [], ...extra }, releaseDir, expand: (p) => p, tmpDir: extra.tmpDir ?? null,
});

check("a board run is narrow: no user config or rules, nothing prompts, no network, no web, features closed", () => {
  const args = cx.codexArgs({ kind: "board", releaseDir, filesystem: boardFs("readonly"), instructions: "i", prompt: "p" });
  for (const flag of ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.strictEqual(value(args, "approval_policy"), '"never"');
  assert.strictEqual(value(args, "default_permissions"), '"harness"');
  assert.strictEqual(value(args, "permissions.harness.network"), '{"enabled"=false}');
  assert.strictEqual(value(args, "web_search"), '"disabled"');
  for (const f of [...cx.CLOSED_FEATURES, "unified_exec"]) assert.strictEqual(value(args, `features.${f}`), "false", f);
  assert.deepStrictEqual(args.slice(-2), ["--", "p"]);
});

check("a board run may not start a sub-agent, and keeps the pack's hooks", () => {
  const args = cx.codexArgs({ kind: "board", releaseDir, filesystem: boardFs("readonly"), packs: [PACK], prompt: "p" });
  assert.ok(args.includes("--dangerously-bypass-hook-trust"));
  const pre = value(args, "hooks.PreToolUse");
  assert.ok(pre.indexOf('"^collaboration"') > -1 && pre.indexOf('"^collaboration"') < pre.indexOf('"Bash"'), "the collaboration deny must come first");
  assert.ok(pre.includes(join(PACK, "hooks", "bot_background_gate.py")) && !pre.includes("${CLAUDE_PLUGIN_ROOT}"));
  assert.ok(!value(cx.codexArgs({ kind: "session", mode: "bypass", packs: [PACK], prompt: "p" }), "hooks.PreToolUse").includes("collaboration"));
});

check("the board profile: readonly reads the repo, engineering writes it; private folders denied both ways", () => {
  const ro = boardFs("readonly");
  assert.strictEqual(ro[":minimal"], "read");
  assert.strictEqual(ro[releaseDir], "read");
  assert.deepStrictEqual(ro[":workspace_roots"], { ".": "read", ".bot-history": "deny" });
  for (const d of ["/srv/repo/.bot-history", STATE, HARNESS]) assert.strictEqual(ro[d], "deny", d);
  const eng = boardFs("engineering", { readPaths: ["/srv/lib"], writePaths: ["/srv/out"], tmpDir: "/tmp/b-1" });
  assert.strictEqual(eng[":workspace_roots"]["."], "write");
  assert.deepStrictEqual([eng["/srv/lib"], eng["/srv/out"], eng["/tmp/b-1"]], ["read", "write", "write"]);
  assert.strictEqual(boardFs("readonly", { readPaths: ["/srv/lib"] })["/srv/lib"], undefined, "readonly takes no extra folders");
});

check("a denied folder inside another denied folder is hidden with it, not named twice — bubblewrap cannot mount inside a hidden folder", () => {
  // Live 2026-10-12: the state folder and the attachments folder in it kept every Codex board run from starting.
  const ro = boardFs("readonly", { denied: [join(STATE, "attachments"), "/srv/repo/uploads"] });
  assert.strictEqual(ro[join(STATE, "attachments")], undefined);
  assert.strictEqual(ro[STATE], "deny");
  assert.strictEqual(ro["/srv/repo/uploads"], "deny", "a folder the run is given still names its own denials");
  const eng = boardFs("engineering", { writePaths: [join(STATE, "out")], denied: [join(STATE, "out", "x")] });
  assert.strictEqual(eng[join(STATE, "out", "x")], "deny", "a given folder between the two keeps the inner denial");
});

check("a restricted session reads its repo and its uploads, and writes nothing", () => {
  const args = cx.codexArgs({ kind: "session", mode: "restricted", releaseDir, readDirs: ["/srv/uploads"], prompt: "p" });
  assert.strictEqual(value(args, "permissions.harness.filesystem"),
    `{":minimal"="read","${releaseDir}"="read","/srv/uploads"="read",":workspace_roots"={"."="read"}}`);
  assert.strictEqual(value(args, "project_doc_fallback_filenames"), '["CLAUDE.md"]');
});

check("a bypass session is the operator's Codex, unsandboxed, with the bot's MCP servers", () => {
  const args = cx.codexArgs({ kind: "session", mode: "bypass", mcp: { db: { command: "node", args: ["s.js"], env_vars: ["DB_URL"] } }, prompt: "p" });
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!args.includes("--ignore-user-config"), "the operator's own config loads, as the host's does on Claude");
  assert.ok(!has(args, "default_permissions"));
  assert.strictEqual(value(args, "mcp_servers.db"), '{"command"="node","args"=["s.js"],"env_vars"=["DB_URL"]}');
  assert.strictEqual(value(args, "features.unified_exec"), "false", "a background terminal would die with the reply");
  assert.ok(cx.codexArgs({ kind: "session", mode: "bypass", strictMcp: true, prompt: "p" }).includes("--ignore-user-config"));
});

check("resume continues the thread: `exec resume`, the id, then the prompt", () => {
  const args = cx.codexArgs({ kind: "session", mode: "bypass", resumeId: "t-1", prompt: "next" });
  assert.deepStrictEqual(args.slice(0, 2), ["exec", "resume"]);
  assert.deepStrictEqual(args.slice(-3), ["--", "t-1", "next"]);
});

check("a summary run reads nothing, keeps nothing, loads no project instructions or hooks", () => {
  const args = cx.codexArgs({ kind: "summarizer", releaseDir, packs: [PACK], instructions: "sum", prompt: "p" });
  assert.ok(args.includes("--ephemeral"));
  assert.strictEqual(value(args, "project_doc_max_bytes"), "0");
  assert.strictEqual(value(args, "permissions.harness.filesystem"), `{":minimal"="read","${releaseDir}"="read"}`);
  assert.ok(!has(args, "hooks.PreToolUse") && !has(args, "project_doc_fallback_filenames"));
});

check("instructions that would pass the kernel's limit are cut at the tail, still one valid string", () => {
  const args = cx.codexArgs({ kind: "board", releaseDir, filesystem: boardFs("readonly"), instructions: "\"x\"\n".repeat(60000), prompt: "p" });
  const arg = configs(args).find((c) => c.startsWith("developer_instructions="));
  assert.ok(Buffer.byteLength(arg) <= MAX_ARG_BYTES, `${Buffer.byteLength(arg)} bytes`);
  assert.doesNotThrow(() => JSON.parse(arg.slice("developer_instructions=".length)));
});

check("TOML strings: quotes, newlines, DEL and lone surrogates come out valid", () => {
  assert.strictEqual(cx.tomlString('a"b\nc'), '"a\\"b\\nc"');
  assert.strictEqual(cx.tomlString("\u007f"), '"\\u007F"');
  assert.strictEqual(cx.tomlString("x\uD800y"), '"x�y"');
  assert.strictEqual(cx.tomlString("😀"), '"😀"');
});

section("Codex — what a board run refuses");

check("a Codex board run needs the CLI, a tested version and its release folder; it has no host allow list", () => {
  const p = (policy, info) => cx.codexBoardProblems({ network: [], ...policy }, info).join("\n");
  assert.strictEqual(p({}, { version: "0.162.1", releaseDir }), "");
  assert.match(p({}, { version: null, releaseDir }), /did not run/);
  assert.match(p({}, { version: "0.170.0", releaseDir }), /tested on Codex 0\.162\.x, this host has 0\.170\.0/);
  assert.match(p({}, { version: "0.162.1", releaseDir: null }), /cannot find the folder the Codex binary runs from/);
  assert.match(p({ network: ["api.example.com"] }, { version: "0.162.1", releaseDir }), /BOT_BOARD_NETWORK_ALLOW: a host allow list is not available on Codex/);
});

check("Discord memory inside the repo stops engineering only — readonly runs on either runtime are denied the history instead", () => {
  const denied = ["/srv/repo/.bot-history"];
  assert.deepStrictEqual(boardPolicyProblems(resolveBoardPolicy({}), denied, "/srv/repo"), []);
  const eng = boardPolicyProblems(resolveBoardPolicy({ BOT_BOARD_EXECUTION: "engineering" }), denied, "/srv/repo");
  assert.strictEqual(eng.length, 1);
  assert.match(eng[0], /^BOT_BOARD_EXECUTION=engineering: .*keep board runs readonly/);
});

check("a Codex board profile denies the repo's git folder and each worktree's copy of the memory", () => {
  const { execFileSync } = require("child_process");
  const { mkdirSync } = require("fs");
  const { boardHistoryDenied, expand } = require("../lib/permission-mode");
  const repo = mkdtempSync(join(tmpdir(), "hist-")), hist = join(repo, "bot-history");
  mkdirSync(hist);
  writeFileSync(join(hist, "s.md"), "x\n");
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.email=t@x", "-c", "user.name=t", ...a], { stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "f");
  git("worktree", "add", "-q", join(repo, ".claude", "worktrees", "w"));
  const denied = [hist, ...boardHistoryDenied([hist])];
  const fs = cx.boardFilesystem({ cwd: repo, denied, policy: resolveBoardPolicy({}), releaseDir: "/opt/codex", expand });
  assert.strictEqual(fs[":workspace_roots"][".git"], "deny");
  assert.strictEqual(fs[":workspace_roots"][join(".claude", "worktrees", "w", "bot-history")], "deny");
  assert.strictEqual(fs[":workspace_roots"]["bot-history"], "deny");
  assert.strictEqual(fs[":workspace_roots"]["."], "read");
});

section("Codex — skills, MCP and events");

check("the pack's skills are named in the instructions with the file to read", () => {
  const text = cx.skillsPrompt([PACK]);
  for (const s of ["bot-state", "land", "remember", "schedule"]) assert.ok(text.includes(join(PACK, "skills", s, "SKILL.md")), s);
  assert.match(text, /\$CLAUDE_PLUGIN_ROOT means /);
  assert.strictEqual(cx.skillsPrompt(["/nonexistent"]), "");
});

check("MCP: local servers carry over with their keys in the child env only; others are skipped and named", () => {
  const got = cx.mcpServers({ mcpServers: {
    db: { command: "node", args: ["${ROOT_DIR}/db.js"], env: { DB_URL: "${SECRET_URL}" } },
    web: { type: "http", url: "https://x" },
    "bad name": { command: "x" },
  } }, { ROOT_DIR: "/srv", SECRET_URL: "postgres://k" });
  assert.deepStrictEqual(got.servers, { db: { command: "node", args: ["/srv/db.js"], env_vars: ["DB_URL"] } });
  assert.deepStrictEqual(got.env, { DB_URL: "postgres://k" });
  assert.deepStrictEqual(got.skipped.map((s) => s.name), ["web", "bad name"]);
  const args = cx.codexArgs({ kind: "session", mode: "bypass", mcp: got.servers, prompt: "p" });
  assert.ok(!args.join(" ").includes("postgres://k"), "a key must never reach the command line");
});

check("Codex events become the stream events the harness reads", () => {
  const t = cx.createCodexTranslator();
  const out = [
    { type: "thread.started", thread_id: "t-9" },
    { type: "item.completed", item: { type: "agent_message", text: "Checking." } },
    { type: "item.completed", item: { type: "command_execution", command: "ls" } },
    { type: "item.completed", item: { type: "file_change", changes: [{ kind: "add", path: "/o/r.csv" }, { kind: "update", path: "/o/a.md" }] } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "db", tool: "query", arguments: { q: 1 } } },
    { type: "item.completed", item: { type: "agent_message", text: "Done." } },
    { type: "item.completed", item: { type: "agent_message", text: "More." } },
    { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } },
  ].flatMap(t);
  assert.deepStrictEqual(out[0], { type: "system", subtype: "init", session_id: "t-9" });
  const blocks = out.filter((e) => e.type === "assistant").map((e) => e.message.content[0]);
  assert.deepStrictEqual(blocks.map((b) => b.name || b.text), ["Checking.", "Bash", "Write", "Edit", "mcp__db__query", "Done.", "\n\nMore."],
    "a message after a tool starts clean; consecutive messages are separated");
  assert.deepStrictEqual(out.at(-1), { type: "result", subtype: "success", is_error: false, total_input_tokens: 5, total_output_tokens: 2 });
  assert.strictEqual(cx.createCodexTranslator()({ type: "turn.failed", error: { message: "x" } })[0].is_error, true);
});

section("The harness — one runtime per bot");

const bot = readFileSync(join(ROOT, "bot.js"), "utf8");

check("Claude's command line is the one it always was", () => {
  assert.ok(bot.includes(`    const args = CODEX ? [] : [
      "--output-format", "stream-json",
      // A run whose reply lands outside Discord gets least privilege, unless
      // its board policy is parity.
      ...permissionArgs(runKind),
      ...skillPackArgs(),
      "--verbose",
      "--max-turns", String(CLAUDE_MAX_TURNS),
      ...(RUNTIME.model ? ["--model", RUNTIME.model] : []),
      ...mcpArgs(),
      ...settingsArgs({ board: narrowBoard, tmpDir: boardTmp }),
      "--append-system-prompt", systemPrompt,
    ];`), "the Claude argv changed");
  assert.match(bot, /\} else if \(resumeSessionId\) \{\n      args\.push\("--resume", resumeSessionId, "-p", "--", finalPrompt\);/);
});

check("a bot that cannot honor its settings refuses to start", () => {
  assert.match(bot, /if \(RUNTIME\.problems\.length\) \{\n  for \(const problem of RUNTIME\.problems\) log\.fatal\(problem\);\n  process\.exit\(EXIT_CONFIG\);/);
});

check("a session is resumed only by the runtime that made it", () => {
  assert.match(bot, /\(existingSession\.runtime \|\| "claude"\) === RUNTIME\.name/);
  assert.match(bot, /\.\.\.\(CODEX \? \{ runtime: RUNTIME\.name \} : \{\}\)/);
});

check("summaries and board checks go to the bot's runtime", () => {
  assert.strictEqual((bot.match(/runtime: RUNTIME,/g) || []).length, 2, "both summarizer call sites");
  assert.match(bot, /boardPolicyProblems\(BOARD_POLICY, boardDeniedPaths\(\), CLAUDE_CWD\)/);
  assert.match(bot, /CODEX && !BOARD_POLICY\.parity \? codexRuntime\.codexBoardProblems\(BOARD_POLICY, RUNTIME\) : \[\]/);
  assert.match(readFileSync(join(ROOT, "summarize.js"), "utf8"), /runtime: RUNTIME,/);
});

check("a summary on Codex runs the Codex CLI and reads its events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-test-"));
  const fake = join(dir, "codex.cjs");   // .cjs: a package.json above tmp may declare ESM
  writeFileSync(fake, `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
for (const e of [{ type: "thread.started", thread_id: "t" }, { type: "item.completed", item: { type: "agent_message", text: "SUMMARY-OK" } }, { type: "turn.completed", usage: {} }]) console.log(JSON.stringify(e));
`);
  chmodSync(fake, 0o755);
  const text = await summarizeCore.summarize({ transcript: "a: hi", kind: "buffer-rotation", cwd: dir, timeoutMs: 20000,
    claudeBin: "/nonexistent/claude", permissionArgs: ["--never-used"], runtime: { name: "codex", bin: fake, releaseDir } });
  assert.strictEqual(text, "SUMMARY-OK");
  const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
  assert.ok(argv.includes("--ephemeral") && !argv.includes("--never-used"));
});

section("Doctor — the selected runtime's CLI, and only it");

check("doctor checks Codex's version and sign-in, and names a Claude-only setting", async () => {
  const { checkRuntimeCli } = await import("../scripts/lib/checks.mjs");
  const exec = (signedIn) => async (bin, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli 0.162.1\n" };
    if (!signedIn) throw new Error("not logged in");
    return { stdout: "Logged in" };
  };
  const good = await checkRuntimeCli({ BOT_RUNTIME: "codex", BOT_MODEL: "gpt-x" }, { exec: exec(true) });
  assert.deepStrictEqual([good.name, good.status], ["Agent CLI (codex)", "pass"]);
  assert.match(good.detail, /0\.162\.1, signed in; model gpt-x/);
  const out = await checkRuntimeCli({ BOT_RUNTIME: "codex" }, { exec: exec(false) });
  assert.strictEqual(out.status, "fail");
  assert.match(out.fix, /codex login/);
  const syntax = await checkRuntimeCli({ BOT_RUNTIME: "codex", BOT_ALLOWED_TOOLS: "Read" }, { exec: exec(true) });
  assert.strictEqual(syntax.status, "fail");
  assert.match(syntax.detail, /BOT_ALLOWED_TOOLS is Claude Code syntax/);
});

chain.then(() => {
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
});
