# slashbin-ai-team

**The AI engineering team behind [slashbin.io](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team) — the webhook ETL gateway for engineers and AI agents. [Try slashbin.io free →](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team)**

*Product Owner, Engineering Manager, SRE — coordinating autonomously to ship software.*

**Build AI employees for your business. Give each one a role, memory, your tools and a schedule; run it on Claude Code or Codex; talk to it on Discord, and optionally assign it work on a Paperclip board.**

[![CI](https://github.com/xrgarcia/slashbin-ai-team/actions/workflows/ci.yml/badge.svg)](https://github.com/xrgarcia/slashbin-ai-team/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

- **Your choice of agent:** each bot runs on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or the [OpenAI Codex CLI](https://github.com/openai/codex), chosen per bot with `BOT_RUNTIME`. A bot uses only the CLI you pick — for replies, summaries, scheduled jobs and board tasks — billed however that CLI is signed in. [Runtimes →](docs/runtimes.md)
- **Discord, a board, or both:** people reach a bot in Discord, on a [Paperclip](#paperclip) board — where it answers tasks assigned to it, read-only or with engineering tools, never with access to its Discord memory — or on both. A bot with a `DISCORD_TOKEN` is on Discord; one with only a board answers on its board alone. [Paperclip-only →](#paperclip-only)
- **Focused context:** Each bot's `CLAUDE.md` is its job description. A PO bot loads product context, an SRE bot loads ops context. Separated context produces sharper output than one generalist juggling every role in one window.
- **Async parallelism:** While you DM the PO, the EM bot can be reviewing a PR and the SRE bot can be watching a deploy. Multiple bots = multiple things happening at once, not role-play.
- **Safe to leave running:** an agent that can merge a PR needs guarantees about what happens when it crashes. [See below.](#why-safe-to-leave-running)

Each bot drives a real agent CLI against your codebase, MCP servers and tools — not a chatbot wrapper, but an AI teammate that can read code, query databases, create issues and ship work, as far as you allow it.

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

**Tell it the moment something happens** — a follow-up can name a signal alongside its timeout: *wake when `dev-deploy-done` fires, or in 30 minutes, whichever comes first.* Anything that can run a command fires one (`npm run signal dev-deploy-done`) — a CI step, a git hook, the last line of a deploy script. The sender passes a **name**, never a prompt: the words that run are the bot's own, written when it made the promise. The timeout is always there, so a signal that never arrives costs nothing.

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
| `npm run doctor:fleet` | Check **every** bot in `ecosystem.config.js` in one pass — tokens, Paperclip board keys, schedules, stale processes |
| `npm run signal <name>` | Tell a bot something happened, waking any follow-up that was waiting for it |
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

Any MCP server works. In `restricted` mode an MCP tool runs only if `BOT_PERMISSION_ALLOW` names it (`mcp__server` for a whole server, `mcp__server__tool` for one tool). Set `MCP_CONFIG_STRICT=true` to load only the servers in `MCP_CONFIG` and none of the host's.

## Tool exposure

| `BOT_PERMISSION_MODE` | Behaviour |
|---|---|
| `restricted` *(default)* | Only `BOT_ALLOWED_TOOLS` — read-only built-ins by default. Runs in `dontAsk` mode: anything else, MCP tools included, is denied unless `BOT_PERMISSION_ALLOW` pre-approves it. No user or repo settings file is read, so none can approve a tool; put the bot's own settings in `BOT_SETTINGS`. CLAUDE.md still loads |
| `bypass` | Every tool, no permission prompts. `BOT_PERMISSION_DENY` still applies; pair it with a `BOT_SETTINGS` sandbox to keep the shell off the rest of the machine |

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

`BOT_SURFACES` declares where a bot answers. Unset, its configuration decides: Discord if it has a `DISCORD_TOKEN`, plus any [Paperclip](#paperclip) board it is given — a bot with a board and no token answers on its board alone, and one with neither refuses to start. `paperclip` declares it on its board alone, which needs the Paperclip connector enabled first. Every setting below is read by the code — CI fails if this table and the source disagree. **Resolution order: environment variable → default.**

### Identity
| Variable | Default | Description |
|---|---|---|
| `BOT_SURFACES` | *(Discord)* | Where the bot answers: `discord`, `paperclip`, or `discord,paperclip`. Unset: Discord if `DISCORD_TOKEN` is set, plus any Paperclip board configured; with neither the bot exits `78`. A declared surface is a prerequisite: `paperclip` needs the Paperclip connector enabled first (`PAPERCLIP_URL` and `PAPERCLIP_API_KEY`, or `PAPERCLIP_EXTRA_BOARDS`), and the bot refuses to start (exit `78`) without it |
| `DISCORD_TOKEN` | — | Bot token from the Developer Portal. Required when `BOT_SURFACES` names `discord`. Unset with `BOT_SURFACES` unset, the bot answers on its Paperclip board alone (`Discord off — Paperclip-only`), and refuses to start (exit `78`) if it has no usable board either |
| `CLAUDE_CWD` | current dir | **Your** project repo — its `CLAUDE.md` is the bot's role |
| `BOT_NAME` | `bot` | Instance name; scopes pid, log and session files |
| `MCP_CONFIG` | *(none)* | Path to `.mcp.json` if not in `CLAUDE_CWD` |
| `MCP_CONFIG_STRICT` | `false` | `true` loads ONLY the servers in `MCP_CONFIG` (`--strict-mcp-config`), or in `CLAUDE_CWD`'s own config when `MCP_CONFIG` is unset |
| `MCP_CONFIG_EXTRA` | *(none)* | A second `--mcp-config` (path or inline JSON) beside `MCP_CONFIG` — e.g. one claude.ai connector as `claudeai-proxy` while strict drops the rest |
| `BOT_SKILL_PACK` | `<harness>/skill-pack` | Harness-owned skills loaded into every bot. Empty disables |
| `BOT_EXTRA_SKILL_PACKS` | *(none)* | Additional plugin directories, comma-separated |

### Access
| Variable | Default | Description |
|---|---|---|
| `ALLOWED_USERS` | *(empty = everyone)* | User IDs allowed to drive the bot |
| `BOT_REQUIRE_ALLOWLIST` | `false` | Refuse to start when `ALLOWED_USERS` is empty |
| `MONITOR_CHANNELS` | *(none)* | Channels answered without an @mention |
| `REPLY_FINAL_TEXT_ONLY` | `false` | `true` posts only the text written after the run's last tool call; anything said before a tool call is dropped from the reply |
| `ALLOWED_CHANNELS` | *(none)* | Restrict responses to these channels |
| `ALLOWED_BOTS` | *(none)* | Peer bot IDs allowed to interact |
| `MAX_BOT_EXCHANGES` | `2` | Consecutive bot-to-bot exchanges before stopping |

### Tools
| Variable | Default | Description |
|---|---|---|
| `BOT_PERMISSION_MODE` | `restricted` | `restricted` or `bypass`. This bot only |
| `BOT_PERMISSION_MODE_DEFAULT` | — | Host-wide default for bots that set no `BOT_PERMISSION_MODE` |
| `BOT_ALLOWED_TOOLS` | `Read,Glob,Grep,WebFetch,WebSearch,TodoWrite` | Built-ins exposed in `restricted` |
| `BOT_RUN_ENV` | — (everything) | Comma-separated exact variable names a run inherits from the bot's process, beside PATH, HOME, locale, TMPDIR, XDG_* and CODEX_HOME and the harness's own settings (the mail, calendar and landing policies, the BOT_* paths, commit identity), which a run always keeps. A `*`, a `NAME_*` prefix or a name JavaScript objects reserve refuses startup (exit `78`). It limits credentials, never policy. On a Codex bypass run a listed variable reaches the MCP servers, and its commands see it only when its name is no credential's (`*_TOKEN`, `*_KEY`, `*_BEARER`, `*_AUTH`...) and its whole value is one absolute path; anything else is hidden from them. A variable an MCP server's env gives it is hidden too, unless it is the same name and value as an inherited variable the commands keep. The board connector keys leave every run and the Discord and Paperclip credentials leave every board run, recognised by name and by value; one shorter than 6 characters refuses startup. A harness setting that holds a withheld credential's value or a whole hidden server value, an MCP server env that would replace a harness setting, a `${VAR}` in a Codex MCP server's `command`, `args` or `cwd` that the run's commands cannot read, a BOT_SETTINGS `env` block on a bot that runs board tasks, or a hidden list too long for one argument, refuses the configuration rather than be dropped. Claude Code cannot keep a variable it has from its commands; only Codex can. Set it on a bot that must hold only its own keys: under pm2 a run otherwise inherits the whole launching shell. The full matrix: [docs/run-environment.md](docs/run-environment.md) |
| `BOT_PERMISSION_ALLOW` | *(none)* | `restricted` only: comma-separated permission rules pre-approved in `dontAsk` mode, e.g. `mcp__my-db,Bash(gh issue list:*)` |
| `BOT_PERMISSION_DENY` | *(none)* | Comma-separated permission rules always denied; deny beats allow, e.g. `Bash(gh *--repo*)` to keep an allowed `gh` command on one repo. Honoured in `bypass` too: nothing prompts, but a denied tool or path stays denied |
| `BOT_SETTINGS` | *(none)* | Claude Code settings (a path or inline JSON) passed to every session with `--settings`, which the repository's own settings cannot loosen. E.g. a shell sandbox for a `bypass` bot: `{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"filesystem":{"denyRead":["~/"],"allowRead":["/srv/bot-repo"]}}}`. Invalid inline JSON stops the bot at startup |
| `BOT_MAIL_ALLOWED_RECIPIENTS` | *(none)* | With the claude.ai Gmail `send_message` tool allowed: the only addresses it may send to, in to, cc or bcc. Set, the pack's mail gate also refuses drafts, replies and unknown arguments, and fails closed. Unset, sends are not checked |
| `BOT_MAIL_SUBJECT_PREFIX` | *(none)* | With `BOT_MAIL_ALLOWED_RECIPIENTS` set: every sent subject must start with this, e.g. `Bot:` |
| `BOT_CALENDAR_NO_ATTENDEES` | *(none)* | `true`: the pack's calendar gate checks the claude.ai Google Calendar `create_event`, `update_event` and `delete_event`. It refuses any attendee, any calendar but `primary`, unknown arguments, and an update or delete without `notificationLevel: "NONE"`, and fails closed. It cannot see an existing event's guests or title. Unset, calendar writes are not checked |
| `BOT_CALENDAR_OWN_EVENTS` | *(none)* | With `BOT_CALENDAR_NO_ATTENDEES` set, `true`: the bot may update or delete only events it created. The pack records each created event's id in `calendar-events` under `BOT_STATE_DIR`; an update or delete on any other id is refused, and so is every one when that file cannot be read |
| `BOT_CALENDAR_TITLE_PREFIX` | *(none)* | With `BOT_CALENDAR_NO_ATTENDEES` set: every created event's title, and any title an update sets, must start with this, e.g. `Bot:` |
| `BOT_LAND_PATHS` | *(none)* | Comma-separated globs, relative to the bot's repo (`CLAUDE_CWD`), of the files the pack's `land` skill may commit and push to the checkout's upstream branch; `!glob` excludes, e.g. `notes/**,skills/**,!skills/guarded/**`. It lands only the files it is named, refuses a checkout with unpushed commits, and pushes the exact commit it checked (built outside the checkout, so another session's commit is never published and local commit hooks do not run); a rejected push leaves nothing behind. Pair it with `Edit(...)` rules on the same paths and an allow rule for the command. Unset, landing is off |
| `BOT_SUMMARIZER_TOOLS` | `Read` | Tools a summary run may use, in every mode. Summaries never get MCP servers or the skip flags, and take `BOT_PERMISSION_DENY` and `BOT_SETTINGS` |

### Agent runtime
| Variable | Default | Description |
|---|---|---|
| `BOT_RUNTIME` | `claude` | The agent CLI this bot runs on: `claude` (Claude Code) or `codex` (OpenAI Codex CLI). Every run the bot makes — Discord, scheduled jobs, summaries, board tasks — uses it, and `npm run doctor` checks only it. No fallback to the other, and a session is never moved between them: after a switch each channel starts fresh. Anything else stops the bot at startup. See [docs/runtimes.md](docs/runtimes.md) |
| `BOT_MODEL` | CLI default | The model, for whichever runtime is selected, e.g. `claude-opus-5` on Claude |
| `CLAUDE_MODEL` | CLI default | Claude only: the model when `BOT_MODEL` is unset, as before. Set on a Codex bot, it stops the bot at startup |
| `SUMMARIZE_MODEL` | the bot's model | A cheaper model is fine here; it must belong to the bot's runtime |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `CODEX_BIN` | `codex` | Path to the Codex CLI, signed in with `codex login` |
| `CLAUDE_MAX_TURNS` | `100` | Steps per request before a cap-out. `0` removes the cap; `CLAUDE_TIMEOUT_MS` then bounds a run |
| `CLAUDE_TIMEOUT_MS` | `3600000` | Max wall time per request |
| `SESSION_TIMEOUT_MS` | `1800000` | Idle time before a channel starts fresh |
| `MAX_CONCURRENT_CLAUDE` | `2` | In-flight requests before new ones are refused |
| `BOT_SYSTEM_PROMPT` | *(built-in)* | Override the harness prompt |
| `HANDOFF_CONTRACT` | — | Where this bot's runs find the operator's shared handoff contract. `tool:<server>.<tool>`: the bot's own MCP tools carry it, and every run is told to call that tool, cite the revision it returns, and report a failed call instead of rebuilding the contract. `reader:<absolute path>`: an ES module exporting `runnerBlock()` → `{ ok, text }` whose text goes into each board task's prompt (board tasks only); a reader that cannot load or answers in another shape gives an explicit `CONTRACT UNAVAILABLE` block. Also the default for every board. A malformed value stops the bot at startup (exit `78`) |
| `BOT_TIMEZONE` | host zone | IANA name; the bot's sense of "today" |

#### Prompt layering

Two optional files under the bot's `CLAUDE_CWD` are added to the front of every
request's system prompt. Both are read per message, so an edit lands on the next
message with no restart, and a missing file simply contributes nothing. A Codex
bot reads the same two files from `.codex/` instead ([runtimes.md](docs/runtimes.md#the-bots-repository-per-runtime)).

| File | Scope | For |
|---|---|---|
| `.claude/system-prompt-overrides.md` | the whole repo | Instructions that must beat the harness defaults they contradict |
| `.claude/channel-prompts/<channel-id>.md` | one channel | What changes per audience — who the bot is addressing, what that person needs, what it must not say to them |

A channel file may be named for the channel instead (`<channel-name>.md`), but
the ID is preferred and wins if both exist: renaming a channel in Discord must
not silently detach it from its instructions.

They layer in that order — repo first, channel second — so the narrower file is
the later word on anything both touch. Both ride at the **head** of the prompt,
never the tail: the whole prompt is one argv string against a kernel size
ceiling, and the clamp that keeps it under cuts from the end.

### Memory
| Variable | Default | Description |
|---|---|---|
| `BOT_STATE_DIR` | `BOT_HISTORY_DIR` | **One root for everything a bot remembers** — buffer, sessions, and the default parent for the rest |
| `BOT_HISTORY_DIR` | `.bot-history` | Daily summaries only — the reviewable record |
| `BOT_ATTACHMENTS_DIR` | `<history>/attachments` | Inbound files. A `restricted` bot can always read this folder; no `BOT_PERMISSION_ALLOW` rule is needed. Worth pointing **outside any git repo** — these are arbitrary user-supplied binaries, and a working tree loses them to `git clean -x` or a re-clone |
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
| `BRIDGE_TOKEN` | — | Required to send a signal when the bridge is not on loopback |
| `BRIDGE_SIGNAL_MEMORY_MS` | `300000` | How long a signal with nothing waiting is remembered |
| `BRIDGE_SIGNAL_DATA_MAX` | `2000` | Characters of signal text kept before truncation |

### Paperclip
Answer tasks assigned to this bot on a [Paperclip](https://paperclip.ing) board. A task Paperclip hands to an agent is checked out to the run it opened, and writes to a checked-out task must come from that run, so the agent's command on the board must hold its run open until a comment lands under it; the bot polls its inbox, answers through the same run path as Discord, and posts the reply under the run. A board is read by people outside the bot's Discord channels, so a board run gets least privilege in every permission mode, `bypass` included: by default (`BOT_BOARD_EXECUTION=readonly`, see [Engineering board runs](#engineering-board-runs)) only `BOT_BOARD_TOOLS` (read-only built-ins), in `dontAsk` mode, which confines the read tools to `CLAUDE_CWD`, plus whatever `BOT_BOARD_PERMISSION_ALLOW` pre-approves. A Paperclip run cannot reach Discord memory — the buffer, summaries, uploads, sessions, scheduled jobs, the state folder and the outbox of files already sent are kept out of its prompt and environment, denied to the read tools, and unreadable to any shell it is allowed, which always runs in Claude Code's sandbox confined to `CLAUDE_CWD` (the host needs it: `bwrap` and `socat` on Linux; without it the task gets the fallback reply; besides `CLAUDE_CWD` it reads only the system folders — `/usr`, `/bin`, `/lib`, `/etc` and the like — so a tool kept anywhere else, such as the home folder, needs an `allowRead` in `BOT_SETTINGS`; nothing else in `BOT_SETTINGS` can loosen a board run's sandbox). No settings file — user, project or local — is read for a board run, and of `BOT_SETTINGS` it takes only the model and those sandbox rules, so no approval made for Discord sessions carries over; the `CLAUDE_CWD` CLAUDE.md still loads. Claude Code's project auto-memory, which the Discord sessions in the same `CLAUDE_CWD` write and the CLI loads at startup, is off for a board run. Its environment carries none of the bot's own configuration — every `BOT_*` variable except the few the skill pack's hooks read (the mail and calendar gates among them), `MCP_CONFIG*`, anything naming Paperclip, `DISCORD_TOKEN` and `BRIDGE_TOKEN` — since a credential inside, say, an inline `BOT_SETTINGS` could otherwise be printed into a reply; other host variables, such as one an MCP server needs, still reach it, so give a board run a shell only if those can be read by every board reader. The whole harness folder is withheld too (its `.env`, logs and default state), so set `CLAUDE_CWD` to the folder board tasks should read: a bot whose `CLAUDE_CWD` is the harness or state folder, or inside one, keeps the connector off and logs why, since Claude Code's sandbox always opens its working directory. Each task keeps its own session.

This connector is the inbound half only. For a bot to create, assign or comment on tasks itself, add Paperclip's own MCP server (`@paperclipai/mcp-server`) to that bot's MCP config and allow its tools. Give every agent its own key, used by both halves, and never share it between bots — the board's record of who did what is only as true as that. The bot hides `PAPERCLIP_API_KEY` from Claude, so hand the MCP server its key under another name: set it in the bot's `env` (pm2 passes only what the ecosystem lists) and reference it from the MCP config as `${THAT_NAME}`.

#### Paperclip-only

Discord and Paperclip are peer surfaces, and a bot says which it is on. `BOT_SURFACES=paperclip` runs it on its board alone, and needs the Paperclip connector enabled first: a board configured, and its connector on (see above). It logs `Discord off — Paperclip-only`, never builds or logs in a Discord client, and refuses at load (with a log line) any scheduled job, which posts to a Discord channel; the background summarizer, which reads Discord, is off. Without the connector it exits `78`, saying the Paperclip connector must be enabled first. A bot with a board and no `DISCORD_TOKEN` is Paperclip-only without declaring it, and says so in the same log line; its connector must then come up, or it exits `78`. A bot with neither a token nor a usable board exits `78`, naming both. The ready marker is written once every surface is up — Discord when it connects (if on), each board on its first successful poll (if on) — and `npm run doctor:fleet` reports them separately (`Discord: off · board paperclip: ready`).

```bash
CLAUDE_CWD=/srv/code/tech-lead-repo
BOT_NAME=tech-lead
WS_PORT=9803
BOT_SURFACES=paperclip
PAPERCLIP_URL=https://board.example.com
PAPERCLIP_API_KEY=<this agent's own key>
```

An agent can sit on more than one board — the same bot as a seat in two companies, say — with a key per board. List the others in `PAPERCLIP_EXTRA_BOARDS` and give each the prompt channel whose audience matches that board's readers.

| Variable | Default | Description |
|---|---|---|
| `PAPERCLIP_URL` | — | Board origin, e.g. `https://board.example.com`. Off unless this and the key are set |
| `PAPERCLIP_API_KEY` | — | The agent's API key. Removed from the environment Claude runs in |
| `PAPERCLIP_PROMPT_CHANNEL` | — | Channel id whose channel-prompt file (`.claude/channel-prompts/`, `.codex/` on Codex) applies to board replies — use the channel with the same audience as the board |
| `PAPERCLIP_CONTRACT` | *(`HANDOFF_CONTRACT`)* | The handoff contract setting for the first board, in `HANDOFF_CONTRACT`'s form; a malformed value turns that board off |
| `PAPERCLIP_POLICY` | *(none)* | The company task-completion policy the first board reads live for each run, as `<caseId>/<documentKey>` (extra boards: `policy`). Its text and revision go in the prompt and the run log; unreadable is said in the prompt as POLICY UNAVAILABLE. A malformed value turns that board off |
| `PAPERCLIP_EXTRA_BOARDS` | — | More boards for the same bot, as a JSON array of `{ "id", "url", "keyEnv", "promptChannel", "events" }`. `keyEnv` names the variable holding that board's key, which is removed from the environment Claude runs in like `PAPERCLIP_API_KEY`. `events: false` keeps that one board on polling alone; unset, it follows `PAPERCLIP_EVENTS`. `escalationLabels` (array), `escalateTo`, `escalationReturnTo`, `escalationAuthority`, `escalationChannel` and `escalationMention` set that board's [escalations](#escalations); `contract` sets that board's handoff contract in `HANDOFF_CONTRACT`'s form, defaulting to `HANDOFF_CONTRACT`, and a malformed one skips the board; every one but `escalateTo` and `escalationReturnTo` falls back to the matching `PAPERCLIP_ESCALATION_*` variable, and those two are never inherited. Each board has its own state file and task sessions; a broken entry is logged and skipped |
| `PAPERCLIP_EVENTS` | `on` | `off`: no board opens a live-event socket, and every board is polled at `PAPERCLIP_POLL_MS`. See [Live events](#live-events) |
| `PAPERCLIP_POLL_MS` | `15000` | How often the inbox is checked while a board's live events are off or down |
| `PAPERCLIP_RECONCILE_MS` | `60000` | How often the inbox is still checked while a board's live events are up — the catch-all for anything the socket missed |
| `PAPERCLIP_RESUME_INTERRUPTED` | off | Only for an attempt saved by a bot from before durable attempts. A board task's work now runs in a worker of its own that outlives a restart (`lib/attempts.js`, under `BOT_STATE_DIR/attempts/`): the restarted bot follows it and posts its answer, never runs it again, and a worker that died midway is answered blocked. For an older attempt, `1`: a task whose answer was cut off by a restart is run once more, under the run it started in, with a note to check what the first attempt already did before acting again — so its card is closed from the real result. Turn on only when the bot's work is safe to re-check (its jobs are idempotent). Off: the task gets the fallback reply and is left blocked |
| `PAPERCLIP_EXTERNAL_WRITER` | — | Pattern for a task description's first line, e.g. `^source: \S+#\d+$`. A matching task's status belongs to another writer (a tracker mirror): the bot comments on it, and sets its status only to block it on an answer that waits (`PAPERCLIP-OUTCOME: blocked`, linking the tasks that answer names); it never moves it otherwise, nor changes its holder |
| `PAPERCLIP_ESCALATION_LABELS` | `Needs EM ruling` | Comma-separated label names that mark a blocked card assigned to this bot as an [escalation](#escalations): it is worked, not refused, and stays blocked. Empty: no card is an escalation |
| `PAPERCLIP_ESCALATE_TO` | — | First board only: who an escalation goes to when this bot cannot resolve it — `agent:<seat name or id>` or `user:<Paperclip user id>`, optionally followed by `\|Name`. Unset: the bot resolves or notes, never hands on |
| `PAPERCLIP_ESCALATION_RETURN_TO` | the holder below on the chain | First board only: who a resolved escalation goes back to, same form as `PAPERCLIP_ESCALATE_TO`. Set it on the bottom bot of a chain to the seat that first handed the card up (the Foreman's seat, say); unset, the card goes back to whoever handed it to this bot |
| `PAPERCLIP_ESCALATE_URL` | — | The process MCP endpoint whose `escalate` action carries the served board's hand-offs (`PAPERCLIP_ESCALATE_BOARD`): a `return` goes up the reporting line, a worked escalation back down its recorded chain, each recorded on the card. Needs `PAPERCLIP_ESCALATE_BEARER_ENV`; unset, hand-offs are direct writes |
| `PAPERCLIP_ESCALATE_BEARER_ENV` | — | Name of the variable holding this bot's bearer for `PAPERCLIP_ESCALATE_URL`. Withheld from every run's commands |
| `PAPERCLIP_ESCALATE_BOARD` | the first board | Origin of the board `PAPERCLIP_ESCALATE_URL` serves, e.g. `https://board.example.com`, when that is an extra board. The action belongs to one company, so only that board's hand-offs go through it, with that board's key; a value matching no board is warned and leaves every hand-off a direct write |
| `PAPERCLIP_ESCALATION_AUTHORITY` | — | One line telling the run what is this bot's to decide, e.g. `scope and mechanism`. Anything outside it is escalated |
| `PAPERCLIP_ESCALATION_CHANNEL` | the prompt channel | Discord channel pinged when an escalation is handed to a person |
| `PAPERCLIP_ESCALATION_MENTION` | — | Mention put at the head of that ping, e.g. `<@1234>` |
| `BOT_BOARD_EXECUTION` | `readonly` | How a board run executes: `readonly`, `engineering` for a bot the board assigns real work, or `parity` for a run built exactly as the bot's Discord session (less the Discord credentials and other channels' conversation). Anything else keeps the connector off |
| `BOT_BOARD_TOOLS` | `Read,Glob,Grep` | `readonly` board runs: the built-in tools a board run gets |
| `BOT_BOARD_ENGINEERING_TOOLS` | `Read,Glob,Grep,Edit,Write,Bash` | `engineering` board runs: the built-in tools a board run gets |
| `BOT_BOARD_PERMISSION_ALLOW` | *(none)* | Board runs, either mode: permission rules pre-approved, e.g. `mcp__my-db` |
| `BOT_BOARD_READ_PATHS` | *(none)* | `engineering` only: comma-separated absolute folders a board run may read besides `CLAUDE_CWD`, e.g. sibling repos. Must not contain `CLAUDE_CWD` or a write path — name the folders beside it |
| `BOT_BOARD_WRITE_PATHS` | *(none)* | `engineering` only: comma-separated absolute folders a board run may write besides `CLAUDE_CWD` |
| `BOT_BOARD_DENY_FILES` | *(none)* | Board runs, either mode: comma-separated file-name patterns a board run may not read anywhere in `CLAUDE_CWD` or the read and write paths, added to the built-in list (`.mcp.json`, `.env`, `.env.*` except `.env.example`/`.sample`/`.template`, `.npmrc`, `.netrc`, `.git-credentials`, `.pgpass`, `.dev.vars`, `*.pem`, `*.key`, SSH keys, `credentials.json`, `service-account*.json`). `*` and `?` match; a leading `!` exempts a name |
| `BOT_BOARD_NETWORK_ALLOW` | *(none)* | `engineering` only: comma-separated host names a board run's shell may reach, added to any `allowedDomains` in `BOT_SETTINGS`, e.g. `github.com,api.github.com` |

#### Escalations

A blocked card is normally the bot's cue to stand back: it says it is held and leaves it. Every wake ends its run with a note of its own — Paperclip keeps a run open until one lands under it — and the bot takes down its previous identical note, so the card shows one. A blocked card assigned to the bot that carries one of `PAPERCLIP_ESCALATION_LABELS` is different — another agent (the Foreman, say) gave up on it and handed it up. The bot works it and the card stays **blocked** the whole time; no bot ever moves it out of blocked. The run is told the card is an escalation and what is its to decide (`PAPERCLIP_ESCALATION_AUTHORITY`), reads the reason, acts on the work it points at (a mirrored card's first description line, `source: owner/repo#N`, names the GitHub issue), and posts a short note. It ends one of three ways:

- **Resolved** — it acted within its authority and says what it did. The bot hands the card back down, inside its own run, to whoever handed it up: `PAPERCLIP_ESCALATION_RETURN_TO` if set, otherwise the holder below it on the chain.
- **Escalated** — the decision is outside its authority, so the reply opens with a one-line ask, says what it tried and why it cannot resolve it, and ends with `PAPERCLIP-OUTCOME: escalate`. The bot reassigns the card to its `escalateTo` holder inside its own run, with that reply as the comment. When the holder is a person, it also posts the card link and the ask to `PAPERCLIP_ESCALATION_CHANNEL`, headed by `PAPERCLIP_ESCALATION_MENTION`.
- **Stuck** — it can do neither; the reply ends with `PAPERCLIP-OUTCOME: blocked` and the card stays with it.

The chain is read from the card's own assignment records since it last went blocked, never from comments: a hand-off to a holder already on the chain unwinds to them, any other climbs. A person at the top resolves by commenting on the card and reassigning it to the bot below; the bot is told the card came back down with a resolution and applies it at its level. An escalation is worked once per hand-off: the bot runs again only when someone comments or the card is handed to it again, and pings a person at most once per hand-off; a re-wake with nothing new ends its run on a short note that the card is still blocked with it. An answer never overwrites the card: if someone moved it or handed it on while the bot worked, the note is posted and the card is left as it is; if a person asked something newer while it worked, the card stays with the bot, blocked, and the next wake answers the newer question. A chain is just each bot's `escalateTo` — the engineering manager to the product owner, the product owner to a person — so a chain that points back at itself loops; end it with a person. The bottom bot's `PAPERCLIP_ESCALATION_RETURN_TO` names where the card lands when the chain unwinds, so whatever mirrors the card can move it on.

#### Live events

Each board seat also listens on Paperclip's live-event socket (`/api/companies/:companyId/events/ws`, authenticated with the same agent key). When Paperclip queues or starts a run for this agent, the bot checks its inbox at once instead of on the next poll; events for other agents in the company are ignored. The socket only decides *when* the inbox is checked — what is answered, and that nothing is answered twice, is decided exactly as on a poll, so a repeated event, a reconnect, or an event that races a poll is harmless. Paperclip does not replay events sent while a socket was down, so every connect — the first and each reconnect — checks the inbox before the stream is trusted, and polling stays on as recovery: every `PAPERCLIP_RECONCILE_MS` while the socket is up, every `PAPERCLIP_POLL_MS` while it is not. A dropped socket reconnects with backoff (1 s, doubling to 60 s); one that hears no ping from the board for 75 s is replaced. A board, or a proxy in front of it, that refuses the upgrade is logged with its status and keeps working on polls. The state of each board's socket — `live`, `reconnecting` or `off` — is logged on every change and written to the bot's surfaces file under `events`; it never holds back the ready marker. Turn it off for every board with `PAPERCLIP_EVENTS=off`, or for one extra board with `"events": false`.

#### Engineering board runs
`BOT_BOARD_EXECUTION=engineering` is for a bot whose board assigns it real work — edit its repo, run tests, `git`, `gh`. It is the same board run with more tools, never a different trust level: `dontAsk` still decides, no settings file is read, the shell runs in the sandbox or not at all, the Discord memory and the harness folder stay unreadable and unwritable, and the bot's own credentials stay out of the environment. It adds only what you name: the tools, the folders besides `CLAUDE_CWD` it may read and write, and the hosts its shell may reach. Each run gets a private temp folder, removed when it ends. A setting it cannot hold — a relative path, a path inside the bot's state or harness folder, `/` or the home folder, a read path that contains `CLAUDE_CWD`, a Discord memory folder (the summaries folder, say) inside `CLAUDE_CWD`, where a shell could read it back through `git` — keeps the connector off and logs why; Discord is unaffected. At startup the bot logs the board mode it runs with, and `npm run doctor:fleet` prints it for each bot.

The shell's network goes through Claude Code's proxy and `socat`. If `socat` or `bwrap` lives outside the system folders (under a home folder, say), add its folder — and any folder a wrapper script loads from — to `BOT_BOARD_READ_PATHS`, or every request from the shell fails; `doctor:fleet` warns when it finds one.

To turn it on, set `BOT_BOARD_EXECUTION=engineering` (and the paths and hosts the work needs) for that bot and restart it; to turn it off, remove the setting or set `readonly` and restart. Verify by assigning the bot a board task that edits a file in `CLAUDE_CWD`: in `engineering` the change lands and the task closes; in `readonly` the reply says it could not, and the task is left **blocked**. Full guide, prerequisites and symptom-to-fix: [docs/paperclip-board-execution.md](docs/paperclip-board-execution.md). A bot on Codex takes board tasks in the same two modes with no network; [what differs](docs/paperclip-board-execution.md#on-codex).

`BOT_BOARD_EXECUTION=parity` lifts the least-privilege board run for a bot whose board readers are the same people as its Discord channels: on Claude or Codex, the run gets the Discord session's tools, MCP servers, settings, files, network and environment, in the bot's `BOT_PERMISSION_MODE`. Two things stay out — other channels' conversation and the Discord credentials (`DISCORD_TOKEN`, `BRIDGE_TOKEN`) — and the startup log names both.

A run that could not do what was asked ends its reply with `PAPERCLIP-OUTCOME: blocked`; the bot removes that line and leaves the task **blocked** with the reply as its comment, instead of **done**. A person's comment on it reopens it. A run whose remaining step belongs to whoever gave it the task, and that they can take, ends with `PAPERCLIP-OUTCOME: return` instead: the task is blocked and handed back to them in the same write, inside the bot's run, with the reply saying what is left. Who gave it is read from the board's own record: the holder it was last assigned from, else the task's creator. When that is nobody but the bot, or the board refuses the hand-off, it stays with the bot, blocked, and the comment says why. A run that is waiting on other tasks ends with `PAPERCLIP-OUTCOME: blocked on ACME-12, ACME-13`: the task is blocked by those tasks on the board, so it shows what it waits on; when the last of them is done Paperclip wakes the bot, which moves the task back in progress, says which task it waited on, and resumes the work; while only some are done, its blockers and wait are trimmed to the open ones. A run that waits on a person — their decision, approval or action — ends with `PAPERCLIP-OUTCOME: blocked on Avery`: the task is blocked and handed to that person as its assignee in the same write, so it waits with them; the bot stays the unblock owner (the board refuses an agent naming anyone else) and the unblock note names the person. The name is matched against the board's people; one the board does not have leaves the task with the bot, blocked, and the comment says so. A re-wake on an ask answered as waiting runs the model once more (SLA-1775): it is told what it said, why it woke (Paperclip's disposition repair, say), and what the board shows now of each task it waits on — status, holder, last change, recent comments — and posts exactly one comment: progress on a blocker being worked (who is on it, what changed, and the next step once it lands), still blocked on it; or an escalation when nothing changed and nobody works the blocker. An answer that only repeats the last one, Paperclip's last repair attempt, or more than three such wakes on one ask is escalated by the bot whatever the model says. Only when the model gives nothing does the bot post the mechanical note instead, repeating the answer's first line and who it waits on, the card left as it was; an answer that finished its ask always gets that note. No note ever deletes an earlier one, since the board shows a deleted comment as a blank one. A block the bot set, or one Paperclip set when it lost the run the bot was answering under (its waiter dropped, say), is the bot's to update: if Paperclip blocks the task while the answer is still running, the bot moves it back in progress with a note, and the answer closes it. A task another agent blocks and hands to the bot — `return` from that agent, in one write or as its next hand-off — is the bot's to work, and the answer closes it. Any other blocked or cancelled set by a person or another agent is never moved, and a reply never closes or hands back a task that was given to someone else while it ran. A refused board request is logged with Paperclip's reason code, e.g. `HTTP 403 cross_issue_influence_run_context_required`.

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

**Or the moment a job finishes.** Give the follow-up `--wait-for <name>` and make
`scripts/signal.mjs <name>` the last step of a detached job: the bot wakes when it
ends, like a task notification in the Claude Code terminal. A plain
`run_in_background` call would die with the reply, so the skill pack's hook blocks
it and prints this path instead.

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

<details>
<summary>Waking a bot the moment something finishes</summary>

Polling a deploy every minute is wasteful and slow. Give the follow-up a signal
name as well as its time:

> *"check back when the deploy finishes, or in 30 minutes"*

```bash
# at the end of your deploy script, CI job, git hook — anything that already knows
npm run signal dev-deploy-done
npm run signal ci:build -- --data "exit 0, 4m12s"
```

The name is **yours**. The harness never interprets it — `nightly-etl`,
`invoice-run-finished`, whatever the sender and the bot agree on. There are no
built-in integrations to configure and nothing to register.

What a sender can and cannot do:

- It sends a **name**, never a prompt. The words that run were written by the bot
  when it promised to look, so a signal cannot put instructions in its context.
- It can only release a follow-up **that bot already booked**, in the channel that
  follow-up already named. A signal nobody is waiting for does nothing (it is
  remembered for five minutes, in case the follow-up is booked a second later).
- Attached `--data` reaches the bot fenced and labelled as untrusted text —
  evidence to read, never instructions to obey.
- The **timeout still applies.** A signal that never arrives means the follow-up
  fires when it always would have. Nothing new can fail.

Signals are the one bridge message that needs a credential, because they start a
run rather than posting text: on loopback (the default) they are accepted, and a
bridge bound anywhere else must set `BRIDGE_TOKEN`. Each bot has its own bridge
port, so signal the bot you mean — `npm run signal <name> -- --port 9801`.

</details>

## Reaction triggers

With `REACTION_HANDLER_ENABLED=true` and a non-empty `ALLOWED_USERS`, reacting to one of the bot's messages with the trigger emoji invokes Claude with a labeled context block naming the emoji, the reactor, and the message reacted to.

The harness is dumb transport here — **what the emoji means is yours to define in your `CLAUDE.md`.** The bot's own ✅ never retriggers, double-taps fire once, and failures get both a ❌ and a reply.

## Files

**Sending to a bot:** attach a file, or reply to a message that has one and ask about it. Any type. The bot is told the name, size, type and local path, and opens it. If a file can't be downloaded, it says so and names the reason.

**Getting files back:** anything the bot writes into its outbox during a reply is attached automatically, or it emits `[[attach: /path]]`, which is stripped before the message is sent. Both routes are explicit on purpose — a bot that merely *mentions* a path doesn't upload it. Files over the size limit are reported with their path rather than silently failing.

## Architecture

```
Discord message, or a Paperclip task
  → bot.js (discord.js)
  → spawn the bot's runtime: `claude` (stream-json) or `codex exec` (--json)
  → events normalized, progress shown, one reply posted
  → session id saved for continuity, tagged with its runtime
```

- **CLI spawn, not SDK** — inherits every built-in tool and MCP support for free
- **stdin ignored** — the CLI can never hang waiting for consent
- **Streamed** — progress as it happens
- **Serialized sends** — no rate-limit races

## Prerequisites

- Node.js 18+
- One agent CLI per bot, installed and signed in: Claude Code (the default), or the Codex CLI for a bot with `BOT_RUNTIME=codex`. See [docs/runtimes.md](docs/runtimes.md)

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
| Exits at startup naming a setting "Claude Code syntax" | A Claude-only setting on a `BOT_RUNTIME=codex` bot — see [docs/runtimes.md](docs/runtimes.md) |

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
