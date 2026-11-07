/**
 * Channel groups (BOT_CHANNEL_GROUPS, lib/private-channels.js channelGroups):
 * named channels share one memory scope. A summary written in one channel of a
 * group is in every channel of the group's view and in no other scope's.
 *
 * Everything runs against one temporary state directory, removed at the end and
 * asserted gone. The refusals also run the real bot.js, which exits before it
 * logs in to Discord when its configuration is refused.
 */
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } = require("fs");
const { join } = require("path");
const os = require("os");
const assert = require("assert");
const { spawnSync } = require("child_process");
const pc = require("../lib/private-channels");
const { confineCommand } = require("../lib/confine");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed++; } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`); failed++;
  }
}

const REPO = join(__dirname, "..");
const bot = readFileSync(join(REPO, "bot.js"), "utf8");
const root = mkdtempSync(join(os.tmpdir(), "channel-groups-"));
const state = join(root, "state"), hist = join(root, "history");
mkdirSync(state, { recursive: true });
mkdirSync(hist, { recursive: true });

// Hank's two channels (H1, H2) share a group; P1 and P2 share another; SOLO is in none.
const raw = JSON.stringify({ hank: ["H1", "H2"], "po-team": ["P1", "P2"] });
const groups = pc.channelGroups(raw, { enabled: true });
const view = (channel, sessions = {}, jobHistoryFile = join(root, "none")) =>
  pc.writeView({ stateDir: state, key: groups.scopeOf(channel), historyDir: hist, sessions, jobHistoryFile, groups });
const summaryNames = (p) => readdirSync(p.summaries).sort();

console.log("\nChannel groups — resolving a channel to its scope");

check("a group's scope key is group_<name>; a channel in no group is its own scope", () => {
  assert.deepStrictEqual(groups.problems, []);
  assert.strictEqual(groups.scopeOf("H1"), "group_hank");
  assert.strictEqual(groups.scopeOf("H2"), "group_hank");
  assert.strictEqual(groups.scopeOf("P1"), "group_po-team");
  assert.strictEqual(groups.scopeOf("SOLO"), "SOLO");
  assert.strictEqual(groups.scopeOf(123), "123");
  assert.deepStrictEqual(groups.members("group_hank"), ["H1", "H2"]);
  assert.deepStrictEqual(groups.members("SOLO"), ["SOLO"]);
  assert.strictEqual(groups.groupOf("H2"), "hank");
  assert.strictEqual(groups.groupOf("SOLO"), null);
});

check("BOT_CHANNEL_GROUPS unset or empty: every channel is its own scope, no problems", () => {
  for (const unset of [undefined, "", "  "]) {
    const g = pc.channelGroups(unset, { enabled: false });
    assert.deepStrictEqual(g.problems, []);
    assert.strictEqual(g.scopeOf("H1"), "H1");
    assert.deepStrictEqual(g.members("H1"), ["H1"]);
  }
});

check("a bare group name cannot collide with board or a snowflake: the key is always prefixed", () => {
  const g = pc.channelGroups(JSON.stringify({ board: ["1"], "123456789": ["2"] }), { enabled: true });
  assert.deepStrictEqual(g.problems, []);
  assert.strictEqual(g.scopeOf("1"), "group_board");
  assert.strictEqual(g.scopeOf("2"), "group_123456789");
});

console.log("\nChannel groups — one memory for the group, none for anyone else");

check("a summary stamped with the group is in each group channel's view, and in no other scope's", () => {
  writeFileSync(join(hist, "2026-11-07-h1.md"), "<!-- channel: group_hank -->\nHank talk from H1");
  writeFileSync(join(hist, "2026-11-07-p1.md"), "<!-- channel: group_po-team -->\nPO talk");
  writeFileSync(join(hist, "2026-11-07-solo.md"), "<!-- channel: SOLO -->\nSolo talk");
  writeFileSync(join(hist, "2026-11-07-old.md"), "no stamp");
  assert.deepStrictEqual(summaryNames(view("H1")), ["2026-11-07-h1.md"]);
  assert.deepStrictEqual(summaryNames(view("H2")), ["2026-11-07-h1.md"], "group channel B did not get channel A's summary");
  assert.deepStrictEqual(summaryNames(view("SOLO")), ["2026-11-07-solo.md"], "a channel in no group got the group's summary");
  assert.deepStrictEqual(summaryNames(view("P2")), ["2026-11-07-p1.md"], "another group got Hank's summary");
});

check("a joining channel's past private summaries stay unpublished: a raw-id stamp is not the group's", () => {
  writeFileSync(join(hist, "2026-11-06-h2-before-joining.md"), "<!-- channel: H2 -->\nsaid before the group existed");
  assert.ok(!summaryNames(view("H1")).includes("2026-11-06-h2-before-joining.md"));
  assert.ok(!summaryNames(view("H2")).includes("2026-11-06-h2-before-joining.md"));
});

check("the group's context is read through channelSummaries by scope", () => {
  const contents = ["<!-- channel: group_hank -->\na", "<!-- channel: H1 -->\nb", "<!-- channel: SOLO -->\nc", "d"];
  assert.deepStrictEqual(pc.channelSummaries(contents, groups.scopeOf("H2")), [contents[0]]);
  assert.deepStrictEqual(pc.channelSummaries(contents, groups.scopeOf("SOLO")), [contents[2]]);
});

check("two group channels append to one buffer.txt; another scope's buffer is separate", () => {
  const bufferOf = (ch) => pc.channelPaths(state, groups.scopeOf(ch)).buffer;
  assert.strictEqual(bufferOf("H1"), bufferOf("H2"));
  pc.appendOwn(bufferOf("H1"), "[#h1] ray: one\n");
  pc.appendOwn(bufferOf("H2"), "[#h2] doug: two\n");
  assert.strictEqual(pc.readOwn(bufferOf("H2")), "[#h1] ray: one\n[#h2] doug: two\n");
  assert.notStrictEqual(bufferOf("SOLO"), bufferOf("H1"));
  assert.strictEqual(pc.readOwn(bufferOf("SOLO")), "");
  assert.strictEqual(existsSync(join(state, "channels", "H1")), false, "a member got a folder of its own");
});

check("sessions stay keyed by real channel id: a group's view holds every member's, no one else's", () => {
  const sessions = { H1: { sessionId: "s-h1" }, H2: { sessionId: "s-h2" }, SOLO: { sessionId: "s-solo" }, P1: { sessionId: "s-p1" } };
  const p = view("H1", sessions);
  assert.deepStrictEqual(JSON.parse(readFileSync(p.sessions, "utf8")), { H1: { sessionId: "s-h1" }, H2: { sessionId: "s-h2" } });
  assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(view("SOLO", sessions).sessions, "utf8"))), ["SOLO"]);
});

check("job history: a group's view keeps rows whose channel is in the group", () => {
  const jh = join(root, "job-history.jsonl");
  writeFileSync(jh, ["H1", "H2", "SOLO", "P1"].map((c) => JSON.stringify({ id: `row-${c}`, channel: c })).join("\n") + "\nnot json\n");
  const ids = (p) => readFileSync(p.jobHistory, "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
  assert.deepStrictEqual(ids(view("H2", {}, jh)), ["row-H1", "row-H2"]);
  assert.deepStrictEqual(ids(view("SOLO", {}, jh)), ["row-SOLO"]);
});

console.log("\nChannel groups — schedules");

check("a job lives in its scope's folder and keeps job.channel as its posting channel", () => {
  const st = join(root, "sched");
  pc.saveChannelSchedules(st, [{ id: "a", channel: "H1" }, { id: "b", channel: "H2" }, { id: "c", channel: "SOLO" }], groups.scopeOf);
  const read = (k) => JSON.parse(readFileSync(join(st, "channels", k, "jobs", "schedules.json"), "utf8"));
  assert.deepStrictEqual(read("group_hank").map((j) => `${j.id}:${j.channel}`), ["a:H1", "b:H2"]);
  assert.deepStrictEqual(read("SOLO").map((j) => j.id), ["c"]);
  const { jobs, dropped } = pc.loadChannelSchedules(st, groups.scopeOf);
  assert.deepStrictEqual(jobs.map((j) => j.id).sort(), ["a", "b", "c"]);
  assert.deepStrictEqual(dropped, []);
});

check("a job naming a channel outside the scope is still dropped", () => {
  const st = join(root, "sched2");
  mkdirSync(join(st, "channels", "group_hank", "jobs"), { recursive: true });
  writeFileSync(join(st, "channels", "group_hank", "jobs", "schedules.json"), JSON.stringify([
    { id: "member", channel: "H2" }, { id: "planted-solo", channel: "SOLO" }, { id: "planted-other-group", channel: "P1" },
  ]));
  const { jobs, dropped } = pc.loadChannelSchedules(st, groups.scopeOf);
  assert.deepStrictEqual(jobs.map((j) => j.id), ["member"]);
  assert.deepStrictEqual(dropped.map((d) => d.id).sort(), ["planted-other-group", "planted-solo"]);
});

check("saving never erases a pre-group file: it stays byte for byte and loads again once groups are off", () => {
  const st = join(root, "sched3");
  const f = join(st, "channels", "111", "jobs", "schedules.json");
  mkdirSync(join(st, "channels", "111", "jobs"), { recursive: true });
  mkdirSync(join(st, "channels", "444", "jobs"), { recursive: true });
  const before = JSON.stringify([{ id: "pre-group", channel: "111" }], null, 2) + "\n";
  writeFileSync(f, before);
  writeFileSync(join(st, "channels", "444", "jobs", "schedules.json"), JSON.stringify([{ id: "gone", channel: "444" }]));
  // 111 is now in a group; a save for an unrelated ungrouped channel 333 follows.
  pc.saveChannelSchedules(st, [{ id: "other", channel: "333" }], pc.channelGroups('{"hank":["111","222"]}', { enabled: true }).scopeOf);
  assert.strictEqual(readFileSync(f, "utf8"), before, "the pre-group file was rewritten");
  assert.deepStrictEqual(JSON.parse(readFileSync(join(st, "channels", "444", "jobs", "schedules.json"), "utf8")), [], "a live scope left with no jobs was not emptied");
  assert.deepStrictEqual(pc.loadChannelSchedules(st).jobs.map((j) => j.id).sort(), ["other", "pre-group"], "groups off: the pre-group job did not come back");
});

check("membership is built linearly: a repeat inside a group appears once, two groups still refused", () => {
  assert.deepStrictEqual(pc.channelGroups('{"a":["1","1","2"]}', { enabled: true }).members("group_a"), ["1", "2"]);
  assert.ok(pc.channelGroups('{"a":["1"],"b":["1"]}', { enabled: true }).problems.length === 1);
  const ids = Array.from({ length: 50000 }, (_, i) => String(i));
  const t0 = Date.now();
  assert.strictEqual(pc.channelGroups(JSON.stringify({ big: ids }), { enabled: true }).members("group_big").length, 50000);
  assert.ok(Date.now() - t0 < 2000, "building a large group is not linear");
});

console.log("\nChannel groups — confinement binds only the group's folder");

check("a group channel's run is handed its group's folder and no other scope's", () => {
  const cwd = join(root, "repo");
  const own = view("H1"), other = view("SOLO"), otherGroup = view("P1");
  mkdirSync(cwd, { recursive: true });
  // The memory a run is given is memoryFor(memoryScope(channel)); built the same way here.
  const memory = (ch) => { const p = pc.channelPaths(state, groups.scopeOf(ch)); return { read: [p.dir], write: [p.jobs], home: p.home }; };
  const m = memory("H2");
  assert.strictEqual(m.read[0], own.dir, "H2's run is not bound to the group's folder");
  const c = confineCommand({ bin: "/bin/sh", args: ["-c", "true"], cwd, home: m.home, read: m.read, write: m.write, hostHome: join(root, "realhome") });
  const bound = c.args.join("\n");
  assert.ok(bound.includes(own.dir), "the group's folder is not bound");
  for (const d of [other.dir, otherGroup.dir]) assert.ok(!bound.includes(d), `bound another scope's folder ${d}`);
});

check("the bot routes every channel-to-scope site through memoryScope", () => {
  assert.ok(/function memoryScope\(channelId, opts = \{\}\) \{\s*return opts\.noBufferContext \? "board" : CHANNEL_GROUPS\.scopeOf\(channelId\);/.test(bot));
  assert.ok(!/memoryFor\(String\(/.test(bot), "a site still turns a channel id into a scope itself");
  assert.ok(/memoryFor\(memoryScope\(channelId\)\)\.buffer/.test(bot));
  assert.ok(/channelSummaries\(loadRecentSummaries\(\), memoryScope\(channelId\)\)/.test(bot));
  assert.ok(/const owner = file === BUFFER_FILE \? null : memoryScope\(channelId\)/.test(bot));
  assert.ok(/writeSummary\(channelName, date, dayMessages\.length, summary, memoryScope\(channelId\)\)/.test(bot));
  assert.ok(/groups: CHANNEL_GROUPS/.test(bot));
  assert.ok(/\.\.\.CHANNEL_GROUPS\.problems/.test(bot));
});

check("a group channel's prompt says its memory is shared with the group; the outbox stays per channel", () => {
  assert.ok(/its memory is shared with every channel in group \$\{channelGroup\}/.test(bot));
  assert.ok(/const runOutbox = channelOutbox\(channelId\)/.test(bot));
});

check("the summarizer stamps the scope, not the raw channel id", () => {
  const s = readFileSync(join(REPO, "summarize.js"), "utf8");
  assert.ok(/channelGroups\(process\.env\.BOT_CHANNEL_GROUPS\)/.test(s));
  assert.ok(/channelId \? CHANNEL_GROUPS\.scopeOf\(channelId\) : channelId/.test(s));
});

console.log("\nChannel groups — the four refusals (channelGroups)");

check("unparseable or mis-shaped JSON", () => {
  for (const bad of ["{nope", "[]", '"x"', "null", '{"hank":"H1"}', '{"hank":[1,2]}', '{"hank":[""]}']) {
    assert.ok(pc.channelGroups(bad, { enabled: true }).problems.length >= 1, `accepted ${bad}`);
  }
});

check("a group name that is not ^[a-z0-9][a-z0-9-]*$", () => {
  for (const bad of ["Hank", "-hank", "ha nk", "ha_nk", "../x", ""]) {
    const g = pc.channelGroups(JSON.stringify({ [bad]: ["1"] }), { enabled: true });
    assert.ok(g.problems.some((p) => /group name/.test(p)), `accepted name ${JSON.stringify(bad)}`);
  }
  assert.deepStrictEqual(pc.channelGroups('{"a":["1"],"0-x":["2"]}', { enabled: true }).problems, []);
});

check("a channel listed in two groups", () => {
  const g = pc.channelGroups('{"a":["1","2"],"b":["2"]}', { enabled: true });
  assert.ok(g.problems.some((p) => /channel 2 is listed in two groups/.test(p)));
  assert.deepStrictEqual(pc.channelGroups('{"a":["1","1"]}', { enabled: true }).problems, [], "a repeat within one group is harmless");
});

check("groups set while BOT_PRIVATE_CHANNELS is not true", () => {
  assert.ok(pc.channelGroups('{"a":["1"]}', { enabled: false }).problems.some((p) => /BOT_PRIVATE_CHANNELS=true/.test(p)));
});

console.log("\nChannel groups — each refusal exits EXIT_CONFIG (78) from the real bot");

const runBot = (extra, ms = 20000) => {
  const dir = mkdtempSync(join(root, "bot-"));
  for (const d of ["cwd", "state", "hist", "att"]) mkdirSync(join(dir, d));
  const r = spawnSync(process.execPath, [join(REPO, "bot.js")], {
    cwd: dir, encoding: "utf8", timeout: ms,
    env: { PATH: process.env.PATH, HOME: dir, DISCORD_TOKEN: "not-a-real-token", CLAUDE_CWD: join(dir, "cwd"), BOT_STATE_DIR: join(dir, "state"),
      BOT_HISTORY_DIR: join(dir, "hist"), BOT_ATTACHMENTS_DIR: join(dir, "att"), ...extra },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const priv = { BOT_PRIVATE_CHANNELS: "true", BOT_CONFINE: "true" };
for (const [label, extra, re] of [
  ["unparseable JSON", { ...priv, BOT_CHANNEL_GROUPS: "{nope" }, /BOT_CHANNEL_GROUPS is not valid JSON/],
  ["mis-shaped JSON", { ...priv, BOT_CHANNEL_GROUPS: '{"hank":"H1"}' }, /must be an array of channel ids/],
  ["a bad group name", { ...priv, BOT_CHANNEL_GROUPS: '{"Hank":["1"]}' }, /group name "Hank"/],
  ["a channel in two groups", { ...priv, BOT_CHANNEL_GROUPS: '{"a":["1"],"b":["1"]}' }, /listed in two groups/],
  ["groups without BOT_PRIVATE_CHANNELS=true", { BOT_CHANNEL_GROUPS: '{"a":["1"]}' }, /BOT_CHANNEL_GROUPS needs BOT_PRIVATE_CHANNELS=true/],
]) {
  check(label, () => {
    const r = runBot(extra);
    assert.strictEqual(r.status, 78, r.out);
    assert.ok(re.test(r.out), r.out);
  });
}

rmSync(root, { recursive: true, force: true });
check("the temporary state directory is removed", () => {
  assert.strictEqual(existsSync(root), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
