#!/usr/bin/env node

/**
 * Discord Chat History Summarizer
 *
 * Background script that fetches Discord messages since the last run,
 * summarizes them with Claude, and stores daily summaries on disk.
 * These summaries are searched by the bot's /remember command.
 *
 * Usage:
 *   node summarize.js                  # summarize all tracked channels
 *   node summarize.js --dry-run        # fetch and show what would be summarized
 *
 * Run on a schedule (cron, pm2, systemd timer) — e.g., daily at midnight.
 */

require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } = require("fs");
const { join } = require("path");
const summarizeCore = require("./lib/summarize-core");
const { resolvePermissionMode } = require("./lib/permission-mode");

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();
// Must resolve identically to bot.js. This used to hardcode .bot-history/, so
// on any bot that sets BOT_HISTORY_DIR (both of ours do) `npm run summarize`
// wrote summaries and checkpoints into a directory the bot never reads —
// the work looked successful and reached nothing.
const HISTORY_DIR = process.env.BOT_HISTORY_DIR
  ? (process.env.BOT_HISTORY_DIR.startsWith("/") ? process.env.BOT_HISTORY_DIR : join(__dirname, process.env.BOT_HISTORY_DIR))
  : join(__dirname, ".bot-history");
// Must resolve identically to bot.js. The checkpoint moved to the state root with
// the rest of the runtime state; if these two disagree the summarizer re-reads
// from the beginning and rewrites days that already have summaries.
const STATE_DIR = process.env.BOT_STATE_DIR
  ? (process.env.BOT_STATE_DIR.startsWith("/") ? process.env.BOT_STATE_DIR : join(__dirname, process.env.BOT_STATE_DIR))
  : HISTORY_DIR;
const CHECKPOINT_FILE = join(STATE_DIR, ".checkpoints.json");
const SUMMARIZE_CHANNELS = process.env.SUMMARIZE_CHANNELS
  ? process.env.SUMMARIZE_CHANNELS.split(",").filter(Boolean)
  : (process.env.MONITOR_CHANNELS || "").split(",").filter(Boolean);
const SUMMARIZE_BATCH_SIZE = parseInt(process.env.SUMMARIZE_BATCH_SIZE, 10) || 200;
const DRY_RUN = process.argv.includes("--dry-run");

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required");
  process.exit(1);
}

if (SUMMARIZE_CHANNELS.length === 0) {
  console.error("No channels to summarize. Set SUMMARIZE_CHANNELS or MONITOR_CHANNELS in .env");
  process.exit(1);
}

// --- Checkpoint tracking ---
function loadCheckpoints() {
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCheckpoints(checkpoints) {
  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoints, null, 2));
}

// --- Discord message fetching ---
// Fetches all messages after a given snowflake ID, paginating as needed
async function fetchMessagesSince(channel, afterId) {
  const allMessages = [];
  let lastId = afterId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.after = lastId;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    // batch is sorted newest-first by Discord API
    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    allMessages.push(...sorted);
    lastId = sorted[sorted.length - 1].id;

    // Safety limit
    if (allMessages.length >= SUMMARIZE_BATCH_SIZE) {
      console.log(`  Hit batch size limit (${SUMMARIZE_BATCH_SIZE}), stopping fetch`);
      break;
    }

    // If we got less than 100, we've reached the end
    if (batch.size < 100) break;
  }

  return allMessages;
}

// --- Group messages by date ---
function groupByDate(messages) {
  const groups = {};
  for (const msg of messages) {
    const date = msg.createdAt.toISOString().split("T")[0]; // YYYY-MM-DD
    if (!groups[date]) groups[date] = [];
    groups[date].push({
      timestamp: msg.createdAt.toISOString(),
      author: msg.author.tag,
      content: msg.content.substring(0, 2000),
      isBot: msg.author.bot,
    });
  }
  return groups;
}

// --- Claude summarization ---
function summarizeWithClaude(channelName, date, messages) {
  const transcript = messages
    .map((m) => `[${m.timestamp}] ${m.isBot ? "(bot) " : ""}${m.author}: ${m.content}`)
    .join("\n");
  return summarizeCore.summarize({
    transcript,
    kind: "channel-day",
    channelName,
    date,
    claudeBin: CLAUDE_BIN,
    cwd: CLAUDE_CWD,
    model: process.env.SUMMARIZE_MODEL || process.env.CLAUDE_MODEL,
    timeoutMs: Number.parseInt(process.env.SUMMARIZE_TIMEOUT_MS, 10) > 0
      ? Number.parseInt(process.env.SUMMARIZE_TIMEOUT_MS, 10)
      : 120000,
    // Resolved through the SHARED resolver, not a second copy of the rule — a
    // host-level default that one process honours and the other ignores is worse
    // than no default at all. Summarisation reads a transcript already present in
    // its prompt, so it needs no write or execute tools.
    permissionArgs: resolvePermissionMode().mode === "bypass"
      ? ["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"]
      : ["--tools", process.env.BOT_SUMMARIZER_TOOLS || "Read"],
  });
}

// --- Write summary to disk ---
// Must behave identically to bot.js's copy — see the comment there. APPENDS:
// overwriting destroyed a whole day of summaries every time the summarizer ran,
// because the checkpoint means each run only covers messages since the last one.
// (Fourth place this logic is duplicated. See slashbin-ai-team#44.)
function writeSummary(channelName, date, messageCount, summary, channelId = null) {
  return summarizeCore.writeSummary({
    historyDir: HISTORY_DIR, channelName, date, messageCount, summary, channelId,
    kind: "channel-day", timezone: process.env.BOT_TIMEZONE,
  });
}

// --- Main ---
async function main() {
  console.log("Discord Chat History Summarizer");
  console.log(`Channels: ${SUMMARIZE_CHANNELS.join(", ")}`);
  console.log(`History dir: ${HISTORY_DIR}`);
  if (DRY_RUN) console.log("DRY RUN — no summaries will be written\n");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  await client.login(DISCORD_TOKEN);
  console.log(`Logged in as ${client.user.tag}\n`);

  const checkpoints = loadCheckpoints();
  let totalMessages = 0;
  let totalSummaries = 0;

  for (const channelId of SUMMARIZE_CHANNELS) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.log(`Skipping ${channelId} — not a text channel`);
        continue;
      }

      const channelName = (channel.name || `dm-${channelId}`).replace(/[^a-zA-Z0-9-_]/g, "-");
      const afterId = checkpoints[channelId] || null;

      console.log(`#${channelName} (${channelId})`);
      console.log(`  Checkpoint: ${afterId || "(none — first run)"}`);

      const messages = await fetchMessagesSince(channel, afterId);
      console.log(`  Fetched: ${messages.length} new messages`);

      if (messages.length === 0) {
        console.log(`  Nothing to summarize\n`);
        continue;
      }

      totalMessages += messages.length;
      const groups = groupByDate(messages);
      const dates = Object.keys(groups).sort();

      for (const date of dates) {
        const dayMessages = groups[date];
        console.log(`  ${date}: ${dayMessages.length} messages`);

        if (DRY_RUN) {
          console.log(`    Would summarize ${dayMessages.length} messages`);
          continue;
        }

        const summary = await summarizeWithClaude(channelName, date, dayMessages);
        const filepath = writeSummary(channelName, date, dayMessages.length, summary, channelId);
        console.log(`    Saved: ${filepath}`);
        totalSummaries++;
      }

      // Update checkpoint to the last message we processed
      const lastMessage = messages[messages.length - 1];
      checkpoints[channelId] = lastMessage.id;

      if (!DRY_RUN) {
        saveCheckpoints(checkpoints);
      }

      console.log(`  Checkpoint updated: ${lastMessage.id}\n`);
    } catch (err) {
      console.error(`Error processing ${channelId}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${totalMessages} messages → ${totalSummaries} summaries`);
  client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
