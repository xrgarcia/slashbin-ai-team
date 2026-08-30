/**
 * One-shot wake-ups — "I'll check back in twenty minutes", kept.
 *
 * Before this, a bot could only schedule a clock time. A follow-up had to be
 * translated into a cron minute plus a matching `expires`, and an expiry that
 * landed one tick early DELETED the job before it fired — the promise vanished
 * with no error anywhere. Everything below is a way that failure could come back.
 *
 * The CLI is exercised for real, in a temp state file, because the whole point of
 * the feature is what ends up on disk: a job the scheduler will find later.
 */
const assert = require("assert");
const { execFileSync } = require("child_process");
const { readFileSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { buildWakePrompt, isWakeJob } = require("../lib/wake");

const REPO = join(__dirname, "..");
const CLI = join(REPO, "skill-pack", "bin", "schedule.mjs");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

function freshState() {
  return join(mkdtempSync(join(tmpdir(), "wake-test-")), "schedules.json");
}

/** Run the CLI. Returns { ok, out } — never throws, so a rejection is assertable. */
function cli(file, args) {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, BOT_SCHEDULES_FILE: file, BOT_CHANNEL_ID: "999", BOT_TIMEZONE: "America/Chicago" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

const jobs = (file) => JSON.parse(readFileSync(file, "utf8"));

console.log("\nA follow-up is a job on disk, not an intention");

check("--in 20m stores an absolute instant twenty minutes out", () => {
  const f = freshState();
  const before = Date.now();
  assert.ok(cli(f, ["wake", "--in", "20m", "--prompt", "check the deploy"]).ok);
  const [j] = jobs(f);
  assert.ok(isWakeJob(j), "the scheduler identifies a wake job by runAt — it is missing");
  assert.ok(!j.cron, "a wake job must carry no cron, or the cron path would try to evaluate it");
  const delta = Date.parse(j.runAt) - before;
  assert.ok(delta > 19 * 60_000 && delta < 21 * 60_000, `runAt is ${Math.round(delta / 60_000)}m out, expected 20`);
});

check("a bare number is refused rather than guessed", () => {
  // "check back in 30" is the one input where guessing wrong is invisible:
  // 30 seconds and 30 hours both look like a schedule that worked.
  const r = cli(freshState(), ["wake", "--in", "30", "--prompt", "x"]);
  assert.ok(!r.ok, "a unitless duration was accepted");
  assert.match(r.out, /no unit/);
});

check("compound and long forms parse", () => {
  const f = freshState();
  assert.ok(cli(f, ["wake", "--in", "1h30m", "--prompt", "x"]).ok);
  const delta = Date.parse(jobs(f)[0].runAt) - Date.now();
  assert.ok(delta > 89 * 60_000 && delta < 91 * 60_000, "1h30m did not resolve to 90 minutes");
});

check("a delay under the tick is rounded up, and says so", () => {
  // The scheduler ticks once a minute. Accepting "10s" silently would promise a
  // fire time the scheduler cannot honour.
  const f = freshState();
  const r = cli(f, ["wake", "--in", "10s", "--prompt", "x"]);
  assert.ok(r.ok);
  assert.match(r.out, /rounded up/);
  assert.ok(Date.parse(jobs(f)[0].runAt) - Date.now() > 55_000);
});

check("a time in the past is refused", () => {
  const r = cli(freshState(), ["wake", "--at", "2020-01-01T00:00:00Z", "--prompt", "x"]);
  assert.ok(!r.ok, "a wake-up that could never fire was accepted");
  assert.match(r.out, /never fire|in the past/);
});

check("a deadline earlier than the wake-up is refused", () => {
  // Otherwise the scheduler drops it on the deadline check and the follow-up
  // never happens — the exact silent failure this feature exists to end.
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const r = cli(freshState(), ["wake", "--in", "2h", "--prompt", "x", "--deadline", soon]);
  assert.ok(!r.ok);
  assert.match(r.out, /deadline/);
});

console.log("\nA watch ends");

check("a chain stops at the attempt cap", () => {
  const r = cli(freshState(), ["wake", "--in", "10m", "--prompt", "x", "--attempt", "13"]);
  assert.ok(!r.ok, "a watch past its limit was allowed to re-arm");
  assert.match(r.out, /limit/);
});

check("the cap is configurable, deliberately", () => {
  const f = freshState();
  assert.ok(cli(f, ["wake", "--in", "10m", "--prompt", "x", "--attempt", "13", "--max-attempts", "20"]).ok);
  assert.strictEqual(jobs(f)[0].maxAttempts, 20);
});

check("every wake carries the chain's start, so carry can expire", () => {
  const f = freshState();
  cli(f, ["wake", "--in", "10m", "--prompt", "x"]);
  assert.ok(Number.isFinite(Date.parse(jobs(f)[0].chainStartedAt)),
    "without a chain start there is no way to bound how long a watch keeps resuming the conversation");
});

console.log("\nCarrying the conversation is opt-in");

check("--carry is recorded; its absence is not", () => {
  const f1 = freshState();
  cli(f1, ["wake", "--in", "10m", "--prompt", "x", "--carry"]);
  assert.strictEqual(jobs(f1)[0].carry, true);
  const f2 = freshState();
  cli(f2, ["wake", "--in", "10m", "--prompt", "x"]);
  assert.strictEqual(jobs(f2)[0].carry, undefined, "a clean run must not be silently upgraded to a carried one");
});

console.log("\nThe two kinds of job coexist");

check("list renders a wake job and a cron job together", () => {
  // Regression: the lister computed a next-fire time by splitting job.cron, which
  // throws on a wake job — one follow-up would have broken `list` entirely.
  const f = freshState();
  cli(f, ["add", "--cron", "0 7 * * 1,2,3,4,5", "--prompt", "standup"]);
  cli(f, ["wake", "--in", "45m", "--prompt", "check the deploy", "--note", "PR merged at 10:04"]);
  const r = cli(f, ["list"]);
  assert.ok(r.ok, `list failed: ${r.out}`);
  assert.match(r.out, /one-shot wake-up/);
  assert.match(r.out, /every weekday/);
  assert.match(r.out, /PR merged at 10:04/);
});

console.log("\nThe prompt a wake-up runs — its only context");

const JOB = {
  id: "wake-x",
  runAt: "2026-08-30T16:00:00.000Z",
  prompt: "Check whether the promotion PR merged.",
  note: "PR #218 approved at 10:04",
  attempt: 2,
  maxAttempts: 12,
  chainStartedAt: "2026-08-30T15:00:00.000Z",
  createdAt: "2026-08-30T15:40:00.000Z",
  carry: true,
};

check("it carries the stored prompt verbatim", () => {
  assert.ok(buildWakePrompt(JOB, { carried: true }).includes(JOB.prompt));
});

check("it says whether the conversation is attached — and never lies about it", () => {
  assert.match(buildWakePrompt(JOB, { carried: true }), /is attached/);
  const clean = buildWakePrompt(JOB, { carried: false });
  assert.match(clean, /NOT attached/);
  assert.match(clean, /do not refer to things you cannot see/);
});

check("it hands over the note", () => {
  assert.ok(buildWakePrompt(JOB, { carried: false }).includes("PR #218 approved at 10:04"),
    "the note is the only memory an uncarried follow-up has");
});

check("it tells the run to say nothing when nothing changed", () => {
  // The scheduler suppresses literal empties, but it cannot catch prose — a
  // 'still waiting' line is a Discord ping either way.
  assert.match(buildWakePrompt(JOB, { carried: true }), /produce NO output at all/);
});

check("it contains the command that schedules the NEXT look", () => {
  // A watch that cannot see how to re-arm simply stops, and nobody finds out
  // until they ask why it went quiet.
  const p = buildWakePrompt(JOB, { carried: true });
  assert.match(p, /bin\/schedule\.mjs" wake --in/);
  assert.match(p, /--attempt 3/, "the re-arm must advance the attempt count, or the cap never bites");
  assert.ok(p.includes("--chain-started 2026-08-30T15:00:00.000Z"), "the chain start must survive a re-arm");
  assert.match(p, /--carry/, "a carried watch must offer to stay carried");
});

check("it says the job is already gone, and that stopping is doing nothing", () => {
  const p = buildWakePrompt(JOB, { carried: true });
  assert.match(p, /already been removed/);
  assert.match(p, /do not schedule another one/);
});

check("a deadline is stated to the run that has to meet it", () => {
  const p = buildWakePrompt({ ...JOB, deadline: "2026-08-30T18:00:00.000Z" }, { carried: true });
  assert.match(p, /Deadline: 2026-08-30T18:00:00\.000Z/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
