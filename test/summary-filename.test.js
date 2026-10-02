/**
 * loadRecentSummaries() must admit summaries and nothing else.
 *
 * The lookback window is a LEXICAL compare against a `YYYY-MM-DD` string. That
 * is a date compare only for filenames that begin with a date — every letter
 * sorts after every digit, so any `.md` starting with a letter reads as newer
 * than today and was admitted unconditionally, at whatever size it happened to
 * be. On 2026-06-19 two pasted docs (64KB and 51KB) landed in `bot-history/`
 * and took the EM bot fully offline with `spawn E2BIG` (EM #207).
 *
 * lib/argv-budget.js has since made the crash unreachable, which is precisely
 * why this filter still matters and matters MORE: the intruder sorts last, so
 * the budget keeps it and drops the real summaries — genuinely older — instead.
 * The bot stays up and silently forgets everything it was supposed to remember,
 * which is the harder failure to notice and the harder one to diagnose.
 *
 * So this asserts the reader's filter is shape-based, not just lexical, and
 * that the writer's own filenames still satisfy it — a reader that rejects what
 * summarize.js writes is the same bug pointed the other way.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const REPO = join(__dirname, "..");
const BOT_SRC = readFileSync(join(REPO, "bot.js"), "utf8");
const SUMMARIZE_SRC = readFileSync(join(REPO, "lib/summarize-core.js"), "utf8");

/**
 * Rebuild the reader's admission test from bot.js source. The file cannot be
 * require()d — importing it logs a live bot into Discord — so the predicate is
 * lifted out of the source the same way history-dir.test.js lifts HISTORY_DIR.
 */
function extractAdmissionTest() {
  const declStart = BOT_SRC.indexOf("const SUMMARY_FILENAME =");
  assert.ok(
    declStart > -1,
    "SUMMARY_FILENAME is not declared in bot.js — the shape filter was removed, " +
      "and the lookback window is a lexical compare again",
  );
  const decl = BOT_SRC.slice(declStart, BOT_SRC.indexOf(";", declStart) + 1);

  const predicate = '(f) => f.endsWith(".md") && SUMMARY_FILENAME.test(f)';
  assert.ok(
    BOT_SRC.includes(`.filter(${predicate})`),
    "loadRecentSummaries() no longer filters on the summary filename shape",
  );

  return new Function(`${decl} return ${predicate};`)();
}

const admits = extractAdmissionTest();

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

console.log("\nloadRecentSummaries() admits summaries and nothing else");

check("a real summary is admitted", () => {
  assert.strictEqual(admits("2026-09-07-engineering.md"), true);
  assert.strictEqual(admits("2026-09-07-buffer-rotation.md"), true);
});

check("the collision form summarize-core falls back to is admitted", () => {
  assert.strictEqual(admits("2026-09-07-engineering-1408234172837.md"), true);
});

check("the 2026-06-19 outage files are rejected", () => {
  assert.strictEqual(admits("jerky-spapi-resubmission-v3-FULL.md"), false);
  assert.strictEqual(admits("jerky-spapi-resubmission-v4-FULL.md"), false);
});

check("a letter-leading name sorts newer than any date — reject on shape, not order", () => {
  const intruder = "notes.md";
  // The bug in one line: the window would have kept this over every summary.
  assert.ok(intruder > "2026-09-07", "premise changed — this name no longer sorts last");
  assert.strictEqual(admits(intruder), false);
});

check("a near-miss date shape is rejected", () => {
  assert.strictEqual(admits("2026-9-7-engineering.md"), false, "single-digit month/day");
  assert.strictEqual(admits("26-09-07-engineering.md"), false, "two-digit year");
  assert.strictEqual(admits("draft-2026-09-07-engineering.md"), false, "date not at the start");
});

check("a dotfile is rejected without needing its own clause", () => {
  assert.strictEqual(admits(".2026-09-07-engineering.md"), false);
  assert.strictEqual(admits(".DS_Store"), false);
});

check("a non-.md file is rejected even with a date prefix", () => {
  assert.strictEqual(admits("2026-09-07-engineering.txt"), false);
  assert.strictEqual(admits("2026-09-07-checkpoint.json"), false);
});

check("the sibling directories in HISTORY_DIR are rejected", () => {
  for (const entry of ["attachments", "em", "outbox", "sre"]) {
    assert.strictEqual(admits(entry), false, entry);
  }
});

check("what summarize-core writes is what the reader admits", () => {
  // The writer's own template, read from source so a rename fails here rather
  // than silently going unread by the bot.
  assert.ok(
    SUMMARIZE_SRC.includes("`${date}-${channelName}.md`"),
    "summarize-core.js no longer writes `${date}-${channelName}.md`",
  );
  const date = new Date().toISOString().split("T")[0];
  for (const channelName of ["engineering", "buffer-rotation", "jerky-em"]) {
    assert.strictEqual(admits(`${date}-${channelName}.md`), true, channelName);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
