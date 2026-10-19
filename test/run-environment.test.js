// The run environment, tested from its specification: one check per row of the
// matrix in docs/run-environment.md, nothing written by hand here. A row's
// outcome is what the run's commands can actually reach — the env handed to the
// child, and on Codex the shell policy built by the real codexArgs from the
// builder's own exclusions — not what the builder says about itself.
//
// Add a case by adding a row to the doc; a row this file cannot run is a failure.

const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");
const { buildRunEnv } = require("../lib/permission-mode");
const { boardKeyEnvs } = require("../lib/paperclip");
const codex = require("../lib/runtime/codex");

let failures = 0, passes = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const DOC = readFileSync(join(__dirname, "..", "docs", "run-environment.md"), "utf8");
const COLUMNS = ["id", "runtime", "mode", "run", "spec", "env", "mcp", "seat", "variable", "expected", "case"];
const OUTCOMES = ["kept", "hidden", "withheld", "refused"];
// What a narrow Codex run's commands inherit (shell_environment_policy inherit=core).
const CODEX_CORE = ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "USERNAME", "TMPDIR", "TEMP", "TMP"];
// Every row runs with the harness's paths published, as bot.js publishes them.
const PUBLISHED = {
  BOT_STATE_DIR: "/srv/bot/state", BOT_SUMMARIES_DIR: "/srv/bot/history", BOT_ATTACHMENTS_DIR: "/srv/bot/attachments",
  BOT_OUTBOX_DIR: "/srv/bot/outbox/1", BOT_BUFFER_FILE: "/srv/bot/state/buffer.txt", BOT_SESSIONS_FILE: "/srv/bot/state/sessions.json",
  BOT_JOB_HISTORY_FILE: "/srv/bot/state/job-history.jsonl", BOT_SCHEDULES_FILE: "/srv/bot/state/schedules.json", BOT_CHANNEL_ID: "1",
  CLAUDE_PLUGIN_ROOT: "/srv/bot/skills", // published on Codex (bot.js)
};

// A `{X}` placeholder is a distinct secret, long enough to be matched by value.
const secret = (name) => `s3cret-${name}-${name.charCodeAt(0).toString(16)}-value`;
const fill = (text) => text.replace(/\{([A-Z])\}/g, (_, n) => secret(n));
const cell = (text) => text.trim().replace(/^`|`$/g, "");
const unset = (text) => text === "—" || text === "";
function pairs(text) {
  if (unset(text)) return {};
  return Object.fromEntries(text.split("; ").map((p) => {
    const at = p.indexOf("=");
    return [p.slice(0, at), fill(p.slice(at + 1))];
  }));
}
// Split on the table's pipes, but not on a pipe inside a backtick span.
function cells(line) {
  const out = [];
  let cur = "", code = false;
  for (const ch of line.trim().slice(1, -1)) {
    if (ch === "`") code = !code;
    if (ch === "|" && !code) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map(cell);
}

const rows = DOC.split("\n").filter((l) => /^\| [A-G]\d+ \|/.test(l)).map((line) => {
  const c = cells(line);
  assert.strictEqual(c.length, COLUMNS.length, `${c[0]}: ${c.length} columns`);
  return Object.fromEntries(COLUMNS.map((k, i) => [k, c[i]]));
});

// The shell policy a real Codex run is built with, read back off its command line.
function shellPolicy(args) {
  const get = (key) => {
    const arg = args.find((a) => a.startsWith(`${key}=`));
    return arg === undefined ? undefined : arg.slice(key.length + 1);
  };
  const exclude = get("shell_environment_policy.exclude");
  return { core: get("shell_environment_policy") === '{"inherit"="core"}', exclude: exclude ? JSON.parse(exclude) : [] };
}

function outcome(row) {
  const env = pairs(row.env);
  if (!unset(row.spec)) env.BOT_RUN_ENV = row.spec;
  // An `@server` entry in the MCP column is that server's args as written; the
  // real reader expands its ${VAR}s against the process env, as the bot does
  // at startup, and reports which it expanded (rule 11).
  const mcp = pairs(row.mcp);
  const config = { mcpServers: {
    env: { command: "node", env: Object.fromEntries(Object.entries(mcp).filter(([k]) => !k.startsWith("@"))) },
    ...Object.fromEntries(Object.entries(mcp).filter(([k]) => k.startsWith("@")).map(([k, v]) => [k.slice(1), { command: "node", args: v.split(" ") }])),
  } };
  const read = codex.mcpServers(config, env);
  const secrets = [...new Set(Object.values({ ...env, ...mcp }).flatMap((v) => v.match(/s3cret-[^ ]*-value/g) || []))];
  const seat = unset(row.seat) ? null : { value: env[row.seat], runId: "run-1" };
  // BOT_SETTINGS as runEnvFor reads it for a board task's run (rule 14).
  const settings = row.run !== "session" && env.BOT_SETTINGS?.startsWith("{") ? JSON.parse(env.BOT_SETTINGS) : null;
  const built = buildRunEnv({
    env, spec: env.BOT_RUN_ENV, runtime: row.runtime, mode: row.mode, run: row.run,
    connectorKeys: boardKeyEnvs(env), published: PUBLISHED, mcpEnv: unset(row.mcp) ? null : read.env, mcpRefs: read.refs, seat,
    tmpDir: row.run === "board" ? "/tmp/bot-board-1" : null, settings,
  });
  if (built.problems.length) {
    assert.strictEqual(built.env, null, "a refused environment is never handed to a run");
    assert.ok(built.problems.some((p) => p.includes(row.variable)), `the refusal names ${row.variable}: ${built.problems.join(" | ")}`);
    for (const p of built.problems) for (const v of secrets) assert.ok(!p.includes(v), "a refusal never quotes a value");
    return "refused";
  }
  if (!(row.variable in built.env)) return "withheld";
  if (row.runtime === "claude") return "kept"; // Claude cannot keep a variable from a command
  const args = codex.codexArgs({
    kind: row.run === "board" ? "board" : "session", mode: row.mode, shellExclude: built.shellExclude,
    filesystem: { ":minimal": "read" }, prompt: "p",
  });
  const policy = shellPolicy(args);
  if (policy.core) return CODEX_CORE.includes(row.variable) ? "kept" : "hidden";
  return policy.exclude.includes(row.variable) ? "hidden" : "kept";
}

console.log(`run environment: ${rows.length} rows from docs/run-environment.md`);
check("the matrix is there and every row names a known outcome", () => {
  assert.ok(rows.length >= 80, `${rows.length} rows`);
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length, "row ids are unique");
  for (const r of rows) assert.ok(OUTCOMES.includes(r.expected), `${r.id}: ${r.expected}`);
});
for (const row of rows) {
  check(`${row.id} ${row.runtime}/${row.mode}/${row.run}: ${row.variable} ${row.expected} — ${row.case}`, () => {
    assert.strictEqual(outcome(row), row.expected);
  });
}

// The builder is the one place a run's environment is decided: bot.js calls it
// once per run, at the point the env is final, for both runtimes, and Codex's
// exclusions come from the same call.
const BOT = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
const spawnBody = BOT.slice(BOT.indexOf("function spawnClaude("), BOT.indexOf("\nfunction ", BOT.indexOf("function spawnClaude(") + 10));
check("spawnClaude builds the env once, from runEnvFor, and spawns exactly that", () => {
  assert.strictEqual((spawnBody.match(/runEnvFor\(/g) || []).length, 1);
  assert.ok(/const cleanEnv = built\.env;/.test(spawnBody));
  assert.ok(/env: cleanEnv,/.test(spawnBody));
  assert.ok(!/cleanEnv(\.\w+|\[[^\]]+\]) =/.test(spawnBody), "nothing writes the env after the builder");
  assert.ok(!/delete cleanEnv/.test(spawnBody), "nothing scrubs the env after the builder");
});
check("the Codex shell exclusions are the builder's, from the same call", () => {
  assert.ok(/shellExclude: built\.shellExclude,/.test(spawnBody));
  assert.ok(spawnBody.indexOf("runEnvFor(") < spawnBody.indexOf("codexRuntime.codexArgs("), "built before the Codex args");
});
check("runEnvFor is the only caller of buildRunEnv, and startup checks every run kind it will make", () => {
  assert.strictEqual((BOT.match(/buildRunEnv\(/g) || []).length, 1);
  assert.ok(/for \(const run of \[\.\.\.\(DISCORD_ON \? \["session"\] : \[\]\), \.\.\.\(PAPERCLIP_BOARDS\.length/.test(BOT));
  assert.ok(/Run environment refused \(\$\{run\} run\)/.test(BOT));
});
check("the builder sees what every Codex server's command line expands, from the servers Codex is handed (rule 11)", () => {
  assert.ok(/mcpRefs: CODEX_MCP\?\.refs \?\? null,/.test(BOT));
  assert.ok(/Object\.assign\(refs, got\.refs\);/.test(BOT), "every config's references, as its servers are");
  assert.ok(/mcp: CODEX_MCP\?\.servers,/.test(BOT), "the servers checked are the servers passed");
});
check("a board task's run sees the bot's settings (rule 14)", () => {
  assert.ok(/settings: run === "session" \? null : readableSettings\(\),/.test(BOT));
});
check("a run whose shell policy clamping would cut is refused before spawn (rule 15)", () => {
  const clampAt = spawnBody.indexOf("clampArgs(args)");
  const refuse = spawnBody.indexOf("codexRuntime.policyClamped(args, clamped)");
  assert.ok(clampAt > 0 && refuse > clampAt, "checked after clamping");
  assert.ok(refuse < spawnBody.indexOf("attempts.run(") && refuse < spawnBody.indexOf("spawn(RUNTIME.bin"), "checked before any spawn");
  assert.match(spawnBody.slice(refuse, refuse + 400), /throw new Error\("Run environment refused/);
  // The policy, long enough to be cut, is what policyClamped finds.
  const { clampArgs } = require("../lib/argv-budget");
  const many = Array.from({ length: 9000 }, (_, i) => `SOME_LONG_VARIABLE_NAME_${i}`);
  const args = codex.codexArgs({ kind: "session", mode: "bypass", shellExclude: many, prompt: "p" });
  const { clamped } = clampArgs(args);
  assert.ok(codex.policyClamped(args, clamped));
  const short = codex.codexArgs({ kind: "session", mode: "bypass", shellExclude: ["A_TOKEN"], prompt: "x".repeat(200000) });
  const cut = clampArgs(short).clamped;
  assert.ok(cut.length > 0 && !codex.policyClamped(short, cut), "a cut prompt is not a cut policy");
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
