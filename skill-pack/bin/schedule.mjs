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
 * Usage:
 *   schedule.mjs list
 *   schedule.mjs add --cron "0 7 * * 1,2,3,4,5" --prompt "..." --by <user> [--channel <id>] [--expires <iso>]
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
  schedule.mjs add --cron "<m h d mo dow>" --prompt "<what to do>" --by <user> [--channel <id>] [--expires <iso>]
  schedule.mjs remove <id>
  schedule.mjs history [id]

Cron accepts * or comma-separated numbers only — write "1,2,3,4,5" for weekdays, not "1-5".
Times are interpreted in ${TZ}.`);
}
