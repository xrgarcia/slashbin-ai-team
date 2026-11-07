/**
 * Private channels (lib/private-channels.js): what one channel says, uploads or
 * schedules is given to that channel's runs and to no other's.
 */
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, lstatSync } = require("fs");
const { join } = require("path");
const os = require("os");
const assert = require("assert");
const pc = require("../lib/private-channels");
const { within } = require("../lib/confine");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed++; } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`); failed++;
  }
}

const REPO = join(__dirname, "..");
const bot = readFileSync(join(REPO, "bot.js"), "utf8");
const tmp = () => mkdtempSync(join(os.tmpdir(), "private-"));

console.log("\nPrivate channels — each channel's view holds only its own records");

check("summaries: only those stamped with the channel; unstamped ones go to no one", () => {
  const state = tmp(), hist = tmp();
  writeFileSync(join(hist, "2026-11-07-a.md"), "<!-- channel: 111 -->\nA talk");
  writeFileSync(join(hist, "2026-11-07-b.md"), "<!-- channel: 222 -->\nB talk");
  writeFileSync(join(hist, "2026-11-07-old.md"), "no stamp");
  const p = pc.writeView({ stateDir: state, key: "111", historyDir: hist, sessions: {}, jobHistoryFile: join(state, "none") });
  assert.deepStrictEqual(readdirSync(p.summaries), ["2026-11-07-a.md"]);
});

check("a view is rebuilt, so a summary no longer the channel's leaves it", () => {
  const state = tmp(), hist = tmp();
  writeFileSync(join(hist, "x.md"), "<!-- channel: 111 -->");
  pc.writeView({ stateDir: state, key: "111", historyDir: hist, sessions: {}, jobHistoryFile: "/none" });
  writeFileSync(join(hist, "x.md"), "<!-- channel: 222 -->");
  const p = pc.writeView({ stateDir: state, key: "111", historyDir: hist, sessions: {}, jobHistoryFile: "/none" });
  assert.deepStrictEqual(readdirSync(p.summaries), []);
});

check("sessions and job history: the channel's own rows only", () => {
  const state = tmp(), hist = tmp();
  const jh = join(state, "job-history.jsonl");
  writeFileSync(jh, [JSON.stringify({ id: "a", channel: "111" }), JSON.stringify({ id: "b", channel: "222" }), JSON.stringify({ id: "c" }), "garbage"].join("\n") + "\n");
  const p = pc.writeView({ stateDir: state, key: "111", historyDir: hist, sessions: { 111: { sessionId: "s1" }, 222: { sessionId: "s2" } }, jobHistoryFile: jh });
  assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(p.sessions, "utf8"))), ["111"]);
  assert.deepStrictEqual(readFileSync(p.jobHistory, "utf8").trim().split("\n").map((l) => JSON.parse(l).id), ["a"]);
});

check("the job-history row names the channel it ran for", () => {
  assert.ok(/\.\.\.\(job\.channel \? \{ channel: job\.channel \} : \{\}\)/.test(bot));
});

check("a fresh session's context gets only its channel's summaries", () => {
  assert.deepStrictEqual(pc.channelSummaries(["<!-- channel: 1 -->\nx", "<!-- channel: 2 -->\ny", "z"], "1"), ["<!-- channel: 1 -->\nx"]);
});

console.log("\nPrivate channels — schedules");

check("a job is taken only from its own channel's file", () => {
  const state = tmp();
  mkdirSync(join(state, "channels", "111", "jobs"), { recursive: true });
  writeFileSync(join(state, "channels", "111", "jobs", "schedules.json"), JSON.stringify([
    { id: "mine", channel: "111" },
    { id: "planted", channel: "222" },
  ]));
  const { jobs, dropped } = pc.loadChannelSchedules(state);
  assert.deepStrictEqual(jobs.map((j) => j.id), ["mine"]);
  assert.deepStrictEqual(dropped.map((d) => d.id), ["planted"]);
});

check("saving writes each job to its own channel, and empties a channel left with none", () => {
  const state = tmp();
  mkdirSync(join(state, "channels", "333", "jobs"), { recursive: true });
  writeFileSync(join(state, "channels", "333", "jobs", "schedules.json"), JSON.stringify([{ id: "gone", channel: "333" }]));
  pc.saveChannelSchedules(state, [{ id: "a", channel: "111" }, { id: "b", channel: "222" }]);
  const read = (k) => JSON.parse(readFileSync(join(state, "channels", k, "jobs", "schedules.json"), "utf8")).map((j) => j.id);
  assert.deepStrictEqual(read("111"), ["a"]);
  assert.deepStrictEqual(read("222"), ["b"]);
  assert.deepStrictEqual(read("333"), []);
});

check("the bot loads and saves through the per-channel files in private mode", () => {
  assert.ok(/if \(PRIVATE_CHANNELS\) \{\s*const \{ jobs, dropped, problems \} = privateChannels\.loadChannelSchedules\(STATE_DIR\)/.test(bot));
  assert.ok(/if \(PRIVATE_CHANNELS\) return privateChannels\.saveChannelSchedules\(STATE_DIR, schedules\)/.test(bot));
});

check("a schedule file that is a link is not read through", () => {
  const state = tmp(), outside = tmp();
  writeFileSync(join(outside, "x.json"), JSON.stringify([{ id: "via-link", channel: "111" }]));
  mkdirSync(join(state, "channels", "111", "jobs"), { recursive: true });
  symlinkSync(join(outside, "x.json"), join(state, "channels", "111", "jobs", "schedules.json"));
  const { jobs, problems } = pc.loadChannelSchedules(state);
  assert.deepStrictEqual(jobs, []);
  assert.strictEqual(problems.length, 1);
});

check("saving replaces a planted link instead of writing through it", () => {
  const state = tmp(), outside = tmp();
  const target = join(outside, "victim");
  writeFileSync(target, "UNTOUCHED");
  mkdirSync(join(state, "channels", "111", "jobs"), { recursive: true });
  const f = join(state, "channels", "111", "jobs", "schedules.json");
  symlinkSync(target, f);
  pc.saveChannelSchedules(state, [{ id: "a", channel: "111" }]);
  assert.strictEqual(readFileSync(target, "utf8"), "UNTOUCHED");
  assert.ok(!lstatSync(f).isSymbolicLink());
});

check("a view is refused when a channel folder the bot writes has become a link", () => {
  const state = tmp(), hist = tmp(), outside = tmp();
  mkdirSync(join(state, "channels", "111"), { recursive: true });
  symlinkSync(outside, join(state, "channels", "111", "home"));
  assert.throws(() => pc.writeView({ stateDir: state, key: "111", historyDir: hist, sessions: {}, jobHistoryFile: "/none" }), /not a plain folder/);
});

check("a run may write only its jobs folder; the rest of its channel it reads", () => {
  assert.ok(/read: \[p\.dir\], write: \[p\.jobs\] \}/.test(bot));
});

check("a job is matched by id AND channel when removed, stamped or claimed", () => {
  assert.ok(/const sameJob = \(a, b\) => a\.id === b\.id && String\(a\.channel \?\? ""\) === String\(b\.channel \?\? ""\)/.test(bot));
  for (const f of ["removeScheduledJob", "stampLastRun", "claimWakeJob"]) {
    const body = new RegExp(`function ${f}\\([\\s\\S]*?\\n}`).exec(bot)[0];
    assert.ok(/sameJob\(/.test(body) && !/\.id === /.test(body), `${f} still matches by id alone`);
  }
  assert.ok(!/(removeScheduledJob|stampLastRun|claimWakeJob)\(job\.id/.test(bot));
});

console.log("\nPrivate channels — what a run is handed");

check("a private bot's runs never get its Discord login or bridge token", () => {
  const { buildRunEnv } = require("../lib/permission-mode");
  const vars = { PATH: "/usr/bin", HOME: "/h", DISCORD_TOKEN: "discord-secret-value-123456", BRIDGE_TOKEN: "bridge-secret-value-123456" };
  const base = { env: vars, runtime: "claude", mode: "restricted", run: "session" };
  const handed = (built) => JSON.stringify(built.env);
  assert.ok(/discord-secret/.test(handed(buildRunEnv(base))), "control: an internal bot's session run keeps it");
  assert.ok(!/discord-secret|bridge-secret/.test(handed(buildRunEnv({ ...base, withholdDiscord: true }))), "a private run was handed a Discord credential");
  assert.ok(/withholdDiscord: PRIVATE_CHANNELS/.test(bot));
});

check("a private bot's bridge opens only with a token, and a handshake must carry it", () => {
  assert.ok(/const wss = BRIDGE_NEEDS_TOKEN && !BRIDGE_TOKEN \? null/.test(bot));
  assert.ok(/if \(BRIDGE_NEEDS_TOKEN && !bridgeTokenMatches\(msg\.token, BRIDGE_TOKEN\)\)/.test(bot));
});

check("a restricted run may read its own channel's uploads", () => {
  assert.ok(/\.\.\.permissionArgs\(runKind, memory\.attachments\)/.test(bot));
  assert.ok(/readDirs: \[memory\.attachments\]/.test(bot));
});

console.log("\nPrivate channels — refused unless the guarantee holds");

const base = { enabled: true, confined: true, cwd: "/srv/repo", historyDir: "/data/bot/history", stateDir: "/data/bot", attachmentsDir: "/data/bot/att", within };

check("a private bot that is not confined does not start", () => {
  assert.ok(pc.privateProblems({ ...base, confined: false }).some((p) => /BOT_CONFINE=true/.test(p)));
});

check("records inside the working directory are refused: every run sees it whole", () => {
  assert.ok(pc.privateProblems({ ...base, historyDir: "/srv/repo/bot-history" }).some((p) => /BOT_HISTORY_DIR/.test(p)));
  assert.ok(pc.privateProblems({ ...base, cwd: "/data/bot/work" }).some((p) => /BOT_STATE_DIR/.test(p)));
});

check("a sound configuration passes, and off is always clean", () => {
  assert.deepStrictEqual(pc.privateProblems(base), []);
  assert.deepStrictEqual(pc.privateProblems({ ...base, enabled: false, confined: false }), []);
});

check("folder names cannot climb out of channels/", () => {
  assert.strictEqual(pc.scopeName("../../etc"), "______etc");
  assert.ok(!pc.channelPaths("/s", "../x").dir.includes(".."));
});

console.log("\nPrivate channels — no config a run is handed carries the Discord login");

{
  const { discordCredential, MIN_CREDENTIAL_CHARS } = require("../lib/permission-mode");
  const vars = { DISCORD_TOKEN: "abc.def.SECRETVALUE", OTHER: "abc.def.SECRETVALUE2" };
  const probe = (text) => pc.configCredentialProblems([{ name: "mcp.json", text }], vars, discordCredential, MIN_CREDENTIAL_CHARS);

  check("a config that names a Discord credential is refused", () => {
    assert.strictEqual(probe('{"mcpServers":{"x":{"env":{"PO_DISCORD_TOKEN":"${PO_DISCORD_TOKEN}"}}}}').length, 1);
  });
  check("a config that holds the login's value under any name is refused", () => {
    assert.strictEqual(probe('{"mcpServers":{"x":{"env":{"T":"abc.def.SECRETVALUE"}}}}').length, 1);
  });
  check("an escaped name or value is decoded before it is judged", () => {
    assert.strictEqual(probe('{"env":{"DISCORD_\\u0054OKEN":"x"}}').length, 1);
    assert.strictEqual(probe('{"env":{"DISCORD\\u005fTOKEN":"x"}}').length, 1);
    assert.strictEqual(probe('{"env":{"T":"\\u0061bc.def.SECRETVALUE"}}').length, 1);
  });
  check("a bridge login whose value needs escaping is found under any alias", () => {
    const tok = 'bridge-"secret-value';
    const text = JSON.stringify({ mcpServers: { x: { command: "node", env: { AUTH: tok } } } });
    assert.strictEqual(pc.configCredentialProblems([{ name: "mcp", text }], { BRIDGE_TOKEN: tok }, discordCredential, MIN_CREDENTIAL_CHARS).length, 1);
  });
  check("the refusal never repeats what it found: the match may be the secret", () => {
    const tok = "bridge_secret_7f928a6b3d0c41e5";
    const text = '{"mcpServers":{"x":{"env":{"AUTH":"\\u0062' + tok.slice(1) + '"}}}}';
    const out = pc.configCredentialProblems([{ name: "mcp", text }], { BRIDGE_TOKEN: tok }, discordCredential, MIN_CREDENTIAL_CHARS);
    assert.strictEqual(out.length, 1);
    assert.ok(!out[0].includes(tok) && !out[0].includes(tok.slice(1)), out[0]);
  });
  check("a config that is not JSON is refused: it cannot be checked", () => {
    assert.strictEqual(probe("not json {").length, 1);
  });
  check("a clean config passes", () => {
    assert.deepStrictEqual(probe('{"mcpServers":{"x":{"command":"node"}}}'), []);
  });
  check("the bot checks every config at startup in private mode", () => {
    assert.ok(/privateChannels\.configCredentialProblems\(configSources\(\), process\.env, discordCredential, MIN_CREDENTIAL_CHARS\)/.test(bot));
    assert.ok(/join\(CLAUDE_CWD, "\.mcp\.json"\)/.test(bot));
  });
}

console.log("\nPrivate channels — the bot's own files are never used through a link");

check("a buffer linked to another channel's is left untouched; reading it gives nothing", () => {
  const state = tmp();
  const a = pc.channelPaths(state, "A"), b = pc.channelPaths(state, "B");
  mkdirSync(a.dir, { recursive: true }); mkdirSync(b.dir, { recursive: true });
  writeFileSync(b.buffer, "B-PRIVATE\n");
  symlinkSync(b.buffer, a.buffer);
  assert.strictEqual(pc.readOwn(a.buffer), "");
  assert.strictEqual(pc.sizeOwn(a.buffer), 0);
  pc.appendOwn(a.buffer, "from A\n");
  assert.strictEqual(readFileSync(b.buffer, "utf8"), "B-PRIVATE\n");
  assert.ok(lstatSync(a.buffer).isFile(), "the link was not replaced");
  pc.writeOwn(a.buffer, "kept\n");
  assert.strictEqual(readFileSync(b.buffer, "utf8"), "B-PRIVATE\n");
});

check("a view folder that has become a link is refused", () => {
  const state = tmp(), elsewhere = tmp();
  const p = pc.channelPaths(state, "A");
  mkdirSync(p.dir, { recursive: true });
  symlinkSync(elsewhere, p.view);
  assert.throws(() => pc.writeView({ stateDir: state, key: "A", historyDir: tmp(), sessions: {}, jobHistoryFile: join(state, "none") }), /not a plain folder/);
});

check("the bot's buffer functions go through the link-safe helpers", () => {
  assert.ok(/privateChannels\.appendOwn\(file/.test(bot));
  assert.ok(/privateChannels\.readOwn\(file\)/.test(bot));
  assert.ok(/privateChannels\.sizeOwn\(file\)/.test(bot));
  assert.ok(/privateChannels\.writeOwn\(file, keepLines/.test(bot));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
