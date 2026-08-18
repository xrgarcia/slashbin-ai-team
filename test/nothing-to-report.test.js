// A scheduled job with nothing to say must post nothing — without eating a real
// message. Both directions matter: over-suppressing loses an alert silently, which
// is strictly worse than the noise this exists to remove.

const assert = require("assert");
const { isNothingToReport } = require("../lib/nothing-to-report");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const SUPPRESS = [
  "[no output]", "no output", "No output.",
  ".", "...", "•", "—", "-",
  "none", "None", "none.", "NONE",
  "n/a", "N/A", "na", "nil", "empty", "null", "undefined",
  "nothing", "nothing to report", "Nothing to report.", "nothing new", "nothing here",
  "(no changes)", "no changes", "no change", "no updates", "No updates!",
  "no open PRs", "no open pr", "no new activity", "no new commits",
  "no errors", "no results", "no items", "no messages", "no news",
  "", "   ", "\n\n",
];

const KEEP = [
  "[DISK FULL]",
  "[URGENT: disk full]",
  "[ALERT] build failed",
  "No changes since Tuesday",
  "None of the PRs merged",
  "nothing works, everything is on fire",
  "3 open PRs",
  "no output from the build, but 4 tests failed",
  "Report: no changes",
  "PR #42 needs review",
  "no changes to the schema, but the migration failed",
];

console.log("\nScheduled-job replies that carry no information");
for (const s of SUPPRESS) {
  check(`suppressed: ${JSON.stringify(s)}`, () => {
    assert.strictEqual(isNothingToReport(s), true);
  });
}

console.log("\nReal messages that must never be swallowed");
for (const s of KEEP) {
  check(`preserved: ${JSON.stringify(s)}`, () => {
    assert.strictEqual(isNothingToReport(s), false);
  });
}

console.log("\nDegenerate input");
check("null and undefined are nothing", () => {
  assert.strictEqual(isNothingToReport(null), true);
  assert.strictEqual(isNothingToReport(undefined), true);
});

check("a non-string is coerced, not thrown on", () => {
  // sendToChannel is also reached from the job-failure path; a throw here would
  // swallow the failure report itself.
  assert.strictEqual(isNothingToReport(0), false);
  assert.strictEqual(isNothingToReport(42), false);
});

const total = SUPPRESS.length + KEEP.length + 2;
console.log(`\n${total - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
