#!/usr/bin/env node
/**
 * `npm run advise` — read an existing install and say what to do before upgrading.
 *
 * `doctor` answers "is this install healthy right now". This answers a different
 * question: "what will break when I upgrade, and what do I do about it" — as a
 * list of concrete, ordered actions rather than a set of observations to interpret.
 *
 * ## It must run against an install that has NOT upgraded yet
 *
 * That is the whole point, and it drives every design decision here. A tool that
 * only works after upgrading cannot de-risk the upgrade. So:
 *
 *   - `--dir` points at ANY harness checkout, including one several majors behind.
 *   - Nothing is imported from the rest of this repo. Node builtins only.
 *   - The ecosystem file and schedules are parsed textually; nothing is evaluated
 *     and no bot is started.
 *   - Findings are gated on the version actually installed there, not on this one.
 *
 * Copy this single file to an old install, or run it from a current clone pointed
 * at the old directory. Both work.
 *
 * ## Output
 *
 * Human-readable by default. `--json` emits a stable object for an agent to act on:
 * every recommendation carries an `id`, a `severity`, the `why`, and an `action`
 * that is either a runnable command or a specific edit.
 *
 * ## Secrets
 *
 * Never prints a credential value. Tokens are referred to by the NAME of the
 * variable they come from; presence is reported, contents never are.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const dirFlag = args.indexOf("--dir");
const DIR = resolve(dirFlag !== -1 && args[dirFlag + 1] ? args[dirFlag + 1] : HERE);

const SEV = { blocker: 0, warn: 1, info: 2 };
const recs = [];
let idSeq = 0;
const add = (severity, title, why, action, evidence) =>
  recs.push({ id: `R${String(++idSeq).padStart(2, "0")}`, severity, title, why, action, evidence });

// --- version -----------------------------------------------------------------

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** Compare dotted versions. Returns <0 if a<b. Pre-release suffixes are ignored. */
function cmp(a, b) {
  const pa = String(a).split("-")[0].split(".").map(Number);
  const pb = String(b).split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const pkg = readJson(join(DIR, "package.json"));
const installed = pkg?.version || null;
const TARGET = readJson(join(HERE, "package.json"))?.version || "latest";
const below = (v) => installed !== null && cmp(installed, v) < 0;

if (!pkg) {
  console.error(`No package.json in ${DIR} — is that a slashbin-ai-team checkout?`);
  process.exit(2);
}

// --- git state ---------------------------------------------------------------

function git(argv) {
  try {
    return execFileSync("git", argv, { cwd: DIR, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return null; }
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const dirty = (git(["status", "--porcelain"]) || "").split("\n").filter(Boolean);
// A fork or a hand-cloned install often has no tracking branch, and reporting
// "no local commits" there would be a false all-clear on the exact thing an
// upgrade discards. Fall back to a remote branch that does exist.
let upstream = git(["rev-parse", "--abbrev-ref", "@{u}"]);
if (!upstream) {
  for (const cand of ["origin/main", "origin/master", "origin/develop"]) {
    if (git(["rev-parse", "--verify", "--quiet", cand])) { upstream = cand; break; }
  }
}
const ahead = upstream ? Number(git(["rev-list", "--count", `${upstream}..HEAD`]) || 0) : null;
const upstreamKnown = Boolean(upstream);

// --- ecosystem / bots --------------------------------------------------------

const ECO = join(DIR, "ecosystem.config.js");
const ecoText = existsSync(ECO) ? readFileSync(ECO, "utf8") : null;

function parseBots(text) {
  if (!text) return [];
  const out = [];
  for (const block of text.split(/^\s*\{\s*$/m)) {
    const name = /^\s*BOT_NAME:\s*['"]([^'"]+)['"]/m.exec(block);
    if (!name) continue;
    const pick = (k) => {
      const m = new RegExp(`^\\s*${k}:\\s*['"]([^'"]*)['"]`, "m").exec(block);
      return m ? m[1] : null;
    };
    const tokenRef = /^\s*DISCORD_TOKEN:\s*process\.env\.([A-Z0-9_]+)/m.exec(block);
    out.push({
      name: name[1],
      tokenVar: tokenRef ? tokenRef[1] : null,
      permissionMode: pick("BOT_PERMISSION_MODE"),
      stateDir: pick("BOT_STATE_DIR"),
      historyDir: pick("BOT_HISTORY_DIR"),
      wsPort: pick("WS_PORT"),
      claudeCwd: pick("CLAUDE_CWD"),
      sessionTimeoutMs: Number(pick("SESSION_TIMEOUT_MS")) || null,
      hasStopExitCodes: /stop_exit_codes/.test(block),
    });
  }
  return out;
}

const bots = parseBots(ecoText);

// --- cron cadence (self-contained; matches the harness parser) ----------------
// `*` and comma lists only — the harness does not support ranges or steps, and
// anything else must report "unknown" rather than guess.

function expand(field, min, max) {
  if (field === "*") return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  if (/[-/]/.test(field)) return null;
  const out = [];
  for (const p of field.split(",")) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < min || v > max) return null;
    out.push(v);
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

function minIntervalMinutes(cron) {
  if (typeof cron !== "string") return null;
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const mins = expand(f[0], 0, 59);
  const hrs = expand(f[1], 0, 23);
  if (!mins || !hrs) return null;
  const slots = [];
  for (const h of hrs) for (const m of mins) slots.push(h * 60 + m);
  slots.sort((a, b) => a - b);
  if (slots.length === 1) return 1440;
  let smallest = Infinity;
  for (let i = 1; i < slots.length; i++) smallest = Math.min(smallest, slots[i] - slots[i - 1]);
  return Math.min(smallest, 1440 - slots[slots.length - 1] + slots[0]);
}

function botStateRoot(b) {
  return resolve(DIR, b.stateDir || b.historyDir || ".bot-history");
}

function schedulesOf(b) {
  const file = join(botStateRoot(b), "schedules.json");
  if (!existsSync(file)) return { file, jobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { file, jobs: Array.isArray(parsed) ? parsed : [] };
  } catch (e) {
    return { file, jobs: [], error: e.message };
  }
}

// --- analysis ----------------------------------------------------------------

const hostDefault = process.env.BOT_PERMISSION_MODE_DEFAULT;
const singleBot = bots.length === 0;

// 1. Tool exposure — the 2.0 breaking change.
if (below("2.0.0")) {
  const missing = bots.filter((b) => !b.permissionMode).map((b) => b.name);
  if (singleBot || missing.length) {
    add(
      "blocker",
      "Tool exposure flips to restricted on upgrade",
      `Before 2.0 every bot ran with all tools. From 2.0 the default is \`restricted\` — Read, Glob, Grep, WebFetch, WebSearch, TodoWrite plus MCP tools. ${singleBot ? "This install" : `${missing.length} bot(s)`} set no permission mode, so ${singleBot ? "it" : "they"} will silently lose the ability to write files or run commands. Nothing errors; the bot just stops being able to do its job.`,
      cmp(TARGET, "2.2.0") >= 0
        ? "Set BOT_PERMISSION_MODE_DEFAULT=bypass once in the environment PM2 launches from (2.2.0+ supports a host-wide default), or BOT_PERMISSION_MODE=bypass per bot. A per-bot value always wins."
        : "Add BOT_PERMISSION_MODE=bypass to every app entry in ecosystem.config.js.",
      singleBot ? { install: "single-bot" } : { botsMissingMode: missing },
    );
  }
}

// 2. Scheduled jobs pinning sessions open — the 2.2.1 cost bug.
//
// Grouped by the file each bot's state actually resolves to. Several bots
// commonly share one state root (that is the default), and reporting the same
// schedules.json once per bot turns one finding into N identical ones — noise a
// human skims past and an agent would act on repeatedly.
const scheduleGroups = new Map();
for (const b of bots.length ? bots : [{ name: "(single-bot)", stateDir: null, historyDir: null, sessionTimeoutMs: null }]) {
  const { file } = schedulesOf(b);
  if (!scheduleGroups.has(file)) scheduleGroups.set(file, []);
  scheduleGroups.get(file).push(b);
}

for (const [, group] of scheduleGroups) {
  const b = group[0];
  const who = group.length > 1 ? `${group.map((x) => x.name).join(", ")} (shared state)` : b.name;
  const { file, jobs, error } = schedulesOf(b);
  if (error) {
    add("warn", `Unreadable schedules for ${who}`,
      `${file} could not be parsed (${error}). The scheduler treats that as no jobs at all, so these schedules are already silently gone.`,
      `Fix the JSON at ${file}, or restore it from a backup.`, { file });
    continue;
  }
  if (!jobs.length) continue;
  const timeoutMin = Math.round((b.sessionTimeoutMs || Number(process.env.SESSION_TIMEOUT_MS) || 1800000) / 60000);
  const tight = jobs
    .map((j) => ({ id: j.id, cron: j.cron, every: minIntervalMinutes(j.cron) }))
    .filter((j) => j.every !== null && j.every < timeoutMin);
  if (tight.length) {
    add(
      below("2.2.1") ? "blocker" : "warn",
      `Schedule tighter than the session timeout on ${who}`,
      below("2.2.1")
        ? `${tight.map((t) => `${t.id} fires every ${t.every}m`).join(", ")}, against a ${timeoutMin}m session timeout. Sessions expire on IDLE, so a job this frequent means the channel is never idle and its session never rotates — every fire re-sends the whole accumulated conversation. Measured on a 10-minute job: one session held open 28.8 hours across 2,115 turns, ~$1,664 in a day, while correctly finding nothing.`
        : `${tight.map((t) => `${t.id} fires every ${t.every}m`).join(", ")}, against a ${timeoutMin}m session timeout. ${TARGET} already makes scheduled runs ephemeral so this no longer accumulates context, but a job this frequent can still overlap its own previous run.`,
      below("2.2.1")
        ? `Upgrade to 2.2.1 or later — the fix is that scheduled runs no longer reuse the channel's session. Back up ${file} first.`
        : "Confirm each job finishes well inside its own interval.",
      { file, jobs: tight, sessionTimeoutMinutes: timeoutMin },
    );
  }
}

// 3. Where the schedules live — the backup target, which is not obvious.
for (const [, group] of scheduleGroups) {
  const b = group[0];
  const who = group.length > 1 ? `${group.map((x) => x.name).join(", ")} (shared state)` : b.name;
  const { file, jobs } = schedulesOf(b);
  if (!jobs.length) continue;
  const inRepo = existsSync(join(DIR, ".git")) && resolve(file).startsWith(resolve(DIR) + "/");
  add(
    inRepo ? "blocker" : "warn",
    `Back up schedules for ${who} before upgrading`,
    inRepo
      ? `${jobs.length} job(s) live at ${file}, which is INSIDE the git working tree. A \`git clean -x\` or a re-clone destroys them, and a schedule that silently stops firing is a failure nobody notices.`
      : `${jobs.length} job(s) live at ${file}. The path depends on BOT_STATE_DIR/BOT_HISTORY_DIR, so backing up the wrong directory is a failure that looks like success.`,
    `cp ${file} ${file}.bak`,
    { file, jobCount: jobs.length, insideGitTree: inRepo },
  );
}

// 4. A dead token becomes a restart loop from 2.0.
if (below("2.0.0")) {
  add("warn", "Verify every token before restarting",
    "Before 2.0 a bot with a bad token stayed alive and reported itself healthy. From 2.0 it exits, and under a process manager that becomes a restart loop whose log drowns every sibling that is fine.",
    cmp(TARGET, "2.3.0") >= 0
      ? "After upgrading, run `npm run doctor:fleet` in the environment PM2 launches from — it verifies every bot's token against Discord in one pass."
      : "Run `npm run doctor` once per bot with that bot's environment loaded.",
    { bots: bots.map((b) => b.name), tokenVars: bots.map((b) => b.tokenVar).filter(Boolean) });
}

// 5. Process manager should stop retrying a config failure (2.2.0+).
if (cmp(TARGET, "2.2.0") >= 0 && ecoText && bots.some((b) => !b.hasStopExitCodes)) {
  add("warn", "Tell PM2 not to retry a failure that cannot succeed",
    "From 2.2.0 a configuration failure — rejected token, missing CLAUDE_CWD, unknown permission mode — exits 78. Without stop_exit_codes the manager restarts it forever anyway.",
    "Add `stop_exit_codes: [78],` to each app entry in ecosystem.config.js (systemd: RestartPreventExitStatus=78).",
    { botsMissing: bots.filter((b) => !b.hasStopExitCodes).map((b) => b.name) });
}

// 6. Billing.
if (process.env.ANTHROPIC_API_KEY) {
  add("warn", "ANTHROPIC_API_KEY is set in this environment",
    "The harness hands its environment to every Claude process it spawns, so those runs bill as metered API usage instead of the subscription — with nothing in any log to say so.",
    "Unset it in the environment the bots are launched from: a wrapper that `unset`s it before exec, or restart the process manager from a clean shell. Setting it to an empty string does NOT work; it must be absent.",
    { note: "presence only — value never read" });
}

// 7. Work that an upgrade would destroy.
if (dirty.length) {
  add("blocker", "Uncommitted changes in the working tree",
    `${dirty.length} modified file(s). The working tree IS the deployment — PM2 runs bot.js straight from it — so this is code that may already be running and exists nowhere in git. A hard reset during upgrade discards it.`,
    "Review with `git diff`, then commit or revert deliberately before upgrading.",
    { files: dirty.slice(0, 20).map((l) => l.slice(3)) });
}
if (!upstreamKnown) {
  add("warn", "Cannot tell whether this install has local commits",
    "No tracking branch and no origin/main, so there is nothing to compare HEAD against. If this install carries local patches, an upgrade that discards commits will take them silently.",
    "Add a remote (`git remote -v` to check), or review the history by hand before upgrading.",
    { branch });
} else if (ahead) {
  add("blocker", `${ahead} local commit(s) not pushed`,
    `Branch ${branch} is ${ahead} commit(s) ahead of ${upstream}. If the upgrade discards local commits, these go with them — including any local patch this install depends on.`,
    `Review with \`git log ${upstream}..HEAD\`. Re-apply anything still needed on top of the new version.`,
    { branch, upstream, ahead });
}

// 8. Bots running code that is no longer on disk.
if (existsSync(join(DIR, "bot.js"))) {
  const codeMs = statSync(join(DIR, "bot.js")).mtimeMs;
  const stale = [];
  for (const b of bots.length ? bots : [{ name: "bot" }]) {
    const ready = join(DIR, `.${b.name}.ready`);
    if (existsSync(ready) && statSync(ready).mtimeMs < codeMs) {
      stale.push({ bot: b.name, hoursBehind: Math.round((codeMs - statSync(ready).mtimeMs) / 3600000) });
    }
  }
  if (stale.length) {
    add("warn", "Some bots are running code that is not what is on disk",
      "Node reads bot.js once at startup, so a bot that connected before the file last changed is running the previous version from memory. A fleet restarted at different times runs different code with nothing to say so.",
      "Restart them — the upgrade will do this anyway, but know that their current behaviour is not what the source says.",
      { stale });
  }
}

// 9. Sibling checkouts that may hold state.
try {
  const parent = resolve(DIR, "..");
  const siblings = readdirSync(parent).filter((d) => {
    if (join(parent, d) === DIR) return false;
    if (!/slashbin|discord.*bot|ai-team/i.test(d)) return false;
    return existsSync(join(parent, d, "bot.js"));
  });
  for (const s of siblings) {
    const p = join(parent, s);
    const hasState = ["schedules.json", ".bot-history", "attachments"].some((f) => existsSync(join(p, f)));
    add(hasState ? "warn" : "info", `Another harness checkout at ${p}`,
      hasState
        ? "It contains runtime state (schedules, history or attachments). On older versions that state lived inside the checkout, so deleting it destroys whatever it holds."
        : "No runtime state found in it. Likely safe to ignore or remove, but confirm nothing runs from it.",
      hasState ? `Inspect ${p} for schedules.json and back it up before deleting anything.` : `Confirm no process runs from ${p}.`,
      { path: p, hasState });
  }
} catch { /* parent unreadable — nothing to say */ }

// 10. The upgrade itself, always last so it lands after the preparation.
if (installed && cmp(installed, TARGET) < 0) {
  add("info", `Upgrade ${installed} → ${TARGET}`,
    "Run this only after the blockers above are cleared.",
    "git pull && npm install" + (cmp(TARGET, "2.3.0") >= 0 ? " && npm run doctor:fleet" : " && npm run doctor") + " && npm restart",
    { installed, target: TARGET });
}

// --- output ------------------------------------------------------------------

recs.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
const summary = {
  blockers: recs.filter((r) => r.severity === "blocker").length,
  warnings: recs.filter((r) => r.severity === "warn").length,
  info: recs.filter((r) => r.severity === "info").length,
};

if (JSON_OUT) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    harness: { dir: DIR, installed, target: TARGET, branch, upstream, ahead, uncommitted: dirty.length },
    bots: bots.map((b) => ({
      name: b.name, tokenVar: b.tokenVar, permissionMode: b.permissionMode,
      wsPort: b.wsPort, stateRoot: botStateRoot(b), scheduleCount: schedulesOf(b).jobs.length,
    })),
    summary,
    recommendations: recs,
  }, null, 2));
  process.exit(summary.blockers ? 1 : 0);
}

console.log(`\nslashbin-ai-team upgrade advisor`);
console.log(`  install : ${DIR}`);
console.log(`  version : ${installed || "unknown"}  →  ${TARGET}`);
console.log(`  bots    : ${bots.length ? bots.map((b) => b.name).join(", ") : "single-bot install"}\n`);

if (!recs.length) {
  console.log("  Nothing to do before upgrading.\n");
  process.exit(0);
}

const LABEL = { blocker: "BLOCKER", warn: "WARN   ", info: "INFO   " };
for (const r of recs) {
  console.log(`  [${LABEL[r.severity]}] ${r.id}  ${r.title}`);
  console.log(`      why: ${r.why}`);
  console.log(`      do : ${r.action}\n`);
}
console.log(`  ${summary.blockers} blocker(s), ${summary.warnings} warning(s), ${summary.info} informational`);
console.log(`  Machine-readable: npm run advise -- --json\n`);
process.exit(summary.blockers ? 1 : 0);
