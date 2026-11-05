/**
 * Runner refusals (lib/refusal.js): out of tokens, over a usage limit,
 * rate-limited. The same signals as the Foreman's src/refusal.ts, with
 * Claude's as defaults and every one of them a setting.
 */
const assert = require("assert");
const { parseRunnerRefusal, detectRefusal, parseReset, DEFAULT_RULES, CLAUDE_REFUSAL_PATTERNS } = require("../lib/refusal");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

// 2026-11-05 06:00 UTC is 00:00 in Chicago (CST, UTC-6).
const NOW = Date.parse("2026-11-05T06:00:00Z");
const RESULT_429 = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "API Error: Rate limited", session_id: "s" });
const BANNER = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3am (America/Chicago)", session_id: "s" });

check("Claude's 429 result is a refusal, in the runner's own words", () => {
  const r = detectRefusal({ stdout: RESULT_429 }, DEFAULT_RULES, NOW);
  assert.deepStrictEqual(r, { reason: "API Error: Rate limited", resetAtMs: undefined });
});

check("Claude's usage-limit banner is a refusal, with the reset it states", () => {
  const r = detectRefusal({ stdout: BANNER }, DEFAULT_RULES, NOW);
  assert.strictEqual(r.reason, "You've hit your limit · resets 3am (America/Chicago)");
  assert.strictEqual(r.resetAtMs, Date.parse("2026-11-05T09:00:00Z"));
});

check("the banner in stderr, and with a curly apostrophe, is a refusal too", () => {
  assert.ok(detectRefusal({ stdout: "", stderr: "Error: You’ve hit your session limit" }));
});

check("an ordinary failure is not a refusal; nor is prose that only mentions a limit", () => {
  assert.strictEqual(detectRefusal({ stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }), stderr: "crashed", exitCode: 1 }), undefined);
  assert.strictEqual(detectRefusal({ stdout: "the session limit for uploads is 10MB" }), undefined);
});

check("a reset already past today is tomorrow's", () => {
  // 10:00 Chicago; "resets 3am" is 3am tomorrow.
  const now = Date.parse("2026-11-05T16:00:00Z");
  assert.strictEqual(parseReset("resets 3am (America/Chicago)", DEFAULT_RULES.resetPattern, now), Date.parse("2026-11-06T09:00:00Z"));
});

check("defaults are Claude's, the same patterns as the Foreman's", () => {
  const d = parseRunnerRefusal({});
  assert.deepStrictEqual(d.refusalPatterns, [...CLAUDE_REFUSAL_PATTERNS]);
  assert.deepStrictEqual(d.refusalExitCodes, []);
  assert.strictEqual(d.backoffMinutes, 15);
});

check("another runner is a settings change: its own patterns, exit codes, reset and back-off", () => {
  const rules = parseRunnerRefusal({
    RUNNER_REFUSAL_PATTERNS: JSON.stringify(["rate_limit_exceeded"]),
    RUNNER_REFUSAL_EXIT_CODES: "75, 99",
    RUNNER_RESET_PATTERN: String.raw`retry after (?<iso>\S+Z)`,
    RUNNER_REFUSAL_BACKOFF_MINUTES: "30",
  });
  const r = detectRefusal({ stdout: "error: rate_limit_exceeded; retry after 2026-11-05T07:00:00Z" }, rules, NOW);
  assert.strictEqual(r.resetAtMs, Date.parse("2026-11-05T07:00:00Z"));
  assert.strictEqual(detectRefusal({ stdout: BANNER }, rules, NOW), undefined, "Claude's banner is no longer this runner's refusal");
  assert.deepStrictEqual(detectRefusal({ stdout: "", exitCode: 75 }, rules, NOW), { reason: "exit 75", resetAtMs: undefined });
  assert.strictEqual(rules.backoffMinutes, 30);
});

check("a malformed setting is refused at load, naming it", () => {
  assert.throws(() => parseRunnerRefusal({ RUNNER_REFUSAL_PATTERNS: "not json" }), /RUNNER_REFUSAL_PATTERNS/);
  assert.throws(() => parseRunnerRefusal({ RUNNER_REFUSAL_PATTERNS: "[\"(unclosed\"]" }), /RUNNER_REFUSAL_PATTERNS.*not a valid regular expression/);
  assert.throws(() => parseRunnerRefusal({ RUNNER_REFUSAL_PATTERNS: "[]" }), /RUNNER_REFUSAL_PATTERNS/);
  assert.throws(() => parseRunnerRefusal({ RUNNER_REFUSAL_EXIT_CODES: "1,x" }), /RUNNER_REFUSAL_EXIT_CODES/);
  assert.throws(() => parseRunnerRefusal({ RUNNER_RESET_PATTERN: "(" }), /RUNNER_RESET_PATTERN/);
  assert.throws(() => parseRunnerRefusal({ RUNNER_REFUSAL_BACKOFF_MINUTES: "0" }), /RUNNER_REFUSAL_BACKOFF_MINUTES/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
