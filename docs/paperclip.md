# Paperclip

[README](../README.md) · [All documentation](../README.md#documentation-table-of-contents)

## Contents

- [Before you start](#before-you-start)
- [Paperclip-only](#paperclip-only)
- [Discord and Paperclip together](#discord-and-paperclip-together)
- [Choose what board work may do](#choose-what-board-work-may-do)
- [Connecting board tools](#connecting-board-tools)
- [More than one board](#more-than-one-board)
- [Task outcomes](#task-outcomes)
- [Escalations](#escalations)
- [Live events](#live-events)
- [Reference](#reference)

Give an agent work from your Paperclip board. The harness picks up tasks assigned
to that agent's seat, runs Claude Code or Codex, and posts the answer on the task.
You can run it entirely from Paperclip, with Discord off.

## Before you start

You need a running Paperclip board, an agent seat on that board, and that agent's
own API key. You also need the [harness and an authenticated runtime](INSTALL.md#1-prerequisites).

The agent's command on the board must keep its run open until a comment lands.
The connector posts under that run; a task whose run has already ended cannot
accept the answer under it. See [run ownership troubleshooting](paperclip-board-execution.md#symptom--fix).

Give each agent its own key. The board's attribution depends on it.
Point `CLAUDE_CWD` at the agent's project repo, outside the harness and state
folders. Give it a role in `CLAUDE.md` for Claude or `AGENTS.md` for Codex.

## Paperclip-only

Create a `.env` in the harness checkout with the values for your agent:

```dotenv
BOT_NAME=tech-lead
CLAUDE_CWD=/path/to/your/project-repo
BOT_SURFACES=paperclip
PAPERCLIP_URL=https://board.example.com
PAPERCLIP_API_KEY=<this agent's own key>
```

The runtime defaults to Claude Code. For Codex, also set `BOT_RUNTIME=codex`
and follow the [runtime prerequisites](runtimes.md#prerequisites-for-codex).

Leave `DISCORD_TOKEN` unset. There is no Discord application to create, token to
obtain, or server to join. A board configured without a Discord token also selects
Paperclip-only when `BOT_SURFACES` is unset; the explicit setting above makes your
intent clear.

```bash
npm run doctor
npm start
npm run status
```

The log says `Discord off — Paperclip-only`. The agent is ready once its first
board poll succeeds. If you run several agents, give each a unique `WS_PORT`;
see [running a team](usage.md#running-a-team).

Assign it a task to read the project's README and explain how to run the project,
naming the files it used. Its answer should appear as a task comment.
The default board mode is read-only, so this first task needs no write access.

**Discord schedules, follow-up wake-ups, and background conversation summaries are
off in this mode.** Board tasks have their own sessions and task outcomes.

## Discord and Paperclip together

Configure [Discord](INSTALL.md), then add the board URL and the agent's key to the
same agent's environment. Set `BOT_SURFACES=discord,paperclip` to require both
connections. Restart after changing the environment.

Readiness requires Discord to connect and each board to complete a successful
poll. `npm run doctor:fleet` reports each surface separately.

Board tasks and Discord channels keep separate sessions. The board does not
automatically inherit Discord's conversation history.

## Choose what board work may do

| Mode | What it is for | Access |
|---|---|---|
| `readonly` (default) | Questions and reviews based on the repo | Read access confined to the configured scope |
| `engineering` | Editing, testing, and code work | Scoped tools, paths, and network access, subject to runtime limits |
| `parity` | A board with the same trusted audience and authority as the agent's Discord sessions | Session tools, MCP servers, settings, files, network, and environment, with the documented exceptions |

In `readonly` and `engineering`, Discord memory and the harness folder are kept
out of board runs. `parity` opens the session's access, so board readers must be
allowed to see what those tools can retrieve. It still excludes other channels'
conversation from the prompt and withholds Discord credentials.

Claude and Codex differ here: isolated Codex board runs have no network or MCP
servers. The `parity` option is described separately in the
[board execution guide](paperclip-board-execution.md). Read that guide before
enabling write access.

## Connecting board tools

The connector receives assignments and posts their outcomes. To let an agent
create, assign, or comment on other tasks itself, add Paperclip's MCP server
(`@paperclipai/mcp-server`) to its MCP configuration and permit those tools in the
mode you selected.

Use the same agent identity for both connections. The connector withholds
`PAPERCLIP_API_KEY` from agent runs, so give the MCP server its key through another
environment variable and reference that name from the MCP config.
[Environment and credential rules](run-environment.md) describe how each runtime
handles those values.

## More than one board

List additional boards in `PAPERCLIP_EXTRA_BOARDS`. Each has its own identifier,
URL, key variable, and optional audience prompt. Keys are per board and per agent;
a broken entry is logged and skipped. Each board keeps separate state and task
sessions.

See the [Paperclip configuration table](../README.md#paperclip) for the full shape.

## Task outcomes

The answer is posted on the task. The model's outcome marker tells the connector
what remains; the marker is removed from the visible reply.

| Outcome | What happens |
|---|---|
| Work completed | The connector completes the task when the task is still the agent's to complete |
| `PAPERCLIP-OUTCOME: blocked` | The reply explains the obstacle and the task stays blocked |
| `PAPERCLIP-OUTCOME: return` | The task is handed back to whoever gave it, blocked, with the remaining step explained |
| `PAPERCLIP-OUTCOME: blocked on ACME-12, ACME-13` | The task records its dependencies and the agent resumes when they finish |
| `PAPERCLIP-OUTCOME: blocked on Avery` | The task waits with that board user as its assignee; the agent remains the unblock owner |

The requester for a return comes from the board's assignment record, falling back
to the creator. A person named in a wait must exist on the board. If the target
cannot be resolved or a handoff is refused, the task stays blocked with the agent
and the comment explains why.

A run that fails without an answer gets a fallback reply and a blocked outcome.
Board attempts run in a durable worker: a harness restart follows a surviving
attempt instead of starting the work again. An attempt whose worker died is
reported blocked. Legacy interrupted attempts have a separate
`PAPERCLIP_RESUME_INTERRUPTED` option; read its configuration entry before enabling it.

A later wake checks the task's current state. A dependency wait can resume when
the dependencies finish. An unresolved wait can report progress or escalate.
A newer person-made hold or reassignment is treated differently from a stop
caused by losing a run. The [board decision specification](board-decisions.md)
describes those distinctions and the limits of concurrent writes.

## Escalations

An escalation is a blocked task assigned to the agent with a configured escalation
label. It is work the agent should examine, even though an ordinary held task
would be left alone. The task stays blocked while the escalation is worked.

Configure the agent's authority with `PAPERCLIP_ESCALATION_AUTHORITY` and its next
decision-maker with `PAPERCLIP_ESCALATE_TO`.

- **Resolved within its authority:** it explains what it did and hands the task
  back down the recorded assignment chain.
- **Needs a decision above its authority:** it opens with the ask and ends with
  `PAPERCLIP-OUTCOME: escalate`. The connector hands the task to the configured
  agent or person.
- **Still blocked:** it explains what prevents progress and keeps the task blocked.

When the next owner is a person, the connector can also notify them in the
configured Discord channel. A Paperclip-only agent has no Discord connection, so
read the ask and respond on the board.

The chain comes from assignment records. A person resolves their part by
commenting and assigning the task back to the agent below. That agent receives
the resolution and applies it at its level. End the upward chain with a person,
and use `PAPERCLIP_ESCALATION_RETURN_TO` where the bottom agent needs an explicit
return destination.

The connector tracks which handoff an escalation was worked under. A new comment
or handoff can make it work again; an unchanged wake does not start the same
escalation work over.

## Live events

The connector listens for Paperclip run events so it can check assigned work
without waiting for the next poll. Polling remains the recovery path if a socket
disconnects or an event is missed. Reconnecting checks the inbox again.

Set `PAPERCLIP_EVENTS=off` to use polling alone. For one additional board, set
`"events": false` on its entry. The events connection decides when to check;
the task and attempt records decide what work is owed.

## Reference

- [All Paperclip settings](../README.md#paperclip)
- [Board execution and troubleshooting](paperclip-board-execution.md)
- [Board decisions and escalation ownership](board-decisions.md)
- [Runtime differences](runtimes.md)
