#!/usr/bin/env node
/**
 * `npm run doctor` — is this install actually going to work?
 *
 * Non-interactive. Runs every check against the current configuration and exits
 * non-zero if any fails, so it drops straight into CI or a container entrypoint.
 * This is what to run when the bot stops working, and what to paste into a bug
 * report. It prints no secret values.
 */
import "dotenv/config";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  checkNode, checkClaudeCli, checkDiscordToken, checkMessageContentIntent,
  checkClaudeCwd, checkPortFree, checkAllowlist, checkEcosystem, checkStateDir,
  checkReservedCommands, checkScheduleCadence, checkRunningCodeFresh,
  checkBillingKeyAbsent, checkFleet, parseFleet, render, skip,
} from "./lib/checks.mjs";

const HARNESS = dirname(dirname(fileURLToPath(import.meta.url)));
const ECOSYSTEM = join(HARNESS, "ecosystem.config.js");
const FLEET = process.argv.includes("--fleet");
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS) || 30 * 60 * 1000;

// A host that launches its bots from ecosystem.config.js gives each one its OWN
// DISCORD_TOKEN and CLAUDE_CWD. The ambient shell carries neither, so the
// single-bot checks below have no subject — they are not failing, they are
// asking about a bot that does not exist at this level. Reporting that as FAIL
// is how a real failure gets ignored: `npm run doctor` was permanently red on
// the 2-bot host with nothing wrong, so the gate stopped being read.
// `--fleet` checks each bot properly, against its own token and its own cwd.
const FLEET_BOTS = parseFleet(ECOSYSTEM);
const PER_BOT_ENV = FLEET_BOTS.length > 0 && !process.env.DISCORD_TOKEN && !process.env.CLAUDE_CWD;
const DEFER = `This host runs ${FLEET_BOTS.length} bot(s) from ecosystem.config.js, each with its own credentials. Run \`npm run doctor:fleet\` — it checks every bot against its own token and CLAUDE_CWD.`;

console.log(`\nslashbin-ai-team doctor${FLEET ? " — fleet" : ""}\n`);

const results = [];
results.push(await checkNode());
results.push(await checkClaudeCli());
if (PER_BOT_ENV) {
  results.push(skip("Discord token", "per-bot — not set at host level", DEFER));
  results.push(skip("Message Content Intent", "per-bot — needs a bot's own token", DEFER));
  results.push(skip("CLAUDE_CWD", "per-bot — each app sets its own", DEFER));
} else {
  results.push(await checkDiscordToken(process.env.DISCORD_TOKEN));
  results.push(await checkMessageContentIntent(process.env.DISCORD_TOKEN));
  results.push(await checkClaudeCwd(process.env.CLAUDE_CWD || process.cwd(), HARNESS));
}
results.push(await checkPortFree(process.env.WS_PORT || 9800));
results.push(checkReservedCommands(process.env.CLAUDE_CWD || process.cwd(), process.env.BOT_STOP_WORDS));
if (PER_BOT_ENV) {
  // Same reason as the token: each app sets its own in ecosystem.config.js.
  // checkFleet verifies both per bot, so nothing is lost by deferring here.
  results.push(skip("State directory", "per-bot — each app sets BOT_STATE_DIR", DEFER));
  results.push(skip("ALLOWED_USERS", "per-bot — each app sets its own", DEFER));
} else {
  results.push(checkStateDir(process.env.BOT_STATE_DIR, process.env.BOT_HISTORY_DIR, HARNESS));
  results.push(checkAllowlist(process.env.ALLOWED_USERS));
}
// Upgrade readiness — what bites on the next restart, which is the question an
// operator actually has and the one nothing used to answer.
results.push(checkBillingKeyAbsent(process.env));
results.push(checkScheduleCadence(process.env.BOT_STATE_DIR, process.env.BOT_HISTORY_DIR, HARNESS, SESSION_TIMEOUT_MS));
results.push(checkRunningCodeFresh(HARNESS, process.env.BOT_NAME));
results.push(...checkEcosystem(ECOSYSTEM, HARNESS));

if (FLEET) {
  results.push(...(await checkFleet(ECOSYSTEM, HARNESS, process.env)));
}

const failed = render(results);

// A multi-bot host that only ever checks one bot is how a reset token stays
// invisible until it restart-loops after an upgrade. Say so, once, where it is read.
if (!FLEET) {
  const fleetSize = parseFleet(ECOSYSTEM).length;
  if (fleetSize > 1) {
    console.log(`\n  ${fleetSize} bots are configured here, and the checks above cover only the one`);
    console.log("  in this environment. Run `npm run doctor:fleet` to check all of them.");
  }
}

if (failed) {
  console.log("\n  Fix the [FAIL] lines above, then run `npm run doctor` again.\n");
} else {
  console.log("\n  Ready. Start with `npm start`.\n");
}
process.exit(failed ? 1 : 0);
