/**
 * The harness is open source: nothing in it may name one operator's people,
 * customers, channels or issue tracker.
 *
 * Every feature here is generic and configured by setting — a gate, a flag, a
 * channel list. The examples, comments and test fixtures around those features
 * are where an operator's own world leaks in: the bot that needed the flag, the
 * customer it was for, the issue number that asked for it. Each one reads as
 * noise to everyone else, and an address or channel id is information nobody
 * meant to publish. This gate fails on the first one.
 */
const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");

const REPO = join(__dirname, "..");
const SELF = "test/no-internal-names.test.js";

// [pattern, what it catches, files where it is legitimate]
const RULES = [
  [/\bacme\b|acme[-_.]/i, "a customer name", []],
  [/\bhank\b|\bdoug\b|\bray\b/i, "a person's name", ["CODE_OF_CONDUCT.md"]],
  [/\bEM ?#\d+/, "an internal issue reference", []],
  [/@slashbin\.io\b/i, "a real email address", ["CODE_OF_CONDUCT.md"]],
  [/\b\d{17,20}\b/, "a real Discord id (use 123456789012345678)", []],
];
const PLACEHOLDER_ID = "123456789012345678";

const files = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
  .split("\n").filter((f) => f && f !== SELF && f !== "package-lock.json" && f !== "CHANGELOG.md");

const hits = [];
for (const f of files) {
  let text;
  try { text = readFileSync(join(REPO, f), "utf8"); } catch { continue; }
  if (text.includes("\0")) continue; // binary
  text.split("\n").forEach((line, i) => {
    for (const [re, what, allowed] of RULES) {
      if (allowed.includes(f)) continue;
      const m = line.match(re);
      if (m && m[0] !== PLACEHOLDER_ID) hits.push(`${f}:${i + 1}: ${what} (${m[0]})`);
    }
  });
}

console.log(`\nNo internal names in ${files.length} tracked files`);
if (hits.length) {
  for (const h of hits) console.log(`  FAIL ${h}`);
  process.exit(1);
}
console.log("  PASS none found");
