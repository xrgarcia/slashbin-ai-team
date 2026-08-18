/**
 * Shared validation used by `npm run doctor` and `npm run setup`.
 *
 * Every check answers one question a new operator would otherwise answer by
 * staring at a silent bot. The rule for all of them: confirm a credential by its
 * EFFECT (the bot's own username comes back), never by printing it. Nothing in
 * this file may write a token, and nothing may write a value read from a config
 * file whose key looks credential-bearing.
 */
import { existsSync, statSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { createServer } from "net";
import { execFile } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";

const run = promisify(execFile);

export const PASS = "pass", FAIL = "fail", WARN = "warn";
const ok = (name, detail) => ({ name, status: PASS, detail });
const bad = (name, detail, fix) => ({ name, status: FAIL, detail, fix });
const warn = (name, detail, fix) => ({ name, status: WARN, detail, fix });

export async function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 18
    ? ok("Node.js", `v${process.versions.node}`)
    : bad("Node.js", `v${process.versions.node} is too old`, "Install Node.js 18 or newer.");
}

export async function checkClaudeCli(bin = process.env.CLAUDE_BIN || "claude") {
  try {
    const { stdout } = await run(bin, ["--version"], { timeout: 15000 });
    return ok("Claude Code CLI", stdout.trim().split("\n")[0]);
  } catch {
    return bad(
      "Claude Code CLI",
      `'${bin}' not found or not runnable`,
      "Install the Claude Code CLI and make sure it is on PATH, then run `claude` once to authenticate. Set CLAUDE_BIN if it lives elsewhere."
    );
  }
}

/**
 * Prove the token works by asking Discord who it belongs to. On success we report
 * the bot's username — the token itself is never echoed, logged, or returned.
 */
export async function checkDiscordToken(token) {
  if (!token) {
    return bad("Discord token", "DISCORD_TOKEN is not set", "Set DISCORD_TOKEN in your .env — see docs/INSTALL.md step 2.");
  }
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) {
      return bad("Discord token", "Discord rejected the token", "The token is wrong or has been reset. Copy it again from the Developer Portal → your app → Bot → Reset Token.");
    }
    if (!res.ok) return bad("Discord token", `Discord returned HTTP ${res.status}`, "Check network access to discord.com, then the token.");
    const me = await res.json();
    return ok("Discord token", `authenticates as ${me.username}`);
  } catch (e) {
    return bad("Discord token", `could not reach Discord: ${e.message}`, "Check network access to discord.com.");
  }
}

/**
 * The check that saves the most time. With Message Content Intent off, the bot
 * connects successfully and then ignores every message — indistinguishable from a
 * working bot by any other signal.
 *
 * NOTE both flags count. An app in fewer than 100 servers gets
 * GATEWAY_MESSAGE_CONTENT_LIMITED (1<<19) rather than the verified
 * GATEWAY_MESSAGE_CONTENT (1<<18); that is the normal state for most self-hosted
 * bots and it works. Checking only the verified flag would fail nearly every user.
 */
export async function checkMessageContentIntent(token) {
  if (!token) return warn("Message Content Intent", "skipped — no token", null);
  try {
    const res = await fetch("https://discord.com/api/v10/applications/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return warn("Message Content Intent", `could not read application flags (HTTP ${res.status})`, null);
    const app = await res.json();
    const VERIFIED = 1 << 18, LIMITED = 1 << 19;
    if (app.flags & (VERIFIED | LIMITED)) {
      return ok("Message Content Intent", app.flags & LIMITED ? "enabled (limited — normal under 100 servers)" : "enabled");
    }
    return bad(
      "Message Content Intent",
      "DISABLED — the bot will connect and then ignore every message",
      "Discord Developer Portal → your app → Bot → Privileged Gateway Intents → turn ON 'Message Content Intent', then restart the bot."
    );
  } catch (e) {
    return warn("Message Content Intent", `could not check: ${e.message}`, null);
  }
}

export async function checkClaudeCwd(cwd, harnessDir) {
  if (!cwd) return bad("CLAUDE_CWD", "not set", "Set CLAUDE_CWD to YOUR project directory — the repo holding the CLAUDE.md that gives the bot its role.");
  const abs = resolve(cwd);
  if (!existsSync(abs)) return bad("CLAUDE_CWD", `${abs} does not exist`, "Point CLAUDE_CWD at a directory that exists.");
  if (!statSync(abs).isDirectory()) return bad("CLAUDE_CWD", `${abs} is not a directory`, "CLAUDE_CWD must be a directory.");
  if (harnessDir && resolve(harnessDir) === abs) {
    return bad(
      "CLAUDE_CWD",
      "points at the harness itself",
      "CLAUDE_CWD is your project, not this repo. Pointing it here gives the bot no role and lets it edit the harness."
    );
  }
  const notes = [];
  notes.push(existsSync(join(abs, "CLAUDE.md")) ? "CLAUDE.md found" : "no CLAUDE.md (the bot will have no role)");
  notes.push(existsSync(join(abs, ".mcp.json")) ? ".mcp.json found" : "no .mcp.json (no external tools)");
  const anyMissing = notes.some((n) => n.startsWith("no "));
  return anyMissing
    ? warn("CLAUDE_CWD", `${abs} — ${notes.join(", ")}`, "Add a CLAUDE.md to give the bot its role. See CLAUDE.md.example.")
    : ok("CLAUDE_CWD", `${abs} — ${notes.join(", ")}`);
}

export async function checkPortFree(port, label = "WS_PORT") {
  const p = Number(port) || 9800;
  const free = await new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.once("listening", () => s.close(() => res(true)));
    s.listen(p, "127.0.0.1");
  });
  return free
    ? ok(label, `${p} is free`)
    : bad(label, `${p} is already in use`, `Another process (often a second bot) holds ${p}. Give each bot a unique ${label}.`);
}

/**
 * Where this bot's memory lives, and whether it can actually be written.
 * A read-only or full volume surfaces today as a summarizer that quietly saves
 * nothing — the work looks successful and reaches no one.
 */
/**
 * A bot command the harness would swallow.
 * The harness intercepts these before Claude sees the message, so a same-named
 * command in the bot's own repo can never run — and the bot still lists it when
 * asked what it can do, because from inside Claude that command is real.
 */
export function checkReservedCommands(claudeCwd, stopWords) {
  const reserved = ["fresh", "status", ...(stopWords || "stop,halt,abort,cancel").split(",").map((w) => w.trim()).filter(Boolean)];
  const hits = [];
  for (const [dir, suffix] of [[join(claudeCwd, ".claude", "commands"), ".md"],
                               [join(claudeCwd, ".claude", "skills"), ""]]) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const name = suffix ? e.replace(/\.md$/, "") : e;
      if (reserved.includes(name.toLowerCase())) hits.push(join(dir, e));
    }
  }
  return hits.length
    ? bad("Reserved commands", `${hits.length} of this bot's command(s) can never run: ${hits.join(", ")}`,
        `The harness answers ${reserved.map((r) => "/" + r).join(", ")} before Claude sees the message. Rename yours — nothing errors today, it just silently never runs.`)
    : ok("Reserved commands", `no collision with ${reserved.map((r) => "/" + r).join(", ")}`);
}

export function checkStateDir(stateDir, historyDir, harnessDir) {
  const root = resolve(stateDir || historyDir || join(harnessDir, ".bot-history"));
  try {
    mkdirSync(root, { recursive: true });
    const probe = join(root, ".doctor-write-probe");
    writeFileSync(probe, "ok");
    unlinkSync(probe);
  } catch (e) {
    return bad("State directory", `${root} is not writable (${e.message})`,
      "The bot cannot save summaries, sessions or attachments here. Fix permissions, or point BOT_STATE_DIR somewhere writable.");
  }
  const inRepo = existsSync(join(root, ".git")) || existsSync(join(resolve(root, ".."), ".git"));
  return inRepo
    ? warn("State directory", `${root} — writable, inside a git working tree`,
        "Fine for summaries, which are meant to be portable. But point BOT_ATTACHMENTS_DIR outside any repo: inbound files are arbitrary binaries, and `git clean -x` or a re-clone will take them.")
    : ok("State directory", `${root} — writable`);
}

export function checkAllowlist(allowedUsers) {
  const list = (allowedUsers || "").split(",").filter(Boolean);
  return list.length
    ? ok("ALLOWED_USERS", `${list.length} user(s) allowed`)
    : warn(
        "ALLOWED_USERS",
        "empty — EVERY Discord user who can reach this bot can drive it",
        "Set ALLOWED_USERS to your Discord user ID (Settings → Advanced → Developer Mode, then right-click your name → Copy User ID). Set BOT_REQUIRE_ALLOWLIST=true to refuse to start without it."
      );
}

const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|APIKEY|API_KEY|_KEY|AUTH|WEBHOOK|DSN)$/i;

/**
 * Validate a PM2 ecosystem file WITHOUT evaluating it and without printing any
 * value whose key looks credential-bearing.
 */
export function checkEcosystem(file, sourceDir) {
  if (!existsSync(file)) return [warn("ecosystem config", "not present — single-bot install", null)];
  const text = readFileSync(file, "utf8");
  const out = [];

  const names = [...text.matchAll(/^\s*BOT_NAME:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  out.push(dupNames.length
    ? bad("ecosystem: BOT_NAME", `duplicate: ${[...new Set(dupNames)].join(", ")}`, "Each app needs a unique BOT_NAME — they share state files otherwise.")
    : ok("ecosystem: BOT_NAME", `${names.length} app(s), all unique`));

  const ports = [...text.matchAll(/^\s*WS_PORT:\s*['"]?(\d+)/gm)].map((m) => m[1]);
  const dupPorts = ports.filter((p, i) => ports.indexOf(p) !== i);
  out.push(dupPorts.length
    ? bad("ecosystem: WS_PORT", `collision on ${[...new Set(dupPorts)].join(", ")}`, "Each bot needs a unique WS_PORT — the second one crashes at startup.")
    : ok("ecosystem: WS_PORT", ports.length ? `${ports.join(", ")} — unique` : "none set"));

  const literals = [];
  for (const m of text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(['"])([\s\S]*?)\2/gm)) {
    if (SECRET_KEY.test(m[1])) literals.push({ key: m[1], len: m[3].length });
  }
  out.push(literals.length
    ? bad("ecosystem: credentials", `${literals.map((l) => `${l.key} (${l.len} chars)`).join(", ")} stored as literals`,
        "Move these to the environment (.env or Doppler) and reference them as process.env.NAME. A gitignored file is not a safe place for a token. ROTATE anything found here.")
    : ok("ecosystem: credentials", "none stored in the file"));

  if (sourceDir) {
    const read = new Set();
    // Shared modules count too. Scanning only the top level reported
    // BOT_PERMISSION_MODE as dead the moment its resolution moved into lib/ — a
    // setting every bot depends on, recommended for deletion.
    const files = [];
    for (const f of readdirSync(sourceDir)) {
      if (/\.(js|mjs|cjs)$/.test(f) && !f.startsWith("ecosystem")) files.push(join(sourceDir, f));
    }
    const libDir = join(sourceDir, "lib");
    if (existsSync(libDir)) {
      for (const f of readdirSync(libDir)) {
        if (/\.(js|mjs|cjs)$/.test(f)) files.push(join(libDir, f));
      }
    }
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Settings are read three ways and ALL count. Matching only the first form
      // reported every envInt-backed setting as dead — a false positive that would
      // have had operators deleting working configuration.
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]);
      for (const m of src.matchAll(/envInt\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) read.add(m[1]);
      // A shared resolver takes the environment as a parameter and reads `env.NAME`.
      // Anchored so `.env` filenames and `cleanEnv.NAME` deletions do not count.
      for (const m of src.matchAll(/(?<![.\w])env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]);
    }
    const set = [...text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]);
    const dead = [...new Set(set)].filter((k) => !read.has(k) && k !== "NODE_ENV");
    out.push(dead.length
      ? warn("ecosystem: dead settings", dead.join(", "), "These are set but read by no source file — remove them, or they will be mistaken for working configuration.")
      : ok("ecosystem: dead settings", "none"));
  }
  return out;
}

export function render(results) {
  const icon = { [PASS]: "PASS", [FAIL]: "FAIL", [WARN]: "WARN" };
  let failed = 0, warned = 0;
  for (const r of results) {
    if (r.status === FAIL) failed++;
    if (r.status === WARN) warned++;
    console.log(`  [${icon[r.status]}] ${r.name}: ${r.detail}`);
    if (r.fix && r.status !== PASS) console.log(`         -> ${r.fix}`);
  }
  console.log(`\n  ${results.length - failed - warned} passed, ${warned} warning(s), ${failed} failed`);
  return failed;
}

// --- Upgrade readiness -----------------------------------------------------
// These answer "what will bite me when I restart", which is the question an
// operator actually has and the one nothing used to answer. Each maps to a
// failure that has really happened on a running fleet.

const require_ = createRequire(import.meta.url);

/**
 * A schedule firing faster than the session idle timeout.
 *
 * Sessions expire on IDLE, so a job tighter than SESSION_TIMEOUT_MS keeps its
 * channel permanently busy and the session never rotates. Before 2.2.1 that meant
 * every fire re-sent the whole accumulated history — a 10-minute poll held one
 * session open for 28.8 hours and cost ~$1,664 in a day while correctly finding
 * nothing. 2.2.1 makes scheduled runs ephemeral, so this is no longer a cost bug;
 * it stays a check because on any earlier version it IS one, and because a job
 * tighter than its own runtime overlaps itself regardless of version.
 */
export function checkScheduleCadence(stateDir, historyDir, harnessDir, sessionTimeoutMs) {
  const { jobsTighterThanTimeout } = require_("../../lib/cron-cadence.js");
  const root = resolve(stateDir || historyDir || join(harnessDir, ".bot-history"));
  const file = join(root, "schedules.json");
  if (!existsSync(file)) return ok("Scheduled jobs", "none configured");

  let jobs;
  try {
    jobs = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return warn("Scheduled jobs", `${file} could not be parsed (${e.message})`,
      "The scheduler will treat this as no jobs at all. Fix the JSON or the schedules are silently gone.");
  }
  const count = Array.isArray(jobs) ? jobs.length : 0;
  if (!count) return ok("Scheduled jobs", "none configured");

  const timeoutMs = sessionTimeoutMs || 30 * 60 * 1000;
  const tight = jobsTighterThanTimeout(jobs, timeoutMs);
  if (!tight.length) return ok("Scheduled jobs", `${count} job(s), none tighter than the session timeout`);

  const listed = tight.map((t) => `${t.id} every ${t.everyMinutes}m`).join(", ");
  return warn("Scheduled jobs", `${listed} — tighter than the ${tight[0].timeoutMinutes}m session timeout`,
    "On 2.2.0 and earlier these hold their channel's session open permanently: sessions expire on IDLE, and a job this frequent is never idle, so every fire re-sends the whole accumulated conversation. Upgrade to 2.2.1+, where scheduled runs are ephemeral. Even after upgrading, check the job cannot overlap its own previous run.");
}

/**
 * Is the running bot executing the code that is on disk?
 *
 * The working tree IS the deployment — PM2 runs bot.js straight out of the
 * checkout, and Node reads it once at startup. So an edit or a `git pull` reaches
 * a bot only when that bot next restarts, and a fleet restarted at different times
 * runs different code with nothing to say so. Measured on the maintainer host: two
 * bots, same checkout, four days apart in what they were actually running.
 *
 * The readiness marker is written when a bot connects, so its mtime is that bot's
 * last successful start. No process manager required.
 */
export function checkRunningCodeFresh(harnessDir, botName) {
  const botFile = join(harnessDir, "bot.js");
  const ready = join(harnessDir, `.${botName || "bot"}.ready`);
  if (!existsSync(botFile)) return warn("Running code", "bot.js not found", null);
  if (!existsSync(ready)) return ok("Running code", "this bot is not currently connected — it will pick up the current code on start");

  const code = statSync(botFile).mtimeMs;
  const started = statSync(ready).mtimeMs;
  if (started >= code) return ok("Running code", "the connected bot is running the code on disk");

  const hours = Math.round((code - started) / 3600000);
  return warn("Running code", `this bot connected BEFORE bot.js was last changed (~${hours}h of drift)`,
    "It is running the previous code from memory — Node reads bot.js once at startup. Restart it, or it keeps running whatever the file said when it launched.");
}

/**
 * A credential that silently changes who pays.
 *
 * The harness hands its own environment to every Claude process it spawns. If
 * ANTHROPIC_API_KEY is present, those runs bill as API usage instead of using the
 * subscription the operator thinks they are on — with nothing in any log to say so.
 */
export function checkBillingKeyAbsent(env = process.env) {
  return env.ANTHROPIC_API_KEY
    ? warn("Claude billing", "ANTHROPIC_API_KEY is set in this environment",
        "Every Claude run the bot spawns inherits it and bills as metered API usage rather than your subscription. If that is not what you want, unset it in the environment the bot is launched from — a wrapper that `unset`s it before exec, or restarting your process manager from a clean shell. Setting it to an empty string does NOT work; it must be absent.")
    : ok("Claude billing", "ANTHROPIC_API_KEY not set — Claude runs use the CLI's own auth");
}

/**
 * Read the per-bot settings out of a PM2 ecosystem file WITHOUT evaluating it.
 *
 * Evaluating it would execute arbitrary JS and, worse, would resolve the token
 * references into memory. This walks app blocks textually and returns only the
 * NAME of the variable each bot's token comes from, never a value.
 */
export function parseFleet(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const bots = [];
  // Split on BOT_NAME, which every app must set uniquely (checkEcosystem enforces).
  const blocks = text.split(/^\s*\{\s*$/m);
  for (const block of blocks) {
    const name = /^\s*BOT_NAME:\s*['"]([^'"]+)['"]/m.exec(block);
    if (!name) continue;
    const tokenRef = /^\s*DISCORD_TOKEN:\s*process\.env\.([A-Z0-9_]+)/m.exec(block);
    const pick = (key) => {
      const m = new RegExp(`^\\s*${key}:\\s*['"]([^'"]*)['"]`, "m").exec(block);
      return m ? m[1] : null;
    };
    bots.push({
      name: name[1],
      tokenVar: tokenRef ? tokenRef[1] : null,
      claudeCwd: pick("CLAUDE_CWD"),
      wsPort: pick("WS_PORT"),
      permissionMode: pick("BOT_PERMISSION_MODE"),
      stateDir: pick("BOT_STATE_DIR"),
      historyDir: pick("BOT_HISTORY_DIR"),
      sessionTimeoutMs: Number(pick("SESSION_TIMEOUT_MS")) || null,
    });
  }
  return bots;
}

/**
 * Every bot in the fleet, checked in one pass.
 *
 * Doctor otherwise validates whichever single bot's configuration happens to be in
 * the ambient environment, so an operator with eight bots had to run it eight
 * times with eight different environments loaded — which in practice means the
 * check does not get run, and a token that has been reset only announces itself
 * when the bot restart-loops after an upgrade.
 */
export async function checkFleet(file, harnessDir, env = process.env) {
  const bots = parseFleet(file);
  if (!bots.length) return [warn("Fleet", "no bots found in ecosystem.config.js", "Expected app entries each setting BOT_NAME.")];

  const out = [ok("Fleet", `${bots.length} bot(s) configured: ${bots.map((b) => b.name).join(", ")}`)];
  const hostDefault = env.BOT_PERMISSION_MODE_DEFAULT;

  for (const b of bots) {
    const label = `  ${b.name}`;

    if (!b.tokenVar) {
      out.push(warn(`${label}: token`, "DISCORD_TOKEN is not a process.env reference",
        "Point it at an environment variable so the token is never stored in the file."));
    } else if (!env[b.tokenVar]) {
      out.push(warn(`${label}: token`, `${b.tokenVar} is not set in this shell`,
        `Run doctor in the same environment PM2 launches from (e.g. under your secrets manager), or this bot's token cannot be verified.`));
    } else {
      const res = await checkDiscordToken(env[b.tokenVar]);
      out.push({ ...res, name: `${label}: token` });
    }

    if (b.claudeCwd && !existsSync(b.claudeCwd)) {
      out.push(bad(`${label}: CLAUDE_CWD`, `${b.claudeCwd} does not exist`,
        "The bot exits at startup rather than failing on the first message. Fix the path."));
    }

    const mode = b.permissionMode || hostDefault;
    if (!mode) {
      out.push(warn(`${label}: tools`, "no permission mode set, and no host default",
        "This bot starts in `restricted` and cannot write files or run commands. Set BOT_PERMISSION_MODE_DEFAULT once for the host, or BOT_PERMISSION_MODE on this bot."));
    }

    out.push({
      ...checkScheduleCadence(b.stateDir, b.historyDir, harnessDir, b.sessionTimeoutMs || Number(env.SESSION_TIMEOUT_MS) || 30 * 60 * 1000),
      name: `${label}: schedules`,
    });
    out.push({ ...checkRunningCodeFresh(harnessDir, b.name), name: `${label}: running code` });
  }
  return out;
}
