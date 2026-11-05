// A runner that refused work, told apart from one that failed at it.
//
// An agent CLI out of tokens, over its usage limit or rate-limited has not
// failed on the merits: the same work succeeds once the limit lifts. Posting
// that run's "could not answer" as the card's answer turned it into a decision
// for the owner (SLA-3693, 2026-11-04: the EM seat ran out of tokens, and its
// second look put the fallback to the owner as an ask).
//
// What a refusal LOOKS like belongs to the runner, so the patterns are settings
// with Claude's as the defaults — the same signals as the Foreman's
// src/refusal.ts. A Codex or any other CLI is a settings change, never a code
// change.

/** Claude's refusals: a final stream-json result carrying HTTP 429, or the "You've hit your … limit" banner. */
const CLAUDE_REFUSAL_PATTERNS = Object.freeze([
  String.raw`"api_error_status"\s*:\s*429\b`,
  String.raw`\bYou(?:'|’)ve hit your\b[^\n]*\blimit`,
]);

/** Claude's stated reset: `resets 12:10pm (America/Chicago)`. Named groups hour, minute, ampm, zone. */
const CLAUDE_RESET_PATTERN = String.raw`resets\s+(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>am|pm)\s*\((?<zone>[^)]+)\)`;

/** How long the board waits on a refusal that states no reset. */
const DEFAULT_BACKOFF_MINUTES = 15;

/** How much of each stream is read: a refusal is the run's last word, never buried mid-transcript. */
const TAIL = 8000;

function compiles(p, label) {
  try { new RegExp(p, "mi"); } catch (err) { throw new Error(`${label}: ${JSON.stringify(p)} is not a valid regular expression (${err.message})`); }
  return p;
}

/**
 * The runner's refusal rules from the environment. Throws on a malformed
 * value: a bad pattern fails at load, never silently when a refusal needs
 * recognising.
 *
 *   RUNNER_REFUSAL_PATTERNS     JSON array of case-insensitive regexes; default Claude's
 *   RUNNER_REFUSAL_EXIT_CODES   comma list of exit codes that mean a refusal; default none
 *   RUNNER_RESET_PATTERN        regex naming when the limit lifts (groups iso, or hour/minute/ampm/zone); default Claude's
 *   RUNNER_REFUSAL_BACKOFF_MINUTES  the wait when a refusal states no reset; default 15
 */
function parseRunnerRefusal(env = process.env) {
  let refusalPatterns = [...CLAUDE_REFUSAL_PATTERNS];
  const raw = env.RUNNER_REFUSAL_PATTERNS;
  if (raw !== undefined && raw.trim() !== "") {
    let list;
    try { list = JSON.parse(raw); } catch { throw new Error(`RUNNER_REFUSAL_PATTERNS must be a JSON array of regular expressions, got ${JSON.stringify(raw)}`); }
    if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === "string" && p.length)) {
      throw new Error("RUNNER_REFUSAL_PATTERNS must be a non-empty JSON array of regular expressions");
    }
    refusalPatterns = list.map((p) => compiles(p, "RUNNER_REFUSAL_PATTERNS"));
  }
  let refusalExitCodes = [];
  const codes = env.RUNNER_REFUSAL_EXIT_CODES;
  if (codes !== undefined && codes.trim() !== "") {
    refusalExitCodes = codes.split(",").map((c) => c.trim()).filter(Boolean).map((c) => {
      if (!/^-?\d+$/.test(c)) throw new Error(`RUNNER_REFUSAL_EXIT_CODES must be a comma list of integers, got ${JSON.stringify(codes)}`);
      return Number(c);
    });
  }
  const resetPattern = env.RUNNER_RESET_PATTERN?.trim() ? compiles(env.RUNNER_RESET_PATTERN, "RUNNER_RESET_PATTERN") : CLAUDE_RESET_PATTERN;
  let backoffMinutes = DEFAULT_BACKOFF_MINUTES;
  const b = env.RUNNER_REFUSAL_BACKOFF_MINUTES;
  if (b !== undefined && b.trim() !== "") {
    backoffMinutes = Number(b);
    if (!Number.isFinite(backoffMinutes) || backoffMinutes <= 0) throw new Error(`RUNNER_REFUSAL_BACKOFF_MINUTES must be a positive number of minutes, got ${JSON.stringify(b)}`);
  }
  return Object.freeze({ refusalPatterns, refusalExitCodes, resetPattern, backoffMinutes });
}

const DEFAULT_RULES = parseRunnerRefusal({});

/**
 * Whether a finished run was a refusal: `{ reason, resetAtMs? }`, else undefined.
 * `out`: `{ stdout, stderr?, exitCode? }`. Pure apart from the clock `now`.
 */
function detectRefusal(out, rules = DEFAULT_RULES, now = Date.now()) {
  const text = [String(out.stdout ?? "").slice(-TAIL), String(out.stderr ?? "").slice(-TAIL)].filter(Boolean).join("\n");
  let reason;
  for (const p of rules.refusalPatterns) {
    const m = new RegExp(p, "mi").exec(text);
    if (m) { reason = reasonOf(lineAt(text, m.index)); break; }
  }
  if (reason === undefined && out.exitCode !== undefined && out.exitCode !== null && rules.refusalExitCodes.includes(out.exitCode)) {
    reason = `exit ${out.exitCode}`;
  }
  if (reason === undefined) return undefined;
  return { reason, resetAtMs: parseReset(text, rules.resetPattern, now) };
}

function lineAt(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The refusal in the runner's own words: a JSON line's message field, else the line itself. */
function reasonOf(line) {
  try {
    const o = JSON.parse(line);
    for (const k of ["result", "message", "error"]) {
      const v = o?.[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 300);
    }
  } catch {
    // a plain-text line
  }
  return line.trim().slice(0, 300) || "runner refused the run";
}

/**
 * The first future instant `pattern` names in `text`, as epoch ms; undefined
 * when it names none, or one already past. Wall-clock times resolve in their
 * zone, so DST is honoured. Pure apart from `now`.
 */
function parseReset(text, pattern, now = Date.now()) {
  let g;
  try { g = new RegExp(pattern, "i").exec(text)?.groups; } catch { return undefined; }
  if (!g) return undefined;
  if (g.iso) {
    const at = Date.parse(g.iso);
    return Number.isFinite(at) && at > now ? at : undefined;
  }
  if (g.hour === undefined) return undefined;
  let hour = Number(g.hour);
  const minute = g.minute ? Number(g.minute) : 0;
  if (g.ampm) {
    hour %= 12;
    if (g.ampm.toLowerCase() === "pm") hour += 12;
  }
  if (!Number.isInteger(hour) || hour > 23 || minute > 59) return undefined;
  const zone = g.zone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const today = zonedParts(now, zone);
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const at = zonedWallToUtc(today.year, today.month, today.day + dayOffset, hour, minute, zone);
      if (at > now) return at;
    }
  } catch {
    // RangeError on an unknown time zone
  }
  return undefined;
}

function zonedParts(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function zoneOffset(ms, zone) {
  const p = zonedParts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function zonedWallToUtc(year, month, day, hour, minute, zone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffset(guess, zone);
  return guess - zoneOffset(first, zone);
}

module.exports = { CLAUDE_REFUSAL_PATTERNS, CLAUDE_RESET_PATTERN, DEFAULT_BACKOFF_MINUTES, DEFAULT_RULES, parseRunnerRefusal, detectRefusal, parseReset };
