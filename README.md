# slashbin-ai-team

**The AI engineering team behind [slashbin.io](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team) — the webhook ETL gateway for engineers and AI agents. [Try slashbin.io free →](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team)**

*Product Owner, Engineering Manager, SRE — coordinating autonomously to ship software.*

**Build AI employees for your business on Discord. Give each one a role, connect it to your tools, and let them work together — across one product or across an entire portfolio.**

[![CI](https://github.com/xrgarcia/slashbin-ai-team/actions/workflows/ci.yml/badge.svg)](https://github.com/xrgarcia/slashbin-ai-team/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

- **Cost:** $0 marginal under your Claude Max plan. Each bot runs through the Claude Code CLI — no API charges, no SaaS subscription, no per-bot fees.
- **Focused context:** Each bot's `CLAUDE.md` is its job description. A PO bot loads product context, an SRE bot loads ops context. Separated context produces sharper output than one generalist juggling every role in one window.
- **Async parallelism:** While you DM the PO, the EM bot can be reviewing a PR and the SRE bot can be watching a deploy. Multiple bots = multiple things happening at once, not role-play.
- **Safe to leave running:** an agent that can merge a PR needs guarantees about what happens when it crashes. [See below.](#why-safe-to-leave-running)

Built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Each bot gets full access to your codebase, MCP servers, and tools — not a chatbot wrapper, but a real AI teammate that can read code, query databases, create issues, and ship work.

```bash
git clone https://github.com/xrgarcia/slashbin-ai-team.git
cd slashbin-ai-team && npm install
npm run setup     # asks a handful of questions, validates every answer
npm start
```

Full walkthrough including the Discord side: **[docs/INSTALL.md](docs/INSTALL.md)**.

## Who this is for

Three patterns where an AI team beats a single generalist agent:

**1. Consulting / agency operators** — one PO bot fields asks across multiple clients and routes work into per-client EM and SRE bots. Each client gets a dedicated `CLAUDE.md` and its own Discord channels. Strategy stays with you; coordination stays with the bots.

**2. Multi-business operators** — you run several companies, each with its own PO/EM/SRE team. One Discord server, separated channels per business, separated context per bot. Bots from different businesses don't cross-talk unless you whitelist them.

**3. Single business, many service owners** — role-based bots (PO, EM, SRE, Support) coordinating on one product. The PO writes issues, the EM decomposes and approves, the [Foreman](https://github.com/xrgarcia/slashbin-ai-foreman) implements, the EM bot reviews, you ship.

**Also useful for:**

- **Vibe coders** — your AI builds the pipeline, you never touch webhook plumbing
- **Developers** — replace boilerplate with AI employees that handle ops, reviews, and coordination
- **Small business owners & solopreneurs** — run a team of AI employees without hiring, from product owner to SRE

> **Why separate bots if you're solo?** Each bot has a focused context window — a PO bot loaded with product context produces sharper product output than a generalist juggling product, ops, and code in one session. And bots run in parallel: while you're talking to one, the others are working. Async, not role-play.

## Why "safe to leave running"

Plenty of projects put an LLM in Discord. The hard part isn't answering — it's what happens when an agent that can **merge a PR** crashes halfway through. These guarantees each exist because the failure happened here first:

- **A crashed run is never blindly retried.** If a resumed session already started, called a tool, or produced text, the harness refuses to re-run it and tells you to check what landed. Re-running a prompt that merged a PR merges it twice. At-most-once, by construction.
- **A step-cap is reported as a step-cap.** Hitting the limit means the work so far landed — you get "reply to continue", not a bare exit code that reads as total failure.
- **A bot that can't reach Discord dies.** It doesn't sit there reporting healthy while ignoring every message. `npm run status` tells you *connected*, not just *running*.
- **A scheduled run survives a reconnect.** Jobs aren't marked "ran" until their channel actually resolves, so a gateway blip doesn't silently burn the day's run.
- **A dropped attachment says so.** The bot will never claim nothing was attached when something was.
- **Bots can't spiral.** Bot-to-bot exchanges stop after a limit, and any human message resets it — you are always the circuit breaker.

## What you can build

- A **Product Owner** that manages your backlog, writes issues, and talks to customers
- An **Engineering Manager** that decomposes epics, reviews PRs, and coordinates deploys
- An **SRE bot** that monitors services, picks up approved issues, and ships fixes
- A **Support agent** that answers questions using your docs and database
- Any role you can describe in a `CLAUDE.md` file

Each bot is defined by its context — a `CLAUDE.md` that describes who it is, what it knows, and what it can do. Change the context, change the employee.

**What to include:**

| Section | Purpose | Example |
|---|---|---|
| **Role** | Who the bot is | "You are a product owner for Acme Corp" |
| **Quick lookups** | What it can query | "Query Postgres via MCP, check Stripe billing" |
| **Actions** | What it's allowed to do | "Create GitHub issues, commit and push" |
| **Terminology** | Domain terms | "Golden Model = canonical output schema" |
| **Repos** | Where to find code and file issues | "acme/backend — main API server" |

Keep it under 100 lines. Claude loads the full `CLAUDE.md` on every message — lean context means faster responses. Start from `CLAUDE.md.example`.

## Features

**Agent runtime** — spawns the `claude` CLI per message. Serialized send queue, automatic message splitting, per-request step and time caps, and a concurrency guard that refuses politely rather than thrashing.

**Live progress** — while a request runs, the bot posts one status line that is edited in place as it works (`⚙️ working — 6 steps · Read bot.js`), then removed when the answer arrives.

> It reports **activity, never prose**. The answer is still delivered exactly once, at the end, unsplit. That distinction is the whole design: an earlier version streamed the reply text itself, so a preamble like "Let me check…" landed as its own message and the bot looked like it answered twice. Tool *inputs* are never shown either — a Bash command routinely carries a connection string.
>
> Turn it off with `BOT_PROGRESS_ENABLED=false`.

**Harness skills, one golden source** — skills that operate on harness-owned data ship *with the harness* in `skill-pack/` and load into every bot automatically, namespaced as `/slashbin-harness:<name>`. No copying into each bot's repo.

> The harness publishes its **resolved** paths — `$BOT_STATE_DIR`, `$BOT_SUMMARIES_DIR`, `$BOT_BUFFER_FILE` and friends — into every run. Pack skills read those and never name a file, which is what stops them going stale when a bot is renamed or a directory moves. Disable with `BOT_SKILL_PACK=`; add your own with `BOT_EXTRA_SKILL_PACKS`.

**Roles and identity** — one bot = one `CLAUDE_CWD`. That directory's `CLAUDE.md` is its role, its `.mcp.json` its tools, its skills its procedures.

**Memory and continuity** — each channel keeps its own Claude session, persisted across restarts. A rolling buffer records everything; when it fills, the oldest slice is summarized rather than dropped. A background summarizer writes daily summaries, and the last 48 hours are injected into new sessions.

**Recall** — `/slashbin-harness:remember <question>` searches everything the bot has: **every** daily summary (not just the injected window), the live conversation buffer, files people sent, live sessions and scheduled runs.

> It reports **which sources it actually searched**, so "searched and found nothing" is never confused with "never searched". That distinction is the feature: the version this replaces read three paths that had been dead for months, reported it had checked them, and answered confidently from the fraction it happened to find.
>
> Works mid-conversation on a resumed session, where the harness does not re-inject context — so a long conversation no longer *loses* memory as it goes.

**Multiple employees, one install** — N bots from one clone, each with its own token, role, channels and state. Manage them individually (`--name`) or see them all (`npm run list`). Bots can @mention each other, with loop prevention built in.

**Access control** — allowlists for users, channels and peer bots. Humans are gated by `ALLOWED_USERS`, bots by `ALLOWED_BOTS`; neither list has to name the other's members.

**Work that happens without you** — *"every weekday at 7am, post the customer reach numbers"*. Just ask; the bot schedules it, reads the job back, and tells you when it will next fire. Times are in **your** timezone, not the server's. Runs missed during a restart are recovered rather than skipped.

**Follow-ups it keeps** — *"I'll check back in twenty minutes"* is a job on disk, not an intention. A bot can set its own one-shot wake-up, carry forward what it already knows, and keep watching something across as many looks as it needs — choosing the gap each time, staying silent while nothing changes, and stopping the moment it has an answer. Nothing survives on hope: the run that promises the follow-up schedules it in the same breath.

**Triggers** — a DM, an @mention, any message in a monitored channel, or an emoji reaction.

**Files, any type, both directions** — attach anything and the bot opens it; reply to a message that has one and ask about it. Bots hand files back via an outbox or a marker. Oversized files are reported, never silently dropped.

**Operations** — `start`/`stop`/`restart`/`status`/`list`/`logs`, structured logging, graceful shutdown, duplicate-instance guard, and `npm run doctor` (plus `doctor:fleet` for every bot at once).

## Commands

In Discord:

| Command | What it does |
|---|---|
| `/fresh` | Clear this channel's session; the next message starts a new conversation |
| `/stop` | Kill the running request in this channel |
| `/status` | Buffer size, message count, attachments, whether a request is running |

> **These names are reserved.** The harness answers them before your bot ever sees
> the message, so a command of your own with one of these names — including any
> `BOT_STOP_WORDS` — **can never run**. Nothing errors; it silently does nothing
> while still appearing in the bot's own list of what it can do. `npm run doctor`
> fails if it finds one, and the bot warns at startup.

In your shell (add `-- --name <bot>` to target one instance):

| Command | What it does |
|---|---|
| `npm run setup` | Interactive configuration, validated as you go |
| `npm run doctor` | Check an existing install; exits non-zero on failure |
| `npm run doctor:fleet` | Check **every** bot in `ecosystem.config.js` in one pass — tokens, schedules, stale processes |
| `npm run advise` | Read an existing install and list what to do **before** upgrading. `--json` for an agent; `--dir` to point at any checkout |
| `npm start` / `stop` / `restart` | Manage the bot |
| `npm run status` | Is it running — and is it *connected*? |
| `npm run list` | Every bot instance in this checkout |
| `npm run logs [N]` | Tail the log |
| `npm run summarize` | Summarize now rather than on the interval |
| `npm test` | The suite |

## Connecting tools (MCP)

Put a `.mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "stripe": { "command": "npx", "args": ["-y", "@stripe/mcp"] },
    "db": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://..."] }
  }
}
```

Any MCP server works. Connected MCP tools stay available in `restricted` mode — the tool allowlist governs the built-ins.

## Tool exposure

| `BOT_PERMISSION_MODE` | Behaviour |
|---|---|
| `restricted` *(default)* | Only `BOT_ALLOWED_TOOLS` — read-only built-ins by default — plus connected MCP tools |
| `bypass` | Every tool, no permission checks |

**Use `bypass` only for a bot you intend to let write code and run commands, and only alongside a real `ALLOWED_USERS`.** In that configuration anyone who can reach the bot can run commands on your machine. It warns on every start.

Running several bots? Set `BOT_PERMISSION_MODE_DEFAULT` once in the host environment instead of repeating `BOT_PERMISSION_MODE` in every app entry. Resolution order:

1. `BOT_PERMISSION_MODE` — this bot. Always wins.
2. `BOT_PERMISSION_MODE_DEFAULT` — every bot on this host that sets no mode of its own.
3. `restricted` — the built-in default.

The startup log names which of the three the value came from, so one bot behaving differently from its siblings is a question you can answer.

Upgrading from 1.x? `BOT_PERMISSION_MODE=bypass` restores the old behaviour — see [UPGRADING.md](UPGRADING.md).

## Running a team

```bash
cp ecosystem.config.example.js ecosystem.config.js   # edit the three paths at the top
npm install -g pm2
pm2 start ecosystem.config.js && pm2 save
```

Secrets are referenced by name and read from the environment — never written into that file. Supply them via `.env` or a secrets manager:

```bash
doppler run --project my-project --config prd -- pm2 start ecosystem.config.js
```

`npm run doctor` fails if it finds a literal credential in the config.

**Which supervisor?** PM2 or systemd for production; the built-in manager is for development and single-bot installs.

### Bot-to-bot coordination

Both bots must whitelist each other:

```env
# Product Owner's env — allow the EM to talk to it
ALLOWED_BOTS=<em-bot-user-id>
# Engineering Manager's env — allow the PO to talk to it
ALLOWED_BOTS=<po-bot-user-id>
```

Exchanges stop after `MAX_BOT_EXCHANGES` (default 2). Any human message resets the counter.

## Configuration

Only `DISCORD_TOKEN` is required. Every setting below is read by the code — CI fails if this table and the source disagree. **Resolution order: environment variable → default.**

### Identity
| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | *(required)* | Bot token from the Developer Portal |
| `CLAUDE_CWD` | current dir | **Your** project repo — its `CLAUDE.md` is the bot's role |
| `BOT_NAME` | `bot` | Instance name; scopes pid, log and session files |
| `MCP_CONFIG` | *(none)* | Path to `.mcp.json` if not in `CLAUDE_CWD` |
| `BOT_SKILL_PACK` | `<harness>/skill-pack` | Harness-owned skills loaded into every bot. Empty disables |
| `BOT_EXTRA_SKILL_PACKS` | *(none)* | Additional plugin directories, comma-separated |

### Access
| Variable | Default | Description |
|---|---|---|
| `ALLOWED_USERS` | *(empty = everyone)* | User IDs allowed to drive the bot |
| `BOT_REQUIRE_ALLOWLIST` | `false` | Refuse to start when `ALLOWED_USERS` is empty |
| `MONITOR_CHANNELS` | *(none)* | Channels answered without an @mention |
| `ALLOWED_CHANNELS` | *(none)* | Restrict responses to these channels |
| `ALLOWED_BOTS` | *(none)* | Peer bot IDs allowed to interact |
| `MAX_BOT_EXCHANGES` | `2` | Consecutive bot-to-bot exchanges before stopping |

### Tools
| Variable | Default | Description |
|---|---|---|
| `BOT_PERMISSION_MODE` | `restricted` | `restricted` or `bypass`. This bot only |
| `BOT_PERMISSION_MODE_DEFAULT` | — | Host-wide default for bots that set no `BOT_PERMISSION_MODE` |
| `BOT_ALLOWED_TOOLS` | `Read,Glob,Grep,WebFetch,WebSearch,TodoWrite` | Built-ins exposed in `restricted` |
| `BOT_SUMMARIZER_TOOLS` | `Read` | Tools the summarizer may use |

### Claude
| Variable | Default | Description |
|---|---|---|
| `CLAUDE_MODEL` | CLI default | e.g. `claude-opus-5` |
| `SUMMARIZE_MODEL` | `CLAUDE_MODEL` | A cheaper model is fine here |
| `CLAUDE_BIN` | `claude` | Path to the CLI |
| `CLAUDE_MAX_TURNS` | `100` | Steps per request before a cap-out |
| `CLAUDE_TIMEOUT_MS` | `3600000` | Max wall time per request |
| `SESSION_TIMEOUT_MS` | `1800000` | Idle time before a channel starts fresh |
| `MAX_CONCURRENT_CLAUDE` | `2` | In-flight requests before new ones are refused |
| `BOT_SYSTEM_PROMPT` | *(built-in)* | Override the harness prompt |
| `BOT_TIMEZONE` | host zone | IANA name; the bot's sense of "today" |

### Memory
| Variable | Default | Description |
|---|---|---|
| `BOT_STATE_DIR` | `BOT_HISTORY_DIR` | **One root for everything a bot remembers** — buffer, sessions, and the default parent for the rest |
| `BOT_HISTORY_DIR` | `.bot-history` | Daily summaries only — the reviewable record |
| `BOT_ATTACHMENTS_DIR` | `<history>/attachments` | Inbound files. Worth pointing **outside any git repo** — these are arbitrary user-supplied binaries, and a working tree loses them to `git clean -x` or a re-clone |
| `BOT_OUTBOX_DIR` | `<history>/outbox` | Files written here are sent to the user |
| `SUMMARIZE_INTERVAL_MS` | `0` *(off)* | Background summarization interval |
| `SUMMARIZE_CHANNELS` | `MONITOR_CHANNELS` | Channels to summarize |
| `SUMMARIZE_SEEN_CHANNELS` | `true` | Also summarize **DMs and any channel the bot has spoken in**. Without this, a conversation held in a DM is never written down and recall cannot find it |
| `SUMMARIZE_BATCH_SIZE` | `200` | Messages fetched per channel per run |
| `SUMMARY_LOOKBACK_HOURS` | `48` | How much summary history is injected (`/remember` reaches past this) |
| `CONTEXT_MAX_BYTES` | `65536` | Ceiling on the remembered context (summaries + buffer) carried into a fresh session. Anything over it is dropped oldest-first, and the prompt says so. **Do not raise past ~120000** — the whole block travels as one command-line argument and Linux rejects any single argument over 128KB with a bare `spawn E2BIG` |
| `RECENT_CONTEXT_MAX_CHARS` | `12000` | Context budget for `/remember` results |
| `SUMMARIZE_TIMEOUT_MS` | `120000` | Wall clock for one summarization run |
| `BOT_SUMMARIZER_START_DELAY_MS` | `10000` | Grace period after login before the first cycle |
| `BUFFER_MAX_BYTES` | `32768` | Buffer size before rotation |
| `BUFFER_ROTATE_PERCENT` | `40` | Oldest N% summarized away on rotation |
| `BUFFER_TRUNCATE_RESPONSE` | `500` | Chars of each reply kept in the buffer |

**How much a bot carries into a new conversation.** Starting fresh, a bot brings
its recent daily summaries and the conversation buffer along — up to
`CONTEXT_MAX_BYTES`. Past that, the oldest days are left out, and the prompt says
so, so the bot knows to go and read them rather than assume nothing happened.
Nothing is deleted: the summaries stay on disk and `/slashbin-harness:remember`
reaches all of them regardless of this setting. A continuing conversation carries
none of it — it resumes the live session, which already has the history.

Why there is a ceiling at all: this context travels to Claude as a **single
command-line argument**, and Linux rejects any argument over 128KB outright, with
a `spawn E2BIG` that names nothing useful. Values above ~120000 bring that back.
Two busy weeks of summaries will reach it. The default is also a cost decision —
64KB is roughly 16,000 tokens attached to every new conversation.

### Files
| Variable | Default | Description |
|---|---|---|
| `MAX_ATTACHMENT_BYTES` | `26214400` | Largest inbound file (25MB) |
| `MAX_OUTBOUND_BYTES` | `8388608` | Largest file attached to a reply (8MB) |
| `ATTACHMENT_FETCH_TIMEOUT_MS` | `60000` | Per-attachment download timeout |
| `BOT_OUTBOX_MTIME_TOLERANCE_MS` | `2000` | Clock-skew slack when detecting new outbox files |
| `BOT_ATTACH_EXTENSIONS` | `csv,pdf,xlsx,png,jpg` | Types the bot may hand back by *naming* a path, without the outbox or a marker. **Widen with care** — a broad list starts attaching every document a bot merely mentions |

### Reactions
| Variable | Default | Description |
|---|---|---|
| `REACTION_HANDLER_ENABLED` | `false` | Requires `ALLOWED_USERS` to be non-empty |
| `REACTION_TRIGGER_EMOJI` | `👍` | Reacting with this invokes Claude |
| `REACTION_ACK_EMOJI` | `✅` | Added on success |
| `REACTION_FAIL_EMOJI` | `❌` | Added on failure |

### Scheduler
| Variable | Default | Description |
|---|---|---|
| `BOT_SCHEDULE_CHECK_MS` | `60000` | How often schedules are evaluated |
| `BOT_SCHEDULE_LOOKBACK_MINUTES` | `5` | How far back a missed run is recovered |
| `BOT_MAX_SCHEDULED_JOBS` | `25` | Cap on jobs per bot |
| `BOT_MAX_WAKE_ATTEMPTS` | `12` | How many times a self-re-arming follow-up may look before it must stop |
| `BOT_WAKE_CARRY_MAX_MS` | `SESSION_TIMEOUT_MS` | How long a chain of follow-ups may keep resuming the conversation that started it |

### WebSocket bridge
| Variable | Default | Description |
|---|---|---|
| `WS_PORT` | `9800` | Bridge port — must be unique per bot |
| `WS_HOST` | `127.0.0.1` | Bind address; it accepts commands, so widen deliberately |
| `WS_HEARTBEAT_MS` | `30000` | Ping interval |
| `WS_HEARTBEAT_MAX_MISSES` | `3` | Missed pings before disconnect |

### Misc
| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | — | `production` disables pretty logging |
| `MAX_DISCORD_LENGTH` | `1900` | Chars per message before splitting |
| `BOT_BOT_EXCHANGE_PRUNE_MS` | `600000` | How often bot-exchange counters reset |
| `BOT_TYPING_INTERVAL_MS` | `8000` | How often the typing indicator refreshes |
| `BOT_PROGRESS_ENABLED` | `true` | Post a live status line while working |
| `BOT_PROGRESS_INTERVAL_MS` | `2500` | How often that line updates (coalesced, to respect rate limits) |
| `BOT_PROGRESS_FIRST_MS` | `800` | How fast the *first* update appears |
| `BOT_STOP_WORDS` | `stop,halt,abort,cancel` | Words that halt a run in flight (see below) |
| `BOT_START_CONFIRM_MS` | `2000` | How long `npm start` waits before judging the start |
| `BOT_STOP_TIMEOUT_MS` | `5000` | Graceful-shutdown wait before `npm stop` force-kills |

### Stopping a run

Say any of `BOT_STOP_WORDS` to halt what a bot is doing. **Both forms work:**

- **`stop` on its own** — halts the run in every bot in the channel. Only a bot that
  actually had something running replies, so idle bots stay quiet.
- **`stop x, y, z`** — a message that *opens* with a stop word also halts, but only
  when a run is in flight. With nothing running it is an ordinary message, so
  "stop sending the Friday digest" is still a request the bot thinks about.

`@TheBot stop` targets one bot. Stopping also clears that channel's session, since
a killed run leaves one mid-thought.

These words are configurable because "stop" is a vocabulary choice, not a protocol
constant — a non-English channel needs its own.

## Scheduled jobs

**Ask for it.**

> *"every weekday at 7am, post a summary of yesterday's merged PRs"*

The bot creates the job, reads it back, and confirms what it understood:

```
Scheduled job-msm37m2z — every weekday at 07:00 America/Chicago
Next run: 2026-08-10 12:00 UTC. Posts here.
```

Then *"list my scheduled jobs"* or *"remove job-msm37m2z"*. Ask what ran with
*"did the standup job fire?"*.

**A follow-up is the other half.** When a bot says it will check back, it books a
one-shot wake-up for that instant — not a clock time, and not a background sleep
that dies when the reply is sent:

```
Wake-up wake-mtfyyczy set for 2026-08-30 15:53 UTC — in 20 minutes.
It continues this conversation if the session is still warm.
```

It fires once. If the answer is not final, the run that wakes up books the next
look itself and decides how long to wait, so a slow deploy is checked patiently
and a nearly-done one closely. It stays silent while nothing changes, and stops
as soon as it has an answer or hits something you need to decide. Twelve looks
and an optional deadline are the backstops.

A job is a **stored prompt** that runs unattended with the bot's normal tool
access, so write it to stand alone — *"post the reach numbers with the change
since last week"*, not *"tell me the reach"*. The bot will ask before scheduling
something vague, because a bad prompt scheduled daily is a bad answer delivered
daily.

**Times are interpreted in `BOT_TIMEZONE`**, so 7am means 7am where you are, not
where the server is.

<details>
<summary>Writing <code>schedules.json</code> by hand</summary>

Jobs live in `<BOT_STATE_DIR>/schedules.json`. You rarely need to touch it, but:

```json
[
  {
    "id": "standup",
    "cron": "0 9 * * 1,2,3,4,5",
    "channel": "123456789012345678",
    "prompt": "Post a short summary of yesterday's merged PRs.",
    "tz": "America/Chicago"
  }
]
```

Five fields: `minute hour day month weekday`, weekday `0` = Sunday. **Only `*` and
comma-separated numbers** — write `1,2,3,4,5`, never `1-5`, which parses as `1` and
would fire on Mondays alone. The tooling rejects a range rather than accepting one.

Add `"expires": "2026-12-31T00:00:00Z"` for a one-shot. Every run is appended to
`job-history.jsonl`. A run missed during a restart or a gateway blip is recovered.

A **wake-up** lives in the same file and carries `runAt` instead of `cron`:

```json
{
  "id": "wake-mtfyyczy",
  "runAt": "2026-08-30T15:53:20.590Z",
  "channel": "123456789012345678",
  "prompt": "Check whether the promotion PR merged. Report only if it changed.",
  "note": "PR #218 approved at 10:04",
  "carry": true,
  "attempt": 1,
  "maxAttempts": 12,
  "chainStartedAt": "2026-08-30T15:33:20.590Z"
}
```

It is deleted before it runs, so it fires **at most once** — a follow-up that
crashed is never silently repeated, and a watch continues only because the run
booked the next one.

</details>

## Reaction triggers

With `REACTION_HANDLER_ENABLED=true` and a non-empty `ALLOWED_USERS`, reacting to one of the bot's messages with the trigger emoji invokes Claude with a labeled context block naming the emoji, the reactor, and the message reacted to.

The harness is dumb transport here — **what the emoji means is yours to define in your `CLAUDE.md`.** The bot's own ✅ never retriggers, double-taps fire once, and failures get both a ❌ and a reply.

## Files

**Sending to a bot:** attach a file, or reply to a message that has one and ask about it. Any type. The bot is told the name, size, type and local path, and opens it. If a file can't be downloaded, it says so and names the reason.

**Getting files back:** anything the bot writes into its outbox during a reply is attached automatically, or it emits `[[attach: /path]]`, which is stripped before the message is sent. Both routes are explicit on purpose — a bot that merely *mentions* a path doesn't upload it. Files over the size limit are reported with their path rather than silently failing.

## Architecture

```
Discord message
  → bot.js (discord.js)
  → spawn `claude` --output-format stream-json
  → stream events back as Discord messages
  → session id saved for continuity
```

- **CLI spawn, not SDK** — inherits every built-in tool and MCP support for free
- **stdin ignored** — the CLI can never hang waiting for consent
- **Streamed** — progress as it happens
- **Serialized sends** — no rate-limit races

## Prerequisites

- Node.js 18+
- Claude Code CLI, installed and authenticated

## Troubleshooting

Run **`npm run doctor`** first — it checks most of this and prints no secrets.

| Symptom | Likely cause |
|---|---|
| Online but ignores everything | Message Content Intent is off — `doctor` catches this |
| "Bot is not running" right after starting | Bad token; `doctor` or the log names it |
| Ignores another bot | Both bots must list each other in `ALLOWED_BOTS` |
| Ignores you | `ALLOWED_USERS` is set and you're not in it |
| Won't write files or run commands | `BOT_PERMISSION_MODE=restricted` — that's the default |
| Hangs, then exit code 143 | Timeout — raise `CLAUDE_TIMEOUT_MS`, or an MCP server is unreachable |
| `Error: spawn E2BIG`, usually on the first message after a restart | Too much remembered context for one command line — lower `CONTEXT_MAX_BYTES` or `SUMMARY_LOOKBACK_HOURS`. See [Memory](#memory) |
| Second bot crashes at startup | `WS_PORT` collision — one port per bot |

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [UPGRADING.md](UPGRADING.md) · [CHANGELOG.md](CHANGELOG.md)

## Who builds this

This is not a demo. **It is the harness running slashbin.io's own engineering
team** — a Product Owner, an Engineering Manager and an SRE that file issues,
review pull requests, and ship releases every day. Every guarantee in
["safe to leave running"](#why-safe-to-leave-running) exists because that team hit
the failure first.

The work those bots ship is **[slashbin.io](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team) — the webhook ETL gateway for
engineers and AI agents.** Vendor webhooks in, transformed and delivered to every
destination you own, with 100% delivery and retries that survive a destination
being down for hours.

If you are wiring up webhooks by hand, that is the problem it removes.

**[Try slashbin.io free →](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team)**

The implementer half of the team is open source too:
[slashbin-ai-foreman](https://github.com/xrgarcia/slashbin-ai-foreman) picks up
approved issues and opens the pull requests these bots review.

## License

MIT — see [LICENSE](LICENSE).
