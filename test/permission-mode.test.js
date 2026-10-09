// Behavioural tests for the permission-mode resolver.
//
// The rest of the permission coverage in startup-safety.test.js asserts on the
// SHAPE of the source, which is the right tool for "no call site bypasses the
// mode". It cannot tell you that the precedence actually works. This runs it.

const assert = require("assert");
const { resolvePermissionMode, VALID_MODES, attachmentReadRule, summarizerArgs, PRIVATE_MEMORY_ENV, privateMemoryDeny } = require("../lib/permission-mode");
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { spawnSync } = require("child_process");

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

console.log("\nPermission mode — precedence");

check("nothing set resolves to restricted", () => {
  const { mode } = resolvePermissionMode({});
  assert.strictEqual(mode, "restricted");
});

check("a host default applies to a bot that sets no mode", () => {
  const { mode, source } = resolvePermissionMode({ BOT_PERMISSION_MODE_DEFAULT: "bypass" });
  assert.strictEqual(mode, "bypass");
  assert.match(source, /BOT_PERMISSION_MODE_DEFAULT/);
});

check("a per-bot mode wins over the host default", () => {
  // The whole point of two variables. If this inverts, a host default silently
  // overrides a deliberate per-bot choice — the opposite of what it is for.
  const { mode, source } = resolvePermissionMode({
    BOT_PERMISSION_MODE: "restricted",
    BOT_PERMISSION_MODE_DEFAULT: "bypass",
  });
  assert.strictEqual(mode, "restricted");
  assert.strictEqual(source, "BOT_PERMISSION_MODE");
});

check("an empty per-bot value is not a choice — it falls through", () => {
  // PM2 and shell exports both produce empty strings for "unset"; treating "" as
  // an explicit answer would pin a bot to an invalid mode and fail at startup.
  const { mode } = resolvePermissionMode({
    BOT_PERMISSION_MODE: "",
    BOT_PERMISSION_MODE_DEFAULT: "bypass",
  });
  assert.strictEqual(mode, "bypass");
});

check("whitespace around a value does not create an invalid mode", () => {
  const { mode } = resolvePermissionMode({ BOT_PERMISSION_MODE: "  bypass  " });
  assert.strictEqual(mode, "bypass");
});

console.log("\nPermission mode — a restricted bot can read its own uploads");

check("the attachment rule is an absolute Read rule on the folder", () => {
  // `//` is how a permission rule spells an absolute path. A single `/` would be
  // read relative to the settings file and never match the saved upload.
  assert.strictEqual(attachmentReadRule("/data/bot/attachments"), "Read(//data/bot/attachments/**)");
  assert.strictEqual(attachmentReadRule("/data/bot/attachments/"), "Read(//data/bot/attachments/**)");
});

check("a relative folder is resolved before it becomes a rule", () => {
  assert.match(attachmentReadRule("rel/attachments"), /^Read\(\/\/.+\/rel\/attachments\/\*\*\)$/);
});

check("restricted sessions pass the rule, ahead of BOT_PERMISSION_ALLOW", () => {
  // Measured 2026-10-08: under dontAsk a Read outside CLAUDE_CWD answers DENIED
  // with no rule and succeeds with this one, alone or after another allow entry.
  const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  const fn = bot.slice(bot.indexOf("function permissionArgs("), bot.indexOf("function settingsArgs("));
  assert.match(fn, /"--allowedTools", attachmentReadRule\(ATTACHMENTS_DIR\)/);
  assert.match(fn, /PERMISSION_ALLOW \? \[PERMISSION_ALLOW\]/);
  const bypass = fn.slice(fn.indexOf('if (PERMISSION_MODE === "bypass")'), fn.indexOf('"--tools", ALLOWED_TOOLS'));
  assert.ok(bypass.length > 0 && !bypass.includes("attachmentReadRule"), "bypass argv must stay the historical one");
});

console.log("\nPermission mode — a summary run is narrow in every mode");

check("summary flags: read-only tools, nothing prompts, no MCP servers", () => {
  // Measured 2026-10-08 with the real CLI: these flags start a run whose only
  // tool is Read, with no MCP server and permissionMode dontAsk.
  assert.deepStrictEqual(summarizerArgs(), ["--tools", "Read", "--permission-mode", "dontAsk", "--strict-mcp-config"]);
  const a = summarizerArgs({ tools: "Read", deny: "Read(//etc/**)", settings: '{"sandbox":{"enabled":true}}' });
  assert.deepStrictEqual(a.slice(-4), ["--disallowedTools", "Read(//etc/**)", "--settings", '{"sandbox":{"enabled":true}}']);
  assert.ok(!a.some((x) => /dangerously/.test(x)));
});

check("bot.js answers a summary run before it looks at the mode", () => {
  // Second-pass review of 2.7.0: under bypass the buffer-rotation and hourly
  // summaries got every tool and the skip flags, and skipped BOT_SETTINGS.
  const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  const fn = bot.slice(bot.indexOf("function permissionArgs("), bot.indexOf("function settingsArgs("));
  const summary = fn.indexOf('if (kind === "summarizer")');
  assert.ok(summary > 0 && summary < fn.indexOf('if (PERMISSION_MODE === "bypass")'), "the bypass branch is reached first");
  assert.match(fn, /summarizerArgs\(\{ tools: SUMMARIZER_TOOLS, deny: PERMISSION_DENY, settings: SESSION_SETTINGS \}\)/);
  assert.strictEqual((bot.match(/summarizeCore\.summarize\(/g) || []).length,
    (bot.match(/permissionArgs: permissionArgs\("summarizer"\)/g) || []).length, "a summary call site skips the summary flags");
});

console.log("\nPermission mode — backward compatibility");

check("an install that sets only BOT_PERMISSION_MODE is unchanged", () => {
  for (const mode of VALID_MODES) {
    assert.strictEqual(resolvePermissionMode({ BOT_PERMISSION_MODE: mode }).mode, mode);
  }
});

check("the source is reported for every path", () => {
  // A fleet operator asking "why is this bot different" cannot answer it from the
  // value alone: an explicit `restricted` and an unset one look identical.
  const paths = [
    {},
    { BOT_PERMISSION_MODE_DEFAULT: "bypass" },
    { BOT_PERMISSION_MODE: "bypass" },
  ];
  for (const env of paths) {
    const { source } = resolvePermissionMode(env);
    assert.ok(source && source.length > 0, `no source reported for ${JSON.stringify(env)}`);
  }
});

check("an unrecognised mode is returned as-is for the caller to reject", () => {
  // The resolver does not validate — bot.js fails loudly on an unknown mode with
  // the source in the message. Silently correcting it here would hide the typo.
  const { mode } = resolvePermissionMode({ BOT_PERMISSION_MODE: "yolo" });
  assert.strictEqual(mode, "yolo");
  assert.ok(!VALID_MODES.includes(mode));
});

console.log("\nBoard runs — no reach into Discord memory");

// Second-pass review of 2.7.0: a board task that asked the bot to recall got the
// Discord buffer back through the remember skill, which finds its stores through
// the environment. Run the real recall script with the environment a board run
// gets, and with the one a Discord run gets, against the same planted secret.
check("recall finds nothing private with a board run's environment", () => {
  const root = mkdtempSync(join(tmpdir(), "mem-"));
  const summaries = join(root, "history"), attachments = join(root, "uploads");
  mkdirSync(summaries); mkdirSync(attachments);
  const secret = "zebra-ledger-7731";
  // The query is echoed back, so look for what each store holds, not for the query.
  const held = { buffer: "BUFFER-PAYLOAD", summary: "SUMMARY-PAYLOAD", upload: "upload-payload.txt" };
  writeFileSync(join(root, "buffer.txt"), `[#private] Ray: the ${secret} figure ${held.buffer}\n`);
  writeFileSync(join(summaries, "2026-10-08-private.md"), `> 3 messages summarized\nRay said the ${secret} figure ${held.summary}.\n`);
  writeFileSync(join(attachments, held.upload), `${secret}\n`);
  writeFileSync(join(root, "sessions.json"), "{}");
  const discordEnv = { ...process.env, BOT_BUFFER_FILE: join(root, "buffer.txt"), BOT_SUMMARIES_DIR: summaries,
    BOT_ATTACHMENTS_DIR: attachments, BOT_SESSIONS_FILE: join(root, "sessions.json"),
    BOT_JOB_HISTORY_FILE: join(root, "job-history.jsonl"), BOT_SCHEDULES_FILE: join(root, "schedules.json") };
  const recall = (env) => spawnSync(process.execPath, [join(__dirname, "..", "skill-pack", "bin", "recall.mjs"), secret],
    { env, encoding: "utf8" }).stdout;
  const discord = recall(discordEnv);
  for (const [store, text] of Object.entries(held)) {
    assert.ok(discord.includes(text), `the ${store} is not reachable even from Discord — the test proves nothing`);
  }
  const boardEnv = { ...discordEnv };
  for (const name of PRIVATE_MEMORY_ENV) delete boardEnv[name];
  const out = recall(boardEnv);
  for (const [store, text] of Object.entries(held)) {
    assert.ok(!out.includes(text), `a board run's recall returned the Discord ${store}`);
  }
  assert.match(out, /UNAVAILABLE/, "recall must say the stores are not available, not that nothing matched");
});

check("every Discord memory path is denied to the read tools by path, file and folder alike", () => {
  const rules = privateMemoryDeny(["/state/buffer.txt", "/state/history/"]);
  for (const r of ["Read(//state/buffer.txt)", "Read(//state/history)", "Read(//state/history/**)"]) {
    assert.ok(rules.includes(r), `missing ${r} in ${JSON.stringify(rules)}`);
  }
});

check("a board run drops every memory variable and denies the path each one names", () => {
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  // The paths denied must be the paths the variables point at, in the same order,
  // so a new store published to Discord runs cannot be left open to board runs.
  const paths = src.match(/function privateMemoryPaths\(\) \{\s*return \[([^\]]+)\]/)[1].split(",").map((x) => x.trim());
  assert.deepStrictEqual(paths, PRIVATE_MEMORY_ENV.map((name) => {
    const m = src.match(new RegExp(`cleanEnv\\.${name} = (\\w+);`));
    assert.ok(m, `${name} is no longer published — update PRIVATE_MEMORY_ENV`);
    return m[1];
  }));
  assert.match(src, /if \(opts\.noBufferContext\) for \(const name of PRIVATE_MEMORY_ENV\) delete cleanEnv\[name\];/);
  assert.match(src, /permissionArgs\("session", opts\.noBufferContext \? privateMemoryDeny\(privateMemoryPaths\(\)\) : \[\]\)/);
  assert.match(src, /noBufferContext: true/, "the Paperclip run no longer marks itself as a board run");
});

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
