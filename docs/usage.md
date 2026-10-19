# Daily use and operations

[README](../README.md) · [All documentation](../README.md#documentation-table-of-contents)

## Contents

- [What applies where](#what-applies-where)
- [Roles and memory](#roles-and-memory)
- [Skills and prompt context](#skills-and-prompt-context)
- [Connecting tools (MCP)](#connecting-tools-mcp)
- [Permissions and access](#permissions-and-access)
- [Progress and diagnostics](#progress-and-diagnostics)
- [Running a team](#running-a-team)
  - [Bot-to-bot coordination](#bot-to-bot-coordination)
- [Stopping a run](#stopping-a-run)
- [Scheduled jobs](#scheduled-jobs)
- [Reaction triggers](#reaction-triggers)
- [Files](#files)

Use this guide once your agent can answer a task or message.
[Install with Discord](INSTALL.md) or [start from Paperclip](paperclip.md) first.

## What applies where

Board assignments use the [Paperclip task lifecycle](paperclip.md).
The memory, schedules, follow-ups, signals, reactions, and file exchange below
describe Discord use. They are not enabled by running a Paperclip-only agent.

[Command reference](../README.md#commands) ·
[Configuration reference](../README.md#configuration)

## Roles and memory

Each agent has its own project directory, set by `CLAUDE_CWD`.
Use `CLAUDE.md` for a Claude Code role or `AGENTS.md` for Codex. Include the
responsibility, the sources it should consult, the actions it may take, and the
decisions it must hand back. [Native runtime layouts](runtimes.md#the-bots-repository-per-runtime)
also describe skills, overrides, and channel prompts.

On Discord, each channel keeps its own runtime session across restarts. A rolling
buffer carries recent conversation into fresh sessions; older slices are
summarized on rotation. Enable the background daily summarizer with
`SUMMARIZE_INTERVAL_MS` if you want daily summaries as well.

The injected context has a size limit. Older summaries stay on disk even when
they no longer fit in a fresh prompt. Ask the agent to use
`/slashbin-harness:remember <question>` to search summaries, the buffer, files,
sessions, and scheduled runs. It reports which sources it searched.

Use `BOT_STATE_DIR` to give each agent its own state root. Keep uploads outside a
git working tree so a clean or re-clone cannot remove them.
[Memory settings](../README.md#memory) document the paths and context budgets.

## Skills and prompt context

The harness skill pack provides `schedule`, `remember`, `bot-state`, and `land`.
They load with the harness and use its published state paths, so you do not need
to copy them into each role repo. [Skill pack reference](../skill-pack/README.md).

Repository overrides and per-channel prompts load on each request, so changes
take effect on the next message. Claude reads them from `.claude/`; Codex reads
them from `.codex/`. A channel file named by ID takes precedence over one named
for the channel. See the [runtime layout](runtimes.md#the-bots-repository-per-runtime)
and [prompt-layering reference](../README.md#prompt-layering).

The remembered context has a command-line size ceiling as well as a token cost.
Keep `CONTEXT_MAX_BYTES` within the documented budget. If startup fails with
`spawn E2BIG`, reduce that setting or `SUMMARY_LOOKBACK_HOURS`; older summaries
remain available to recall.

## Connecting tools (MCP)

Configure the data sources and tools the role needs. Claude Code reads the
project's `.mcp.json`; Codex support depends on its mode and server transport.
The [runtime guide](runtimes.md#what-differs-on-codex) explains the differences.

On Claude, a connected MCP tool must also be permitted: in restricted mode,
`BOT_PERMISSION_ALLOW` names the permitted server or tool.
`MCP_CONFIG_STRICT=true` limits Claude to the selected MCP configuration.

On Codex, restricted runs have no MCP servers or network. A bypass session can
use local stdio MCP servers from `.mcp.json`; HTTP/SSE servers belong in the
Codex configuration it loads. Isolated board runs have additional restrictions.

Restart after a configuration change and ask the agent to perform a read through
the tool, such as listing tables in the configured database. A role description
that names a tool does not connect it.

## Permissions and access

`BOT_PERMISSION_MODE=restricted` is the default. Use the runtime guide to see
what that exposes. `bypass` grants broad command access; set a real
`ALLOWED_USERS` list before exposing it through Discord.

Claude supports narrower allow and deny rules. Those settings use Claude syntax
and are refused on Codex; follow the [runtime-specific settings](runtimes.md#settings-codex-cannot-honor).

For board work, `BOT_BOARD_EXECUTION` controls access separately.
[Board execution](paperclip-board-execution.md) explains the isolated modes and
the broader `parity` mode. [SECURITY.md](../SECURITY.md) covers access controls.

## Progress and diagnostics

Discord runs show a status line with tool activity while they work, then post the
answer. Tool inputs are not shown. Set `BOT_PROGRESS_ENABLED=false` to turn the
status line off.

Run `npm run doctor` for one agent or `npm run doctor:fleet` for a team.
Connection readiness includes each configured surface, not just the process.
Use `npm run status` and `npm run logs` when investigating a stopped run.

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

## Stopping a run

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

With `REACTION_HANDLER_ENABLED=true` and a non-empty `ALLOWED_USERS`, reacting to one of the bot's messages with the trigger emoji invokes the selected runtime with a labeled context block naming the emoji, the reactor, and the message reacted to.

The harness is dumb transport here — **what the emoji means is yours to define in your `CLAUDE.md`.** The bot's own ✅ never retriggers, double-taps fire once, and failures get both a ❌ and a reply.

## Files

**Sending to a bot:** attach a file, or reply to a message that has one and ask about it. Any type. The bot is told the name, size, type and local path, and opens it. If a file can't be downloaded, it says so and names the reason.

**Getting files back:** anything the bot writes into its outbox during a reply is attached automatically, or it emits `[[attach: /path]]`, which is stripped before the message is sent. Both routes are explicit on purpose — a bot that merely *mentions* a path doesn't upload it. Files over the size limit are reported with their path rather than silently failing.
