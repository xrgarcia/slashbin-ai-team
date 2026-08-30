#!/usr/bin/env node
/**
 * Create, list and remove this bot's scheduled jobs.
 *
 * The scheduler has always run jobs; nothing could CREATE one. `schedules.json`
 * had to be hand-written on the host, and the bot was never told the file exists,
 * so "remind me every morning at 7" was unserveable.
 *
 * Paths come from the environment the harness publishes. Nothing here names a file.
 *
 * `wake` is the other half: a ONE-SHOT follow-up at an instant, not a cron.
 * "I'll check back in 20 minutes" had no home here — it had to become a
 * wall-clock cron minute plus a matching `--expires`, and an expiry that landed
 * a tick early deleted the job before it ever fired. A wake job carries the
 * instant itself, fires once, and re-arms only if the run that fires it says so.
 *
 * Usage:
 *   schedule.mjs list
 *   schedule.mjs add --cron "0 7 * * 1,2,3,4,5" --prompt "..." --by <user> [--channel <id>] [--expires <iso>]
 *   schedule.mjs wake --in 20m --prompt "..." [--note "..."] [--carry] [--deadline <iso>] [--max-attempts N]
 *   schedule.mjs remove <id>
 *   schedule.mjs history [id]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const SCHEDULES = process.env.BOT_SCHEDULES_FILE;
const HISTORY = process.env.BOT_JOB_HISTORY_FILE;
const TZ = process.env.BOT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const MAX_JOBS = Number.parseInt(process.env.BOT_MAX_SCHEDULED_JOBS, 10) > 0
  ? Number.parseInt(process.env.BOT_MAX_SCHEDULED_JOBS, 10) : 25;
// A self-re-arming watch decides its own cadence, so nothing but a count stops
// it looking forever. The cap is what turns "keep checking" into a promise that
// ends — hit it and the run is told to report and stop rather than re-arm.
const MAX_WAKE_ATTEMPTS = Number.parseInt(process.env.BOT_MAX_WAKE_ATTEMPTS, 10) > 0
  ? Number.parseInt(process.env.BOT_MAX_WAKE_ATTEMPTS, 10) : 12;
// The scheduler ticks once a minute, so anything shorter is a lie about when it
// will fire, and anything past a week is a job nobody will remember setting.
const MIN_WAKE_MS = 60_000;
const MAX_WAKE_MS = 7 * 24 * 60 * 60_000;

function die(msg) { console.error(msg); process.exit(1); }
if (!SCHEDULES) die("BOT_SCHEDULES_FILE is not set — this harness is too old to support scheduling from chat.");

const load = () => { try { return JSON.parse(readFileSync(SCHEDULES, "utf8")); } catch { return []; } };
const save = (jobs) => { mkdirSync(dirname(SCHEDULES), { recursive: true }); writeFileSync(SCHEDULES, JSON.stringify(jobs, null, 2) + "\n"); };

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function zoned(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { min: +p.minute, hour: +p.hour % 24, day: +p.day, month: +p.month, dow: WEEKDAY[p.weekday] };
}

/**
 * Validate against what the SCHEDULER can actually evaluate — not against cron
 * in general. Its matcher handles `*` and comma lists only, so `1-5` would parse
 * as 1 and a "weekdays" job would silently fire on Mondays alone. Rejecting that
 * loudly is the difference between a wrong schedule and a missing one.
 */
function validateCron(cron) {
  const fields = (cron || "").trim().split(/\s+/);
  if (fields.length !== 5) return `expected 5 fields (minute hour day month weekday), got ${fields.length}`;
  const names = ["minute", "hour", "day", "month", "weekday"];
  for (let i = 0; i < 5; i++) {
    const f = fields[i];
    if (f === "*") continue;
    if (f.includes("-")) return `ranges are not supported in the ${names[i]} field — write "1,2,3,4,5" rather than "1-5"`;
    if (f.includes("/")) return `steps are not supported in the ${names[i]} field — list the values explicitly`;
    if (!/^\d+(,\d+)*$/.test(f)) return `the ${names[i]} field must be * or a comma-separated list of numbers`;
  }
  if (fields[0] === "*") return "a wildcard minute would fire every minute — give an explicit minute";
  return null;
}

/**
 * Durations as a person writes them: `45s`, `20m`, `2h`, `1h30m`, `3d`.
 *
 * A bare number is REJECTED rather than assumed to be minutes. "check back in
 * 30" is the one input where guessing wrong is invisible — 30 seconds and 30
 * hours both look like a schedule that worked.
 */
function parseDuration(text) {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return { error: "no duration given" };
  if (/^\d+$/.test(raw)) return { error: `"${raw}" has no unit — write ${raw}m for minutes, ${raw}h for hours` };
  if (!/^(\d+[smhd])+$/.test(raw)) return { error: `cannot read "${text}" as a duration — use forms like 45s, 20m, 2h, 1h30m, 3d` };
  const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let ms = 0;
  for (const [, n, u] of raw.matchAll(/(\d+)([smhd])/g)) ms += Number(n) * UNIT[u];
  return { ms };
}

function humanDelay(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h${m}m` : `${h} hour${h === 1 ? "" : "s"}`;
}

function describe(cron, tz) {
  const [mi, h, d, mo, dw] = cron.split(/\s+/);
  const at = h === "*" ? "every hour" : `${h.split(",").map((x) => `${String(x).padStart(2, "0")}:${String(mi).padStart(2, "0")}`).join(" and ")}`;
  let when = "every day";
  if (dw !== "*") {
    const days = dw.split(",").map((n) => DAY_NAME[+n]).filter(Boolean);
    when = days.length === 5 && !days.includes("Saturday") && !days.includes("Sunday") ? "every weekday" : days.join(", ");
  }
  if (d !== "*" && mo !== "*") when = `on ${mo}/${d}`;
  return `${when} at ${at} ${tz}`;
}

function nextRun(cron, tz) {
  const [mi, h, d, mo, dw] = cron.split(/\s+/);
  const hit = (f, v) => f === "*" || f.split(",").some((x) => +x === v);
  const now = new Date(Math.ceil(Date.now() / 60000) * 60000);
  for (let i = 0; i < 60 * 24 * 90; i++) {   // 90 days of minutes
    const t = new Date(now.getTime() + i * 60000);
    const z = zoned(t, tz);
    if (hit(mi, z.min) && hit(h, z.hour) && hit(d, z.day) && hit(mo, z.month) && hit(dw, z.dow)) return t;
  }
  return null;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };

if (cmd === "list") {
  const jobs = load();
  if (!jobs.length) { console.log("No scheduled jobs."); process.exit(0); }
  console.log(`${jobs.length} scheduled job(s):\n`);
  for (const j of jobs) {
    const tz = j.tz || TZ;
    if (j.runAt) {
      // A wake job has no cron to describe — it is one instant, and the only
      // interesting question is whether that instant is still ahead of us.
      const at = Date.parse(j.runAt);
      const overdue = Number.isFinite(at) && at < Date.now();
      console.log(`- **${j.id}** — one-shot wake-up${j.attempt > 1 ? `, look ${j.attempt}` : ""}`);
      console.log(`  fires: ${Number.isFinite(at) ? j.runAt.slice(0, 16).replace("T", " ") + " UTC" : "NEVER — unreadable runAt"}${overdue ? " (overdue — next tick)" : ""}`);
      console.log(`  posts to channel ${j.channel}${j.createdBy ? `, created by ${j.createdBy}` : ""}${j.deadline ? `, gives up ${j.deadline}` : ""}${j.carry ? ", carries the conversation" : ""}`);
      if (j.note) console.log(`  note: ${String(j.note).slice(0, 160)}`);
      console.log(`  prompt: ${String(j.prompt).slice(0, 160)}\n`);
      continue;
    }
    const next = nextRun(j.cron, tz);
    console.log(`- **${j.id}** — ${describe(j.cron, tz)}`);
    console.log(`  next: ${next ? next.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never (check the cron)"}`);
    console.log(`  posts to channel ${j.channel}${j.createdBy ? `, created by ${j.createdBy}` : ""}${j.expires ? `, expires ${j.expires}` : ""}`);
    console.log(`  prompt: ${String(j.prompt).slice(0, 160)}\n`);
  }
} else if (cmd === "add") {
  const cron = flag("cron"), prompt = flag("prompt");
  if (!cron || !prompt) die("add requires --cron and --prompt");
  const bad = validateCron(cron);
  if (bad) die(`Cannot schedule that: ${bad}`);

  const jobs = load();
  if (jobs.length >= MAX_JOBS) die(`This bot already has ${jobs.length} jobs (limit ${MAX_JOBS}). Remove one first.`);

  const channel = flag("channel") || process.env.BOT_CHANNEL_ID;
  if (!channel) die("No channel — pass --channel or run this from a bot conversation.");

  const id = flag("id") || `job-${Date.now().toString(36)}`;
  if (jobs.some((j) => j.id === id)) die(`A job called ${id} already exists.`);

  const job = {
    id, cron, channel, prompt,
    tz: TZ,                              // pinned, so a host or config move cannot silently reinterpret it
    createdBy: flag("by") || "unknown",
    createdAt: new Date().toISOString(),
    ...(flag("expires") ? { expires: flag("expires") } : {}),
  };
  jobs.push(job);
  save(jobs);

  // Read back rather than trusting the write — a schedule nobody verified is a
  // schedule nobody notices is wrong until it fails to fire.
  const written = load().find((j) => j.id === id);
  if (!written) die("Wrote the job but could not read it back — check permissions on the schedules file.");
  const next = nextRun(written.cron, written.tz);
  console.log(`Scheduled **${id}** — ${describe(written.cron, written.tz)}`);
  console.log(`Next run: ${next ? next.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "NEVER — the cron matches no time in the next 90 days"}`);
  console.log(`Posts to channel ${written.channel}.`);
} else if (cmd === "wake") {
  const prompt = flag("prompt");
  if (!prompt) die("wake requires --prompt — the stored prompt is the whole job");

  const inFlag = flag("in"), atFlag = flag("at");
  if (!inFlag && !atFlag) die('wake requires --in <duration> (e.g. "20m") or --at <iso timestamp>');
  if (inFlag && atFlag) die("pass --in or --at, not both");

  let runAtMs;
  let clampNote = null;
  if (inFlag) {
    const d = parseDuration(inFlag);
    if (d.error) die(`Cannot set that wake-up: ${d.error}`);
    let ms = d.ms;
    if (ms > MAX_WAKE_MS) die(`${inFlag} is more than a week out — a job that distant belongs on a cron, where it survives being forgotten.`);
    if (ms < MIN_WAKE_MS) {
      // Rounding up is honest; firing "in 10 seconds" on a 60-second tick is not.
      clampNote = `${inFlag} is shorter than the scheduler's one-minute tick — rounded up to 1 minute.`;
      ms = MIN_WAKE_MS;
    }
    runAtMs = Date.now() + ms;
  } else {
    runAtMs = Date.parse(atFlag);
    if (!Number.isFinite(runAtMs)) die(`Cannot read "${atFlag}" as a time — use an ISO timestamp like 2026-08-30T15:30:00Z.`);
    if (runAtMs < Date.now() + MIN_WAKE_MS) die(`${atFlag} is in the past or less than a minute away — it would never fire.`);
    if (runAtMs > Date.now() + MAX_WAKE_MS) die(`${atFlag} is more than a week out — use a cron job for anything that distant.`);
  }

  const attempt = Number.parseInt(flag("attempt"), 10) > 0 ? Number.parseInt(flag("attempt"), 10) : 1;
  const maxAttempts = Number.parseInt(flag("max-attempts"), 10) > 0
    ? Number.parseInt(flag("max-attempts"), 10) : MAX_WAKE_ATTEMPTS;
  if (attempt > maxAttempts) {
    die(`This watch has already looked ${attempt - 1} times, which is its limit (${maxAttempts}). Report what you have and stop — do not schedule another look. If it genuinely needs more, raise --max-attempts deliberately and say why.`);
  }

  const deadline = flag("deadline");
  if (deadline) {
    const dl = Date.parse(deadline);
    if (!Number.isFinite(dl)) die(`Cannot read "${deadline}" as a deadline — use an ISO timestamp.`);
    if (dl < runAtMs) die(`The wake-up lands after the deadline (${deadline}), so it would be dropped without ever running. Move one or the other.`);
  }

  const jobs = load();
  if (jobs.length >= MAX_JOBS) die(`This bot already has ${jobs.length} jobs (limit ${MAX_JOBS}). Remove one first.`);

  const channel = flag("channel") || process.env.BOT_CHANNEL_ID;
  if (!channel) die("No channel — pass --channel or run this from a bot conversation.");

  const id = flag("id") || `wake-${Date.now().toString(36)}`;
  if (jobs.some((j) => j.id === id)) die(`A job called ${id} already exists.`);

  const chainStartedAt = flag("chain-started") && Number.isFinite(Date.parse(flag("chain-started")))
    ? flag("chain-started") : new Date().toISOString();

  const job = {
    id,
    runAt: new Date(runAtMs).toISOString(),
    channel,
    prompt,
    tz: TZ,
    attempt,
    maxAttempts,
    chainStartedAt,
    ...(flag("note") ? { note: flag("note") } : {}),
    ...(argv.includes("--carry") ? { carry: true } : {}),
    ...(deadline ? { deadline } : {}),
    createdBy: flag("by") || "unknown",
    createdAt: new Date().toISOString(),
  };
  jobs.push(job);
  save(jobs);

  // Read back rather than trusting the write — same reason as `add`. A follow-up
  // nobody verified is one nobody notices is missing until the moment it was
  // supposed to speak.
  const written = load().find((j) => j.id === id);
  if (!written) die("Wrote the wake-up but could not read it back — check permissions on the schedules file.");
  if (clampNote) console.log(clampNote);
  console.log(`Wake-up **${id}** set for ${written.runAt.slice(0, 16).replace("T", " ")} UTC — in ${humanDelay(Date.parse(written.runAt) - Date.now())}.`);
  console.log(written.attempt > 1 ? `Look ${written.attempt} of at most ${written.maxAttempts}.` : `Fires once. Limit ${written.maxAttempts} looks if it keeps re-arming.`);
  console.log(written.carry
    ? "It continues this conversation if the session is still warm, and falls back to the note if it is not."
    : "It runs on its own, with no conversation around it — the prompt and the note are all it will have.");
  console.log(`Posts to channel ${written.channel}.`);
} else if (cmd === "remove") {
  const id = argv[1];
  if (!id) die("remove requires a job id (see `list`)");
  const jobs = load();
  const rest = jobs.filter((j) => j.id !== id);
  if (rest.length === jobs.length) die(`No job called ${id}. Run \`list\` to see what exists.`);
  save(rest);
  console.log(`Removed **${id}**. ${rest.length} job(s) remain.`);
} else if (cmd === "history") {
  if (!HISTORY || !existsSync(HISTORY)) { console.log("No run history yet."); process.exit(0); }
  const want = argv[1];
  const rows = readFileSync(HISTORY, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((r) => !want || r.id === want);
  if (!rows.length) { console.log(want ? `No runs recorded for ${want}.` : "No runs recorded yet."); process.exit(0); }
  console.log(`${rows.length} run(s):\n`);
  for (const r of rows.slice(-20)) {
    console.log(`- ${r.id} — ${r.firedAt} — ${r.success ? `ok (${Math.round(r.durationMs / 1000)}s)` : `FAILED: ${r.error || "unknown"}`}`);
  }
} else {
  console.log(`Usage:
  schedule.mjs list
  schedule.mjs add  --cron "<m h d mo dow>" --prompt "<what to do>" --by <user> [--channel <id>] [--expires <iso>]
  schedule.mjs wake --in <20m|2h|1h30m> --prompt "<what to do>" [--note "<carry forward>"] [--carry]
                    [--at <iso>] [--deadline <iso>] [--max-attempts <n>] [--attempt <n>] [--chain-started <iso>]
  schedule.mjs remove <id>
  schedule.mjs history [id]

add is recurring (a cron). wake is a single follow-up at an instant — it fires
once and is gone; a run that needs to look again schedules the next one itself.

Cron accepts * or comma-separated numbers only — write "1,2,3,4,5" for weekdays, not "1-5".
Times are interpreted in ${TZ}.`);
}
