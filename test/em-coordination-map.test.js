/**
 * docs/em-coordination.md is the coordinator's map of what the bots
 * handle by themselves. It is hand-written, so this test holds it to the source:
 * every surface, reserved command, card status, hand-off word, escalation label and
 * scheduler kind in code must be named in it (in backticks), or the coordinator meets
 * a state its map does not cover.
 *
 * Most of what a bot does is prompt in its own repo, so only what exists in code is
 * pinned. bot.js cannot be require()d (importing it logs a bot into Discord), so its
 * enumerations are read from source text.
 */
const assert = require("assert");
const { readFileSync, existsSync } = require("fs");
const { join } = require("path");

const ROOT = join(__dirname, "..");
const map = readFileSync(join(ROOT, "docs", "em-coordination.md"), "utf8");
const BOT = readFileSync(join(ROOT, "bot.js"), "utf8");
const SCHEDULE = readFileSync(join(ROOT, "skill-pack", "bin", "schedule.mjs"), "utf8");

const { SURFACE_NAMES } = require("../lib/surfaces");
const { CARD_STATUSES, ESCALATION_LABELS, OUTCOME_MARK, REVIEW_ROUNDS } = require("../lib/paperclip");
const { ASK_OPERATION } = require("../lib/owner-asks");
const { isWakeJob } = require("../lib/wake");
const { isNothingToReport } = require("../lib/nothing-to-report");
const { DEFAULT_CONTEXT_MAX_BYTES } = require("../lib/argv-budget");

const named = (n) => map.includes("`" + n + "`");
const missing = (names) => [...names].filter((n) => !named(n));
let n = 0;
function check(what, fn) {
  fn();
  n++;
  console.log(`  ok  ${what}`);
}

// Hand-off words the run's OUTCOME line is read for: the cases in outcomeOf().
const OUTCOME_WORDS = ["blocked", "review", "return", "follow-up", "escalate"];
const outcomeSrc = readFileSync(join(ROOT, "lib", "paperclip.js"), "utf8").match(/function outcomeOf[\s\S]*?\n}\n/)[0];

// Reserved commands: `["fresh", "status", ...STOP_WORDS]` and the stop-word default.
const reservedSrc = /const RESERVED_COMMANDS = \[([^\]]*)\]/.exec(BOT)[1];
const stopDefault = /BOT_STOP_WORDS \|\| "([^"]+)"/.exec(BOT)[1].split(",");
const reserved = [...(reservedSrc.match(/"([a-z]+)"/g) || []).map((s) => s.slice(1, -1)), ...stopDefault];

// Env knobs whose code default the map states as a number.
const envDefault = (name) => {
  const m = new RegExp(`envInt\\("${name}", ([0-9_*\\s]+)[,)]`).exec(BOT) || new RegExp(`${name}, 10\\) \\|\\| ([0-9*\\s]+);`).exec(BOT);
  assert.ok(m, `${name}: default not found in bot.js`);
  return Function(`return ${m[1].replace(/_/g, "")}`)();
};

check("every surface is named", () => assert.deepStrictEqual(missing(SURFACE_NAMES), []));
check("every card status is named", () => assert.deepStrictEqual(missing(CARD_STATUSES), []));
check("every escalation label is named", () => assert.deepStrictEqual(missing(ESCALATION_LABELS), []));
check("every hand-off word is still read by outcomeOf and named", () => {
  for (const w of OUTCOME_WORDS) assert.ok(new RegExp(`"${w.replace("-", "[-_]?")}"|follow\\[-_\\]\\?up`, "i").test(outcomeSrc), `outcomeOf no longer reads ${w}`);
  assert.deepStrictEqual(missing(OUTCOME_WORDS), []);
  assert.ok(named(OUTCOME_MARK), "OUTCOME_MARK not named");
});
check("every reserved command is named", () => {
  assert.ok(reserved.length >= 6, `read ${reserved}`);
  assert.deepStrictEqual(missing(reserved.map((c) => (c === "fresh" || c === "status" ? "/" + c : c))), []);
});
check("the owner-ask operation is named", () => assert.ok(named(ASK_OPERATION)));
check("scheduler kinds are named: cron, wake (runAt), the schedule CLI", () => {
  assert.ok(isWakeJob({ runAt: "2026-01-01T00:00:00Z" }) && !isWakeJob({ cron: "* * * * *" }));
  assert.deepStrictEqual(missing(["runAt", "schedules.json", "isNothingToReport", "Speaking unprompted"]), []);
  assert.ok(isNothingToReport("none"));
  assert.ok(/--- Speaking unprompted ---/.test(BOT), "the always-appended block is gone from bot.js");
  assert.ok(/cmd === "add"/.test(SCHEDULE) && /cmd === "wake"/.test(SCHEDULE), "schedule CLI lost add or wake");
});
check("the limits the map states match the code defaults", () => {
  const facts = [
    ["session 30 min", /SESSION_TIMEOUT_MS, 10\) \|\| 30 \* 60 \* 1000;/.test(BOT) ? 1800000 : -1, "`SESSION_TIMEOUT_MS` (30 min)"],
    ["concurrency", /MAX_CONCURRENT_CLAUDE, 10\) \|\| 2;/.test(BOT) ? 2 : -1, "`MAX_CONCURRENT_CLAUDE` (2 per process)"],
    ["schedule tick", envDefault("BOT_SCHEDULE_CHECK_MS"), "`BOT_SCHEDULE_CHECK_MS` (60 s)"],
    ["lookback", envDefault("BOT_SCHEDULE_LOOKBACK_MINUTES"), "`BOT_SCHEDULE_LOOKBACK_MINUTES` (5)"],
    ["poll", envDefault("PAPERCLIP_POLL_MS"), "`PAPERCLIP_POLL_MS` 15 s"],
    ["reconcile", envDefault("PAPERCLIP_RECONCILE_MS"), "`PAPERCLIP_RECONCILE_MS` 60 s"],
    ["stall", envDefault("PAPERCLIP_STALL_MINUTES"), "`PAPERCLIP_STALL_MINUTES` (15)"],
    ["rotate", envDefault("BUFFER_ROTATE_PERCENT"), "`BUFFER_ROTATE_PERCENT` (40%)"],
  ];
  const expect = { "session 30 min": 1800000, concurrency: 2, "schedule tick": 60000, lookback: 5, poll: 15000, reconcile: 60000, stall: 15, rotate: 40 };
  for (const [k, v, text] of facts) {
    assert.strictEqual(v, expect[k], `${k}: code default is ${v}`);
    assert.ok(map.includes(text), `map must say ${text}`);
  }
  assert.ok(/BUFFER_MAX_BYTES, 10\) \|\| 32 \* 1024/.test(BOT) && map.includes("`BUFFER_MAX_BYTES` (32 KB)"));
  assert.strictEqual(DEFAULT_CONTEXT_MAX_BYTES, 64 * 1024);
  assert.ok(map.includes("`CONTEXT_MAX_BYTES` (64 KB)"));
  assert.ok(map.includes(`\`REVIEW_ROUNDS\` (${REVIEW_ROUNDS})`), "REVIEW_ROUNDS value");
  assert.ok(/const MAX_WAKE_ATTEMPTS[\s\S]{0,200}: 12;/.test(SCHEDULE) && map.includes("`BOT_MAX_WAKE_ATTEMPTS` (12)"));
});

console.log(`em-coordination-map: ${n} checks passed`);
