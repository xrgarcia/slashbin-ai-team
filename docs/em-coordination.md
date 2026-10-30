# Coordinator map: the bot runtime

What a coordinating agent (the engineering manager, EM) must do, and must not do, with the
bots this runtime hosts. Read it before answering in a bot's channel, acting on a card a bot
holds, or reading a bot's schedule. It is written from the source (`bot.js`, `lib/`,
`skill-pack/`), not from the other docs; where they disagree, this file and the code win.
Per-bot personas, channels and filing rules live in each bot's own repo, not here.

`test/em-coordination-map.test.js` fails when the runtime gains a surface, reserved command,
card status, hand-off word, escalation label or scheduler kind this file does not name, or a
limit changes from the value stated here. Adding one means adding its row here.

**Most of what a bot does is prompt, not code.** Its persona, tone, what it will not say and
what it files are in its own context repo and are read per message. This file pins only what
the runtime does in code. The test says the same.

**One program, many seats.** `bot.js` is one program started once per bot by a process
manager. Each process has its own state folder, history folder, port and concurrency limit.
Which seat a run is in decides who owes what: check the process before you read a reply.

## 1. Surfaces

Surfaces (`SURFACE_NAMES`, `lib/surfaces.js`): `discord`, `paperclip`. A bot with no
`DISCORD_TOKEN` and a board is Paperclip-only and builds no Discord client: it has no
channels, so nothing is said to it in chat.

| Setting | Runtime does | Coordinator owes |
|---|---|---|
| an app's `MONITOR_CHANNELS` | replies to every message there with no `@mention` | answer only in channels the coordinator's own seat monitors |
| elsewhere, or a DM | replies only when `@mentioned`, and only to `ALLOWED_USERS` (humans) and `ALLOWED_BOTS`; anyone else is silently ignored | none |
| `ALLOWED_CHANNELS` set | mentions work only in those channels | none |

## 2. Reserved commands

Reserved commands (`RESERVED_COMMANDS`) are answered by the runtime before the model sees
them, in any channel, from humans only.

| Command | Runtime does | Coordinator owes |
|---|---|---|
| `/fresh` | clears that channel's session | none |
| `/status` | replies buffer size, counts and `running` if a run is live | none |
| `stop`, `halt`, `abort`, `cancel` (`BOT_STOP_WORDS`) | kills the run in flight in that channel and replies `Stopped.`; a bare stop with no mention reaches every bot there, and only one with a run replies | never send a bare stop to see if a bot is alive |

A command a bot defines in its own repo with a reserved name is shadowed and never runs.

## 3. Self-handled states, schedules and failures

| Situation | Runtime does by itself | Coordinator owes |
|---|---|---|
| Message in a monitored channel | replies | none |
| A channel's rules | `.claude/channel-prompts/<channel id>.md` in the bot's repo, read per message, after the repo overrides | never answer in a channel you do not own |
| Two bots trade messages | stops after `MAX_BOT_EXCHANGES` bot messages with no human between | wait for a human |
| Every slot busy | a message past `MAX_CONCURRENT_CLAUDE` (2 per process) gets "I'm busy with other requests" | retry later |
| New message while a run is live in that channel | kills the live run, starts the new one | do not send a second message to nudge |
| Session idle | expires after `SESSION_TIMEOUT_MS` (30 min) | none |
| Run takes long | killed at `CLAUDE_TIMEOUT_MS`, shown as exit 143 | a repeat is a defect: file it |
| Run killed after it started work | no retry; the reply says check whether the work landed, then `/fresh` | check before asking again |
| Scheduled check finds nothing | `isNothingToReport` drops a placeholder-only reply ("none", "no changes"); the always-appended prompt block `Speaking unprompted` tells a wake to send nothing | none: silence is the answer. Never ask for a heartbeat |
| Follow-up promised | booked with the scheduler in the same reply, with a fire time; a sleep or timer dies with the session | do not ask again. No job means a defect |
| Scheduler (`cron` job) | ticks every `BOT_SCHEDULE_CHECK_MS` (60 s) over `schedules.json`; looks back `BOT_SCHEDULE_LOOKBACK_MINUTES` (5) for a missed run; a missing channel retries next tick; a job with `expires` is removed once it has run; a failure posts `Scheduled job "<id>" failed` | the same failure twice: file it |
| Wake job (`runAt`) | fires once, is removed before it runs, may re-arm itself up to `BOT_MAX_WAKE_ATTEMPTS` (12) looks, 1 min to 7 days out | wait for the last look. Never create or delete a bot's job |
| Discord off | cron jobs are refused at load and kept in the file; wake and board work continue | none |
| History rotation | the buffer rotates at `BUFFER_MAX_BYTES` (32 KB): the oldest `BUFFER_ROTATE_PERCENT` (40%) is summarized into `BOT_HISTORY_DIR` as `buffer-rotation`, then dropped; channel summaries run every `SUMMARIZE_INTERVAL_MS` | none. Do not edit summaries; they are the bot's memory |
| Prompt too long | context cut oldest-first to `CONTEXT_MAX_BYTES` (64 KB) | none |
| Restart mid-board-answer | `PAPERCLIP_RESUME_INTERRUPTED` reruns the task once, told what may have happened | none |
| Config wrong (bad token, missing cwd) | exits 78; the process manager does not restart it | fix the config |

## 4. Paperclip cards

A card is picked up by live events with a poll backstop (`PAPERCLIP_POLL_MS` 15 s,
`PAPERCLIP_RECONCILE_MS` 60 s). `PAPERCLIP_INTAKE` is the statuses a new ask may start a run
in; the default is all but `backlog`. Statuses (`CARD_STATUSES`): `backlog`, `todo`,
`in_progress`, `in_review`, `done`, `blocked`, `cancelled`.

A run ends a task with a `PAPERCLIP-OUTCOME:` line (`OUTCOME_MARK`). Words read: `blocked`
(optionally `on <card ids>` or `on <person>`), `review`, `return`, `follow-up`, `escalate`.
No line means `done`.

| State | Runtime does by itself | Coordinator owes |
|---|---|---|
| New ask outside the intake list | one comment `Not started: this card is in ...`, card put back, no run | move it into a listed status |
| `blocked` on cards | linked to them; wakes the bot when the last is `done` | none |
| `blocked` on a person | handed to that person, still blocked | answer if it is you |
| `return` | handed back to whoever gave the task, still blocked | pick it up if yours |
| `review` | the giver becomes reviewer; at most `REVIEW_ROUNDS` (10) agent follow-ups before a person | review if named |
| Card changed under a run | redone on the fresh card, at most `MAX_REWORK` (2) rounds, then left as the person set it | none |
| Card blocked by the seat itself | `PAPERCLIP_RESOLVE_OWN` runs it once per block to end fixed, handed up, or asked of the owner | none: wait |
| Seat stalled | a run queued over `PAPERCLIP_STALL_MINUTES` (15) is flagged | file it if it persists |
| Run lost with the board connection | work continues as one attempt, posted when done | none |
| Task stopped by a person (`blocked`, `cancelled`) | not picked up; one note | move it out of that status |

## 5. Escalation

A hand-up is a record on the card (`process.escalate`), never a chat message. Labels that
route a card to a ruling seat (`ESCALATION_LABELS`, plus `PAPERCLIP_ESCALATION_LABELS`):
`Needs EM ruling` is the default. A card labelled for another seat (for example
`Needs Nova ruling`) is that seat's: do not rule on it. A reserved decision becomes one linked
To Do card for the owner (`request_ray_action`); the origin card stays blocked. The owner's
answer counts only from the owner's own login (`record_answer`).

## 6. Limits, one place

Session 30 min, 2 concurrent runs per process, buffer 32 KB with 40% summarized per rotation,
context 64 KB, scheduler tick 60 s with 5 min lookback, wake 1 min to 7 days and 12 looks,
board poll 15 s, reconcile 60 s, stall 15 min, review rounds 10, rework 2. Values are the code
defaults; a process may set its own.

## 7. What the coordinator must never do

- Answer in a channel it does not own, or for a bot.
- File an issue for a bot or move its card.
- Create, edit or delete a bot's `schedules.json` job, session, buffer, summary or state file.
- Send a bare `stop`, `/fresh` or `/status` into a shared channel to see if a bot is alive.
- Re-ask a bot that said it will check back, or ask for a status when a check found nothing.
- Restart a bot to change its config without the production grant: it is a live deployment.
