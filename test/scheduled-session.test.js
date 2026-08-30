// A scheduled job must not run inside the channel's conversation session.
//
// The incident: a job on a 10-minute cron held one session open for 28.8 hours
// and 2,115 turns, because sessions expire on 30 minutes of IDLE and a 10-minute
// poll is never idle. Every fire re-sent the whole accumulated history; a poll
// that found nothing still paid ~400k tokens, and context reached 998k.
//
// Source-level assertions: runClaude spawns a real Claude process against a live
// Discord channel, so the behaviour cannot be exercised in a unit test. What
// regressed is the SHAPE — which call sites opt into an isolated session and
// which must not — and that is what these pin.

const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");

const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");

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

console.log("\nScheduled jobs run outside the channel conversation");

check("the scheduler asks for an ephemeral run", () => {
  const call = /await runClaude\(job\.prompt[^;]*\);/.exec(bot);
  assert.ok(call, "the scheduler's runClaude call moved or changed shape");
  assert.match(call[0], /ephemeral:\s*true/,
    "a scheduled job must opt out of the channel session, or it pins that session open forever");
});

check("an ephemeral run resumes nothing", () => {
  const fn = bot.slice(bot.indexOf("async function runClaude("));
  const head = fn.slice(0, fn.indexOf("const existingSession"));
  assert.match(head, /if \(opts\.ephemeral\)/,
    "ephemeral must short-circuit BEFORE the resume lookup");
  assert.match(head, /spawnClaude\([^)]*null,\s*progress,\s*opts\)/,
    "the ephemeral path must pass a null resume id");
});

check("an ephemeral run stores nothing", () => {
  // Storing it would hand the channel's next human message the job's session,
  // and would keep lastActivity fresh forever so the real conversation could
  // never rotate either — the same coupling, just inverted.
  assert.match(bot, /if \(state\.sessionId && !opts\.ephemeral\)/,
    "the session store must be skipped for an ephemeral run");
});

check("opts is threaded to every spawnClaude call site", () => {
  const spawns = [...bot.matchAll(/spawnClaude\((?!prompt, channelId, reqLog, sendMessage, attachments, channelName, resumeSessionId)[^;]*\)/g)];
  assert.ok(spawns.length >= 3, `expected 3 call sites, found ${spawns.length}`);
  for (const s of spawns) {
    assert.match(s[0], /opts\)/,
      `a spawnClaude call site drops opts, so ephemeral would leak a stored session: ${s[0].slice(0, 90)}`);
  }
});

console.log("\nConversations must NOT become stateless");

check("the human message path keeps its session", () => {
  // The fix must not be applied globally. A conversation that resumes nothing
  // loses continuity between messages, which is the whole point of the session.
  const call = /const responseText = await runClaude\(prompt, msg\.channel\.id[^;]*\);/.exec(bot);
  assert.ok(call, "the message-handler runClaude call moved or changed shape");
  assert.doesNotMatch(call[0], /ephemeral/,
    "a human message must resume the channel session");
});

check("the reaction trigger keeps its session", () => {
  const start = bot.indexOf("Reaction trigger — invoking Claude");
  assert.ok(start > -1, "reaction trigger not found");
  const call = bot.slice(start, start + 500);
  assert.doesNotMatch(call, /ephemeral/,
    "a reaction is a human acting inside a conversation — it keeps the session");
});

console.log("\nThe rotation trap this exists to close");

check("session expiry is still idle-based, so the fix is load-bearing", () => {
  // If rotation ever becomes age-based rather than idle-based, this fix stops
  // being the only thing standing between a fast cron and a 28-hour session —
  // but until then, removing it reopens the incident.
  assert.match(bot, /Date\.now\(\) - entry\.lastActivity < SESSION_TIMEOUT_MS/,
    "session expiry shape changed — re-check whether ephemeral is still required");
});

console.log("\nA one-shot follow-up is the ONE thing allowed to carry the conversation");

check("a recurring job can never carry it", () => {
  // The incident was a CADENCE problem: a job firing faster than the idle timeout
  // keeps its channel busy forever, so the session never rotates. Only a job that
  // fires once is safe to attach, which is why the exemption is shaped as
  // "wake jobs" and not as a flag any job could set.
  const fn = bot.slice(bot.indexOf("async function runWakeJob("));
  assert.ok(fn.length > 0, "runWakeJob is gone — the wake path moved or was removed");
  const cron = /await runClaude\(job\.prompt[^;]*\);/.exec(bot);
  assert.match(cron[0], /ephemeral:\s*true/, "the cron path must remain unconditionally ephemeral");
});

check("carrying is bounded by a wall clock, not by trust", () => {
  // A chain of carried follow-ups re-creates the incident if it can run forever:
  // each look keeps the session warm, so it never rotates.
  const fn = bot.slice(bot.indexOf("async function runWakeJob("), bot.indexOf("async function runScheduledJobs("));
  assert.match(fn, /WAKE_CARRY_MAX_MS/,
    "nothing bounds how long a chain of wake-ups keeps resuming the channel session");
  assert.match(fn, /ephemeral:\s*!carried/,
    "the run must fall back to an isolated session once carry expires");
  assert.match(bot, /const WAKE_CARRY_MAX_MS = envInt\("BOT_WAKE_CARRY_MAX_MS", SESSION_TIMEOUT_MS/,
    "the ceiling must default to the session idle timeout — the number the incident was measured against");
});

check("the run is TOLD when it is not carrying", () => {
  // Silent degradation is worse than no carry at all: a follow-up that thinks it
  // can see the conversation will answer as if it can.
  const wake = readFileSync(join(__dirname, "..", "lib", "wake.js"), "utf8");
  assert.match(wake, /NOT attached/, "a clean run must be told it is running clean");
});

console.log("\nA follow-up fires at most once");

check("the job is deleted BEFORE it runs, not after", () => {
  // Same guarantee as the resume path: a prompt that may have merged a PR is
  // never re-fired because the run outlived the tick or the process died holding
  // it. Deleting afterwards would leave a window where a restart re-fires it.
  const fn = bot.slice(bot.indexOf("async function runWakeJob("), bot.indexOf("async function runScheduledJobs("));
  const removedAt = fn.indexOf("removeScheduledJob(job.id);\n\n  const chainStarted");
  const ranAt = fn.indexOf("await runClaude(");
  assert.ok(removedAt > -1, "the pre-run removal moved or changed shape");
  assert.ok(removedAt < ranAt, "a wake job must be removed before its run starts, or a crash re-fires it");
});

check("a tick never saves a stale copy of the schedules file", () => {
  // A run can CREATE a job while it is running — that is how a watch re-arms —
  // and the scheduler's in-memory array predates that write. Saving the array
  // would silently delete the follow-up the run just scheduled.
  const fn = bot.slice(bot.indexOf("async function runScheduledJobs("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.doesNotMatch(body, /saveSchedules\(/,
    "the scheduler loop writes the file directly — it must go through the reload-first helpers");
  assert.match(bot, /function removeScheduledJob\(id\) \{\s*saveSchedules\(loadSchedules\(\)/,
    "removeScheduledJob must re-read the file before writing it");
});

const total = 14;
console.log(`\n${total - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
