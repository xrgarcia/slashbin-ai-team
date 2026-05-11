# slashbin-ai-team

**The AI engineering team behind [slashbin.io](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team) — the webhook ETL gateway for engineers and AI agents. [Try slashbin.io free →](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team)**

*Product Owner, Engineering Manager, SRE — coordinating autonomously to ship software.*

Build AI employees for your business on Discord. Give each one a role, connect it to your tools, and let them work together.

Built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Each bot gets full access to your codebase, MCP servers, and tools — not a chatbot wrapper, but a real AI teammate that can read code, query databases, create issues, and ship work.

## Who this is for

- **Vibe coders** — your AI builds the pipeline, you never touch webhook plumbing
- **Developers** — replace boilerplate with AI employees that handle ops, reviews, and coordination
- **Small business owners & solopreneurs** — run a team of AI employees without hiring, from product owner to SRE

## What you can build

- A **Product Owner** that manages your backlog, writes issues, and talks to customers
- An **Engineering Manager** that decomposes epics, reviews PRs, and coordinates deploys
- An **SRE bot** that monitors services, picks up approved issues, and ships fixes
- A **Support agent** that answers questions using your docs and database
- Any role you can describe in a `CLAUDE.md` file

Each bot is defined by its context — a `CLAUDE.md` that describes who it is, what it knows, and what it can do. Change the context, change the employee.

## Key features

- **One codebase, many employees** — run multiple bot instances from a single install, each with its own role, tools, and Discord channels
- **Real tool access** — connect Stripe, Postgres, Railway, GitHub, or any MCP server. Bots don't just talk — they act.
- **Bot-to-bot coordination** — AI employees can @mention each other and collaborate, with built-in loop prevention so they don't spiral
- **Conversation memory** — sessions persist across restarts. Background summarization compresses chat history into searchable daily summaries, giving bots cross-session awareness.
- **Image understanding** — attach screenshots, diagrams, or UI mockups and the bot analyzes them
- **Stream progress** — see what the bot is doing as it works, not just the final answer
- **Works with your codebase** — bots run from your project directory with full read/write access to code, docs, and config

## Quick start

### 1. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g., "Product Owner")
3. Go to **Bot** tab → **Reset Token** → copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2 → URL Generator** → select `bot` scope → permissions: `Send Messages`, `Read Message History`
6. Open the generated URL → invite the bot to your server

### 2. Clone and install

```bash
git clone https://github.com/xrgarcia/slashbin-discord-bot.git
cd slashbin-discord-bot
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your-discord-bot-token-here
CLAUDE_CWD=/path/to/your/project-repo
```

`CLAUDE_CWD` is your **project directory** — the repo with your `CLAUDE.md`, `.mcp.json`, and Claude Code skills. This is how the bot gets its personality and capabilities.

### 4. Define your AI employee

The `CLAUDE.md` in your project directory is the bot's brain. It controls what the bot knows, how it behaves, and what it can do.

```bash
cp CLAUDE.md.example CLAUDE.md
```

**What to include:**

| Section | Purpose | Example |
|---|---|---|
| **Role** | Who the bot is | "You are a product owner for Acme Corp" |
| **Quick lookups** | What it can query | "Query Postgres via MCP, check Stripe billing" |
| **Actions** | What it's allowed to do | "Create GitHub issues, commit and push" |
| **Terminology** | Domain terms | "Golden Model = canonical output schema" |
| **Repos** | Where to find code and file issues | "acme/backend — main API server" |

Keep it under 100 lines. Claude loads the full `CLAUDE.md` on every message — lean context means faster responses.

### 5. Run

```bash
npm start
```

Your AI employee is online.

## Usage

- **DM the bot** — it responds to all direct messages
- **@mention in a channel** — `@ProductOwner what's the status of open issues?`
- **Monitored channels** — set `MONITOR_CHANNELS` in `.env` for always-on response (no @mention needed)
- `/new` — clear the session, start fresh
- `/stop` — kill the running Claude process

### Sessions

Each channel gets its own conversation. Messages continue with full context until you type `/new`. Sessions survive bot restarts, idle time, and reboots.

### Context tiers

Every session gets two layers of memory:

1. **Recent summaries** — compressed daily summaries from the last 48 hours
2. **Recent messages** — last 30 raw messages from monitored channels

This gives bots awareness across sessions and channels without raw message bloat.

## Running multiple AI employees

Run a whole team from a single install. Each bot gets its own Discord token, project directory, and role.

```bash
cp ecosystem.config.example.js ecosystem.config.js
```

```js
require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'product-owner',
      script: 'bot.js',
      env: {
        BOT_NAME: 'product-owner',
        DISCORD_TOKEN: process.env.PO_DISCORD_TOKEN,
        CLAUDE_CWD: '/path/to/product-owner-repo',
        MONITOR_CHANNELS: '123456789',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: '/path/to/product-owner-repo/.bot-history',
        WS_PORT: '9801',
        NODE_ENV: 'production',
      }
    },
    {
      name: 'engineering-manager',
      script: 'bot.js',
      env: {
        BOT_NAME: 'engineering-manager',
        DISCORD_TOKEN: process.env.EM_DISCORD_TOKEN,
        CLAUDE_CWD: '/path/to/engineering-manager-repo',
        MONITOR_CHANNELS: '987654321',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: '/path/to/engineering-manager-repo/.bot-history',
        WS_PORT: '9802',
        NODE_ENV: 'production',
      }
    },
  ]
};
```

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

**Using Doppler for secrets?** Replace `require('dotenv').config()` with `doppler run`:

```bash
doppler run --project my-project --config prd -- pm2 start ecosystem.config.js
```

Tokens are injected via `process.env` — no `.env` file needed. Set up as a systemd service for auto-start on reboot.

### Bot-to-bot coordination

AI employees can talk to each other. A Product Owner bot can @mention the Engineering Manager to hand off work. An SRE bot can escalate to the Product Owner when something breaks.

**Both bots must whitelist each other:**

```env
# Product Owner's .env — allow Engineering Manager to talk to it
ALLOWED_BOTS=<em-bot-user-id>

# Engineering Manager's .env — allow Product Owner to talk to it
ALLOWED_BOTS=<po-bot-user-id>
```

**Loop prevention** is built in. Bots automatically stop after `MAX_BOT_EXCHANGES` consecutive exchanges (default: 2). Any human message resets the counter — you're always the circuit breaker.

## Connecting tools (MCP servers)

Give your AI employees access to real systems via `.mcp.json`:

```json
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": ["-y", "@stripe/mcp"]
    },
    "my-database": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://..."]
    }
  }
}
```

Any MCP server works — Stripe, Postgres, Railway, GitHub, Slack, custom APIs. The bot connects them all before responding.

## Managing bots

```bash
npm start          # start in background
npm stop           # graceful shutdown
npm restart        # stop + start
npm run status     # PID, uptime, recent logs
npm run logs       # tail last 20 lines
npm run logs 50    # tail last 50 lines
```

For production, use **pm2** or **systemd** for auto-restart on crashes and reboots.

<details>
<summary>systemd example (Linux)</summary>

```ini
# /etc/systemd/system/ai-employee.service
[Unit]
Description=AI Employee (Discord)
After=network.target

[Service]
Type=simple
User=your-user
WorkingDir=/path/to/slashbin-discord-bot
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable ai-employee
sudo systemctl start ai-employee
journalctl -u ai-employee -f
```

</details>

## Chat history & summarization

The built-in summarizer compresses Discord chat history into searchable daily markdown files. Enable it in `.env`:

```env
SUMMARIZE_INTERVAL_MS=3600000   # summarize every hour
```

Summaries are automatically injected into every Claude session (last 48h), giving bots long-term memory across conversations. You can also run it manually:

```bash
npm run summarize          # summarize new messages
npm run summarize:dry      # preview (no changes)
```

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | (required) | Discord bot token |
| `BOT_NAME` | `bot` | Instance name (used for PID file, required for multi-bot) |
| `CLAUDE_CWD` | current dir | Project repo with `CLAUDE.md`, `.mcp.json`, skills |
| `MCP_CONFIG` | (none) | Path to `.mcp.json` if not in `CLAUDE_CWD` |
| `ALLOWED_USERS` | (all) | Restrict access to specific Discord user IDs |
| `MONITOR_CHANNELS` | (none) | Channels where bot responds without @mention |
| `ALLOWED_CHANNELS` | (none) | Channels where bot can respond (DMs always allowed) |
| `ALLOWED_BOTS` | (none) | Bot user IDs allowed to interact |
| `MAX_BOT_EXCHANGES` | `2` | Max bot-to-bot exchanges before stopping |
| `BOT_SYSTEM_PROMPT` | (built-in) | Override the system prompt |
| `SESSION_TIMEOUT_MS` | `1800000` | Session inactivity timeout (30 min) |
| `CLAUDE_TIMEOUT_MS` | `3600000` | Max time per session (1 hour) |
| `CLAUDE_MODEL` | (CLI default) | Claude model (e.g., `claude-opus-4-6`) |
| `SUMMARIZE_MODEL` | `CLAUDE_MODEL` | Model for summarization (use cheaper model) |
| `RECENT_CONTEXT_CHANNELS` | (none) | Channels to pull recent messages from for session context |
| `RECENT_CONTEXT_MAX_MESSAGES` | `30` | Sliding window size |
| `RECENT_CONTEXT_MAX_CHARS` | `12000` | Total context budget |
| `SUMMARIZE_CHANNELS` | (none) | Channels to summarize on interval |
| `SUMMARY_LOOKBACK_HOURS` | `48` | Summary history window |
| `SUMMARIZE_INTERVAL_MS` | `0` | Background summarization interval |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `REACTION_HANDLER_ENABLED` | `false` | Set `true` to enable emoji reaction triggers (requires `ALLOWED_USERS`) |
| `REACTION_TRIGGER_EMOJI` | `👍` | Emoji that triggers Claude when reacted on a bot message |
| `REACTION_ACK_EMOJI` | `✅` | Emoji the bot adds after a successful Claude invocation |
| `REACTION_FAIL_EMOJI` | `❌` | Emoji the bot adds when Claude invocation fails |

## Reaction-trigger handler

Enable bots to respond to emoji reactions instead of typed messages. A single tap on a bot message invokes Claude with a labeled context line describing the reaction.

**Hard requirement:** `ALLOWED_USERS` must be non-empty when `REACTION_HANDLER_ENABLED=true`. If `ALLOWED_USERS` is empty, the handler refuses to register and logs a fatal warning — the bot otherwise starts normally for messages.

Enable per-bot in `ecosystem.config.js`:

```js
REACTION_HANDLER_ENABLED: 'true',
ALLOWED_USERS: '<your-discord-user-id>',
REACTION_TRIGGER_EMOJI: '👍',
```

When the trigger emoji is reacted on a bot message, Claude receives this context:

```
[reaction_trigger]
emoji: 👍
reactor: username#1234567890
message_id: <id>
channel_id: <id>
reacted_content: <verbatim message text>
```

**Bot operator's responsibility:** Define in your `CLAUDE.md` what the trigger emoji means and which MCP tool to call. The harness is dumb transport — all semantic meaning lives in the bot's own context.

**Behavior notes:**

- The bot's own ack reaction (`✅`) does not retrigger — self-loop is prevented
- Unauthorized users (not in `ALLOWED_USERS`) are silently ignored
- Double-tapping the same message fires Claude only once; the second tap is dropped
- Reactions on older messages after a bot restart still fire (Discord partials are resolved)
- On failure: fail emoji is added AND a reply with the error summary is posted — no silent failure

## Architecture

```
Discord message
  → bot.js receives via discord.js
  → spawns `claude` CLI with --output-format stream-json
  → streams events back as Discord messages
  → session ID saved for conversation continuity
```

- **CLI spawn, not SDK** — uses Claude Code CLI directly, inheriting all built-in tools (Bash, Read, Edit, Grep) and MCP support
- **stdin: "ignore"** — prevents Claude from hanging waiting for interactive consent
- **Stream processing** — users see progress as the bot works, not just the final answer
- **Send queue** — messages are serialized to avoid Discord rate limits

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Bot sends empty messages | Claude hanging on stdin | Ensure `stdio: ["ignore", "pipe", "pipe"]` in spawn options |
| Bot ignores @mentions from another bot | Bot-to-bot not configured | Add the other bot's user ID to `ALLOWED_BOTS` in both bots |
| Bot appears stuck | MCP server unreachable | Remove `.mcp.json`, test, add servers back one at a time |
| Error code 143 | Timeout (SIGTERM) | Increase `CLAUDE_TIMEOUT_MS` or check for hanging MCP servers |
| "Claude exited with code 1" | CLI not authenticated | Run `claude auth` in your terminal |
| Bot doesn't see messages | Missing intent | Enable **Message Content Intent** in Discord Developer Portal |

## Prerequisites

- **Node.js** 18+
- **Claude Code CLI** installed and authenticated ([install guide](https://docs.anthropic.com/en/docs/claude-code/getting-started))

## License

ISC
