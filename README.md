# Slashbin AI Team

**Give your AI agents work without babysitting every session.**

Run Claude Code or Codex as an agent with a role, your tools, and a place to receive
work. Assign tasks through **Paperclip**, talk through **Discord**, or use both.
**A Paperclip agent needs no Discord account or bot.**

This is the harness behind the AI team building [Slashbin](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team).
We're sharing it so you can run your own. **Free, self-hosted, MIT licensed.**

[![CI](https://github.com/xrgarcia/slashbin-ai-team/actions/workflows/ci.yml/badge.svg)](https://github.com/xrgarcia/slashbin-ai-team/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[Start with Paperclip →](docs/paperclip.md)** ·
**[Start with Discord →](docs/INSTALL.md)** ·
**[Documentation →](#documentation-table-of-contents)**

## Contents

- [The problem it solves](#the-problem-it-solves)
- [How it works](#how-it-works)
- [Use Paperclip, Discord, or both](#use-paperclip-discord-or-both)
- [What changes in your day](#what-changes-in-your-day)
- [Start with one agent](#start-with-one-agent)
- [Why we built it](#why-we-built-it)
- [Documentation table of contents](#documentation-table-of-contents)
- [Configuration](#configuration)
- [Commands](#commands)
- [Contributing](#contributing)
- [License](#license)

## The problem it solves

You already have an agent that can read a repo, review a change, or investigate a
problem. Keeping that work moving takes more than the prompt that started it.

Someone has to receive the next assignment, preserve context between conversations,
notice when a run stops, and follow up when a dependency finishes. If that someone
is always you, every handoff becomes another terminal session to manage.

Slashbin AI Team handles that connection between your agent and the people assigning
it work. Each agent has its own working directory, role, permissions, and state.
It receives work, runs the CLI you selected, and returns the answer to the place
the work came from.

On Discord, it also keeps conversation history and can schedule work and follow-ups.
On Paperclip, work stays attached to its task, with a reply and an explicit outcome.

## How it works

```text
Paperclip task and/or Discord message
  → Slashbin AI Team
  → your agent's role, working directory, and permissions
  → Claude Code or Codex
  → reply and task outcome on Paperclip, or reply in Discord
```

You supply the role, tools, and authority. The harness connects the agent to its
work and manages its runs. A role file describes what an agent should do; the
runtime's permissions determine what it can actually do.

| You choose | What it controls |
|---|---|
| Runtime | Claude Code or Codex, selected per agent with `BOT_RUNTIME` |
| Working directory | The agent's own repo, set with `CLAUDE_CWD` on either runtime |
| Role | `CLAUDE.md` for Claude Code; `AGENTS.md` for Codex |
| Tools and permissions | What the agent may read, change, or access through MCP |
| Where work arrives | Paperclip, Discord, or both |

Runtime capabilities differ. For example, restricted Codex runs have no network or
MCP access; isolated Codex board runs cannot push to GitHub. Read the
[runtime comparison](docs/runtimes.md#what-differs-on-codex) before choosing the
permissions for a role.

## Use Paperclip, Discord, or both

Both connections are optional individually. **At least one must be configured.**

| Where you work | What the agent does | What you need |
|---|---|---|
| **Paperclip only** | Receives tasks assigned to its board seat, works within its permissions, and posts the answer on the task | A Paperclip board and the agent's own key; no Discord setup |
| **Discord only** | Answers DMs, mentions, or monitored channels; supports conversation memory, files, schedules, and follow-ups | A Discord bot token and your access rules; no Paperclip setup |
| **Both** | Accepts board assignments and Discord conversations through the same agent runtime | Both connections configured; board access is controlled separately |

### Paperclip-only

**Already using Paperclip? Give an agent a seat on your board and point this
harness at it.** The connector picks up assigned tasks, runs the agent, and posts
its answer under the task's run. A task the agent cannot complete is reported as
blocked. Dependencies and escalations can carry the work to its next owner.

Board runs are read-only by default. Choose `engineering` for scoped code work, or
`parity` when the board should grant the same access as the agent's Discord
sessions. The isolated modes keep Discord memory out of board runs; `parity`
opens the session's files and tools and needs the same trusted audience.

A board run reads its card (status, assignee, creator, reviewer, unblock owner, blockers) from a "Card now" block in its prompt; it has no board key to read it with.

**[Paperclip setup and task lifecycle →](docs/paperclip.md)** ·
[Board permissions and runtime limits →](docs/paperclip-board-execution.md)

### Discord

Talk to an agent from your laptop or phone. Send it a file, ask what you decided
earlier, or ask it to post a recurring report. While it works, a status line shows
activity; the answer arrives when the run finishes.

Schedules, follow-up wake-ups, and background conversation summaries use Discord.
They are off on a Paperclip-only agent. Board tasks keep their own sessions;
connecting both surfaces does not create a shared conversation.

**[Discord installation →](docs/INSTALL.md)** ·
[Memory, files, schedules, and follow-ups →](docs/usage.md)

## What changes in your day

| The work you keep doing | What the harness provides |
|---|---|
| Opening a terminal to pass along the next board assignment | A connector that picks up tasks assigned to the agent and posts its answer back |
| Reconstructing earlier Discord conversations | Saved sessions, a conversation buffer, summaries, and a recall skill that names the sources it searched |
| Remembering to ask whether something finished | On Discord, stored follow-ups that can wake on a timer or a named signal |
| Guessing whether an agent is connected or stuck | Connection checks, logs, a diagnostic command, and progress shown during Discord runs |
| Deciding whether a failed run already acted before retrying | Resume checks that refuse a blind fresh retry after activity; board attempts have durable recovery |
| Coordinating different responsibilities in one context | Separate agents with their own roles, tools, state, and permissions |

These are controls around an agent's work. Review and verification still belong in
the role and workflow you give it. A failed run can leave partial work; a reply is
not proof that a deploy succeeded.

## Start with one agent

You need Node.js 18 or newer, an installed and authenticated Claude Code or Codex
CLI, and a machine to run the harness. The runtime guide lists
[additional sandbox prerequisites](docs/runtimes.md).

```bash
git clone https://github.com/xrgarcia/slashbin-ai-team.git
cd slashbin-ai-team
npm install
```

Then take the path that matches where you work:

- **Paperclip:** follow the [Paperclip guide](docs/paperclip.md). Configure the board,
  the agent's key, and its working directory in `.env`. Leave `DISCORD_TOKEN` unset.
- **Discord:** follow the [install guide](docs/INSTALL.md). Create the Discord bot,
  then run `npm run setup` to configure and check it.
- **Both:** configure Discord, then add the [Paperclip connector](docs/paperclip.md).

Give the agent a role in its project repo: `CLAUDE.md` for Claude Code or
`AGENTS.md` for Codex. Describe its responsibility, the sources it should use,
and what it may decide. Use an existing role file if the repo already has one.

```bash
npm run doctor
npm start
npm run status
```

For a first useful task, ask it to read your project's README and explain how to
run the project, naming the files it used. Assign that task on Paperclip or send
it in Discord. That checks whether the agent can find and use its own context.

Once that works, add the tools the role needs and check their permissions.
The default is restricted access. [Tool setup →](docs/usage.md#connecting-tools-mcp)

Start with one role. Add an Engineering Manager, Product Owner, SRE, or another
role when you have distinct work to give it. Each can use a different runtime.
[Running a team →](docs/usage.md#running-a-team)

**The code is free to use and modify under the [MIT license](LICENSE).**
You supply the host and the agent CLI account; usage is billed according to how
that CLI is signed in.

## Why we built it

We use this harness to run the agents building Slashbin. Giving agents real work
made the gaps concrete: a process could be running while disconnected, a promised
follow-up could disappear with the conversation, and a failed run could have
already taken an action before anyone noticed.

The connection checks, stored follow-ups, resume checks, and task outcomes address
those failures. We're sharing the harness so other developers can use it, adapt
it, and contribute what they learn.

[Slashbin](https://www.slashbin.io?utm_source=github&utm_medium=readme&utm_campaign=ai-team)
is the webhook ETL and programmable gateway our team builds. It gives applications
and agents a way to receive, transform, and deliver business events. If your next
project involves connecting those systems, that's where it fits.

The implementation part of our engineering workflow is also open source:
[Slashbin AI Foreman](https://github.com/xrgarcia/slashbin-ai-foreman) picks up
approved issues and opens pull requests. Connect the roles and workflow you need.

## Documentation table of contents

Each guide has its own table of contents. Start with installation or Paperclip,
then follow the reference that matches your task.

| Page | What you will find |
|---|---|
| [Install guide](docs/INSTALL.md) | Prerequisites, Discord setup, role files, starting an agent, and checking the first reply |
| [Paperclip guide](docs/paperclip.md) | Board-only setup, both surfaces, task pickup, outcomes, dependencies, and escalations |
| [Daily use and operations](docs/usage.md) | Tools, memory, files, schedules, signals, stopping work, and running a team |
| [Runtime guide](docs/runtimes.md) | Claude Code and Codex layouts, capabilities, switching, and limitations |
| [Configuration reference](#configuration) | Environment variables and their defaults |
| [Command reference](#commands) | Discord commands and shell commands |
| [Board execution](docs/paperclip-board-execution.md) | Read-only, engineering, and parity access; prerequisites and troubleshooting |
| [Run environment](docs/run-environment.md) | How credentials and environment variables reach each runtime |
| [Board decisions](docs/board-decisions.md) | Status ownership, escalation routing, and handling concurrent changes |
| [Model-work triggers](docs/model-work-triggers.md) | Which board wakes start the model: intake statuses, re-looks at answered waits, the recommended quiet setup |
| [Landing](docs/landing.md) | Rules for committing and pushing only the changes an agent owns |
| [Harness skill pack](skill-pack/README.md) | Shared skills and the environment paths they use |
| [Upgrading](UPGRADING.md) | Upgrade advice and changes existing operators need to make |
| [Security](SECURITY.md) | Access controls, hardening, and private vulnerability reporting |
| [Contributing](CONTRIBUTING.md) | Development workflow, checks, and compatibility expectations |
| [Changelog](CHANGELOG.md) | Release history |
| [Code of conduct](CODE_OF_CONDUCT.md) | Community expectations |

## Configuration

The tables below are the canonical environment-variable reference, checked against
the code by `test/config-docs.test.js`. For a first install, use the guides above.
For Claude and Codex differences, read [runtimes.md](docs/runtimes.md).

<details>
<summary>Expand the full configuration reference</summary>

### Identity
| Variable | Default | Description |
|---|---|---|
| `BOT_SURFACES` | *(from configuration)* | Where the bot answers: `discord`, `paperclip`, or `discord,paperclip`. Unset: Discord if `DISCORD_TOKEN` is set, plus any Paperclip board configured; with neither the bot exits `78`. A declared surface is a prerequisite: `paperclip` needs the Paperclip connector enabled first (`PAPERCLIP_URL` and `PAPERCLIP_API_KEY`, or `PAPERCLIP_EXTRA_BOARDS`), and the bot refuses to start (exit `78`) without it |
| `DISCORD_TOKEN` | — | Bot token from the Developer Portal. Required when `BOT_SURFACES` names `discord`. Unset with `BOT_SURFACES` unset, the bot answers on its Paperclip board alone (`Discord off — Paperclip-only`), and refuses to start (exit `78`) if it has no usable board either |
| `CLAUDE_CWD` | current dir | **Your** project repo — `CLAUDE.md` gives Claude its role; `AGENTS.md` gives Codex its role |
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
| `BOT_BOARD_MODEL` | the bot's model | The model for Paperclip task runs; a cheaper one fits when judgement work forks to its own skill model |
| `BOT_JOB_MODEL` | the bot's model | The model for scheduled-job runs |
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
| File | Scope | For |
|---|---|---|
| `.claude/system-prompt-overrides.md` | the whole repo | Instructions that must beat the harness defaults they contradict |
| `.claude/channel-prompts/<channel-id>.md` | one channel | What changes per audience — who the bot is addressing, what that person needs, what it must not say to them |

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
| Variable | Default | Description |
|---|---|---|
| `PAPERCLIP_URL` | — | Board origin, e.g. `https://board.example.com`. Off unless this and the key are set |
| `PAPERCLIP_API_KEY` | — | The agent's API key. Removed from the environment Claude runs in |
| `PAPERCLIP_PROMPT_CHANNEL` | — | Channel id whose channel-prompt file (`.claude/channel-prompts/`, `.codex/` on Codex) applies to board replies — use the channel with the same audience as the board |
| `PAPERCLIP_CONTRACT` | *(`HANDOFF_CONTRACT`)* | The handoff contract setting for the first board, in `HANDOFF_CONTRACT`'s form; a malformed value turns that board off |
| `PAPERCLIP_POLICY` | *(none)* | The company task-completion policy the first board reads live for each run, as `<caseId>/<documentKey>` (extra boards: `policy`). Its text and revision go in the prompt and the run log; unreadable is said in the prompt as POLICY UNAVAILABLE. A malformed value turns that board off |
| `PAPERCLIP_EXTRA_BOARDS` | — | More boards for the same bot, as a JSON array of `{ "id", "url", "keyEnv", "promptChannel", "events" }`. `keyEnv` names the variable holding that board's key, which is removed from the environment Claude runs in like `PAPERCLIP_API_KEY`. `events: false` keeps that one board on polling alone; unset, it follows `PAPERCLIP_EVENTS`. `escalationLabels` (array), `escalateTo`, `escalationReturnTo`, `escalationAuthority`, `escalationChannel` and `escalationMention` set that board's [escalations](docs/paperclip.md#escalations); `contract` sets that board's handoff contract in `HANDOFF_CONTRACT`'s form, defaulting to `HANDOFF_CONTRACT`, and a malformed one skips the board; every one but `escalateTo` and `escalationReturnTo` falls back to the matching `PAPERCLIP_ESCALATION_*` variable, and those two are never inherited. Each board has its own state file and task sessions; a broken entry is logged and skipped |
| `PAPERCLIP_EVENTS` | `on` | `off`: no board opens a live-event socket, and every board is polled at `PAPERCLIP_POLL_MS`. See [Live events](docs/paperclip.md#live-events) |
| `PAPERCLIP_POLL_MS` | `15000` | How often the inbox is checked while a board's live events are off or down |
| `PAPERCLIP_RECONCILE_MS` | `60000` | How often the inbox is still checked while a board's live events are up — the catch-all for anything the socket missed |
| `PAPERCLIP_INTAKE` | every status but `backlog` | The card statuses a new ask starts the model in: a comma list of `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`, or `all`. A card in any other status gets one note saying so, is put back in that status, and no model run. Read from the status before the wake checked the card out. An unknown status turns the connector off. See [Model-work triggers](docs/model-work-triggers.md) |
| `PAPERCLIP_REWAKE` | `off` | How many times the model looks again at one ask it answered as waiting, when the card wakes with nothing new asked. `off`: each such wake gets the mechanical note, no model run. A number `N`: up to `N` looks, the last told to escalate, and the note after that. Anything else turns the connector off. See [Model-work triggers](docs/model-work-triggers.md) |
| `PAPERCLIP_RESUME_INTERRUPTED` | off | Only for an attempt saved by a bot from before durable attempts. A board task's work now runs in a worker of its own that outlives a restart (`lib/attempts.js`, under `BOT_STATE_DIR/attempts/`): the restarted bot follows it and posts its answer, never runs it again, and a worker that died midway is answered blocked. For an older attempt, `1`: a task whose answer was cut off by a restart is run once more, under the run it started in, with a note to check what the first attempt already did before acting again — so its card is closed from the real result. Turn on only when the bot's work is safe to re-check (its jobs are idempotent). Off: the task gets the fallback reply and is left blocked |
| `PAPERCLIP_EXTERNAL_WRITER` | — | Pattern for a task description's first line, e.g. `^source: \S+#\d+$`. A matching task's status belongs to another writer (a tracker mirror): the bot comments on it, and sets its status only to block it on an answer that waits (`PAPERCLIP-OUTCOME: blocked`, linking the tasks that answer names); it never moves it otherwise, nor changes its holder. Its prompt says a hold on it is released only in the source |
| `PAPERCLIP_ESCALATION_LABELS` | `Needs EM ruling` | Comma-separated label names that mark a blocked card assigned to this bot as an [escalation](docs/paperclip.md#escalations): it is worked, not refused, and stays blocked. Empty: no card is an escalation |
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

</details>

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

## Contributing

Use the code, adapt it to your team, and share improvements. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

For problems with an install, start with `npm run doctor` and the
[troubleshooting guide](docs/INSTALL.md#troubleshooting).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
