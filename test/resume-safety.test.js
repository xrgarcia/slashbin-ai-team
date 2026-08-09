/**
 * Resume-retry safety.
 *
 * When a resumed Claude session fails, the bot may retry the same prompt on a
 * fresh session. These prompts merge PRs, file issues and send mail — so the
 * retry is only safe if the failed run did nothing at all. Anything else must
 * surface as an error rather than silently running twice.
 *
 * Asserted against the real isSafeToRetryFresh body lifted from bot.js — the
 * file cannot be require()d, importing it logs a live bot into Discord.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const SRC = readFileSync(join(__dirname, "..", "bot.js"), "utf8");

function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in bot.js`);
  let i = SRC.indexOf("(", start), paren = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "(") paren++;
    else if (SRC[i] === ")" && --paren === 0) break;
  }
  let depth = 0;
  i = SRC.indexOf("{", i);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

const isSafeToRetryFresh = new Function(
  `${extractFn("isSafeToRetryFresh")}; return isSafeToRetryFresh;`
)();

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

// A failure carrying no evidence of work — the process never got going.
const didNothing = { sessionStarted: false, toolCalls: 0, producedText: false };

console.log("\nSafe to retry — the run never started");
check("dead session id: no init, no tools, no text", () =>
  assert.strictEqual(isSafeToRetryFresh({ ...didNothing }), true));
check("spawn failure carries no diagnostics at all", () =>
  assert.strictEqual(isSafeToRetryFresh(new Error("Failed to spawn claude: ENOENT")), true));

console.log("\nNOT safe to retry — side effects may already have landed");
check("called a tool (could have merged a PR)", () =>
  assert.strictEqual(isSafeToRetryFresh({ ...didNothing, toolCalls: 1 }), false));
check("many tool calls", () =>
  assert.strictEqual(isSafeToRetryFresh({ ...didNothing, toolCalls: 47 }), false));
check("session started, even with no tool call yet", () =>
  assert.strictEqual(isSafeToRetryFresh({ ...didNothing, sessionStarted: true }), false));
check("produced text (already answered the user)", () =>
  assert.strictEqual(isSafeToRetryFresh({ ...didNothing, producedText: true }), false));
check("the real regression: long run, merged, then crashed", () =>
  assert.strictEqual(isSafeToRetryFresh({ sessionStarted: true, toolCalls: 31, producedText: true }), false));
check("a timed-out run that did work is not retried", () =>
  assert.strictEqual(isSafeToRetryFresh({ sessionStarted: true, toolCalls: 12, producedText: false }), false));

console.log("\nDegenerate input");
check("null does not retry", () =>
  assert.strictEqual(isSafeToRetryFresh(null), false));
check("undefined does not retry", () =>
  assert.strictEqual(isSafeToRetryFresh(undefined), false));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
