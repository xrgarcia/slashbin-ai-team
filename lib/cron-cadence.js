/**
 * How often does this cron actually fire, at its tightest?
 *
 * Exists because of one number. Sessions are keyed by channel and expire after
 * SESSION_TIMEOUT_MS of *idle*; a job firing faster than that means its channel is
 * never idle, so the session never rotates and every fire re-sends the whole
 * accumulated history. Measured before 2.2.1: a 10-minute poll held one session
 * open for 28.8 hours and 2,115 turns, and cost ~$1,664 in a day while correctly
 * finding nothing.
 *
 * 2.2.1 fixed the consequence — scheduled runs are ephemeral now. This exists so
 * the *shape* is visible before it costs anything: a cadence tighter than the idle
 * timeout is worth knowing about on any version, because it also means the job
 * overlaps its own previous run if that run is slow.
 *
 * Parsing matches the harness exactly (`cronMatchesTime` in bot.js): five fields,
 * `*` or comma lists only. Ranges are NOT supported — `1-5` parses as `1`, which
 * is why the scheduler rejects them rather than accepting a job that would fire on
 * Mondays alone. Anything this cannot parse returns null, and null means "unknown,
 * do not warn" — a false alarm about a schedule is worse than silence.
 */

/** Expand one cron field to the values it matches, or null if unparseable. */
function expandField(field, min, max) {
  if (field === "*") {
    const out = [];
    for (let v = min; v <= max; v++) out.push(v);
    return out;
  }
  if (/[-/]/.test(field)) return null; // ranges and steps are not supported by the harness
  const parts = field.split(",");
  const out = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < min || v > max) return null;
    out.push(v);
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

/**
 * Smallest gap between two consecutive firings, in minutes.
 *
 * Computed over a full day of minute-of-day slots and wrapped to the next day, so
 * a job at 23:50 and 00:05 is correctly 15 minutes apart rather than looking like
 * a 1,425-minute gap.
 *
 * Day-of-month and day-of-week are deliberately ignored. They can only make a job
 * fire LESS often, so ignoring them is the conservative direction: it never
 * invents a tighter cadence than the job really has.
 *
 * @returns {number|null} minutes, or null when the expression cannot be parsed
 */
function minIntervalMinutes(cron) {
  if (typeof cron !== "string") return null;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = expandField(fields[0], 0, 59);
  const hours = expandField(fields[1], 0, 23);
  if (!minutes || !hours) return null;

  const slots = [];
  for (const h of hours) for (const m of minutes) slots.push(h * 60 + m);
  slots.sort((a, b) => a - b);
  if (slots.length === 1) return 24 * 60; // once a day at most

  let smallest = Infinity;
  for (let i = 1; i < slots.length; i++) {
    smallest = Math.min(smallest, slots[i] - slots[i - 1]);
  }
  // Wrap: last firing of the day to the first of the next.
  smallest = Math.min(smallest, 24 * 60 - slots[slots.length - 1] + slots[0]);
  return smallest;
}

/**
 * Jobs whose cadence is tighter than the session idle timeout.
 *
 * @param {Array} jobs      parsed schedules.json
 * @param {number} timeoutMs SESSION_TIMEOUT_MS for that bot
 * @returns {Array<{id, cron, everyMinutes, timeoutMinutes}>}
 */
function jobsTighterThanTimeout(jobs, timeoutMs) {
  const timeoutMinutes = Math.round(timeoutMs / 60000);
  const out = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const every = minIntervalMinutes(job && job.cron);
    if (every === null) continue; // unparseable — say nothing rather than cry wolf
    if (every < timeoutMinutes) {
      out.push({ id: job.id, cron: job.cron, everyMinutes: every, timeoutMinutes });
    }
  }
  return out;
}

module.exports = { minIntervalMinutes, jobsTighterThanTimeout, expandField };
