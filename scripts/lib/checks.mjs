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
    for (const f of readdirSync(sourceDir)) {
      if (!/\.(js|mjs|cjs)$/.test(f) || f.startsWith("ecosystem")) continue;
      const src = readFileSync(join(sourceDir, f), "utf8");
      // Settings are read two ways and BOTH count. Matching only the first form
      // reported every envInt-backed setting as dead — a false positive that would
      // have had operators deleting working configuration.
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]);
      for (const m of src.matchAll(/envInt\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) read.add(m[1]);
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
