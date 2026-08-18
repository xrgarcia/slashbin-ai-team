// The cadence check turns the 2.2.1 incident into one comparison a machine can
// make. It is only useful if it is right in both directions: a missed tight
// schedule leaves the operator paying, and a false alarm on a daily job trains
// them to ignore the warning.

const assert = require("assert");
const { minIntervalMinutes, jobsTighterThanTimeout } = require("../lib/cron-cadence");

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

console.log("\nCadence — how often does this actually fire");

const CASES = [
  ["0,10,20,30,40,50 * * * *", 10, "the incident job"],
  ["* * * * *", 1, "every minute"],
  ["0,5,10,15,20,25,30,35,40,45,50,55 * * * *", 5, "every five minutes"],
  ["0 * * * *", 60, "hourly"],
  ["30 8 * * *", 1440, "once a day"],
  ["0,30 8 * * *", 30, "twice inside one hour"],
  ["0 8,17 * * *", 540, "morning and evening"],
  ["5 0,23 * * *", 60, "wraps midnight: 23:05 then 00:05"],
  ["0 8 * * 1,2,3,4,5", 1440, "weekdays only — day fields cannot tighten it"],
];
for (const [cron, want, label] of CASES) {
  check(`${label}: ${cron}`, () => assert.strictEqual(minIntervalMinutes(cron), want));
}

console.log("\nUnparseable input says nothing rather than crying wolf");
for (const cron of ["1-5 * * * *", "*/5 * * * *", "0 * * *", "99 * * * *", "bogus", "", null, undefined]) {
  check(`null for ${JSON.stringify(cron)}`, () => assert.strictEqual(minIntervalMinutes(cron), null));
}

console.log("\nFlagging against the session timeout");

check("a 10-minute job is flagged against a 30-minute timeout", () => {
  const hits = jobsTighterThanTimeout([{ id: "poll", cron: "0,10,20,30,40,50 * * * *" }], 30 * 60 * 1000);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].everyMinutes, 10);
  assert.strictEqual(hits[0].timeoutMinutes, 30);
});

check("a daily job is not flagged", () => {
  assert.strictEqual(jobsTighterThanTimeout([{ id: "report", cron: "30 8 * * *" }], 30 * 60 * 1000).length, 0);
});

check("exactly at the timeout is not flagged", () => {
  // 30-minute cadence against a 30-minute timeout is the boundary. It does not
  // pin the session open, so warning here would be noise.
  assert.strictEqual(jobsTighterThanTimeout([{ id: "half", cron: "0,30 * * * *" }], 30 * 60 * 1000).length, 0);
});

check("a longer configured timeout flags MORE jobs", () => {
  // An operator who raised SESSION_TIMEOUT_MS widened the trap, and the check has
  // to follow their setting rather than a baked-in 30.
  const jobs = [{ id: "hourly", cron: "0 * * * *" }];
  assert.strictEqual(jobsTighterThanTimeout(jobs, 30 * 60 * 1000).length, 0);
  assert.strictEqual(jobsTighterThanTimeout(jobs, 120 * 60 * 1000).length, 1);
});

check("an unparseable cron in a real list does not break the others", () => {
  const hits = jobsTighterThanTimeout(
    [{ id: "bad", cron: "*/5 * * * *" }, { id: "tight", cron: "* * * * *" }],
    30 * 60 * 1000,
  );
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].id, "tight");
});

check("no jobs, or junk input, is not an error", () => {
  assert.strictEqual(jobsTighterThanTimeout([], 1800000).length, 0);
  assert.strictEqual(jobsTighterThanTimeout(null, 1800000).length, 0);
  assert.strictEqual(jobsTighterThanTimeout([{}], 1800000).length, 0);
});

const total = CASES.length + 8 + 6;
console.log(`\n${total - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
