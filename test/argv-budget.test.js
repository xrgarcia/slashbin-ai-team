/**
 * The bug: `Error: spawn E2BIG`, on the first message after a machine restart.
 *
 * A fresh session injects every recent daily summary plus the whole conversation
 * buffer into ONE `--append-system-prompt` argument. Linux caps a single argv
 * string at 128KB. Summaries had no cap at all — two busy days measured 137,242
 * bytes on the engineering-manager bot, and every fresh session died at spawn.
 * A resumed session skips context injection, which is why it looked like a
 * reboot-only fault instead of an "any conversation older than 30 minutes" fault.
 *
 * These tests assert the premise (the kernel really does refuse), the policy
 * (budgetContext fits and SAYS what it left out), and the guarantee (clampArgs
 * makes E2BIG unreachable even if the policy is misconfigured).
 */
const assert = require("assert");
const { spawnSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");
const {
  MAX_ARG_BYTES,
  DEFAULT_ARG_LIMIT,
  byteLength,
  truncateToBytes,
  budgetContext,
  clampArgs,
} = require("../lib/argv-budget");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

/** Does this host accept a single argument of n bytes? */
function spawnAccepts(arg) {
  const r = spawnSync(process.execPath, ["-e", "0", arg]);
  return !(r.error && r.error.code === "E2BIG");
}

console.log("\nargv limits — the premise\n");

check("the kernel rejects a single argument above the limit (this IS the bug)", () => {
  assert.strictEqual(spawnAccepts("x".repeat(MAX_ARG_BYTES + 1)), false,
    "expected E2BIG — if this passes, this host's limit differs and MAX_ARG_BYTES needs revisiting");
});

check("a 137KB system prompt — the size measured in production — is rejected raw", () => {
  assert.strictEqual(spawnAccepts("x".repeat(137242)), false);
});

check("the same 137KB prompt spawns fine once clamped", () => {
  const { args, clamped } = clampArgs(["--append-system-prompt", "x".repeat(137242)]);
  assert.strictEqual(clamped.length, 1, "the oversized argument should be reported");
  assert.ok(spawnAccepts(args[1]), "clamped argument still hit E2BIG");
});

check("clamping says so inside the argument, so the model knows it was cut", () => {
  const { args } = clampArgs(["y".repeat(200000)]);
  assert.ok(/TRUNCATED/.test(args[0]), "a truncated prompt must announce itself");
});

check("arguments within the limit are passed through byte-identical", () => {
  const original = ["--model", "opus", "-p", "--", "hello — em dash"];
  const { args, clamped } = clampArgs(original);
  assert.deepStrictEqual(args, original);
  assert.strictEqual(clamped.length, 0);
});

check("the clamp limit leaves headroom under the kernel ceiling", () => {
  assert.ok(DEFAULT_ARG_LIMIT < MAX_ARG_BYTES, "no headroom for a differing page size");
});

console.log("\ncontext budget — the policy\n");

const bigSummaries = [
  "day one — " + "a".repeat(20000),
  "day two — " + "b".repeat(30000),
  "day three — " + "c".repeat(50000),
];
const bigBuffer = Array.from({ length: 800 }, (_, i) => `[10:0${i % 10}] user: line ${i}`).join("\n");

check("production-shaped input (105KB summaries + 30KB buffer) fits the budget", () => {
  const r = budgetContext({ summaries: bigSummaries, buffer: bigBuffer, maxBytes: 65536 });
  assert.ok(r.bytes <= 65536, `context was ${r.bytes} bytes, over the 65536 budget`);
});

check("the budgeted context spawns — end to end, no E2BIG", () => {
  const r = budgetContext({ summaries: bigSummaries, buffer: bigBuffer, maxBytes: 65536 });
  assert.ok(spawnAccepts(`some base prompt\n\n${r.text}`));
});

check("the NEWEST summary survives and the oldest is what gets dropped", () => {
  const r = budgetContext({ summaries: bigSummaries, buffer: "", maxBytes: 60000 });
  assert.ok(r.text.includes("day three"), "the most recent day must be kept");
  assert.ok(!r.text.includes("day one — aaa"), "the oldest day should have been dropped");
  assert.ok(r.droppedSummaries > 0);
});

check("omitted history is ANNOUNCED — a bot must not imply nothing happened", () => {
  const r = budgetContext({ summaries: bigSummaries, buffer: "", maxBytes: 60000 });
  assert.ok(/omitted/i.test(r.text), "the prompt must state that older summaries exist");
  assert.ok(/BOT_SUMMARIES_DIR/.test(r.text), "and where to find them");
});

check("a truncated buffer keeps the NEWEST lines and says it was cut", () => {
  const r = budgetContext({ summaries: [], buffer: bigBuffer, maxBytes: 8192 });
  assert.ok(r.bufferTruncated);
  assert.ok(r.text.includes("line 799"), "the newest buffer line must survive");
  assert.ok(!r.text.includes("line 0:"), "the oldest lines should be gone");
  assert.ok(/BOT_BUFFER_FILE/.test(r.text));
});

check("everyday input is untouched — no truncation, both sections present", () => {
  const r = budgetContext({
    summaries: ["yesterday: we shipped the thing"],
    buffer: "[09:00] ray: morning",
    maxBytes: 65536,
  });
  assert.strictEqual(r.droppedSummaries, 0);
  assert.strictEqual(r.bufferTruncated, false);
  assert.ok(r.text.includes("we shipped the thing"));
  assert.ok(r.text.includes("[09:00] ray: morning"));
  assert.ok(!/omitted/i.test(r.text), "nothing was dropped, so nothing should be announced");
});

check("empty input produces an empty context, not a header with nothing under it", () => {
  const r = budgetContext({ summaries: [], buffer: "", maxBytes: 65536 });
  assert.strictEqual(r.text, "");
});

check("budgeting counts BYTES, not characters — em dashes are 3 bytes each", () => {
  // The harness's own summaries are full of em dashes. Measuring .length would
  // undercount by a third and walk straight back into E2BIG.
  const emdash = "—".repeat(40000);       // 40k chars, 120k bytes
  const r = budgetContext({ summaries: [emdash], buffer: "", maxBytes: 65536 });
  assert.ok(byteLength(r.text) <= 65536, `${byteLength(r.text)} bytes exceeds the budget`);
});

check("truncation never leaves a broken UTF-8 character", () => {
  const out = truncateToBytes("—".repeat(1000), 1001, { keep: "tail" });
  assert.ok(!out.includes("�"), "found a replacement character — a multibyte char was split");
});

check("a budget smaller than the content still yields something spawnable", () => {
  const r = budgetContext({ summaries: bigSummaries, buffer: bigBuffer, maxBytes: 4096 });
  assert.ok(r.bytes <= 4096, `${r.bytes} bytes over a 4096 budget`);
  assert.ok(spawnAccepts(r.text));
});

console.log("\nno un-clamped spawn survives in the codebase\n");

check("bot.js spawns the clamped argument list, never the raw one", () => {
  const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  assert.ok(/spawn\(CLAUDE_BIN,\s*safeArgs/.test(src),
    "bot.js must spawn clamped args — an un-clamped spawn re-arms E2BIG");
  assert.ok(!/spawn\(CLAUDE_BIN,\s*args\b/.test(src));
});

check("summarize-core.js spawns the clamped argument list too", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "summarize-core.js"), "utf8");
  assert.ok(/spawn\(claudeBin,\s*safeArgs/.test(src),
    "the summarizer passes a whole transcript through argv — it needs the same clamp");
  assert.ok(!/spawn\(claudeBin,\s*args\b/.test(src));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
