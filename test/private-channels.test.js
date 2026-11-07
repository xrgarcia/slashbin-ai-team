/**
 * Private channels (lib/private-channels.js): what one channel says, uploads or
 * schedules is given to that channel's runs and to no other's.
 */
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } = require("fs");
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
  mkdirSync(join(state, "channels", "111"), { recursive: true });
  writeFileSync(join(state, "channels", "111", "schedules.json"), JSON.stringify([
    { id: "mine", channel: "111" },
    { id: "planted", channel: "222" },
  ]));
  const { jobs, dropped } = pc.loadChannelSchedules(state);
  assert.deepStrictEqual(jobs.map((j) => j.id), ["mine"]);
  assert.deepStrictEqual(dropped.map((d) => d.id), ["planted"]);
});

check("saving writes each job to its own channel, and empties a channel left with none", () => {
  const state = tmp();
  mkdirSync(join(state, "channels", "333"), { recursive: true });
  writeFileSync(join(state, "channels", "333", "schedules.json"), JSON.stringify([{ id: "gone", channel: "333" }]));
  pc.saveChannelSchedules(state, [{ id: "a", channel: "111" }, { id: "b", channel: "222" }]);
  const read = (k) => JSON.parse(readFileSync(join(state, "channels", k, "schedules.json"), "utf8")).map((j) => j.id);
  assert.deepStrictEqual(read("111"), ["a"]);
  assert.deepStrictEqual(read("222"), ["b"]);
  assert.deepStrictEqual(read("333"), []);
});

check("the bot loads and saves through the per-channel files in private mode", () => {
  assert.ok(/if \(PRIVATE_CHANNELS\) \{\s*const \{ jobs, dropped \} = privateChannels\.loadChannelSchedules\(STATE_DIR\)/.test(bot));
  assert.ok(/if \(PRIVATE_CHANNELS\) return privateChannels\.saveChannelSchedules\(STATE_DIR, schedules\)/.test(bot));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
