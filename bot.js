require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync, appendFileSync, readdirSync, readlinkSync, renameSync } = require("fs");
const { join } = require("path");
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");
const pino = require("pino");
const summarizeCore = require("./lib/summarize-core");
const { budgetContext, clampArgs, DEFAULT_CONTEXT_MAX_BYTES } = require("./lib/argv-budget");

// --- Logger ---
const log = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

/**
 * Read a numeric setting from the environment.
 *
 * The idiom this replaces — `parseInt(process.env.X, 10) || DEFAULT` — silently
 * swallows 0, NaN and negatives into the default, so a typo looks like a working
 * config. Worse, for a value like a poll interval, a 0 that DID get through would
 * be a hot loop. Clamp explicitly and say something when the input was garbage.
 */
function envInt(name, def, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    log.warn({ [name]: raw, using: def }, `${name} is not a number — using the default`);
    return def;
  }
  if (n < min) {
    log.warn({ [name]: n, min, using: def }, `${name} is below the minimum — using the default`);
    return def;
  }
  return n;
}

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();
const MAX_DISCORD_LENGTH = parseInt(process.env.MAX_DISCORD_LENGTH, 10) || 1900;
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 3600000;
const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS, 10) || 100;
const ALLOWED_USER_IDS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").filter(Boolean)
  : [];
const MONITOR_CHANNELS = process.env.MONITOR_CHANNELS
  ? process.env.MONITOR_CHANNELS.split(",").filter(Boolean)
  : [];
const ALLOWED_BOTS = process.env.ALLOWED_BOTS
  ? process.env.ALLOWED_BOTS.split(",").filter(Boolean)
  : [];
const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNELS
  ? process.env.ALLOWED_CHANNELS.split(",").filter(Boolean)
  : [];
const MAX_BOT_EXCHANGES = parseInt(process.env.MAX_BOT_EXCHANGES, 10) || 2;
const SUMMARIZE_INTERVAL_MS = parseInt(process.env.SUMMARIZE_INTERVAL_MS, 10) || 0;
const SUMMARIZE_CHANNELS = process.env.SUMMARIZE_CHANNELS
  ? process.env.SUMMARIZE_CHANNELS.split(",").filter(Boolean)
  : MONITOR_CHANNELS;
const SUMMARIZE_BATCH_SIZE = parseInt(process.env.SUMMARIZE_BATCH_SIZE, 10) || 200;
const SUMMARY_LOOKBACK_HOURS = parseInt(process.env.SUMMARY_LOOKBACK_HOURS, 10) || 48;
// How many bytes of remembered context (summaries + buffer) a fresh session may
// carry. Not a taste setting — the whole block travels as ONE command-line
// argument, and Linux rejects any single argument over 128KB with a bare
// `spawn E2BIG`. Raising this past ~120000 re-arms that failure.
const CONTEXT_MAX_BYTES = envInt("CONTEXT_MAX_BYTES", DEFAULT_CONTEXT_MAX_BYTES, { min: 4096 });
const HISTORY_DIR = process.env.BOT_HISTORY_DIR
  ? (process.env.BOT_HISTORY_DIR.startsWith("/") ? process.env.BOT_HISTORY_DIR : join(__dirname, process.env.BOT_HISTORY_DIR))
  : join(__dirname, ".bot-history");
// --- State root ---
// One place for everything a bot remembers. Summaries, attachments and the outbox
// were already configurable; the conversation buffer and the session map were NOT
// — they were pinned to the install directory. So the two artifacts recall needs
// most were the two you could not move, they were stranded by a re-clone, and any
// skill wanting them had to hardcode a path inside the harness. That is exactly
// how the shipped /remember came to read three files that did not exist.
//
// Resolution order, stated once and true everywhere: specific setting -> state
// root -> default. BOT_STATE_DIR defaults to BOT_HISTORY_DIR, so an existing
// install resolves to byte-identical paths.
const STATE_DIR = process.env.BOT_STATE_DIR
  ? (process.env.BOT_STATE_DIR.startsWith("/")
      ? process.env.BOT_STATE_DIR
      : join(__dirname, process.env.BOT_STATE_DIR))
  : HISTORY_DIR;

// Runtime state, not memory. HISTORY_DIR holds SUMMARIES — the reviewable record
// people deliberately keep in a repo. A user's schedules, the summarizer's read
// position and the job log are none of those things, and living in a working tree
// means one `git clean -x` or a re-clone destroys them. Gitignored is not safe;
// it is only invisible.
const CHECKPOINT_FILE = join(STATE_DIR, ".checkpoints.json");
// --- Tool exposure ---
// Every Claude invocation used to pass --dangerously-skip-permissions
// unconditionally, with no way to change it. Combined with an empty ALLOWED_USERS
// that meant any Discord user who could reach the bot got arbitrary code execution
// on the host. That is a reasonable trade for a private deployment; it is not a
// defensible default for a public project.
//
// MEASURED, not assumed (2026-08-09), because the obvious flags do not do what
// their names suggest in -p mode:
//   --allowedTools Read      -> restricts NOTHING. Bash still ran.
//   --permission-mode plan   -> restricts NOTHING. Bash exposed and used.
//   --tools Read,Grep        -> exposes EXACTLY those (plus connected MCP tools).
// So --tools is the real control surface, and the one we use.
const PERMISSION_MODE = process.env.BOT_PERMISSION_MODE || "restricted";
const DEFAULT_ALLOWED_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,TodoWrite";
const ALLOWED_TOOLS = process.env.BOT_ALLOWED_TOOLS || DEFAULT_ALLOWED_TOOLS;
// Summarisation reads a transcript that is already in its prompt. It never needs
// to write, edit or execute anything.
const SUMMARIZER_TOOLS = process.env.BOT_SUMMARIZER_TOOLS || "Read";

/**
 * The permission flags for one invocation.
 * `bypass` reproduces the historical behaviour byte-for-byte — that is the
 * documented one-line upgrade for anyone already running this harness.
 */
function permissionArgs(kind = "session") {
  if (PERMISSION_MODE === "bypass") {
    return ["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"];
  }
  return ["--tools", kind === "summarizer" ? SUMMARIZER_TOOLS : ALLOWED_TOOLS];
}

// How often the "typing…" indicator is refreshed while a request runs.
const TYPING_INTERVAL_MS = envInt("BOT_TYPING_INTERVAL_MS", 8000, { min: 1000 });
// Wall clock for ONE summarization run (three call sites, one setting).
const SUMMARIZE_TIMEOUT_MS = envInt("SUMMARIZE_TIMEOUT_MS", 120000, { min: 5000 });
// Grace period after login before the first summarizer cycle, so startup work settles.
const SUMMARIZER_START_DELAY_MS = envInt("BOT_SUMMARIZER_START_DELAY_MS", 10000, { min: 0 });

// Words that halt a run in flight. Configurable because "stop" is a vocabulary
// choice, not a protocol constant — a non-English channel needs its own.
const STOP_WORDS = (process.env.BOT_STOP_WORDS || "stop,halt,abort,cancel")
  .split(",").map((w) => w.trim()).filter(Boolean);
const STOP_ALTERNATION = STOP_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

// Legacy auto-attach: file types the bot may hand back merely by NAMING the path,
// without using the outbox or an [[attach:]] marker. Deliberately narrow — widening
// it starts attaching every repo document a bot happens to mention. Configurable,
// but read the warning in the README before adding to it.
const ATTACH_EXTENSIONS = (process.env.BOT_ATTACH_EXTENSIONS || "csv,pdf,xlsx,png,jpg")
  .split(",").map((e) => e.trim().replace(/^\./, "")).filter(Boolean);
// Compiled once and used by BOTH call sites. Two copies of this list existed,
// and making only one configurable is how a setting silently half-works.
const ATTACH_RE = new RegExp(`\\.(${ATTACH_EXTENSIONS.join("|")})$`, "i");

// --- Reserved commands ---
// The harness intercepts these before Claude ever sees the message. Declared ONCE
// so the collision warning, the injected context and the docs cannot drift from
// the behaviour — they were three separate literals in the message handler.
//
// A bot defining one of these in its own repo gets silently shadowed: the PO bot
// shipped a /status ("cross-customer status view") that could never run, and
// still listed it when asked what it could do, because from inside Claude that
// command is real. Nothing errored. Nothing logged.
const RESERVED_COMMANDS = ["fresh", "status", ...STOP_WORDS];

/**
 * Commands in the bot's own project that a reserved name would shadow.
 * Read from CLAUDE_CWD, which is where Claude Code looks for them.
 */
function shadowedCommands() {
  const hits = [];
  for (const [dir, suffix] of [[join(CLAUDE_CWD, ".claude", "commands"), ".md"],
                               [join(CLAUDE_CWD, ".claude", "skills"), ""]]) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const name = suffix ? entry.replace(new RegExp(`\\${suffix}$`), "") : entry;
      if (RESERVED_COMMANDS.includes(name.toLowerCase())) hits.push(join(dir, entry));
    }
  }
  return hits;
}

// --- Summarization coverage ---
// SUMMARIZE_CHANNELS defaults to MONITOR_CHANNELS, which answers the wrong
// question. "Where do I reply unprompted?" and "what is worth remembering?" are
// not the same, and the second must be at least as wide as everywhere the bot
// actually talks. As written, a conversation held entirely in a DM produced NO
// summary at all — a DM has no entry in MONITOR_CHANNELS and cannot have one —
// and neither did any channel the bot was merely @mentioned in.
//
// That is upstream of recall: /remember can only find what got written down, so
// asked about a DM it would search everything, find nothing, and answer
// confidently from a different conversation.
const SUMMARIZE_SEEN = process.env.SUMMARIZE_SEEN_CHANNELS !== "false";
const SEEN_CHANNELS_FILE = join(STATE_DIR, "seen-channels.json");

function loadSeenChannels() {
  try {
    const raw = JSON.parse(readFileSync(SEEN_CHANNELS_FILE, "utf8"));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}
const seenChannels = loadSeenChannels();

/**
 * Remember that this bot spoke here, so the summarizer can cover it later.
 * Durable on purpose: channelSessions expires after SESSION_TIMEOUT_MS, so a
 * conversation from yesterday would otherwise be invisible after a restart.
 */
function recordSeenChannel(channelId) {
  if (!SUMMARIZE_SEEN || seenChannels.has(channelId)) return;
  seenChannels.add(channelId);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SEEN_CHANNELS_FILE, JSON.stringify([...seenChannels], null, 2));
  } catch (err) {
    log.warn({ err: err.message }, "Could not persist seen channels — this channel may not be summarized");
  }
}

/** Configured channels, plus everywhere the bot has actually spoken. */
function channelsToSummarize() {
  const configured = new Set(SUMMARIZE_CHANNELS);
  if (SUMMARIZE_SEEN) for (const id of seenChannels) configured.add(id);
  return [...configured];
}

// --- Harness skill pack ---
// Skills that ship WITH the harness and load into every bot, so they never have
// to be copied into each bot's repo. The copies are why this exists: the shipped
// per-repo /remember hardcoded harness internals, and every path it used was dead
// by the time anyone checked. Loaded via --plugin-dir and namespaced by the
// plugin, so a pack skill cannot shadow a bot's own.
//
// Set BOT_SKILL_PACK= (empty) to disable entirely.
const SKILL_PACK = process.env.BOT_SKILL_PACK !== undefined
  ? process.env.BOT_SKILL_PACK
  : join(__dirname, "skill-pack");
const EXTRA_SKILL_PACKS = (process.env.BOT_EXTRA_SKILL_PACKS || "")
  .split(",").map((d) => d.trim()).filter(Boolean);

/** --plugin-dir args for every pack that actually exists on disk. */
function skillPackArgs() {
  return [SKILL_PACK, ...EXTRA_SKILL_PACKS]
    .filter((d) => d && existsSync(d))
    .flatMap((d) => ["--plugin-dir", d]);
}

// --- Progress reporting ---
// Streaming was removed on 2026-03-28 because text emitted BEFORE a tool call
// ("Let me check...") was posted as its own Discord message, so the bot looked
// like it answered twice. That diagnosis was right; the cure was too broad — it
// batched everything to the end and took all progress visibility with it.
//
// The fix is to stream ACTIVITY, never prose. The answer is still delivered
// exactly once, at the end, unsplit. Alongside it runs a single status message
// that is EDITED IN PLACE as tools are called, then deleted. One answer, one
// transient status: the original complaint cannot recur, because no part of the
// reply is ever sent early.
const PROGRESS_ENABLED = process.env.BOT_PROGRESS_ENABLED !== "false";
// Discord rate-limits edits per channel. Coalesce rather than edit per tool call.
const PROGRESS_INTERVAL_MS = envInt("BOT_PROGRESS_INTERVAL_MS", 2500, { min: 1000 });
// How fast the FIRST update appears. Short on purpose: the point of progress is
// to show up early, and a full interval of silence looks identical to no feature.
const PROGRESS_FIRST_MS = envInt("BOT_PROGRESS_FIRST_MS", 800, { min: 100 });

// The clock the bot is told it lives in. Every session gets this in its prompt, so
// a wrong zone makes the bot wrong about "today" — and about anything it schedules.
// Defaults to the host's own zone rather than to whoever wrote the code.
const BOT_TIMEZONE = process.env.BOT_TIMEZONE
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || "UTC";
const REACTION_HANDLER_ENABLED = process.env.REACTION_HANDLER_ENABLED === "true";
const REACTION_TRIGGER_EMOJI = process.env.REACTION_TRIGGER_EMOJI || "👍";
const REACTION_ACK_EMOJI = process.env.REACTION_ACK_EMOJI || "✅";
const REACTION_FAIL_EMOJI = process.env.REACTION_FAIL_EMOJI || "❌";

// --- Bot identity (must be before buffer/PID config) ---
const BOT_NAME = process.env.BOT_NAME || "bot";

// --- Conversation buffer config ---
const BUFFER_FILE = join(STATE_DIR, "buffer.txt");
// Declared here with the other state paths rather than beside the scheduler:
// spawnClaude publishes these to the child env, and a path declared further down
// the file is a temporal-dead-zone error waiting for the first message.
const SCHEDULES_FILE = join(STATE_DIR, "schedules.json");
const JOB_HISTORY_FILE = join(STATE_DIR, "job-history.jsonl");

// Files that used to live in the install directory, keyed by BOT_NAME. Moved on
// first start rather than abandoned — a bot that silently forgets every session
// after an upgrade is worse than one that refuses to start.
const LEGACY_STATE = [
  [join(__dirname, `.${BOT_NAME}-conversation-buffer.txt`), BUFFER_FILE],
];
const BUFFER_MAX_BYTES = parseInt(process.env.BUFFER_MAX_BYTES, 10) || 32 * 1024;
const BUFFER_TRUNCATE_RESPONSE = parseInt(process.env.BUFFER_TRUNCATE_RESPONSE, 10) || 500;
const ATTACHMENTS_DIR = process.env.BOT_ATTACHMENTS_DIR
  ? (process.env.BOT_ATTACHMENTS_DIR.startsWith("/") ? process.env.BOT_ATTACHMENTS_DIR : join(__dirname, process.env.BOT_ATTACHMENTS_DIR))
  : join(STATE_DIR, "attachments");

// --- File transfer config ---
// Inbound accepts ANY file type. Discord's own upload ceiling is 10MB (25MB
// boosted, 500MB Nitro), so 25MB is a generous default for what can arrive.
const MAX_ATTACHMENT_BYTES = parseInt(process.env.MAX_ATTACHMENT_BYTES, 10) || 25 * 1024 * 1024;
const ATTACHMENT_FETCH_TIMEOUT_MS = parseInt(process.env.ATTACHMENT_FETCH_TIMEOUT_MS, 10) || 60000;
// Outbound: anything written into the outbox is handed to the user, any type.
const OUTBOX_DIR = process.env.BOT_OUTBOX_DIR
  ? (process.env.BOT_OUTBOX_DIR.startsWith("/") ? process.env.BOT_OUTBOX_DIR : join(__dirname, process.env.BOT_OUTBOX_DIR))
  : join(STATE_DIR, "outbox");
const MAX_OUTBOUND_BYTES = parseInt(process.env.MAX_OUTBOUND_BYTES, 10) || 8 * 1024 * 1024;

if (!DISCORD_TOKEN) {
  log.fatal("DISCORD_TOKEN environment variable is required — see docs/INSTALL.md");
  process.exit(1);
}

// A bot pointed at a directory that does not exist used to start happily and then
// fail on the first message with a spawn error naming neither the variable nor the
// path. Fail here instead, while someone is still watching the terminal.
if (!existsSync(CLAUDE_CWD)) {
  log.fatal(
    { CLAUDE_CWD },
    "CLAUDE_CWD does not exist. Set it to YOUR project directory — the repo holding the CLAUDE.md that gives this bot its role. It is not this repo."
  );
  process.exit(1);
}
if (!statSync(CLAUDE_CWD).isDirectory()) {
  log.fatal({ CLAUDE_CWD }, "CLAUDE_CWD is not a directory");
  process.exit(1);
}

if (!["bypass", "restricted"].includes(PERMISSION_MODE)) {
  log.fatal(
    { BOT_PERMISSION_MODE: PERMISSION_MODE },
    'BOT_PERMISSION_MODE must be "restricted" (default — expose only BOT_ALLOWED_TOOLS) or "bypass" (all tools, no permission checks)'
  );
  process.exit(1);
}
if (PERMISSION_MODE === "bypass") {
  log.warn(
    "BOT_PERMISSION_MODE=bypass — this bot runs with ALL tools and no permission checks. Anyone allowed to talk to it can run arbitrary commands on this host. Remove it to fall back to BOT_ALLOWED_TOOLS."
  );
} else {
  log.info({ tools: ALLOWED_TOOLS }, "Tool exposure restricted — set BOT_PERMISSION_MODE=bypass for the previous unrestricted behaviour, or widen BOT_ALLOWED_TOOLS");
}

// Fail on a bad IANA name here rather than throwing on every message.
try {
  new Intl.DateTimeFormat("en-US", { timeZone: BOT_TIMEZONE });
} catch {
  log.fatal(
    { BOT_TIMEZONE },
    'BOT_TIMEZONE is not a valid IANA timezone name (expected e.g. "Europe/London", "America/New_York", "UTC")'
  );
  process.exit(1);
}

// Opt-in strict mode. Default stays permissive so "invite the bot and talk to it"
// remains the five-minute first run; operators who want the guarantee set this.
if (process.env.BOT_REQUIRE_ALLOWLIST === "true" && ALLOWED_USER_IDS.length === 0) {
  log.fatal(
    "BOT_REQUIRE_ALLOWLIST=true but ALLOWED_USERS is empty — refusing to start open to every Discord user. Set ALLOWED_USERS to a comma-separated list of user IDs."
  );
  process.exit(1);
}

// --- Duplicate instance guard ---
// Prevent multiple bot instances from connecting to Discord simultaneously.
// Checks .bot.pid — if another bot.js process is already running, exit.
const PID_FILE = join(__dirname, `.${BOT_NAME}.pid`);
(() => {
  try {
    const existingPid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // throws if process doesn't exist
        // Verify it's actually a bot.js MAIN process for THIS bot instance.
        // process.kill + /proc/<id>/cmdline both answer for thread ids too
        // (cmdline reports the whole thread group's command line), so after a
        // reboot a stale pid can be reused by a worker THREAD of the other
        // bot and pass the old check — permanently locking this bot out
        // (2026-07-19: .em-bot.pid's stale 927 became a libuv thread of the
        // po-bot). Require Tgid === pid (a real process, not a thread) and a
        // matching cwd (this bot, not a sibling running the same bot.js).
        try {
          const cmdline = readFileSync(`/proc/${existingPid}/cmdline`, "utf8");
          const tgid = Number(/^Tgid:\s*(\d+)/m.exec(readFileSync(`/proc/${existingPid}/status`, "utf8"))?.[1]);
          const cwd = readlinkSync(`/proc/${existingPid}/cwd`);
          if (cmdline.includes("bot.js") && tgid === existingPid && cwd === process.cwd()) {
            log.fatal({ existingPid }, "Another bot instance is already running. Exiting.");
            process.exit(1);
          }
        } catch {
          // /proc not available — trust the PID check
          log.fatal({ existingPid }, "Another bot instance is already running. Exiting.");
          process.exit(1);
        }
      } catch {
        // Process doesn't exist — stale PID file, safe to continue
      }
    }
  } catch {
    // No PID file — safe to continue
  }
  writeFileSync(PID_FILE, String(process.pid));
})();

// --- Readiness marker ---
// "A process exists" is not "the bot works": a failed Discord login leaves the
// process alive (the WS server and scheduler keep the event loop busy), so PID
// checks reported a permanently deaf bot as healthy. This file is written only
// once Discord says ready, and removed on the way out, so `status` can tell
// connected apart from merely running.
const READY_FILE = join(__dirname, `.${BOT_NAME}.ready`);
function markReady() {
  try { writeFileSync(READY_FILE, String(Date.now())); } catch { /* non-fatal */ }
}
function clearReady() {
  try { unlinkSync(READY_FILE); } catch { /* already gone */ }
}
clearReady();

// Ensure directories exist
mkdirSync(HISTORY_DIR, { recursive: true });
mkdirSync(ATTACHMENTS_DIR, { recursive: true });
mkdirSync(OUTBOX_DIR, { recursive: true });

// --- WebSocket Bridge ---
const WS_PORT = envInt("WS_PORT", 9800, { min: 1 });
// Loopback by default: the bridge takes commands, so exposing it beyond this
// host is an explicit decision, never an accident of configuration.
const WS_HOST = process.env.WS_HOST || "127.0.0.1";
const WS_HEARTBEAT_MS = envInt("WS_HEARTBEAT_MS", 30000, { min: 1000 });
const WS_HEARTBEAT_MAX_MISSES = envInt("WS_HEARTBEAT_MAX_MISSES", 3, { min: 1 });
const connectedAgents = new Map(); // agentId → { ws, discordBotId, channels }

const wss = new WebSocketServer({ port: WS_PORT, host: WS_HOST });
log.info({ port: WS_PORT }, "WebSocket bridge listening");

wss.on("connection", (ws) => {
  let agentId = null;
  let heartbeatMisses = 0;

  const heartbeat = setInterval(() => {
    if (heartbeatMisses >= WS_HEARTBEAT_MAX_MISSES) {
      log.warn({ agentId }, "Agent missed 3 heartbeats, disconnecting");
      ws.terminate();
      return;
    }
    heartbeatMisses++;
    try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
  }, WS_HEARTBEAT_MS);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "pong") {
      heartbeatMisses = 0;
      return;
    }

    if (msg.type === "handshake") {
      agentId = msg.agentId;
      connectedAgents.set(agentId, {
        ws,
        discordBotId: msg.discordBotId,
        channels: msg.channels,
      });
      log.info({ agentId, channels: msg.channels }, "Agent connected");
      ws.send(JSON.stringify({
        type: "handshake_ack",
        success: true,
        connectedAgents: Array.from(connectedAgents.keys()),
      }));
      return;
    }

    if (!agentId) {
      ws.send(JSON.stringify({ type: "error", message: "Handshake required" }));
      return;
    }

    if (msg.type === "status") {
      const agent = connectedAgents.get(agentId);
      if (agent?.channels?.status) {
        const channel = client.channels.cache.get(agent.channels.status);
        if (channel) {
          const prefix = msg.level === "error" ? "**[ERROR]**" : msg.level === "warn" ? "**[WARN]**" : "";
          const text = prefix ? `${prefix} ${msg.text}` : msg.text;
          for (const chunk of splitMessage(text)) {
            try { await channel.send(chunk); } catch (err) {
              log.error({ err: err.message, agentId }, "Failed to send status to Discord");
            }
          }
        }
      }
      return;
    }

    if (msg.type === "response") {
      const channel = client.channels.cache.get(msg.channelId);
      if (channel) {
        for (const chunk of splitMessage(msg.text)) {
          try {
            if (msg.replyTo) {
              const original = await channel.messages.fetch(msg.replyTo).catch(() => null);
              if (original) { await original.reply(chunk); continue; }
            }
            await channel.send(chunk);
          } catch (err) {
            log.error({ err: err.message, agentId }, "Failed to send response to Discord");
          }
        }
      }
      return;
    }

    if (msg.type === "typing") {
      const channel = client.channels.cache.get(msg.channelId);
      if (channel) {
        try { await channel.sendTyping(); } catch { /* ignore */ }
      }
      return;
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (agentId) {
      connectedAgents.delete(agentId);
      log.info({ agentId }, "Agent disconnected");
    }
  });

  ws.on("error", (err) => {
    log.error({ err: err.message, agentId }, "WebSocket error");
  });
});

/**
 * Route a Discord message to connected agents.
 * Returns true if at least one agent received it.
 */
function routeToAgents(discordMsg, prompt) {
  let routed = false;
  for (const [id, agent] of connectedAgents) {
    const listenChannels = agent.channels?.listen || [];
    if (listenChannels.includes(discordMsg.channel.id)) {
      const payload = {
        type: "command",
        channelId: discordMsg.channel.id,
        userId: discordMsg.author.id,
        username: discordMsg.author.username,
        text: prompt,
        messageId: discordMsg.id,
        attachments: discordMsg.attachments.map(a => ({
          filename: a.name,
          url: a.url,
          contentType: a.contentType,
        })),
      };
      try {
        agent.ws.send(JSON.stringify(payload));
        routed = true;
        log.info({ agentId: id, channel: discordMsg.channel.id }, "Message routed to agent");
      } catch (err) {
        log.error({ err: err.message, agentId: id }, "Failed to route message to agent");
      }
    }
  }
  return routed;
}

// --- Conversation buffer ---

function formatBufferLine(channelName, author, text, fileRefs) {
  const now = new Date();
  const ts = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  let line = `[${ts} #${channelName}] ${author}: ${text}`;
  if (fileRefs && fileRefs.length > 0) {
    const refs = fileRefs.map(f => `[file: ${f.name} ${Math.round(f.size / 1024)}KB ${f.path}]`).join(" ");
    line += ` ${refs}`;
  }
  return line;
}

function appendToBuffer(line) {
  appendFileSync(BUFFER_FILE, line + "\n");
}

function readBuffer() {
  try {
    return readFileSync(BUFFER_FILE, "utf8");
  } catch {
    return "";
  }
}

function getBufferSize() {
  try {
    return statSync(BUFFER_FILE).size;
  } catch {
    return 0;
  }
}

let rotating = false;

async function rotateBuffer() {
  if (rotating) return;
  if (getBufferSize() <= BUFFER_MAX_BYTES) return;
  rotating = true;

  try {
    const content = readBuffer();
    const lines = content.split("\n").filter(Boolean);
    // Keep the newest 60%, summarize the oldest 40%
    const cutIndex = Math.floor(lines.length * (envInt("BUFFER_ROTATE_PERCENT", 40, { min: 1 }) / 100));
    const oldLines = lines.slice(0, cutIndex);
    const keepLines = lines.slice(cutIndex);

    if (oldLines.length > 0) {
      // Summarize the old lines
      const rotLog = log.child({ component: "buffer-rotation" });
      rotLog.info({ oldLines: oldLines.length, keepLines: keepLines.length }, "Rotating buffer");

      try {
        const summary = await summarizeBufferLines(oldLines);
        const date = new Date().toISOString().split("T")[0];
        writeSummary("buffer-rotation", date, oldLines.length, summary, null, "buffer-rotation");
        rotLog.info({ date, lines: oldLines.length }, "Rotation summary saved");
      } catch (err) {
        rotLog.warn({ err: err.message }, "Failed to summarize during rotation, trimming anyway");
      }

      // Clean up orphaned attachments
      const keepContent = keepLines.join("\n");
      cleanOrphanedAttachments(keepContent);
    }

    // Write back only the kept lines
    writeFileSync(BUFFER_FILE, keepLines.join("\n") + "\n");
  } finally {
    rotating = false;
  }
}

function cleanOrphanedAttachments(bufferContent) {
  // A file drops out of the buffer long before the conversation about it ends —
  // the Claude session still holds its path and will Read it. Only reap files
  // older than the window the summaries cover.
  const minAgeMs = SUMMARY_LOOKBACK_HOURS * 3600000;
  try {
    const files = readdirSync(ATTACHMENTS_DIR);
    for (const file of files) {
      const filePath = join(ATTACHMENTS_DIR, file);
      if (bufferContent.includes(filePath)) continue;
      try {
        if (Date.now() - statSync(filePath).mtimeMs < minAgeMs) continue;
        unlinkSync(filePath);
        log.debug({ file }, "Cleaned orphaned attachment");
      } catch { /* ignore */ }
    }
  } catch { /* ignore if dir doesn't exist */ }
}

/**
 * Every attachment relevant to a message: its own, plus those on the message it
 * replies to. Replying to a file and asking about it is how people actually use
 * Discord — before this, that attachment was invisible.
 */
async function collectAttachments(msg) {
  const items = [];
  const seen = new Set();

  for (const [, attachment] of msg.attachments) {
    seen.add(attachment.id);
    items.push({ attachment, messageId: msg.id, source: "message" });
  }

  if (msg.reference?.messageId) {
    try {
      const referenced = await msg.fetchReference();
      for (const [, attachment] of referenced.attachments) {
        if (seen.has(attachment.id)) continue;
        seen.add(attachment.id);
        items.push({ attachment, messageId: referenced.id, source: "reply" });
      }
    } catch (err) {
      log.debug({ err: err.message }, "Could not fetch replied-to message for attachments");
    }
  }

  return items;
}

async function recordMessage(msg) {
  const channelName = msg.channel.name || "DM";
  const author = msg.author.username || msg.author.tag;
  const text = msg.content || "";

  // Download and record any attachments — ANY type, not just images
  const fileRefs = [];
  const failures = [];
  for (const { attachment, messageId, source } of await collectAttachments(msg)) {
    try {
      const savedPath = await downloadAttachmentPersistent(attachment, messageId);
      fileRefs.push({
        name: attachment.name || "file",
        size: attachment.size || 0,
        contentType: attachment.contentType || "",
        path: savedPath,
        source,
      });
    } catch (err) {
      // A dropped attachment used to vanish at debug level while the default log
      // level is info — so the bot told the user "nothing came through" with no
      // trace anywhere. Warn, and carry the failure into the prompt so the answer
      // says what actually happened.
      log.warn({ name: attachment.name, err: err.message }, "Failed to download attachment");
      failures.push({ name: attachment.name || "file", reason: err.message });
    }
  }

  if (!text && fileRefs.length === 0) return { fileRefs, failures };

  const line = formatBufferLine(channelName, author, text, fileRefs);
  appendToBuffer(line);

  // Check if rotation needed (async, don't block)
  if (getBufferSize() > BUFFER_MAX_BYTES) {
    rotateBuffer().catch(err => log.warn({ err: err.message }, "Buffer rotation failed"));
  }

  return { fileRefs, failures };
}

function recordBotResponse(channelName, responseText) {
  if (!responseText || !responseText.trim()) return;

  let text = responseText.trim();
  if (text.length > BUFFER_TRUNCATE_RESPONSE) {
    const fullLength = text.length;
    text = `${text.substring(0, BUFFER_TRUNCATE_RESPONSE)}... [truncated, ${fullLength} chars total]`;
  }

  const botName = client.user ? (client.user.username || client.user.tag) : "Bot";
  const line = formatBufferLine(channelName, botName, text, null);
  appendToBuffer(line);
}

// --- Persistent attachment handling ---
// Every type is accepted. Classification only decides HOW a file is described to
// Claude, never whether it is passed along.
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];
const TEXT_EXTENSIONS = [
  ".txt", ".md", ".json", ".csv", ".tsv", ".log", ".yaml", ".yml", ".xml",
  ".html", ".sql", ".diff", ".patch", ".ini", ".conf", ".sh", ".js", ".mjs",
  ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".css",
];

function isImageAttachment({ name = "", contentType = "" }) {
  const n = (name || "").toLowerCase();
  return (contentType || "").toLowerCase().startsWith("image/")
    || IMAGE_EXTENSIONS.some(ext => n.endsWith(ext));
}

function isTextAttachment({ name = "", contentType = "" }) {
  const n = (name || "").toLowerCase();
  const ct = (contentType || "").toLowerCase();
  return ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")
    || TEXT_EXTENSIONS.some(ext => n.endsWith(ext));
}

async function downloadAttachmentPersistent(attachment, messageId) {
  const { Readable } = require("stream");
  // attachment.name is user-controlled — strip separators so it cannot escape
  // ATTACHMENTS_DIR.
  const safeName = (attachment.name || "file").replace(/[/\\]/g, "_");
  // Keyed on the ATTACHMENT id, not the message id. A message can carry several
  // files, and nothing requires their names to differ — two `report.csv` on one
  // message produced the same path, and the existsSync short-circuit below then
  // silently handed back the FIRST file's contents for the second one. The bot
  // would describe two attachments and read one, with no error anywhere.
  // attachment.id is a Discord snowflake: unique per file, forever.
  const savePath = join(ATTACHMENTS_DIR, `${attachment.id}-${safeName}`);

  // Skip if already downloaded
  if (existsSync(savePath)) return savePath;

  if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file is ${Math.round(attachment.size / 1048576)}MB, over the ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB limit`);
  }

  const res = await fetch(attachment.url, { signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
  const nodeStream = Readable.fromWeb(res.body);
  await pipeline(nodeStream, createWriteStream(savePath));
  return savePath;
}

/**
 * The lines that tell Claude what the user actually sent. This is the ONLY path
 * by which an attachment reaches the model — it rides on the user prompt, so it
 * survives session resume (the conversation buffer does not).
 */
function buildAttachmentPrompt(fileRefs = [], failures = []) {
  const lines = [];

  for (const f of fileRefs) {
    const kb = Math.max(1, Math.round(f.size / 1024));
    const via = f.source === "reply" ? " on the message this one replies to" : "";
    if (isImageAttachment(f)) {
      lines.push(`[Image attached by the user${via}: "${f.name}" (${kb}KB) — use the Read tool on "${f.path}" to view it]`);
    } else if (isTextAttachment(f)) {
      lines.push(`[File attached by the user${via}: "${f.name}" (${kb}KB, ${f.contentType || "text"}) — use the Read tool on "${f.path}" to read it]`);
    } else {
      lines.push(`[File attached by the user${via}: "${f.name}" (${kb}KB, ${f.contentType || "unknown type"}) — saved at "${f.path}". Open it with whatever tool suits its type; do not assume it is unreadable until you have tried]`);
    }
  }

  for (const f of failures) {
    lines.push(`[The user attached "${f.name}" but it FAILED to download: ${f.reason}. Tell them that plainly — do NOT tell them nothing was attached]`);
  }

  return lines;
}

// --- Active Claude process tracking ---
const activeProcesses = new Map();
const MAX_CONCURRENT_CLAUDE = parseInt(process.env.MAX_CONCURRENT_CLAUDE, 10) || 2;

// --- Bot-to-bot exchange tracking ---
const botExchanges = new Map();

// --- Session continuity: track Claude session IDs per channel for --resume ---
const SESSION_FILE = join(STATE_DIR, "sessions.json");
LEGACY_STATE.push([join(__dirname, `.${BOT_NAME}-sessions.json`), SESSION_FILE]);
// Moved out of the summaries directory: a schedule is the user's, and losing it
// to a re-clone is the kind of failure nobody notices until a job stops firing.
LEGACY_STATE.push([join(HISTORY_DIR, "schedules.json"), SCHEDULES_FILE]);
LEGACY_STATE.push([join(HISTORY_DIR, "job-history.jsonl"), JOB_HISTORY_FILE]);
LEGACY_STATE.push([join(HISTORY_DIR, ".checkpoints.json"), CHECKPOINT_FILE]);

/**
 * Move pre-2.1 state into the state root, once, loudly.
 * Never overwrites: if the new file already exists the old one is left alone for
 * a human to look at rather than silently discarded.
 */
function migrateLegacyState() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (const [from, to] of LEGACY_STATE) {
    if (from === to || !existsSync(from)) continue;
    if (existsSync(to)) {
      log.warn({ from, to }, "Legacy state file left in place — the new location already exists");
      continue;
    }
    try {
      renameSync(from, to);
      log.info({ from, to }, "Migrated state file into the state root");
    } catch (err) {
      log.warn({ from, to, err: err.message }, "Could not migrate state file — continuing with the new location");
    }
  }
}
migrateLegacyState();
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS, 10) || 30 * 60 * 1000;

function loadSessions() {
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    const map = new Map();
    for (const [channelId, entry] of Object.entries(data)) {
      if (Date.now() - entry.lastActivity < SESSION_TIMEOUT_MS) {
        map.set(channelId, entry);
      }
    }
    log.info({ loaded: map.size }, "Restored sessions from disk");
    return map;
  } catch {
    return new Map();
  }
}

function saveSessions() {
  try {
    const obj = Object.fromEntries(channelSessions);
    writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    log.warn({ err: err.message }, "Failed to persist sessions");
  }
}

const channelSessions = loadSessions();

// Prune stale botExchanges every 10 minutes
setInterval(() => {
  if (botExchanges.size > 0) {
    log.debug({ entries: botExchanges.size }, "Pruning botExchanges");
    botExchanges.clear();
  }
}, envInt("BOT_BOT_EXCHANGE_PRUNE_MS", 600000, { min: 1000 }));

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// --- WebSocket crash resilience ---
client.on("error", (err) => {
  log.error({ err: err.message }, "Discord client error");
});

client.on("shardError", (err) => {
  log.error({ err: err.message }, "Discord WebSocket error");
});

client.once("ready", () => {
  markReady();
  log.info({ tag: client.user.tag, cwd: CLAUDE_CWD }, "Bot online");
  const shadowed = shadowedCommands();
  if (shadowed.length) {
    log.warn(
      { shadowed, reserved: RESERVED_COMMANDS },
      "This bot defines command(s) the harness intercepts first — they can NEVER run. Rename them, or they will keep appearing in the bot's list of what it can do while silently doing nothing."
    );
  }
  if (ALLOWED_USER_IDS.length === 0) {
    log.warn(
      "ALLOWED_USERS is not set — EVERY Discord user who can DM this bot or post in a monitored channel can drive it. Set ALLOWED_USERS to your user ID, or BOT_REQUIRE_ALLOWLIST=true to refuse to start without it."
    );
  }
  log.info(
    { allowedUsers: ALLOWED_USER_IDS.length || "all", monitoredChannels: MONITOR_CHANNELS },
    "Access config"
  );
});

client.on("messageCreate", async (msg) => {
  // Skip own messages (bot responses are recorded via recordBotResponse)
  if (msg.author.id === client.user?.id) return;

  // Record ALL messages to buffer before any response filtering
  let fileRefs = [];
  let attachmentFailures = [];
  try {
    const recorded = await recordMessage(msg);
    fileRefs = recorded.fileRefs;
    attachmentFailures = recorded.failures;
  } catch (err) {
    log.warn({ err: err.message }, "Failed to record message to buffer");
  }

  // --- Stop and /fresh command handling (before response filtering so it works in any channel) ---
  // Only humans can issue these commands
  if (!msg.author.bot) {
    const rawContent = msg.content.trim();

    // /fresh — clear session for this channel so next message starts a new Claude session
    if (new RegExp(`^(?:<@!?\\d+>\\s*)*/(?:fresh)$`, "i").test(rawContent)) {
      channelSessions.delete(msg.channel.id);
      await msg.reply("Session cleared. Next message starts fresh.");
      return;
    }

    // Exactly "stop" / "/stop" — the historical form, always treated as a stop.
    const stopPattern = new RegExp(`^(?:<@!?\\d+>\\s*)*(?:/)?(?:${STOP_ALTERNATION})$`, "i");
    // A message that OPENS with a stop word but carries more text ("stop x, y, z",
    // "stop please", "stop!"). Anchoring on `$` meant these fell through to Claude
    // and SPAWNED A NEW RUN — the exact opposite of the intent, at the one moment
    // the user is trying to halt something. Treated as a stop only when this
    // channel actually has a run in flight, so "stop sending the Friday digest"
    // with nothing running is still a normal request to think about.
    const stopPrefix = new RegExp(`^(?:<@!?\\d+>\\s*)*(?:/)?(?:${STOP_ALTERNATION})\\b`, "i");
    const hasRun = activeProcesses.has(msg.channel.id);
    const isStopCommand = stopPattern.test(rawContent) || (hasRun && stopPrefix.test(rawContent));

    if (isStopCommand) {
      const mentionsThisBot = msg.mentions.has(client.user);
      const mentionsAnyBot = rawContent.match(/<@!?\d+>/g);
      const isBroadcast = !mentionsAnyBot; // plain "stop" with no mentions
      const isTargeted = mentionsThisBot;   // "@ThisBot stop"

      if (isBroadcast || isTargeted) {
        const reqLog = log.child({ channel: msg.channel.id, user: msg.author.tag });
        channelSessions.delete(msg.channel.id);
        const child = activeProcesses.get(msg.channel.id);
        if (child) {
          // MARK IT. Without this the close handler treats a deliberate stop as a
          // crash: it rejects with "Claude exited with code 143", and the caller's
          // catch replies `Error: ...`. So asking a bot to stop answered with an
          // error message — the only feedback the broadcast form ever produced,
          // since "Stopped." was sent for the @mention form alone.
          child._intentionalKill = true;
          child.kill("SIGTERM");
          activeProcesses.delete(msg.channel.id);
          reqLog.info({ broadcast: isBroadcast }, "Claude process killed by stop");
          // Acknowledge whenever we actually stopped something, however it was
          // phrased. Only the bot that had a run in flight replies, so a broadcast
          // in a channel of idle bots stays quiet instead of N-way spam.
          await msg.reply("Stopped.");
        }
        return;
      }
      // Stop mentions a different bot — ignore
      return;
    }
  }

  // --- Response filtering (only below this point) ---
  if (msg.author.bot && !ALLOWED_BOTS.includes(msg.author.id)) return;

  // ALLOWED_USERS gates HUMANS. It used to gate everyone, so a bot that had been
  // deliberately whitelisted in ALLOWED_BOTS was then dropped here for not also
  // being in ALLOWED_USERS — bot-to-bot coordination broke silently the moment an
  // operator secured their bot, which is exactly when they are least likely to
  // suspect the allowlist. Bots are authorised by ALLOWED_BOTS, humans by
  // ALLOWED_USERS; neither list should have to name the other's members.
  if (!msg.author.bot && ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(msg.author.id)) {
    return;
  }

  const isDM = !msg.guild;
  const isMentioned = msg.mentions.has(client.user);
  const isMonitored = MONITOR_CHANNELS.includes(msg.channel.id);
  if (!isDM && !isMentioned && !isMonitored) return;

  // Channel allowlist — if set, only respond in these channels (even for @mentions). DMs still work.
  if (!isDM && ALLOWED_CHANNELS.length > 0 && !ALLOWED_CHANNELS.includes(msg.channel.id)) {
    log.debug({ channel: msg.channel.id, bot: BOT_NAME }, "Message ignored — channel not in ALLOWED_CHANNELS");
    return;
  }

  // The bot is going to answer here, so this conversation is worth remembering.
  recordSeenChannel(msg.channel.id);

  // Bot-to-bot loop prevention
  if (msg.author.bot) {
    const exchange = botExchanges.get(msg.channel.id) || { count: 0 };
    exchange.count++;
    botExchanges.set(msg.channel.id, exchange);
    if (exchange.count > MAX_BOT_EXCHANGES) {
      log.info({ channel: msg.channel.id, count: exchange.count, bot: msg.author.tag }, "Bot exchange limit reached, ignoring");
      return;
    }
  } else {
    botExchanges.delete(msg.channel.id);
  }

  let prompt = msg.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  const hasAttachments = fileRefs.length > 0 || attachmentFailures.length > 0;
  if (!prompt && !hasAttachments) return;
  if (!prompt && hasAttachments) prompt = "The user sent the attachment(s) above with no message text. Open them and respond.";

  const reqLog = log.child({ channel: msg.channel.id, user: msg.author.tag, prompt: prompt.substring(0, 80) });

  // --- Bridge routing: if a connected agent is listening on this channel, route to it ---
  if (routeToAgents(msg, prompt)) {
    reqLog.info("Message routed to connected agent via WebSocket");
    return;
  }

  if (prompt === "/status") {
    const bufSize = getBufferSize();
    const bufLines = readBuffer().split("\n").filter(Boolean).length;
    const running = activeProcesses.has(msg.channel.id);
    let attachCount = 0;
    try { attachCount = readdirSync(ATTACHMENTS_DIR).length; } catch { /* ignore */ }
    await msg.reply(`Buffer: ${Math.round(bufSize / 1024)}KB / ${Math.round(BUFFER_MAX_BYTES / 1024)}KB (${bufLines} messages, ${attachCount} attachments)${running ? " — **running**" : ""}`);
    return;
  }

  // Kill existing Claude process in this channel before spawning a new one
  const existingChild = activeProcesses.get(msg.channel.id);
  if (existingChild) {
    reqLog.info("Killing existing Claude process for new message");
    existingChild._intentionalKill = true;
    existingChild.kill("SIGTERM");
    activeProcesses.delete(msg.channel.id);
  }

  // Global concurrency guard — drop if too many Claude processes running
  if (activeProcesses.size >= MAX_CONCURRENT_CLAUDE) {
    reqLog.warn({ active: activeProcesses.size, max: MAX_CONCURRENT_CLAUDE }, "Claude concurrency limit reached, dropping message");
    await msg.reply("I'm busy with other requests — try again in a moment.");
    return;
  }

  const typing = setInterval(() => msg.channel.sendTyping(), TYPING_INTERVAL_MS);
  msg.channel.sendTyping();

  const sendQueue = createSendQueue(msg, reqLog);
  const channelName = msg.channel.name || "DM";
  const progress = createProgressReporter(msg, reqLog);

  try {
    const responseText = await runClaude(prompt, msg.channel.id, reqLog, sendQueue.enqueue, { fileRefs, attachmentFailures }, channelName, progress);
    clearInterval(typing);
    await sendQueue.flush();

    // Record bot's response to buffer
    recordBotResponse(channelName, responseText);
  } catch (err) {
    clearInterval(typing);
    // A failed run must not leave a "working..." message sitting there forever.
    try { await progress?.finish(); } catch { /* ignore */ }
    await sendQueue.flush();
    // Don't send error to Discord for intentional kills — prevents bot-to-bot feedback loops
    if (err.message && err.message.includes("intentionally killed")) {
      reqLog.info({ err }, "Suppressed error from intentional kill");
    } else {
      reqLog.error({ err }, "Claude invocation failed");
      await msg.reply(`Error: ${err.message}`);
    }
  }
});

// --- Reaction-trigger handler ---
if (REACTION_HANDLER_ENABLED && ALLOWED_USER_IDS.length === 0) {
  log.fatal(
    "REACTION_HANDLER_ENABLED=true requires ALLOWED_USERS to be non-empty. " +
    "Refusing to register the reaction handler. Bot will continue running for messages."
  );
}

const reactionInFlight = new Set();

if (REACTION_HANDLER_ENABLED && ALLOWED_USER_IDS.length > 0) {
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch (err) {
      log.warn({ err: err.message }, "Failed to fetch partial reaction/message");
      return;
    }

    if (user.id === client.user?.id) return;
    if (user.bot) return;

    if (reaction.message.author?.id !== client.user?.id) return;

    if (reaction.emoji.name !== REACTION_TRIGGER_EMOJI) return;

    if (!ALLOWED_USER_IDS.includes(user.id)) {
      log.debug({ user: user.tag }, "Reaction ignored — user not in ALLOWED_USERS");
      return;
    }

    if (reactionInFlight.has(reaction.message.id)) {
      log.debug({ messageId: reaction.message.id }, "Reaction trigger already in flight — ignoring duplicate");
      return;
    }
    reactionInFlight.add(reaction.message.id);

    const reqLog = log.child({
      channel: reaction.message.channel.id,
      reactor: user.tag,
      messageId: reaction.message.id,
      emoji: reaction.emoji.name,
    });

    const channelName = reaction.message.channel.name || "DM";
    const contextLine = [
      "[reaction_trigger]",
      `emoji: ${reaction.emoji.name}`,
      `reactor: ${user.tag}#${user.id}`,
      `message_id: ${reaction.message.id}`,
      `channel_id: ${reaction.message.channel.id}`,
      `reacted_content: ${reaction.message.content || "(no text content)"}`,
    ].join("\n");

    const sendQueue = createSendQueue(reaction.message, reqLog);
    const progress = createProgressReporter(reaction.message, reqLog);

    try {
      reqLog.info("Reaction trigger — invoking Claude");
      const responseText = await runClaude(
        contextLine,
        reaction.message.channel.id,
        reqLog,
        sendQueue.enqueue,
        {},
        channelName,
        progress
      );
      await sendQueue.flush();
      recordBotResponse(channelName, responseText);

      try {
        await reaction.message.react(REACTION_ACK_EMOJI);
      } catch (err) {
        reqLog.warn({ err: err.message }, "Failed to add ack reaction");
      }
    } catch (err) {
      try { await progress?.finish(); } catch { /* ignore */ }
      await sendQueue.flush();
      reqLog.error({ err }, "Reaction-triggered Claude invocation failed");
      try {
        await reaction.message.react(REACTION_FAIL_EMOJI);
        await reaction.message.reply(`Reaction trigger failed: ${err.message}`);
      } catch (replyErr) {
        reqLog.warn({ err: replyErr.message }, "Failed to surface reaction failure");
      }
    } finally {
      reactionInFlight.delete(reaction.message.id);
    }
  });

  log.info(
    { trigger: REACTION_TRIGGER_EMOJI, ack: REACTION_ACK_EMOJI, fail: REACTION_FAIL_EMOJI },
    "Reaction-trigger handler enabled"
  );
}

/**
 * A single status message, edited in place while the bot works, deleted when done.
 *
 * Deliberately holds O(1) state — the latest tool name and a count, never a
 * transcript. Nothing here grows with the length of a run.
 *
 * It shows tool NAMES, and a basename for file tools. It never shows tool INPUT:
 * a Bash command routinely carries a connection string or an API key, and this
 * text goes to a Discord channel that is not the transcript's security boundary.
 */
function createProgressReporter(msg, reqLog) {
  if (!PROGRESS_ENABLED) return null;

  let statusMsg = null;
  let latest = null;
  let count = 0;
  let timer = null;
  let sending = false;
  let finished = false;

  function label(name, input) {
    // Only file-shaped tools get a detail, and only its basename.
    if (input && typeof input.file_path === "string" && /^(Read|Write|Edit|NotebookEdit)$/.test(name)) {
      return `${name} ${input.file_path.split("/").pop()}`;
    }
    if (input && typeof input.pattern === "string" && /^(Glob|Grep)$/.test(name)) {
      return `${name} ${String(input.pattern).slice(0, 40)}`;
    }
    return name;
  }

  async function render() {
    if (finished || sending) return;
    sending = true;
    const body = `-# ⚙️ working — ${count} step${count === 1 ? "" : "s"} · ${latest}`;
    try {
      if (statusMsg) {
        await statusMsg.edit(body);
        reqLog.info({ steps: count, latest }, "Progress updated");
      } else {
        statusMsg = await msg.reply(body);
        reqLog.info({ steps: count, latest }, "Progress posted");
      }
    } catch (err) {
      // Never let progress reporting break the actual request — but SAY SO.
      // This was debug-level, and the effective level is info, so the first time
      // progress silently did nothing there was no way to tell whether it had
      // failed or never run. An invisible failure in an observability feature is
      // the worst of both.
      reqLog.warn({ err: err.message, steps: count }, "Progress update FAILED");
    } finally {
      sending = false;
    }
  }

  return {
    tool(name, input) {
      count++;
      latest = label(name, input);
      if (timer) return;                     // an update is already scheduled
      // Leading edge: show something almost immediately, then throttle. Waiting a
      // full interval before the FIRST update meant a 14s request displayed
      // status for only its last 5s — long enough to miss entirely, which is
      // exactly what happened on the first live test.
      const delay = statusMsg ? PROGRESS_INTERVAL_MS : PROGRESS_FIRST_MS;
      timer = setTimeout(() => { timer = null; render(); }, delay);
    },
    async finish() {
      finished = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (!statusMsg) {
        reqLog.info({ steps: count }, "Progress: nothing posted (run finished first)");
        return;
      }
      try {
        await statusMsg.delete();
        reqLog.info({ steps: count }, "Progress cleared");
      } catch (err) {
        reqLog.warn({ err: err.message }, "Progress cleanup FAILED — a status message may be left behind");
      }
      statusMsg = null;
    },
  };
}

// --- Send queue: serializes Discord messages to avoid race conditions ---
function createSendQueue(msg, reqLog) {
  const pending = [];
  let sending = false;

  async function drain() {
    if (sending) return;
    sending = true;
    while (pending.length > 0) {
      const item = pending.shift();
      // File attachment object — send directly
      if (typeof item === "object" && item.files) {
        try {
          await msg.reply(item);
        } catch (err) {
          reqLog.error({ err }, "Failed to send Discord file attachment");
        }
        continue;
      }
      const chunks = splitMessage(item);
      for (const chunk of chunks) {
        try {
          await msg.reply(chunk);
        } catch (err) {
          reqLog.error({ err }, "Failed to send Discord message");
        }
      }
    }
    sending = false;
  }

  return {
    enqueue(item) {
      if (!item) return;
      if (typeof item === "string" && !item.trim()) return;
      pending.push(item);
      drain();
    },
    async flush() {
      while (pending.length > 0 || sending) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

// --- Context building (buffer + summaries) ---

function loadRecentSummaries() {
  const cutoffMs = Date.now() - SUMMARY_LOOKBACK_HOURS * 3600000;
  const cutoffDate = new Date(cutoffMs).toISOString().split("T")[0];

  try {
    const files = readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .sort()
      .filter((f) => f >= cutoffDate);

    const summaries = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(HISTORY_DIR, file), "utf8").trim();
        if (content) summaries.push(content);
      } catch { /* skip unreadable */ }
    }
    return summaries;
  } catch {
    return [];
  }
}

function buildContextPrompt(reqLog = log) {
  // Summaries used to be injected whole, all of them, for the entire lookback
  // window — the one input to the command line with no ceiling on it. Two busy
  // days put this past the kernel's 128KB single-argument limit and every fresh
  // session died with `spawn E2BIG`. Budget it. See lib/argv-budget.js.
  const result = budgetContext({
    summaries: loadRecentSummaries(),
    buffer: readBuffer(),
    maxBytes: CONTEXT_MAX_BYTES,
  });

  if (result.droppedSummaries > 0 || result.bufferTruncated) {
    reqLog.warn(
      {
        contextBytes: result.bytes,
        budget: CONTEXT_MAX_BYTES,
        droppedSummaries: result.droppedSummaries,
        bufferTruncated: result.bufferTruncated,
      },
      "Remembered context exceeded CONTEXT_MAX_BYTES — oldest history was left out of this prompt (it is still on disk; raise CONTEXT_MAX_BYTES or lower SUMMARY_LOOKBACK_HOURS)"
    );
  }

  return result.text;
}

// --- Outbound files (bot → user, any type) ---
// The harness is dumb transport: it does not guess which files the user wanted.
// A bot hands a file over by writing it to the outbox, or by naming it with an
// [[attach: <path>]] marker. Both carry any file type; neither can be triggered
// by the bot merely mentioning a path in prose.
const ATTACH_MARKER = /\[\[attach:\s*([^\]\n]+)\]\]/gi;

function stripAttachMarkers(text) {
  return text.replace(ATTACH_MARKER, "").replace(/\n{3,}/g, "\n\n");
}

function collectMarkedFiles(text) {
  const paths = [];
  for (const match of text.matchAll(ATTACH_MARKER)) {
    const raw = match[1].trim().replace(/^[`'"]+|[`'"]+$/g, "");
    if (!raw) continue;
    paths.push(raw.startsWith("/") ? raw : join(CLAUDE_CWD, raw));
  }
  return paths;
}

// File mtimes do not share a clock with Date.now() — measured here, a file
// written immediately after a Date.now() call stamps 1-5ms BEHIND it, and some
// filesystems round to whole seconds. A strict >= silently drops the very file
// the user asked for, so allow a tolerance.
const OUTBOX_MTIME_TOLERANCE_MS = envInt("BOT_OUTBOX_MTIME_TOLERANCE_MS", 2000, { min: 0 });

/**
 * The outbox for ONE channel.
 *
 * A single shared outbox leaked across conversations: MAX_CONCURRENT_CLAUDE
 * defaults to 2, so two runs overlap, and the old collector claimed every file
 * whose mtime fell after ITS OWN start — including files the other run had just
 * written for a different channel. A document produced for one client could be
 * attached to a reply in another client's channel, which is precisely the
 * separation this project advertises.
 *
 * Per CHANNEL is enough, and is stable: activeProcesses is keyed by channel, and
 * a new message in a channel kills that channel's previous run, so a channel can
 * never have two runs at once.
 */
function channelOutbox(channelId) {
  const dir = join(OUTBOX_DIR, String(channelId));
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

function collectOutboxFiles(sinceMs, dir = OUTBOX_DIR) {
  const cutoff = sinceMs - OUTBOX_MTIME_TOLERANCE_MS;
  try {
    return readdirSync(dir)
      .map(f => join(dir, f))
      .filter(p => {
        try {
          const s = statSync(p);
          return s.isFile() && s.mtimeMs >= cutoff;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

// --- Claude invocation with session continuity ---

/**
 * Can a failed resume be retried on a fresh session?
 *
 * Only when the resumed process did NOTHING. Retrying re-runs the same prompt
 * from scratch — and these prompts merge PRs, file issues, label tickets and
 * send mail. A run that got as far as calling a tool may have already done the
 * irreversible half of its work; running it again does it twice.
 *
 * The safe case is narrow and real: `--resume <id>` against a session the CLI
 * can no longer find. Claude exits immediately, having emitted no session init,
 * called no tool and written no text. Starting fresh there is correct.
 *
 * Anything else — session started, any tool call, any output — is reported to
 * the user instead. A duplicated merge is far worse than an error message.
 */
function isSafeToRetryFresh(err) {
  if (!err) return false;
  return !err.sessionStarted && !err.toolCalls && !err.producedText;
}

async function runClaude(prompt, channelId, reqLog, sendMessage, attachments = {}, channelName = "unknown", progress = null) {
  const existingSession = channelSessions.get(channelId);
  const canResume = existingSession &&
    (Date.now() - existingSession.lastActivity) < SESSION_TIMEOUT_MS;

  if (canResume) {
    try {
      return await spawnClaude(prompt, channelId, reqLog, sendMessage, attachments, channelName, existingSession.sessionId, progress);
    } catch (err) {
      if (!isSafeToRetryFresh(err)) {
        // Keep the session. It exists and holds the conversation, so the user's
        // NEXT message continues where the crash left off. If the session is
        // genuinely unusable, the next resume fails with no work done and takes
        // the safe-retry branch below — self-healing either way.
        reqLog.error(
          { err: err.message, sessionId: existingSession.sessionId, toolCalls: err.toolCalls, sessionStarted: err.sessionStarted },
          "Resumed session failed after doing work — NOT retrying, would repeat side effects"
        );
        err.message = `${err.message}. It had already started working, so I did not retry — re-running would repeat anything it already did (merges, issues, messages). Check whether that work landed before asking again. If this keeps happening, send /fresh for a clean session.`;
        throw err;
      }

      channelSessions.delete(channelId);
      reqLog.warn(
        { err: err.message, sessionId: existingSession.sessionId },
        "Resume never started — safe to retry on a fresh session"
      );
    }
  }

  return spawnClaude(prompt, channelId, reqLog, sendMessage, attachments, channelName, null, progress);
}

function spawnClaude(prompt, channelId, reqLog, sendMessage, attachments, channelName, resumeSessionId, progress = null) {
  return new Promise((resolve, reject) => {
    const basePrompt = process.env.BOT_SYSTEM_PROMPT ||
      "You are running inside a Discord bot. Keep responses concise — Discord has a 2000 char limit per message. Do NOT perform startup rituals. Be brief.";

    const now = new Date();
    // timeStyle:"long" already emits the correct zone abbreviation for the date —
    // CDT in summer, CST in winter. The old code appended a literal " CDT" on top
    // of it, so this line read "10:01 AM CDT CDT" all summer and "6:00 AM CST CDT"
    // all winter. Let the formatter say it once, correctly.
    const localTime = now.toLocaleString("en-US", {
      timeZone: BOT_TIMEZONE,
      dateStyle: "short",
      timeStyle: "long",
    });
    const timeContext = `\n\nCurrent time: ${now.toISOString()} (${localTime})`;

    const channelContext = `${timeContext}\n\nYou are responding in channel: #${channelName}. Only respond to the message in THIS channel. The conversation buffer contains messages from multiple channels — focus only on #${channelName} context. Do NOT respond to or act on messages from other channels.`;

    // This run's outbox. Per channel, so two concurrent runs cannot claim each
    // other's files (see channelOutbox).
    const runOutbox = channelOutbox(channelId);

    // Harness mechanics, not personality — appended even when BOT_SYSTEM_PROMPT
    // overrides the base prompt, because these are the only ways files move.
    const fileTransferContext = [
      "",
      "",
      "--- Files ---",
      "RECEIVING: files the user attaches are downloaded and named to you in the prompt as [File attached by the user: ...] or [Image attached by the user: ...], with a local path. Any file type can arrive. Open the path with Read (or Bash for binary formats) before answering — never tell the user nothing was attached when such a line is present.",
      `SENDING: to hand a file back, either write it into the outbox at ${runOutbox} (anything you create there during this reply is attached automatically, any type), or emit a marker [[attach: /absolute/path]] anywhere in your reply. The marker is stripped before the user sees the message. Do not paste large file contents into chat when you can attach the file.`,
      "--- End files ---",
      "",
      "--- Commands handled by the harness ---",
      `These are intercepted before you see them, so you will never receive one as a message: ${RESERVED_COMMANDS.map((c) => "/" + c).join(", ")}. If asked what commands are available here, include them: /fresh clears this channel's session, /status reports buffer size and whether a request is running, and any of the stop words halts a run in flight. Do NOT define a command of your own with one of these names — the harness answers first and yours would never run.`,
      "--- End commands ---",
    ].join("\n");

    let systemPrompt;
    if (resumeSessionId) {
      // Resumed sessions already have the full context — only inject time and channel focus
      systemPrompt = `${basePrompt}${channelContext}${fileTransferContext}`;
      reqLog.info("Resume mode: skipping buffer/summary re-injection");
    } else {
      const context = buildContextPrompt(reqLog);
      systemPrompt = context
        ? `${basePrompt}${channelContext}${fileTransferContext}\n\n${context}`
        : `${basePrompt}${channelContext}${fileTransferContext}`;
    }

    const args = [
      "--output-format", "stream-json",
      ...permissionArgs("session"),
      ...skillPackArgs(),
      "--verbose",
      "--max-turns", String(CLAUDE_MAX_TURNS),
      ...(process.env.CLAUDE_MODEL ? ["--model", process.env.CLAUDE_MODEL] : []),
      ...(process.env.MCP_CONFIG ? ["--mcp-config", process.env.MCP_CONFIG] : []),
      "--append-system-prompt", systemPrompt,
    ];

    // Build the final prompt with every attachment named. This rides on the user
    // prompt rather than the system prompt, so files reach Claude on resumed
    // sessions too — the conversation buffer is skipped on resume.
    const fileRefs = attachments?.fileRefs || [];
    const attachmentFailures = attachments?.attachmentFailures || [];
    const attachmentLines = buildAttachmentPrompt(fileRefs, attachmentFailures);
    const finalPrompt = attachmentLines.length > 0
      ? `${attachmentLines.join("\n")}\n\n${prompt}`
      : prompt;

    const attachmentLog = { attachments: fileRefs.length, failedAttachments: attachmentFailures.length };
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId, "-p", "--", finalPrompt);
      reqLog.info({ sessionId: resumeSessionId, ...attachmentLog }, "Resuming Claude session");
    } else {
      args.push("-p", "--", finalPrompt);
      reqLog.info(attachmentLog, "Starting fresh Claude session");
    }

    // Build a clean env without Claude nesting vars
    const cleanEnv = { ...process.env };

    // Publish the RESOLVED paths. This is what stops harness-owned skills from
    // rotting: a skill that reads $BOT_BUFFER_FILE cannot go stale, while one
    // that names `.po-bot-conversation-buffer.txt` breaks the moment a bot is
    // renamed — which is exactly what happened to the shipped /remember, whose
    // three hardcoded paths were ALL dead by the time anyone checked.
    cleanEnv.BOT_STATE_DIR = STATE_DIR;
    cleanEnv.BOT_SUMMARIES_DIR = HISTORY_DIR;
    cleanEnv.BOT_ATTACHMENTS_DIR = ATTACHMENTS_DIR;
    cleanEnv.BOT_OUTBOX_DIR = runOutbox;
    cleanEnv.BOT_BUFFER_FILE = BUFFER_FILE;
    cleanEnv.BOT_SESSIONS_FILE = SESSION_FILE;
    cleanEnv.BOT_JOB_HISTORY_FILE = JOB_HISTORY_FILE;
    cleanEnv.BOT_SCHEDULES_FILE = SCHEDULES_FILE;
    cleanEnv.BOT_CHANNEL_ID = String(channelId);

    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_AGENT_SDK_VERSION;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;

    // The spawn boundary. The context budget above is the policy; this is the
    // guarantee — an oversized argument gets cut here rather than becoming a
    // `spawn E2BIG` that names neither the argument nor the reason.
    const { args: safeArgs, clamped } = clampArgs(args);
    for (const c of clamped) {
      reqLog.error(
        { argBytes: c.bytes, limit: c.limit, startsWith: c.preview },
        "An argument to Claude exceeded the OS limit and was truncated — this run saw an incomplete prompt. Lower CONTEXT_MAX_BYTES or SUMMARY_LOOKBACK_HOURS."
      );
    }

    const startTime = Date.now();
    const child = spawn(CLAUDE_BIN, safeArgs, {
      cwd: CLAUDE_CWD,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT_MS,
    });

    activeProcesses.set(channelId, child);

    let jsonBuffer = "";
    let turnText = "";
    let fullResponse = "";
    const writtenFiles = [];
    const state = {
      getTurnText: () => turnText,
      setTurnText: (t) => { turnText = t; },
      appendResponse: (t) => { fullResponse += t; },
      writtenFiles,
      sessionId: null,
      resultSubtype: null,
      progress,
      // Did this process actually DO anything? Decides whether a failed run can
      // be safely retried — see isSafeToRetryFresh.
      toolCalls: 0,
    };

    child.stdout.on("data", (data) => {
      jsonBuffer += data.toString();

      const lines = jsonBuffer.split("\n");
      jsonBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event, reqLog, sendMessage, state);
        } catch {
          reqLog.warn({ raw: line.substring(0, 200) }, "Non-JSON line from Claude");
        }
      }
    });

    child.stderr.on("data", (data) => {
      reqLog.warn({ stderr: data.toString().trim() }, "Claude stderr");
    });

    child.on("close", async (code) => {
      activeProcesses.delete(channelId);
      // Remove the status message first, so it never sits above the answer.
      try { await progress?.finish(); } catch { /* never block the reply */ }
      const elapsed = Date.now() - startTime;

      if (jsonBuffer.trim()) {
        try {
          const event = JSON.parse(jsonBuffer);
          handleStreamEvent(event, reqLog, sendMessage, state);
        } catch {
          // ignore
        }
      }

      // Send any remaining text from the last turn, minus the attach markers —
      // those are instructions to the harness, not something the user should read.
      if (turnText.trim()) {
        fullResponse += turnText;
        const visible = stripAttachMarkers(turnText);
        if (visible.trim()) sendMessage(visible);
        turnText = "";
      }

      // Hand back files, ANY type, by two explicit routes:
      //   1. [[attach: <path>]] in the reply
      //   2. anything written into the outbox during this run
      for (const p of collectMarkedFiles(fullResponse)) {
        if (existsSync(p) && !writtenFiles.includes(p)) writtenFiles.push(p);
      }
      // This channel's outbox — unambiguous, whatever else is running.
      for (const p of collectOutboxFiles(startTime, runOutbox)) {
        if (!writtenFiles.includes(p)) writtenFiles.push(p);
      }
      // Backward compatibility: a bot whose own context hardcodes the old shared
      // outbox path still works — but only when nothing else is in flight, since
      // that is the only moment a file in the shared root is unambiguously ours.
      if (activeProcesses.size === 0) {
        for (const p of collectOutboxFiles(startTime, OUTBOX_DIR)) {
          if (!writtenFiles.includes(p)) writtenFiles.push(p);
        }
      } else {
        reqLog.debug({ active: activeProcesses.size }, "Skipping shared outbox sweep — another run is in flight");
      }

      // Legacy route, deliberately kept narrow: Claude often names a file it made
      // via Bash/Python rather than the Write tool. Widening this extension list
      // would start attaching every repo doc the bot merely mentions, so new file
      // types go through the two routes above instead.
      const FILE_EXTENSIONS = ATTACH_RE;
      const pathMatches = fullResponse.match(/(?:^|[\s`'"])(\/?(?:[\w.-]+\/)*[\w.-]+\.\w{2,4})(?:[\s`'"]|$)/gm) || [];
      for (const match of pathMatches) {
        const cleaned = match.trim().replace(/^[`'"]+|[`'"]+$/g, "");
        if (!FILE_EXTENSIONS.test(cleaned)) continue;
        const candidates = cleaned.startsWith("/")
          ? [cleaned]
          : [join(CLAUDE_CWD, cleaned), join(CLAUDE_CWD, "..", cleaned), cleaned];
        for (const candidate of candidates) {
          if (existsSync(candidate) && !writtenFiles.includes(candidate)) {
            writtenFiles.push(candidate);
            break;
          }
        }
      }

      if (writtenFiles.length > 0) {
        const attachable = [];
        const tooBig = [];
        // Claude can Write the same path twice in one reply — send it once.
        for (const f of [...new Set(writtenFiles)]) {
          let size;
          try { size = statSync(f).size; } catch { continue; }
          if (size > MAX_OUTBOUND_BYTES) tooBig.push({ path: f, size });
          else attachable.push(f);
        }
        if (attachable.length > 0) {
          sendMessage({ files: attachable.map(f => ({ attachment: f })) });
          reqLog.info({ files: attachable }, "Attaching files to Discord");
        }
        // Oversized files used to fail inside msg.reply and get logged where the
        // user never sees it — they just got a reply with no file.
        if (tooBig.length > 0) {
          const listed = tooBig.map(t => `\`${t.path}\` (${Math.round(t.size / 1048576)}MB)`).join(", ");
          sendMessage(`⚠️ Too large to attach here (Discord limit ${Math.round(MAX_OUTBOUND_BYTES / 1048576)}MB): ${listed}`);
          reqLog.warn({ files: tooBig }, "Files too large to attach");
        }
      }

      // Persist session for resume — even on intentional kill (new message arriving)
      // so the next message can resume the conversation
      if (state.sessionId) {
        channelSessions.set(channelId, {
          sessionId: state.sessionId,
          lastActivity: Date.now(),
        });
        saveSessions();
        reqLog.info({ sessionId: state.sessionId, code }, "Session stored for resume");
      }

      if (code !== 0) {
        if (child._intentionalKill) {
          reqLog.info({ code, elapsed }, "Claude process intentionally killed");
          resolve(fullResponse);
          return;
        }
        // Hitting the step cap is not a crash — the work up to that point already
        // landed (PR reviews have merged and *then* tripped the cap). Say so plainly
        // instead of reporting a bare exit code, which reads as total failure.
        if (state.resultSubtype === "error_max_turns") {
          reqLog.warn({ code, elapsed, maxTurns: CLAUDE_MAX_TURNS }, "Claude hit the max-turns cap");
          sendMessage(
            `⚠️ Hit the ${CLAUDE_MAX_TURNS}-step limit for one request. Everything above this line completed — but there may be more to do. Reply to continue where I left off.`
          );
          resolve(fullResponse);
          return;
        }
        reqLog.error(
          { code, elapsed, subtype: state.resultSubtype, toolCalls: state.toolCalls, sessionStarted: Boolean(state.sessionId) },
          "Claude exited with non-zero code"
        );
        const failure = new Error(`Claude exited with code ${code} after ${Math.round(elapsed / 1000)}s`);
        // Evidence for the caller: a run that started a session, called tools, or
        // produced text may have already changed something in the world.
        failure.sessionStarted = Boolean(state.sessionId);
        failure.toolCalls = state.toolCalls;
        failure.producedText = fullResponse.trim().length > 0;
        reject(failure);
        return;
      }

      reqLog.info({ elapsed }, "Claude completed");
      resolve(fullResponse);
    });

    child.on("error", (err) => {
      reqLog.error({ err }, "Failed to spawn Claude");
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

function handleStreamEvent(event, reqLog, sendMessage, state) {
  switch (event.type) {
    case "system":
      // `system` arrives repeatedly during a run, not once — 29 of them landed in
      // one request on 2026-08-09, all logged identically as "session started",
      // burying the two Tool call lines that actually mattered. Only the init
      // event is the session starting; the rest are noise at info level.
      if (event.session_id && !state.sessionId) {
        state.sessionId = event.session_id;
        reqLog.info({ sessionId: event.session_id }, "Claude session started");
      } else {
        reqLog.debug({ subtype: event.subtype }, "Stream system event");
      }
      break;

    case "assistant":
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            state.setTurnText(state.getTurnText() + block.text);
          } else if (block.type === "tool_use") {
            // Don't flush text on tool calls — wait until Claude is fully done.
            // Flushing here causes "multiple responses" where users see a preamble
            // ("Let me check...") as a separate message before the actual answer.
            // Track files Claude creates for Discord attachment
            // Only attach user-facing files (CSV, PDF, etc.), not config/internal files
            state.toolCalls++;
            state.progress?.tool(block.name, block.input);
            if (block.name === "Write" && block.input?.file_path) {
              const fp = block.input.file_path;
              if (ATTACH_RE.test(fp)) {
                state.writtenFiles.push(fp);
              }
            }
            reqLog.info({ tool: block.name, inputPreview: JSON.stringify(block.input).substring(0, 120) }, "Tool call");
          }
        }
      }
      break;

    case "result":
      // subtype tells a step-cap stop apart from a real crash — both exit non-zero
      state.resultSubtype = event.subtype;
      reqLog.info(
        { subtype: event.subtype, isError: event.is_error, numTurns: event.num_turns, costUsd: event.cost_usd, durationMs: event.duration_ms, inputTokens: event.total_input_tokens, outputTokens: event.total_output_tokens },
        "Claude result summary"
      );
      break;

    default:
      reqLog.debug({ type: event.type }, "Stream event");
      break;
  }
}

function splitMessage(text) {
  if (text.length <= MAX_DISCORD_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt < MAX_DISCORD_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(" ", MAX_DISCORD_LENGTH);
    }
    if (splitAt < MAX_DISCORD_LENGTH / 2) {
      splitAt = MAX_DISCORD_LENGTH;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}

// --- Buffer rotation summarizer ---

function summarizeBufferLines(lines) {
  return summarizeCore.summarize({
    transcript: lines.join("\n"),
    kind: "buffer-rotation",
    claudeBin: CLAUDE_BIN,
    cwd: CLAUDE_CWD,
    model: process.env.SUMMARIZE_MODEL || process.env.CLAUDE_MODEL,
    timeoutMs: SUMMARIZE_TIMEOUT_MS,
    permissionArgs: permissionArgs("summarizer"),
  });
}

// --- Background summarizer (hourly channel summaries to HISTORY_DIR) ---

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

/**
 * Write one summary batch for a channel-day.
 *
 * APPENDS. It used to writeFileSync, which silently destroyed the day's history:
 * the summarizer runs on an interval, the checkpoint means each run only fetches
 * messages since the last one, so every run replaced a whole day's summary with a
 * summary of the last few minutes. Observed 2026-08-09 on this host — a day with
 * 14 completed conversations had a "daily" summary reading "6 messages
 * summarized", written at 11:34. Everything before 11:34 was gone, and the recall
 * paths that read these files had no way to know.
 *
 * `channelId` disambiguates two Discord channels that share a name (or that
 * sanitise to the same one). Without it the second channel's summaries append
 * into the first channel's file and the two conversations interleave.
 */
function writeSummary(channelName, date, messageCount, summary, channelId = null, kind = "channel-day") {
  return summarizeCore.writeSummary({
    historyDir: HISTORY_DIR, channelName, date, messageCount, summary, channelId, kind,
    timezone: BOT_TIMEZONE,
  });
}

async function fetchMessagesSince(channel, afterId) {
  const allMessages = [];
  let lastId = afterId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.after = lastId;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    allMessages.push(...sorted);
    lastId = sorted[sorted.length - 1].id;

    if (allMessages.length >= SUMMARIZE_BATCH_SIZE) break;
    if (batch.size < 100) break;
  }

  return allMessages;
}

function groupByDate(messages) {
  const groups = {};
  for (const m of messages) {
    const date = m.createdAt.toISOString().split("T")[0];
    if (!groups[date]) groups[date] = [];
    groups[date].push({
      timestamp: m.createdAt.toISOString(),
      author: m.author.tag,
      content: m.content.substring(0, 2000),
      isBot: m.author.bot,
    });
  }
  return groups;
}

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
    timeoutMs: SUMMARIZE_TIMEOUT_MS,
    permissionArgs: permissionArgs("summarizer"),
  });
}

let summarizing = false;

async function runSummarizer() {
  if (summarizing) return;
  if (channelsToSummarize().length === 0) return;
  summarizing = true;

  const sumLog = log.child({ component: "summarizer" });
  sumLog.info({ configured: SUMMARIZE_CHANNELS.length, total: channelsToSummarize().length }, "Summarizer cycle starting");

  const checkpoints = loadCheckpoints();
  let totalMessages = 0;
  let totalSummaries = 0;

  for (const channelId of channelsToSummarize()) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) continue;

      // A DM has no name. `dm-<channelId>` means nothing to a human reading the
      // directory later, so prefer who the conversation is actually with.
      const dmLabel = channel.recipient?.username
        ? `dm-${channel.recipient.username}`
        : `dm-${channelId}`;
      const channelName = (channel.name || dmLabel).replace(/[^a-zA-Z0-9-_]/g, "-");
      const afterId = checkpoints[channelId] || null;

      const messages = await fetchMessagesSince(channel, afterId);
      if (messages.length === 0) continue;

      totalMessages += messages.length;
      const groups = groupByDate(messages);

      for (const date of Object.keys(groups).sort()) {
        const dayMessages = groups[date];
        try {
          const summary = await summarizeWithClaude(channelName, date, dayMessages);
          writeSummary(channelName, date, dayMessages.length, summary, channelId);
          totalSummaries++;
          sumLog.info({ channel: channelName, date, messages: dayMessages.length }, "Summary saved");
        } catch (err) {
          sumLog.error({ channel: channelName, date, err: err.message }, "Failed to summarize");
        }
      }

      checkpoints[channelId] = messages[messages.length - 1].id;
      saveCheckpoints(checkpoints);
    } catch (err) {
      sumLog.error({ channelId, err: err.message }, "Failed to process channel");
    }
  }

  sumLog.info({ totalMessages, totalSummaries }, "Summarizer cycle complete");
  summarizing = false;
}

if (SUMMARIZE_INTERVAL_MS > 0) {
  setTimeout(() => {
    runSummarizer();
    setInterval(runSummarizer, SUMMARIZE_INTERVAL_MS);
  }, SUMMARIZER_START_DELAY_MS);
  log.info({ intervalMs: SUMMARIZE_INTERVAL_MS, channels: SUMMARIZE_CHANNELS }, "Background summarizer enabled");
}

// --- Scheduled jobs ---
const SCHEDULE_CHECK_MS = envInt("BOT_SCHEDULE_CHECK_MS", 60_000, { min: 1000 }); // scheduler tick

function loadSchedules() {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSchedules(schedules) {
  writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2) + "\n");
}


function recordJobExecution(job, startTime, durationMs, success, error) {
  const record = {
    id: job.id,
    cron: job.cron,
    scheduledFor: startTime.toISOString(),
    firedAt: new Date().toISOString(),
    durationMs,
    success,
    ...(error ? { error } : {}),
  };
  try {
    appendFileSync(JOB_HISTORY_FILE, JSON.stringify(record) + "\n");
  } catch { /* ignore */ }
}

function describeCron(cron) {
  const [min, hour, day, month, dow] = cron.split(/\s+/);
  const parts = [];
  if (min !== "*" && hour !== "*") {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    parts.push(`${h12}:${String(m).padStart(2, "0")} ${ampm}`);
  }
  if (day !== "*" && month !== "*") {
    parts.push(`on ${month}/${day}`);
  }
  if (dow !== "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayNames = dow.split(",").map(d => days[parseInt(d, 10)] || d);
    parts.push(dayNames.join(","));
  }
  return parts.join(" ") || cron;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Wall-clock fields for a moment, in a named timezone.
 *
 * The scheduler used date.getHours()/getDate()/getDay(), which are HOST-local.
 * So a bot configured BOT_TIMEZONE=Europe/London firing "0 7 * * *" on a Chicago
 * host fired at 7am Chicago — 1pm London. "Every morning at 7am local" meant
 * "7am wherever the server happens to be", which is nobody's intent.
 */
function zonedParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    min: Number(parts.minute),
    hour: Number(parts.hour) % 24,     // some engines render midnight as 24
    day: Number(parts.day),
    month: Number(parts.month),
    dow: WEEKDAY_INDEX[parts.weekday],
  };
}

function cronMatchesTime(cron, date, tz = BOT_TIMEZONE) {
  // Parse "M H D MO DOW" cron format — check if a given time matches
  const [cronMin, cronHour, cronDay, cronMonth, cronDow] = cron.split(/\s+/);
  const { min, hour, day, month, dow } = zonedParts(date, tz);

  function matches(field, value) {
    if (field === "*") return true;
    return field.split(",").some(v => parseInt(v, 10) === value);
  }

  return matches(cronMin, min) && matches(cronHour, hour)
    && matches(cronDay, day) && matches(cronMonth, month)
    && matches(cronDow, dow);
}

function shouldRunNow(cron, lastRunKey, tz = BOT_TIMEZONE) {
  // Check current minute AND the last few minutes (catch missed runs)
  const now = new Date();
  const LOOKBACK_MINUTES = envInt("BOT_SCHEDULE_LOOKBACK_MINUTES", 5, { min: 0 });

  for (let i = 0; i <= LOOKBACK_MINUTES; i++) {
    const checkTime = new Date(now.getTime() - i * 60_000);
    // Keyed in the same zone the match is evaluated in, or the two disagree
    // across a DST boundary and a run is either doubled or lost.
    const k = zonedParts(checkTime, BOT_TIMEZONE);
    const checkKey = `${k.month}-${k.day}-${k.hour}-${k.min}`;

    // Skip if already ran for this minute
    if (checkKey === lastRunKey) continue;

    if (cronMatchesTime(cron, checkTime, tz)) return true;
  }

  return false;
}

// Re-entrancy guard: setInterval fires this without awaiting, so a job running
// longer than the check interval would otherwise stack overlapping ticks.
let schedulerRunning = false;

async function runScheduledJobs() {
  if (schedulerRunning) return;
  schedulerRunning = true;

  try {
    const schedules = loadSchedules();
    if (!schedules.length) return;

    const now = new Date();
    const sLog = log.child({ component: "scheduler" });

    // Second Way: log what we found on every cycle
    const pending = schedules.filter(j => !j._remove);
    sLog.debug({ jobs: pending.length, ids: pending.map(j => j.id) }, "Scheduler check");

    for (const job of schedules) {
      // Check if job should run (current minute or missed in last 5 minutes)
      if (!shouldRunNow(job.cron, job._lastRun, job.tz || BOT_TIMEZONE)) {
        // Only expire jobs that didn't need to run
        if (job.expires && new Date(job.expires) < now) {
          job._remove = true;
          saveSchedules(schedules.filter(j => !j._remove));
          sLog.info({ id: job.id, expires: job.expires, cron: describeCron(job.cron) }, "Scheduled job expired without firing, removing");
        }
        continue;
      }

      // Resolve the channel BEFORE stamping _lastRun. Stamping first marked a job
      // "ran" even when it was skipped for a missing channel — and channels.cache
      // is empty for a moment after a Discord reconnect, so a gateway blip at the
      // scheduled minute silently burned the run for the day (jerky-em, 2026-06-11).
      // Leaving it unstamped keeps it eligible for the 5-minute lookback.
      const channel = client.channels.cache.get(job.channel);
      if (!channel) {
        sLog.warn(
          { id: job.id, channel: job.channel },
          "Scheduled job channel not found — not stamping _lastRun so it retries on the next tick"
        );
        continue;
      }

      // Stamp and PERSIST before the job runs. Without persisting, a job that
      // outlasts the check interval is re-fired by the next tick, because the
      // file on disk still shows the previous _lastRun.
      const nk = zonedParts(now, BOT_TIMEZONE);
      const nowKey = `${nk.month}-${nk.day}-${nk.hour}-${nk.min}`;
      job._lastRun = nowKey;
      saveSchedules(schedules.filter(j => !j._remove));

      // First Way: validate before executing
      sLog.info({ id: job.id, cron: job.cron, humanTime: describeCron(job.cron), prompt: job.prompt.substring(0, 80) }, "Firing scheduled job");

      const jobLog = log.child({ component: "scheduler", jobId: job.id });
      const sendToChannel = async (content) => {
        try {
          if (typeof content === "object" && content.files) {
            await channel.send(content);
          } else {
            for (const chunk of splitMessage(content)) {
              await channel.send(chunk);
            }
          }
        } catch (err) {
          jobLog.error({ err: err.message }, "Failed to send scheduled message");
        }
      };

      // Third Way: record execution for learning
      const startTime = new Date();
      try {
        const channelName = channel.name || job.channel;
        await runClaude(job.prompt, job.channel, jobLog, sendToChannel, {}, channelName);
        const durationMs = Date.now() - startTime.getTime();
        sLog.info({ id: job.id, durationMs }, "Scheduled job completed successfully");
        recordJobExecution(job, startTime, durationMs, true);
      } catch (err) {
        const durationMs = Date.now() - startTime.getTime();
        sLog.error({ id: job.id, err: err.message, durationMs }, "Scheduled job failed");
        recordJobExecution(job, startTime, durationMs, false, err.message);
        await sendToChannel(`Scheduled job "${job.id}" failed: ${err.message}`);
      }

      // Expire one-time jobs after successful execution
      if (job.expires) {
        job._remove = true;
        saveSchedules(schedules.filter(j => !j._remove));
        sLog.info({ id: job.id }, "One-time job completed, removing");
      }
    }
  } finally {
    schedulerRunning = false;
  }
}

// First Way: validate jobs on load — log what's scheduled so misconfigurations are visible immediately
function validateSchedulesOnStartup() {
  const schedules = loadSchedules();
  if (!schedules.length) {
    log.info({ file: SCHEDULES_FILE }, "Job scheduler enabled (no jobs)");
    return;
  }
  for (const job of schedules) {
    const fields = (job.cron || "").split(/\s+/);
    if (fields.length !== 5) {
      log.warn({ id: job.id, cron: job.cron }, "Invalid cron format — expected 5 fields");
      continue;
    }
    log.info({ id: job.id, fires: describeCron(job.cron), expires: job.expires || "never", prompt: job.prompt.substring(0, 60) }, "Scheduled job loaded");
  }
  log.info({ file: SCHEDULES_FILE, count: schedules.length }, "Job scheduler enabled");
}
validateSchedulesOnStartup();

// Start scheduler check loop
setInterval(runScheduledJobs, SCHEDULE_CHECK_MS);

// --- Process error handlers ---
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error({ err: err.message, stack: err.stack }, "Unhandled promise rejection");
});

// Graceful shutdown
process.on("SIGINT", () => {
  log.info("Shutting down...");
  clearReady();
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log.info("Shutting down...");
  clearReady();
  client.destroy();
  process.exit(0);
});

// A rejected login MUST be fatal. Left uncaught it fell through to the
// unhandledRejection handler, which only logs — and the process stayed alive
// forever because the WS server and scheduler keep the event loop busy. The
// result was a bot that reported "started" and "running" while being
// permanently deaf, which is the worst failure mode we can hand a new user.
client.login(DISCORD_TOKEN).catch((err) => {
  clearReady();
  const hint = /token/i.test(err.message)
    ? "Check DISCORD_TOKEN — it is missing, malformed, or has been reset in the Discord Developer Portal."
    : "Check network access to Discord, then the token.";
  log.fatal({ err: err.message }, `Discord login failed. ${hint}`);
  process.exit(1);
});
