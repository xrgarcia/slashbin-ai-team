// Behavioural tests for the permission-mode resolver.
//
// The rest of the permission coverage in startup-safety.test.js asserts on the
// SHAPE of the source, which is the right tool for "no call site bypasses the
// mode". It cannot tell you that the precedence actually works. This runs it.

const assert = require("assert");
const { resolvePermissionMode, VALID_MODES, attachmentReadRule, summarizerArgs, PRIVATE_MEMORY_ENV, DISCORD_CREDENTIAL_ENV, BOARD_BOT_ENV, withheldFromBoard, privateMemoryDeny, boardArgs, boardSettings, boardCwdDenied, SYSTEM_READ } = require("../lib/permission-mode");
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
  assert.match(bot, /if \(opts\.noBufferContext \|\| PERMISSION_MODE === "restricted"\) cleanEnv\.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";/);
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
  assert.match(src, /const PAPERCLIP_CWD_DENIED = boardCwdDenied\(boardDeniedPaths\(\), CLAUDE_CWD\);\nif \(PAPERCLIP_URL && PAPERCLIP_API_KEY && PAPERCLIP_CWD_DENIED\) \{\n  log\.error/);
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
  assert.ok(at(/cleanEnv\.BOT_CHANNEL_ID = /) < at(/withheldFromBoard\(name\)\) delete/) && at(/withheldFromBoard\(name\)\) delete/) < at(/spawn\(CLAUDE_BIN, safeArgs/),
    "the credentials are removed before they are set, or after the spawn");
  assert.match(src, /deny: \[PERMISSION_DENY, \.\.\.privateMemoryDeny\(boardDeniedPaths\(\)\)\]/, "the board run no longer denies the memory paths");
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
  assert.match(src, /\.\.\.permissionArgs\(opts\.noBufferContext \? "board" : "session"\)/, "the board run no longer takes the board branch");
  const fn = /function permissionArgs[\s\S]*?\n}/.exec(src)[0];
  const board = fn.indexOf('kind === "board"'), bypass = fn.indexOf('PERMISSION_MODE === "bypass"');
  assert.ok(board > -1 && board < bypass, "the board branch must come before the bypass branch");
  assert.match(src, /const BOARD_TOOLS = process\.env\.BOT_BOARD_TOOLS \|\| "Read,Glob,Grep";/);
  const args = boardArgs({ tools: "Read,Glob,Grep", allow: "", deny: ["Read(//state/buffer.txt)"] });
  assert.deepStrictEqual(args, ["--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--setting-sources", "", "--disallowedTools", "Read(//state/buffer.txt)"]);
  // Second pass on f2a7466: an approval in any settings file — the bot's, the
  // repo's, the user's — was honored by dontAsk. None is read; CLAUDE.md still is.
  assert.deepStrictEqual(boardArgs({ tools: "Read", cwd: "/repo" }).slice(4), ["--setting-sources", "", "--add-dir", "/repo"]);
  assert.match(src, /boardArgs\(\{ tools: BOARD_TOOLS, allow: BOARD_PERMISSION_ALLOW, cwd: CLAUDE_CWD,/);
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
  assert.match(src, /\.\.\.settingsArgs\(\{ board: Boolean\(opts\.noBufferContext\) \}\)/, "the board run no longer gets the sandbox");
  assert.match(src, /boardSettings\(base, boardDeniedPaths\(\), CLAUDE_CWD\)/);
  // Second pass on 3c32d35: a relative BOT_SETTINGS read from the harness folder
  // failed every board run while Discord sessions, run in CLAUDE_CWD, found it.
  assert.match(src, /readFileSync\(resolve\(CLAUDE_CWD, SESSION_SETTINGS\), "utf8"\)/, "a relative settings file is read from the wrong folder");
});

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
