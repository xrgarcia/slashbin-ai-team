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
  checkReservedCommands, render,
} from "./lib/checks.mjs";

const HARNESS = dirname(dirname(fileURLToPath(import.meta.url)));

console.log("\nslashbin-ai-team doctor\n");

const results = [];
results.push(await checkNode());
results.push(await checkClaudeCli());
results.push(await checkDiscordToken(process.env.DISCORD_TOKEN));
results.push(await checkMessageContentIntent(process.env.DISCORD_TOKEN));
results.push(await checkClaudeCwd(process.env.CLAUDE_CWD || process.cwd(), HARNESS));
results.push(await checkPortFree(process.env.WS_PORT || 9800));
results.push(checkReservedCommands(process.env.CLAUDE_CWD || process.cwd(), process.env.BOT_STOP_WORDS));
results.push(checkStateDir(process.env.BOT_STATE_DIR, process.env.BOT_HISTORY_DIR, HARNESS));
results.push(checkAllowlist(process.env.ALLOWED_USERS));
results.push(...checkEcosystem(join(HARNESS, "ecosystem.config.js"), HARNESS));

const failed = render(results);
if (failed) {
  console.log("\n  Fix the [FAIL] lines above, then run `npm run doctor` again.\n");
} else {
  console.log("\n  Ready. Start with `npm start`.\n");
}
process.exit(failed ? 1 : 0);
