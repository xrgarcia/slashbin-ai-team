// Behavioural tests for the permission-mode resolver.
//
// The rest of the permission coverage in startup-safety.test.js asserts on the
// SHAPE of the source, which is the right tool for "no call site bypasses the
// mode". It cannot tell you that the precedence actually works. This runs it.

const assert = require("assert");
const { runEnvironment, runEnvProblems, runEnvCredentials, HARNESS_POLICY_ENV, RUN_ENV_BASE, resolvePermissionMode, VALID_MODES, attachmentReadRule, summarizerArgs, PRIVATE_MEMORY_ENV, DISCORD_CREDENTIAL_ENV, BOARD_BOT_ENV, withheldFromBoard, privateMemoryDeny, boardArgs, boardSettings, boardCwdDenied, SYSTEM_READ, resolveBoardPolicy, boardPolicyProblems, boardEngineeringRules, boardRunKind, withheldFromParityBoard } = require("../lib/permission-mode");
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync } = require("fs");
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

check("restricted sessions read no settings file, so only the bot's list approves a tool", () => {
  // dontAsk honors an approval from any settings source: a user's or the repo's
  // `mcp__shell` would otherwise run with BOT_PERMISSION_ALLOW empty.
  const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  const fn = bot.slice(bot.indexOf("function permissionArgs("), bot.indexOf("function settingsArgs("));
  const restricted = fn.slice(fn.indexOf('"--tools", ALLOWED_TOOLS'));
  assert.match(restricted, /"--setting-sources", "",\s*"--add-dir", CLAUDE_CWD,/);
  const bypass = fn.slice(fn.indexOf('if (PERMISSION_MODE === "bypass")'), fn.indexOf('"--tools", ALLOWED_TOOLS'));
  assert.ok(!bypass.includes("--setting-sources"), "bypass argv must stay the historical one");
  // --add-dir loads that folder's CLAUDE.md only with this set.
  assert.match(bot, /if \(narrowBoard \|\| PERMISSION_MODE === "restricted"\) cleanEnv\.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";/);
});

check("a board run gets none of the bot's own configuration, but keeps what the hooks read", () => {
  // Second pass on e73ddeb: BOT_SETTINGS='{"env":{"DISCORD_TOKEN":"…"}}' reached
  // the board run, where an approved printenv would post it.
  for (const name of ["BOT_SETTINGS", "BOT_SYSTEM_PROMPT", "BOT_PERMISSION_ALLOW", "BOT_SOMETHING_ADDED_LATER",
    "MCP_CONFIG", "MCP_CONFIG_EXTRA", "PAPERCLIP_API_KEY", "HANK_PAPERCLIP_API_KEY", "DISCORD_TOKEN"]) {
    assert.ok(withheldFromBoard(name), `${name} reaches a board run`);
  }
  for (const name of ["PATH", "HOME", "GIT_AUTHOR_NAME", ...BOARD_BOT_ENV]) assert.ok(!withheldFromBoard(name), `${name} is withheld`);
  // Every BOT_* the skill pack reads is kept or private: a gate whose variable is
  // withheld turns itself off.
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  const read = new Set(walk(join(__dirname, "..", "skill-pack")).flatMap((f) => readFileSync(f, "utf8").match(/BOT_[A-Z_]+/g) ?? []));
  for (const name of read) {
    assert.ok(BOARD_BOT_ENV.includes(name) || PRIVATE_MEMORY_ENV.includes(name), `the skill pack reads ${name}: add it to BOARD_BOT_ENV or PRIVATE_MEMORY_ENV`);
  }
});

check("a private store reached through a symlink is denied by its real path too", () => {
  // Second pass on 731cfbf: BOT_STATE_DIR a link into CLAUDE_CWD left the target
  // open to the built-in Read, which the shell sandbox does not govern.
  const tmp = require("fs").realpathSync(mkdtempSync(join(require("os").tmpdir(), "board-store-")));
  mkdirSync(join(tmp, "repo", "private"), { recursive: true });
  require("fs").symlinkSync(join(tmp, "repo", "private"), join(tmp, "state"));
  const rules = privateMemoryDeny([join(tmp, "state")]);
  for (const p of [join(tmp, "state"), join(tmp, "repo", "private")]) {
    assert.ok(rules.includes(`Read(/${p})`) && rules.includes(`Read(/${p}/**)`), `${p} is not denied`);
  }
  assert.strictEqual(privateMemoryDeny(["/no/such/place"]).length, 2, "a path with no link is denied once");
});

check("a bot whose CLAUDE_CWD is a denied folder answers no board", () => {
  // Second pass on 1f20c66: the sandbox binds the working directory writable after
  // its read denials, so a denied CLAUDE_CWD (the harness folder) was open to a
  // board shell, secrets file included. Measured 2026-10-09: a denied subfolder
  // of the working directory stays hidden; a denied working directory does not.
  const denied = ["/harness", "/data/state"];
  assert.ok(boardCwdDenied(denied, "/harness"));
  assert.ok(boardCwdDenied(denied, "/harness/"));
  assert.ok(boardCwdDenied(denied, "/data/state/sub"));
  assert.ok(!boardCwdDenied(denied, "/repo"));
  assert.ok(!boardCwdDenied(denied, "/harness-two"));
  assert.ok(!boardCwdDenied(denied, "/data"), "a denied folder inside the working directory stays hidden");
  // Second pass on 0897d78: a symlink to a denied folder is that folder.
  const tmp = mkdtempSync(join(require("os").tmpdir(), "board-alias-"));
  mkdirSync(join(tmp, "harness"));
  require("fs").symlinkSync(join(tmp, "harness"), join(tmp, "alias"));
  assert.ok(boardCwdDenied([join(tmp, "harness")], join(tmp, "alias")), "an alias of a denied folder passes");
  assert.ok(boardCwdDenied([join(tmp, "alias")], join(tmp, "harness")), "a denied alias misses its target");
  assert.ok(boardCwdDenied([join(tmp, "harness")], join(tmp, "alias", "not-made-yet")));
  const fsSettings = boardSettings(null, [join(tmp, "harness")], join(tmp, "alias")).sandbox.filesystem;
  assert.ok(!fsSettings.allowRead.some((p) => p.startsWith(tmp)), "the alias is still given an allowRead");
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /const PAPERCLIP_CWD_DENIED = boardCwdDenied\(boardDeniedPaths\(\), CLAUDE_CWD\);\nif \(PAPERCLIP_BOARDS\.length && PAPERCLIP_CWD_DENIED\) \{\n  log\.error/);
  assert.ok(src.indexOf("PAPERCLIP_CWD_DENIED) {") < src.indexOf("createPaperclipPoller({"), "the poller starts before the check");
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
  writeFileSync(join(root, "buffer.txt"), `[#private] Owner: the ${secret} figure ${held.buffer}\n`);
  writeFileSync(join(summaries, "2026-10-08-private.md"), `> 3 messages summarized\nThe owner said the ${secret} figure ${held.summary}.\n`);
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
  assert.match(src, /if \(opts\.noBufferContext\) \{\s*for \(const name of Object\.keys\(cleanEnv\)\) if \(withheldFromBoard\(name\)\) delete cleanEnv\[name\];/);
  for (const name of PRIVATE_MEMORY_ENV) assert.ok(withheldFromBoard(name), `${name} reaches a board run`);
  // Second-pass review of 2.7.0: a bypass board run could print the bot's
  // Discord token into its reply. Every credential the bot itself reads that
  // gives Discord access must be withheld.
  for (const name of ["DISCORD_TOKEN", "BRIDGE_TOKEN"]) {
    assert.ok(DISCORD_CREDENTIAL_ENV.includes(name) && withheldFromBoard(name), `${name} reaches a board run`);
    assert.ok(src.includes(`process.env.${name}`), `${name} is no longer read by the bot — revisit this list`);
  }
  // The withholding runs after every variable is set and before the spawn.
  const at = (re) => src.search(re);
  assert.ok(at(/cleanEnv\.BOT_CHANNEL_ID = /) < at(/withheldFromBoard\(name\)\) delete/) && at(/withheldFromBoard\(name\)\) delete/) < at(/spawn\(RUNTIME\.bin, safeArgs/),
    "the credentials are removed before they are set, or after the spawn");
  assert.match(src, /deny: \[PERMISSION_DENY, \.\.\.privateMemoryDeny\(boardReadDeniedPaths\(\), BOARD_ENGINEERING \? \["Read", "Edit"\] : \["Read"\]\)\]/, "the board run no longer denies the memory paths");
  // Second pass on e4411f4: files already sent to Discord sit in the outbox,
  // which can be moved anywhere, including inside CLAUDE_CWD.
  const denied = /function boardDeniedPaths\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  // Second passes on 0f2539f and 1bf0c97: with the default CLAUDE_CWD a board
  // run's Read tool sat next to the bot's .env and every instance's log. The
  // harness folder (and the folder dotenv reads from) is denied whole.
  assert.match(denied, /return \[\.\.\.privateMemoryPaths\(\), STATE_DIR, OUTBOX_DIR, \.\.\.new Set\(\[__dirname, process\.cwd\(\)\]\)\];/,
    "the outbox, state folder or harness folder is readable to a board run");
  assert.match(src, /noBufferContext: true/, "the Paperclip run no longer marks itself as a board run");
});

check("a board run is least privilege in every mode — never bypass", () => {
  // Second-pass review of 2.7.0: a bypass board run's shell could read Claude's
  // own transcripts of Discord conversations, and any other bot's files on the
  // host. No list of private paths covers that; least privilege does.
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /\.\.\.permissionArgs\(runKind\)/, "the board run no longer takes the board branch");
  assert.match(src, /const runKind = opts\.noBufferContext \? BOARD_KIND : "session";/, "a Paperclip run no longer resolves its kind from the board policy");
  assert.match(src, /const BOARD_KIND = boardRunKind\(BOARD_POLICY\);/);
  assert.strictEqual(boardRunKind(resolveBoardPolicy({})), "board", "the default board run is no longer least privilege");
  const fn = /function permissionArgs[\s\S]*?\n}/.exec(src)[0];
  const board = fn.indexOf('kind === "board"'), bypass = fn.indexOf('PERMISSION_MODE === "bypass"');
  assert.ok(board > -1 && board < bypass, "the board branch must come before the bypass branch");
  assert.match(src, /const BOARD_POLICY = resolveBoardPolicy\(\);/);
  assert.strictEqual(resolveBoardPolicy({}).tools, "Read,Glob,Grep", "the default board run is no longer read-only");
  const args = boardArgs({ tools: "Read,Glob,Grep", allow: "", deny: ["Read(//state/buffer.txt)"] });
  assert.deepStrictEqual(args, ["--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--setting-sources", "", "--disallowedTools", "Read(//state/buffer.txt)"]);
  // Second pass on f2a7466: an approval in any settings file — the bot's, the
  // repo's, the user's — was honored by dontAsk. None is read; CLAUDE.md still is.
  assert.deepStrictEqual(boardArgs({ tools: "Read", cwd: "/repo" }).slice(4), ["--setting-sources", "", "--add-dir", "/repo"]);
  assert.match(src, /boardArgs\(\{ tools: BOARD_POLICY\.tools, allow: \[BOARD_POLICY\.allow, \.\.\.boardEngineeringRules\(CLAUDE_CWD, BOARD_POLICY\)\], cwd: CLAUDE_CWD,/);
  assert.match(src, /cleanEnv\.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";/, "a board run loses the repo's CLAUDE.md");
  assert.ok(!args.some((a) => /dangerously/.test(a)), "a board run must never skip permissions");
  assert.deepStrictEqual(boardArgs({ tools: "Read", allow: "mcp__db" }).slice(6), ["--allowedTools", "mcp__db"]);
});

check("a board run's shell is sandboxed to the working directory, on top of the bot's own settings", () => {
  // Read deny rules do not bind the shell; an allowed shell must not read the home folder.
  const base = { model: "x", sandbox: { network: { allowedDomains: ["github.com"] }, filesystem: { denyRead: ["/etc/secret"], allowRead: ["/opt/tools"] } } };
  const s = boardSettings(base, ["/repo/bot-history/", "/state/buffer.txt"], "/repo");
  assert.strictEqual(s.model, "x", "the bot's model was dropped");
  const carried = boardSettings({ model: "m", permissions: { allow: ["mcp__shell"], defaultMode: "bypassPermissions" }, hooks: { PreToolUse: [] }, env: { A: "1" } }, [], "/repo");
  assert.deepStrictEqual(Object.keys(carried).sort(), ["autoMemoryEnabled", "model", "sandbox"], "a board run inherits the bot's approvals, hooks or env");
  assert.deepStrictEqual(s.sandbox.network, { ...base.sandbox.network, allowAllUnixSockets: false }, "the bot's network rules were dropped");
  assert.strictEqual(s.sandbox.enabled, true);
  // Second pass on 09bb6cd: the CLI loads project auto-memory, shared with the
  // Discord sessions, at startup, before any sandbox or deny rule applies.
  assert.strictEqual(boardSettings({ autoMemoryEnabled: true }, [], "/repo").autoMemoryEnabled, false, "a board run loads Discord sessions' auto-memory");
  assert.match(readFileSync(join(__dirname, "..", "bot.js"), "utf8"), /if \(opts\.noBufferContext\) \{[^}]*cleanEnv\.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";[^}]*\}/, "the board run's env leaves auto-memory on");
  assert.strictEqual(s.sandbox.failIfUnavailable, true, "a host without the sandbox would run the board task open");
  assert.strictEqual(s.sandbox.allowUnsandboxedCommands, false, "a command could step outside the sandbox");
  assert.deepStrictEqual(s.sandbox.filesystem.denyRead, ["/etc/secret", "/", "/repo/bot-history", "/state/buffer.txt"]);
  // Second pass on 1a1d7a2: denying only the home folder left /srv/bot-b/state readable.
  const sys = (a) => a.filter((p) => !SYSTEM_READ.includes(p));
  assert.ok(SYSTEM_READ.includes("/usr") && !SYSTEM_READ.some((p) => /^\/(tmp|var|srv|opt|home|root|mnt)\b/.test(p)), "a system allowRead reopens where bots keep state");
  assert.deepStrictEqual(sys(s.sandbox.filesystem.allowRead), ["/opt/tools", "/repo"]);
  // Second pass on 8260cf4: an allowRead is mounted back over a denyRead, so a
  // working directory that IS the denied harness folder must not be allowed.
  const harness = boardSettings({ sandbox: { filesystem: { allowRead: ["/opt/tools", "/bot/logs", "/bot"] } } }, ["/bot", "/state"], "/bot");
  assert.deepStrictEqual(sys(harness.sandbox.filesystem.allowRead), ["/opt/tools"], "an allowRead reopens a denied folder");
  assert.deepStrictEqual(sys(boardSettings(null, ["/bot"], "/bot-po").sandbox.filesystem.allowRead), ["/bot-po"], "a sibling folder is not inside a denied one");
  const open = boardSettings({ sandbox: { enabled: false, allowUnsandboxedCommands: true } }, ["/s"], "/repo");
  assert.strictEqual(open.sandbox.enabled, true, "a bot that turns its sandbox off turns it off for board runs too");
  assert.strictEqual(open.sandbox.allowUnsandboxedCommands, false);
  // Second pass on c2da179: a key of the bot's that loosens the sandbox survived a spread.
  const loose = boardSettings({ sandbox: { excludedCommands: ["cat:*"], enableWeakerNestedSandbox: true, autoAllowBashIfSandboxed: true,
    network: { allowedDomains: ["x.com"], allowAllUnixSockets: true }, credentials: { envVars: { deny: ["K"] } },
    filesystem: { disabled: true, allowWrite: ["/state"], denyWrite: ["/repo/.git"] } } }, ["/state"], "/repo");
  assert.strictEqual(loose.sandbox.filesystem.disabled, false, "the bot's settings switch the file sandbox off");
  assert.deepStrictEqual(loose.sandbox.excludedCommands, [], "a command runs outside the sandbox");
  assert.strictEqual(loose.sandbox.enableWeakerNestedSandbox, false);
  assert.strictEqual(loose.sandbox.autoAllowBashIfSandboxed, false, "every shell command is pre-approved, not only BOT_BOARD_PERMISSION_ALLOW");
  assert.strictEqual(loose.sandbox.network.allowAllUnixSockets, false, "a shell can reach any local socket");
  assert.deepStrictEqual(loose.sandbox.network.allowedDomains, ["x.com"]);
  assert.deepStrictEqual(loose.sandbox.credentials, { envVars: { deny: ["K"] } }, "a tightening key was dropped");
  assert.ok(!("allowWrite" in loose.sandbox.filesystem), "a board shell may write where the bot allows");
  assert.deepStrictEqual(loose.sandbox.filesystem.denyWrite, ["/repo/.git"]);
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /\.\.\.settingsArgs\(\{ board: narrowBoard, tmpDir: boardTmp \}\)/, "the board run no longer gets the sandbox");
  assert.match(src, /boardSettings\(botSettings\(\), boardReadDeniedPaths\(\), CLAUDE_CWD, \{ \.\.\.BOARD_POLICY, tmpDir \}\)/);
  // Second pass on 3c32d35: a relative BOT_SETTINGS read from the harness folder
  // failed every board run while Discord sessions, run in CLAUDE_CWD, found it.
  assert.match(src, /readFileSync\(resolve\(CLAUDE_CWD, SESSION_SETTINGS\), "utf8"\)/, "a relative settings file is read from the wrong folder");
});

console.log("\nBoard runs — engineering mode");

check("readonly is the default, and unset or readonly changes nothing about a board run", () => {
  const ro = resolveBoardPolicy({});
  assert.deepStrictEqual([ro.execution, ro.tools, ro.readPaths, ro.writePaths, ro.network], ["readonly", "Read,Glob,Grep", [], [], []]);
  // Engineering-only settings are ignored unless engineering is asked for.
  const ignored = resolveBoardPolicy({ BOT_BOARD_READ_PATHS: "/srv/code", BOT_BOARD_WRITE_PATHS: "/srv/out", BOT_BOARD_NETWORK_ALLOW: "example.com" });
  assert.deepStrictEqual(boardSettings(null, ["/state"], "/repo", ignored), boardSettings(null, ["/state"], "/repo"));
  assert.deepStrictEqual(boardEngineeringRules("/repo", ignored), []);
  const s = boardSettings(null, ["/state"], "/repo").sandbox;
  assert.strictEqual(s.autoAllowBashIfSandboxed, false);
  assert.ok(!("allowWrite" in s.filesystem) && !("denyWrite" in s.filesystem));
});

check("engineering: the named tools, edits in the working directory and write paths, the private memory still closed", () => {
  const env = { BOT_BOARD_EXECUTION: "engineering", BOT_BOARD_READ_PATHS: "/srv/code/other", BOT_BOARD_WRITE_PATHS: "/srv/scratch", BOT_BOARD_NETWORK_ALLOW: "api.example.com" };
  const p = resolveBoardPolicy(env);
  assert.strictEqual(p.tools, "Read,Glob,Grep,Edit,Write,Bash");
  assert.strictEqual(resolveBoardPolicy({ ...env, BOT_BOARD_ENGINEERING_TOOLS: "Read,Bash" }).tools, "Read,Bash");
  assert.deepStrictEqual(boardEngineeringRules("/srv/code/repo", p), ["Edit(//srv/code/repo/**)", "Edit(//srv/scratch/**)", "Read(//srv/code/other/**)"]);
  const s = boardSettings({ sandbox: { network: { allowedDomains: ["github.com"] } } }, ["/state"], "/srv/code/repo", { ...p, tmpDir: "/tmp/b-1" }).sandbox;
  assert.strictEqual(s.autoAllowBashIfSandboxed, true);
  assert.deepStrictEqual(s.filesystem.allowWrite, ["/srv/code/repo", "/srv/scratch", "/tmp/b-1"]);
  assert.ok(s.filesystem.denyRead.includes("/") && s.filesystem.denyRead.includes("/state"), "the root or the private memory is readable");
  assert.ok(s.filesystem.denyWrite.includes("/state"), "a write path above the state folder could overwrite it");
  for (const r of ["/srv/code/other", "/srv/scratch", "/tmp/b-1"]) assert.ok(s.filesystem.allowRead.includes(r), `${r} is not readable`);
  assert.deepStrictEqual(s.network.allowedDomains, ["github.com", "api.example.com"]);
  assert.strictEqual(s.network.allowAllUnixSockets, false);
  assert.strictEqual(s.allowUnsandboxedCommands, false);
  assert.strictEqual(s.failIfUnavailable, true);
  // The private memory is denied to Edit as well as Read when the run may edit.
  assert.ok(privateMemoryDeny(["/state"], ["Read", "Edit"]).includes("Edit(//state/**)"));
});

check("engineering: a policy that would open what a board run must not reach is refused, not loosened", () => {
  const denied = ["/srv/harness", "/srv/harness/state"];
  const probs = (env) => boardPolicyProblems(resolveBoardPolicy({ BOT_BOARD_EXECUTION: "engineering", ...env }), denied, "/srv/code/repo");
  assert.deepStrictEqual(probs({ BOT_BOARD_READ_PATHS: "/srv/code/other", BOT_BOARD_WRITE_PATHS: "/srv/scratch" }), []);
  assert.match(boardPolicyProblems(resolveBoardPolicy({ BOT_BOARD_EXECUTION: "yolo" }), denied, "/r")[0], /not one of readonly, engineering, parity/);
  assert.match(probs({ BOT_BOARD_READ_PATHS: "relative/dir" })[0], /not an absolute path/);
  assert.match(probs({ BOT_BOARD_READ_PATHS: "/srv/harness/state/history" })[0], /private Discord memory/);
  assert.match(probs({ BOT_BOARD_WRITE_PATHS: "/srv/harness" })[0], /private Discord memory/);
  assert.match(probs({ BOT_BOARD_READ_PATHS: "/" })[0], /whole filesystem/);
  assert.match(probs({ BOT_BOARD_WRITE_PATHS: require("os").homedir() })[0], /whole home folder/);
  // A read path over the working directory or a write path mounts it read-only and the sandbox cannot start.
  assert.match(probs({ BOT_BOARD_READ_PATHS: "/srv/code" })[0], /contains \/srv\/code\/repo/);
  assert.match(probs({ BOT_BOARD_READ_PATHS: "/srv", BOT_BOARD_WRITE_PATHS: "/srv/scratch" }).join(" "), /\/srv\/scratch/);
  assert.match(probs({ BOT_BOARD_NETWORK_ALLOW: "https://x.example.com/path" })[0], /not a host name/);
  // Discord memory inside CLAUDE_CWD: a shell reads it back through version
  // control, so engineering is refused; readonly (no shell) is unaffected.
  const nested = ["/srv/harness", "/srv/code/repo/bot-history"];
  assert.match(boardPolicyProblems(resolveBoardPolicy({ BOT_BOARD_EXECUTION: "engineering" }), nested, "/srv/code/repo")[0],
    /\/srv\/code\/repo\/bot-history.*inside CLAUDE_CWD.*version control/);
  assert.deepStrictEqual(boardPolicyProblems(resolveBoardPolicy({}), nested, "/srv/code/repo"), []);
  // bot.js turns board pickup off on any problem, and says so.
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /else if \(PAPERCLIP_BOARDS\.length && BOARD_POLICY_PROBLEMS\.length\) \{\n  for \(const problem of BOARD_POLICY_PROBLEMS\) log\.error\(`Paperclip connector off — \$\{problem\}`\);/);
});

check("bot.js: an engineering run gets a private temp folder, removed when the run ends", () => {
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /mkdtempSync\(join\(require\("os"\)\.tmpdir\(\), `\$\{BOT_NAME\}-board-`\)\)|mkdtempSync\(join\(os\.tmpdir\(\), `\$\{BOT_NAME\}-board-`\)\)/);
  assert.match(src, /if \(boardTmp\) cleanEnv\.TMPDIR = boardTmp;/);
  assert.ok((src.match(/rmSync\(boardTmp, \{ recursive: true, force: true \}\)/g) || []).length >= 1, "the private temp folder is never removed");
});

check("credential files in reach of a board run are denied in every mode; a template is not", () => {
  const { boardSecretFiles, DEFAULT_BOARD_SECRET_FILES } = require("../lib/permission-mode");
  const repo = mkdtempSync(join(tmpdir(), "secret-files-"));
  for (const d of ["sub", "node_modules/x", ".git"]) mkdirSync(join(repo, d), { recursive: true });
  for (const f of [".mcp.json", ".env", "sub/.env.local", "sub/deploy.pem", ".env.example", "app.js", "node_modules/x/.env", ".git/.env", "custom.secret"]) writeFileSync(join(repo, f), "x");
  const rel = (list) => list.filter((p) => p.startsWith(repo)).map((p) => p.slice(repo.length + 1)).sort();
  for (const execution of ["", "engineering"]) {
    const policy = resolveBoardPolicy({ BOT_BOARD_EXECUTION: execution });
    assert.deepStrictEqual(policy.secretFiles, DEFAULT_BOARD_SECRET_FILES);
    assert.deepStrictEqual([...new Set(rel(boardSecretFiles([repo], policy.secretFiles)))], [".env", ".mcp.json", "node_modules/x/.env", "sub/.env.local", "sub/deploy.pem"]);
  }
  // However deep a folder lies, it is walked; past the walk's budget, every folder
  // not walked is denied whole, so nothing the bound left unread is readable.
  const deep = join(repo, "a/b/c/d/e/f/g");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, ".env"), "x");
  assert.ok(rel(boardSecretFiles([repo], DEFAULT_BOARD_SECRET_FILES)).includes("a/b/c/d/e/f/g/.env"));
  const bounded = rel(boardSecretFiles([repo], DEFAULT_BOARD_SECRET_FILES, { maxEntries: 12 }));
  assert.ok(bounded.includes(".env") && bounded.includes("sub/.env.local"), bounded.join());
  assert.ok(!bounded.includes("a/b/c/d/e/f/g/.env") && bounded.some((d) => "a/b/c/d/e/f/g/.env".startsWith(`${d}/`)), bounded.join());
  assert.ok(bounded.includes("node_modules"), "the dependency folder, walked last, is closed when the budget runs out");
  // BOT_BOARD_DENY_FILES adds a pattern; the defaults stay.
  const added = resolveBoardPolicy({ BOT_BOARD_DENY_FILES: "*.secret" });
  assert.ok(rel(boardSecretFiles([repo], added.secretFiles)).includes("custom.secret"));
  assert.ok(rel(boardSecretFiles([repo], added.secretFiles)).includes(".mcp.json"));
  // Kept apart from the Discord memory: a .env in CLAUDE_CWD never turns engineering off.
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /boardPolicyProblems\(BOARD_POLICY, boardDeniedPaths\(\), CLAUDE_CWD/);
  // Every board call site denies them: the read rules, the sandbox, and the Codex profile.
  assert.match(src, /privateMemoryDeny\(boardReadDeniedPaths\(\)/);
  assert.match(src, /boardSettings\(botSettings\(\), boardReadDeniedPaths\(\), CLAUDE_CWD/);
  assert.match(src, /denied: boardReadDeniedPaths\(\), policy: BOARD_POLICY/);
  assert.match(src, /return \[\.\.\.boardDeniedPaths\(\), \.\.\.boardHistoryDenied\(privateMemoryPaths\(\)\), \.\.\.boardSecretFiles\(roots, BOARD_POLICY\.secretFiles\)\];/, "the run-time deny list dropped the Discord memory or its copies");
});

console.log("\nBoard runs — parity mode");

check("parity runs a Paperclip task as the bot's Discord session", () => {
  // An agent must have the same capabilities in Paperclip as in Discord.
  // A parity board run takes the session branch — its tools, MCP
  // servers, settings, filesystem and network — in whatever mode the bot runs.
  const policy = resolveBoardPolicy({ BOT_BOARD_EXECUTION: "parity" });
  assert.strictEqual(policy.parity, true);
  assert.strictEqual(boardRunKind(policy), "session");
  for (const execution of [undefined, "readonly", "engineering"]) {
    const other = resolveBoardPolicy(execution ? { BOT_BOARD_EXECUTION: execution } : {});
    assert.strictEqual(other.parity, false);
    assert.strictEqual(boardRunKind(other), "board", `${execution || "the default"} stopped being least privilege`);
  }
  assert.deepStrictEqual(boardPolicyProblems(policy, ["/state"], "/state/repo"), [], "parity has no sandbox to refuse");
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /const narrowBoard = runKind === "board";/);
  assert.match(src, /kind: runKind,/, "the Codex run ignores the board policy");
  assert.match(src, /filesystem: narrowBoard \? codexRuntime\.boardFilesystem\(/);
  assert.match(src, /if \(!narrowBoard && CODEX_MCP\) Object\.assign\(cleanEnv, opts\.noBufferContext \? parityMcpEnv\(CODEX_MCP\.env\) : CODEX_MCP\.env\);/, "a parity Codex run lost its MCP keys, or gets them unscrubbed");
  assert.match(src, /CODEX && !BOARD_POLICY\.parity \? codexRuntime\.codexBoardProblems/);
});

check("a board session made under other access is not resumed, on either runtime", () => {
  const { boardAccessKey } = require("../lib/permission-mode");
  const parity = resolveBoardPolicy({ BOT_BOARD_EXECUTION: "parity" });
  const narrow = resolveBoardPolicy({ BOT_BOARD_EXECUTION: "readonly" });
  const key = (policy) => boardAccessKey({ kind: boardRunKind(policy), policy, permissionMode: "bypass", settings: null });
  assert.notStrictEqual(key(parity), key(narrow));
  assert.strictEqual(key(narrow), key(resolveBoardPolicy({ BOT_BOARD_EXECUTION: "readonly" })));
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /\(!opts\.noBufferContext \|\| existingSession\.access === opts\.access\) &&/, "a board session is resumed whatever access made it");
  assert.match(src, /if \(opts\.noBufferContext\) opts = \{ \.\.\.opts, access: boardAccess\(\) \};/);
  assert.match(src, /\.\.\.\(opts\.access \? \{ access: opts\.access \} : \{\}\),/, "a stored session does not record its access");
});

check("narrowing a parity run's tools, allow or deny rules opens a fresh board session", () => {
  const { boardAccessKey } = require("../lib/permission-mode");
  const parity = resolveBoardPolicy({ BOT_BOARD_EXECUTION: "parity" });
  const base = { kind: boardRunKind(parity), policy: parity, permissionMode: "restricted", settings: null, tools: "Read,Bash", allow: "Bash(gh issue edit:*)", deny: "" };
  for (const change of [{ tools: "Read" }, { allow: "" }, { deny: "Bash(gh *--repo*)" }]) {
    assert.notStrictEqual(boardAccessKey({ ...base, ...change }), boardAccessKey(base), Object.keys(change)[0]);
  }
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  const body = src.slice(src.indexOf("function boardAccess()"), src.indexOf("\n}\n", src.indexOf("function boardAccess()")));
  for (const input of ["ALLOWED_TOOLS", "PERMISSION_ALLOW", "PERMISSION_DENY"]) {
    assert.match(body, new RegExp(`\\b${input}\\b`), `a board session survives a change to ${input}`);
  }
});

check("credential files under the folders the bot's settings open to reading are denied to a board run", () => {
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /const roots = \[CLAUDE_CWD, \.\.\.BOARD_POLICY\.readPaths, \.\.\.BOARD_POLICY\.writePaths, \.\.\.\(botSettings\(\)\?\.sandbox\?\.filesystem\?\.allowRead \?\? \[\]\)\];/);
});

check("a parity run's MCP env never puts back a withheld credential, by name or by value", () => {
  const { parityMcpEnv } = require("../lib/permission-mode");
  const env = { DISCORD_TOKEN: "tok-123", OTHER: "fine" };
  const out = parityMcpEnv({ DISCORD_TOKEN: "tok-123", TOKEN: "tok-123", AUTH: "Bot tok-123", API_KEY: "k-1", EMPTY: "" }, env);
  assert.deepStrictEqual(out, { API_KEY: "k-1", EMPTY: "" });
  for (const name of DISCORD_CREDENTIAL_ENV) assert.ok(!(name in parityMcpEnv({ [name]: "x" }, {})), `${name} restored by name`);
});

check("no board run keeps a Discord or bridge credential, under any name or any variable carrying its value", () => {
  const { discordCarriers, parityMcpEnv } = require("../lib/permission-mode");
  // The fleet's shared environment: each bot holds every bot's token under its
  // own name, beside the DISCORD_TOKEN it runs as.
  const env = {
    DISCORD_TOKEN: "fixture-discord-em", EM_DISCORD_TOKEN: "fixture-discord-em", PO_DISCORD_TOKEN: "fixture-discord-po",
    OPS_DISCORD_TOKEN: "fixture-discord-ops", DISCORD_BOT_KEY: "fixture-discord-bot", BRIDGE_TOKEN: "fixture-bridge",
    SESSION_HEADER: "Bot fixture-discord-po", RELAY_AUTH: "fixture-discord-em",
    GITHUB_TOKEN: "fixture-github", DOPPLER_CONFIG: "prd", DISCORD_CHANNEL_ID: "123", FLAG: "1",
  };
  const kept = Object.keys(env).filter((k) => !discordCarriers(env).includes(k));
  assert.deepStrictEqual(kept, ["GITHUB_TOKEN", "DOPPLER_CONFIG", "DISCORD_CHANNEL_ID", "FLAG"]);
  for (const name of ["EM_DISCORD_TOKEN", "PO_DISCORD_TOKEN", "OPS_DISCORD_TOKEN", "DISCORD_BOT_KEY"]) {
    assert.ok(withheldFromParityBoard(name) && withheldFromBoard(name), `${name} reaches a board run`);
  }
  assert.deepStrictEqual(parityMcpEnv({ PO_TOKEN: "fixture-discord-po", API_KEY: "k-1" }, env), { API_KEY: "k-1" });
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /if \(opts\.noBufferContext\) for \(const name of discordCarriers\(cleanEnv\)\) delete cleanEnv\[name\];/, "a board run keeps a credential carried under another name");
});

check("a parity run's commands get no Paperclip key, under any name or any variable carrying its value", () => {
  const { paperclipCarriers } = require("../lib/permission-mode");
  // The shared environment: this bot's own board key under a second name, and other bots' keys.
  const env = {
    PAPERCLIP_API_KEY: "fixture-board-own", EM_PAPERCLIP_API_KEY: "fixture-board-own", PO_PAPERCLIP_API_KEY: "fixture-board-po",
    OPS_EXTRA_PAPERCLIP_API_KEY: "fixture-board-ops", BOARD_AUTH: "Bearer fixture-board-po",
    PAPERCLIP_URL: "https://board.example", PAPERCLIP_PROMPT_CHANNEL: "123", GITHUB_TOKEN: "fixture-github",
  };
  const kept = Object.keys(env).filter((k) => !paperclipCarriers(env).includes(k));
  assert.deepStrictEqual(kept, ["PAPERCLIP_URL", "PAPERCLIP_PROMPT_CHANNEL", "GITHUB_TOKEN"]);
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /if \(opts\.noBufferContext && !narrowBoard\) \{[^}]*for \(const name of paperclipCarriers\(cleanEnv\)\) delete cleanEnv\[name\];/,
    "a parity run's commands keep a Paperclip key held under another name");
});

check("a parity run withholds only the Discord credentials, and still sees no other channel", () => {
  // The two named exceptions. Everything else a Discord session has — Doppler,
  // MCP config, the BOT_* paths — a parity run has too.
  for (const name of DISCORD_CREDENTIAL_ENV) assert.ok(withheldFromParityBoard(name), `${name} reaches a parity run`);
  for (const name of ["MCP_CONFIG", "MCP_CONFIG_EXTRA", "BOT_STATE_DIR", "BOT_SCHEDULES_FILE", "DOPPLER_PROJECT", "DOPPLER_CONFIG", "GITHUB_TOKEN"]) {
    assert.ok(!withheldFromParityBoard(name), `${name} is silently withheld from a parity run`);
  }
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(src, /if \(opts\.noBufferContext && !narrowBoard\) \{\s*for \(const name of Object\.keys\(cleanEnv\)\) if \(withheldFromParityBoard\(name\)\) delete cleanEnv\[name\];/);
  // The Paperclip connector keys are removed from every run, Discord's included,
  // before a Codex MCP server's env goes back in for the servers that name them;
  // the model's commands are kept from them (shellExclude).
  assert.match(src, /\["PAPERCLIP_API_KEY", \.\.\.PAPERCLIP_BOARDS\.map\(\(b\) => b\.keyEnv\)\]/);
  const removed = src.indexOf("for (const name of connectorKeys()) delete cleanEnv[name];");
  const restored = src.indexOf("if (!narrowBoard && CODEX_MCP) Object.assign(cleanEnv,");
  assert.ok(removed > 0 && restored > removed, "a Codex MCP server loses the connector key its config names");
  assert.ok(!/delete cleanEnv\.PAPERCLIP_API_KEY|delete cleanEnv\[keyEnv\]/.test(src), "a connector key is removed after the MCP env is put back");
  assert.match(src, /shellExclude: shellWithheld\(\),/, "a bypass Codex session's commands can read the connector keys");
  assert.match(src, /\[\.\.\.connectorKeys\(\), RUN_AGENT_KEY_ENV,/, "the withheld set starts with the connector keys");
  // Other channels' conversation stays out of the prompt in every board policy.
  assert.match(src, /opts\.noBufferContext \? "" : buildContextPrompt/);
});

console.log("\nRun environment — BOT_RUN_ENV");

// Hank's policy settings beside a Doppler shell's credentials: the shape that
// turned the mail and calendar gates off when a list dropped everything
// unlisted (PR #91 review, S1).
const POLICY = {
  BOT_MAIL_ALLOWED_RECIPIENTS: "owner@example.com", BOT_MAIL_SUBJECT_PREFIX: "Bot:",
  BOT_CALENDAR_NO_ATTENDEES: "true", BOT_CALENDAR_OWN_EVENTS: "true", BOT_CALENDAR_TITLE_PREFIX: "Bot:",
  BOT_LAND_PATHS: "notes/**", BOT_NAME: "hank", BOT_TIMEZONE: "UTC", BOT_MAX_WAKE_ATTEMPTS: "3", BOT_MAX_SCHEDULED_JOBS: "5",
  WS_PORT: "9899", RECENT_CONTEXT_MAX_CHARS: "1000",
  GIT_AUTHOR_NAME: "bot", GIT_AUTHOR_EMAIL: "bot@example.com", GIT_COMMITTER_NAME: "bot", GIT_COMMITTER_EMAIL: "bot@example.com",
};
const CREDS = { EM_GITHUB_TOKEN: "ghp_em_token_value", PROD_STRIPE_SRE_KEY: "sk_live_value", PAPERCLIP_API_KEY: "pcp_value",
  DOPPLER_TOKEN: "dp.st.value", RAILWAY_API_TOKEN: "rw_value" };

check("unset passes the whole environment on, as before", () => {
  const env = { PATH: "/bin", EM_GITHUB_TOKEN: "x" };
  assert.deepStrictEqual(runEnvironment(env, undefined), env);
  assert.deepStrictEqual(runEnvironment(env, " "), env);
});

check("named keeps the basics, the names and the harness policy, and no unlisted credential", () => {
  const env = { PATH: "/bin", HOME: "/h", LC_ALL: "C", XDG_RUNTIME_DIR: "/r", NOVA_BEARER: "n", NOVA_OTHER: "o", ...POLICY, ...CREDS };
  const run = runEnvironment(env, "NOVA_BEARER");
  assert.deepStrictEqual(Object.keys(run).sort(), ["HOME", "LC_ALL", "NOVA_BEARER", "PATH", "XDG_RUNTIME_DIR", ...Object.keys(POLICY)].sort());
  for (const [k, v] of Object.entries(POLICY)) assert.strictEqual(run[k], v, `${k} changed`);
});

check("a trailing * keeps a prefix", () => {
  const run = runEnvironment({ NOVA_A: "1", NOVA_B: "2", EM_A: "3" }, "NOVA_*");
  assert.deepStrictEqual(Object.keys(run).sort(), ["NOVA_A", "NOVA_B"]);
});

check("a harness setting is a policy, never a credential", () => {
  // Named like a credential under a harness prefix, or holding a dropped
  // credential's value: dropped. Listed by name: kept.
  const env = { GIT_AUTHOR_TOKEN: "secretvalue1", BOT_LAND_PATHS: `notes/**,${CREDS.EM_GITHUB_TOKEN}`, ...CREDS, NOVA_BEARER: "n" };
  const run = runEnvironment(env, "NOVA_BEARER");
  assert.ok(!("GIT_AUTHOR_TOKEN" in run), "a credential-named harness variable reached the run");
  assert.ok(!("BOT_LAND_PATHS" in run), "a harness setting holding a dropped credential reached the run");
  assert.strictEqual(runEnvironment(env, "NOVA_BEARER,EM_GITHUB_TOKEN").BOT_LAND_PATHS, env.BOT_LAND_PATHS);
});

check("a list it would read differently from its operator is refused, at startup and at every run", () => {
  assert.deepStrictEqual(runEnvProblems("NOVA_BEARER, GH_CONFIG_DIR,NOVA_*"), []);
  for (const bad of ["*", "NOVA BEARER", "NOVA-BEARER", "NOVA_*_X", "$HOME"]) {
    assert.strictEqual(runEnvProblems(`NOVA_BEARER,${bad}`).length, 1, `${bad} was accepted`);
    assert.throws(() => runEnvironment({}, bad), /BOT_RUN_ENV entry/);
  }
  const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.match(bot, /if \(runEnvProblems\(process\.env\.BOT_RUN_ENV\)\.length\) \{[\s\S]{0,200}process\.exit\(EXIT_CONFIG\)/);
});

// Every setting a hook or skill-pack script reads, found by reading them.
const walkPack = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkPack(join(d, e.name)) : [join(d, e.name)]);
const PACK = join(__dirname, "..", "skill-pack");
const hookReads = new Set(walkPack(PACK).flatMap((f) => {
  const src = readFileSync(f, "utf8");
  return [...src.matchAll(/os\.environ(?:\.get\(|\[)\s*["']([A-Z_][A-Z0-9_]*)["']|process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g)]
    .map((m) => m[1] || m[2] || m[3]);
}));
// Set for each run by the runtime (Claude for a plugin) or the harness (Codex), never inherited.
const SET_PER_RUN = ["CLAUDE_PLUGIN_ROOT"];

check("every setting the skill pack reads is one a run keeps", () => {
  assert.ok(hookReads.has("BOT_MAIL_ALLOWED_RECIPIENTS") && hookReads.has("BOT_LAND_PATHS"), "the scan found no hook reads");
  const covered = (k) => SET_PER_RUN.includes(k) || [...HARNESS_POLICY_ENV, ...RUN_ENV_BASE].some((p) => (p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p));
  for (const name of hookReads) assert.ok(covered(name), `the skill pack reads ${name}: add it to HARNESS_POLICY_ENV`);
  // …and survives a list that names none of them.
  const env = Object.fromEntries([...hookReads].filter((k) => !SET_PER_RUN.includes(k)).map((k) => [k, `v-${k}`]));
  const run = runEnvironment({ ...env, ...CREDS }, "NOVA_BEARER");
  for (const k of Object.keys(env)) assert.strictEqual(run[k], env[k], `${k} was dropped`);
});

// The gates and land.mjs, run with an environment built the way a run's is.
const runEnv = (extra = {}) => {
  const env = runEnvironment({ ...process.env, ...POLICY, ...CREDS, NOVA_BEARER: "n", ...extra }, "NOVA_BEARER");
  for (const k of Object.keys(CREDS)) assert.ok(!(k in env), `${k} reached the run`);
  return env;
};
const hook = (name, tool, input, env) =>
  spawnSync("python3", [join(PACK, "hooks", name)], { input: JSON.stringify({ tool_name: tool, tool_input: input }), env, encoding: "utf8" });

check("an outside-recipient email is still refused through the run environment", () => {
  const send = (to) => hook("bot_mail_gate.py", "mcp__claude_ai_Gmail__send_message", { to: [to], subject: "Bot: hi", body: "b" }, runEnv());
  assert.strictEqual(send("someone@example.invalid").status, 2, "an outside recipient was allowed");
  assert.strictEqual(send("owner@example.com").status, 0, send("owner@example.com").stderr);
});

check("an event inviting an attendee is still refused through the run environment", () => {
  const ev = (extra) => ({ summary: "Bot: x", startTime: "2026-10-20", endTime: "2026-10-21", allDay: true, ...extra });
  const tmp = mkdtempSync(join(tmpdir(), "run-env-cal-"));
  const env = runEnv({ BOT_STATE_DIR: tmp });
  const cal = (input) => hook("bot_calendar_gate.py", "mcp__claude_ai_Google_Calendar__create_event", input, env);
  assert.strictEqual(cal(ev({ attendees: [{ email: "someone@example.invalid" }] })).status, 2, "an attendee was allowed");
  assert.strictEqual(cal(ev()).status, 0, cal(ev()).stderr);
});

check("configured landing still lands inside its paths, and only there, through the run environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-env-land-"));
  const origin = join(dir, "origin.git"), repo = join(dir, "repo");
  const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, env: { ...process.env, ...POLICY }, encoding: "utf8" }); assert.strictEqual(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  git(dir, "clone", "--quiet", origin, repo);
  mkdirSync(join(repo, "notes"));
  writeFileSync(join(repo, "notes", "a.md"), "v1\n"); writeFileSync(join(repo, "RULES.md"), "r\n");
  git(repo, "add", "."); git(repo, "commit", "--quiet", "-m", "init"); git(repo, "push", "--quiet", "-u", "origin", "main");
  writeFileSync(join(repo, "notes", "a.md"), "v2\n"); writeFileSync(join(repo, "RULES.md"), "r2\n");
  const env = runEnv({ CLAUDE_CWD: repo });
  delete env.GIT_DIR;
  const land = (...paths) => spawnSync("node", [join(PACK, "bin", "land.mjs"), "-m", "x", ...paths], { cwd: repo, env, encoding: "utf8" });
  const outside = land("RULES.md");
  assert.strictEqual(outside.status, 1, "a file outside BOT_LAND_PATHS landed");
  const inside = land("notes/a.md");
  assert.strictEqual(inside.status, 0, inside.stderr);
  assert.strictEqual(git(repo, "ls-remote", origin, "refs/heads/main").split("\t")[0], git(repo, "rev-parse", "HEAD"));
});

check("the bot builds every run's environment through it", () => {
  const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.ok(/const cleanEnv = runEnvironment\(process\.env, process\.env\.BOT_RUN_ENV\)/.test(bot));
});

check("a credential the run environment names is withheld from a Codex run's commands", () => {
  // The harness's shell exclude list replaces the bot's own Codex config's,
  // so Nova's bearer reached her shell until the harness withheld it (2026-10-15).
  assert.deepStrictEqual(runEnvCredentials("NOVA_SLASHBIN_MCP_ROUTER_BEARER,GH_CONFIG_DIR,DOPPLER_CONFIG_DIR"), ["NOVA_SLASHBIN_MCP_ROUTER_BEARER"]);
  assert.deepStrictEqual(runEnvCredentials("A_TOKEN, B_api_key ,C_SECRET,D_PASSWORD,NOVA_*"), ["A_TOKEN", "B_api_key", "C_SECRET", "D_PASSWORD"]);
  assert.deepStrictEqual(runEnvCredentials(undefined), []);
  const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.ok(/shellExclude: shellWithheld\(\)/.test(bot));
  assert.ok(/runEnvCredentials\(process\.env\.BOT_RUN_ENV\)/.test(bot));
});

check("a Codex board run hands the escalate action its seat key and run, never to a command", () => {
  const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.ok(/connectorKeys\(\), RUN_AGENT_KEY_ENV,/.test(bot), "the run's seat key is withheld from commands");
  assert.ok(/paperclipRun: runId \? \{ runId, keyEnv: board\.keyEnv \} : null/.test(bot), "the board answer passes its run");
  assert.ok(/run\?\.runId && !narrowBoard && PERMISSION_MODE === "bypass"/.test(bot), "never on a narrow run");
  const paperclip = readFileSync(join(__dirname, "..", "lib", "paperclip.js"), "utf8");
  assert.ok(/issue, \{ runId: postRun \}\)\)\.trim\(\)/.test(paperclip), "the task's run reaches the answer");
});

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
