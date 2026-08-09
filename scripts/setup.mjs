#!/usr/bin/env node
/**
 * `npm run setup` — go from a fresh clone to a working config without reading
 * bot.js or guessing which of ~30 settings are required.
 *
 * Prompts for the handful that matter, validates them LIVE (a token is confirmed
 * by the bot's own username coming back, never by being printed), and writes .env
 * only once the answers hold up. Existing files are never overwritten silently.
 */
import "dotenv/config";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { writeFileSync, existsSync, copyFileSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  checkClaudeCli, checkDiscordToken, checkMessageContentIntent,
  checkClaudeCwd, checkPortFree, FAIL,
} from "./lib/checks.mjs";

const HARNESS = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = join(HARNESS, ".env");
const rl = createInterface({ input: stdin, output: stdout });

const say = (s = "") => console.log(s);
async function ask(question, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}
async function confirm(question) {
  const a = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
  return a === "y" || a === "yes";
}
function report(r) {
  say(`  [${r.status.toUpperCase()}] ${r.name}: ${r.detail}`);
  if (r.fix && r.status !== "pass") say(`         -> ${r.fix}`);
  return r;
}

say("\nslashbin-ai-team setup\n");
say("This writes a validated .env. It never prints your token.\n");

// --- Prerequisite that cannot be prompted away -------------------------------
if (report(await checkClaudeCli()).status === FAIL) {
  say("\nInstall the Claude Code CLI first — the bot is a wrapper around it.\n");
  rl.close();
  process.exit(1);
}

// --- Identity ----------------------------------------------------------------
const botName = await ask("Bot name (used for its pid/log/session files)", "bot");

// --- Token, validated before anything is written -----------------------------
let token = "";
for (let attempt = 1; ; attempt++) {
  token = await ask("Discord bot token (Developer Portal -> your app -> Bot -> Reset Token)");
  const tokenResult = report(await checkDiscordToken(token));
  if (tokenResult.status !== FAIL) {
    // Only worth checking once the token is known good.
    report(await checkMessageContentIntent(token));
    break;
  }
  if (attempt >= 3 || !(await confirm("Try a different token?"))) {
    say("\nStopping without writing anything.\n");
    rl.close();
    process.exit(1);
  }
}

// --- Project directory -------------------------------------------------------
let claudeCwd = "";
for (;;) {
  claudeCwd = resolve(await ask("Your project directory (the repo with YOUR CLAUDE.md — not this repo)", process.cwd()));
  const r = report(await checkClaudeCwd(claudeCwd, HARNESS));
  if (r.status !== FAIL) break;
  if (!(await confirm("Try a different directory?"))) { rl.close(); process.exit(1); }
}

// --- Access ------------------------------------------------------------------
say("\nAccess control. An empty allowlist means EVERY Discord user who can DM this");
say("bot, or post in a channel it watches, can drive it with full tool access.");
const allowedUsers = await ask("Your Discord user ID (Settings -> Advanced -> Developer Mode, right-click your name -> Copy User ID)", "");
if (!allowedUsers && !(await confirm("Leave this bot open to EVERYONE who can reach it?"))) {
  say("\nStopping. Re-run when you have your user ID.\n");
  rl.close();
  process.exit(1);
}

const monitorChannels = await ask("Channel IDs it should answer in without an @mention (comma-separated, blank = mention-only)", "");

// --- Port --------------------------------------------------------------------
let wsPort = "";
for (;;) {
  wsPort = await ask("WebSocket bridge port (must be unique per bot)", "9800");
  const r = report(await checkPortFree(wsPort));
  if (r.status !== FAIL) break;
}

const timezone = await ask("Timezone for the bot's clock (IANA name)", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

// --- Write -------------------------------------------------------------------
if (existsSync(ENV_PATH)) {
  say("");
  if (!(await confirm(".env already exists. Back it up to .env.bak and replace it?"))) {
    say("\nNothing written. Your existing configuration is untouched.\n");
    rl.close();
    process.exit(0);
  }
  copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
  say("  Backed up to .env.bak");
}

const lines = [
  "# Written by `npm run setup`. Re-run `npm run doctor` after editing.",
  "# Every other setting is documented in the README config table.",
  "",
  `BOT_NAME=${botName}`,
  `DISCORD_TOKEN=${token}`,
  `CLAUDE_CWD=${claudeCwd}`,
  `WS_PORT=${wsPort}`,
  `BOT_TIMEZONE=${timezone}`,
  "",
  "# Humans allowed to drive this bot. EMPTY MEANS EVERYONE.",
  `ALLOWED_USERS=${allowedUsers}`,
  "# Set to true to refuse to start when ALLOWED_USERS is empty.",
  `BOT_REQUIRE_ALLOWLIST=${allowedUsers ? "true" : "false"}`,
  "",
  "# Channels answered without an @mention. DMs always work.",
  `MONITOR_CHANNELS=${monitorChannels}`,
  "",
];
writeFileSync(ENV_PATH, lines.join("\n"));

say("");
say(`  Wrote ${ENV_PATH}`);
if (!existsSync(join(claudeCwd, "CLAUDE.md"))) {
  say(`  NOTE: ${claudeCwd} has no CLAUDE.md, so the bot has no role yet.`);
  say(`        Copy CLAUDE.md.example there and describe who it is.`);
}
say("");
say("  Next:  npm run doctor    # confirm everything still checks out");
say("         npm start         # start the bot");
say("");
rl.close();
