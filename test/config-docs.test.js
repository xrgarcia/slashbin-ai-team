/**
 * The README config table and the source must agree, in both directions.
 *
 * This is the test that would have caught what shipped for months: the README
 * documented three RECENT_CONTEXT_* settings that NO source file read, while
 * eight settings the code did read (WS_PORT, CLAUDE_MAX_TURNS,
 * MAX_CONCURRENT_CLAUDE, ...) appeared nowhere. A user configuring from the
 * README was setting variables into the void and missing real controls.
 *
 * Documentation drift is invisible to every other kind of test, so it gets its
 * own gate.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const REPO = join(__dirname, "..");

// Settings the harness actually reads, both access patterns.
const SOURCES = ["bot.js", "summarize.js", "bot-manager.mjs"];
const read = new Set();
for (const f of SOURCES) {
  const src = readFileSync(join(REPO, f), "utf8");
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]);
  for (const m of src.matchAll(/envInt\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) read.add(m[1]);
}

// Settings the README documents: rows shaped `| \`NAME\` | default | description |`
const readme = readFileSync(join(REPO, "README.md"), "utf8");
const documented = new Set();
for (const m of readme.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)) documented.add(m[1]);

// Set by the runtime rather than by us, or an illustrative name inside a comment.
const EXEMPT = new Set([
  "NODE_ENV",                              // documented, but also set by supervisors
  "CLAUDECODE",                            // scrubbed from the child env, never read as config
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "X",                                     // appears only in envInt()'s own doc comment
]);

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

console.log("\nREADME config table matches the code");

check("every setting the code reads is documented", () => {
  const missing = [...read].filter((k) => !documented.has(k) && !EXEMPT.has(k)).sort();
  assert.deepStrictEqual(missing, [],
    `undocumented settings — a user cannot discover these: ${missing.join(", ")}`);
});

check("every documented setting is actually read", () => {
  const phantom = [...documented].filter((k) => !read.has(k) && !EXEMPT.has(k)).sort();
  assert.deepStrictEqual(phantom, [],
    `documented but read by nothing — configuring these does nothing: ${phantom.join(", ")}`);
});

check("no slash command is documented that does not exist", () => {
  const bot = readFileSync(join(REPO, "bot.js"), "utf8");
  const docd = [...readme.matchAll(/\|\s*`(\/[a-z]+)`\s*\|/g)].map((m) => m[1]);
  assert.ok(docd.length, "no slash commands documented at all");
  const missing = docd.filter((c) => !bot.includes(c));
  assert.deepStrictEqual(missing, [], `README documents commands bot.js does not implement: ${missing.join(", ")}`);
});

check("every slash command the bot implements is documented", () => {
  const bot = readFileSync(join(REPO, "bot.js"), "utf8");
  const implemented = new Set();
  for (const m of bot.matchAll(/\/\^\(\?:<@!\?\\d\+>\\s\*\)\*\\?\/(\w+)/g)) implemented.add(`/${m[1]}`);
  // Also catch the plain `prompt === "/x"` form.
  for (const m of bot.matchAll(/prompt === "(\/[a-z]+)"/g)) implemented.add(m[1]);
  const undocumented = [...implemented].filter((c) => !readme.includes(`\`${c}\``)).sort();
  assert.deepStrictEqual(undocumented, [], `implemented but undocumented: ${undocumented.join(", ")}`);
});

check("the clone URL names this repository", () => {
  assert.ok(!/slashbin-discord-bot\.git/.test(readme),
    "README still clones the pre-rename repo name");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
