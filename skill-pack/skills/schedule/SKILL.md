---
name: schedule
description: Create, list, remove or inspect recurring jobs for this bot — "every morning at 7 tell me X", "every weekday at 9 post the standup", "remind me on Friday". Use whenever someone asks for something to happen on a schedule, repeatedly, later, or every day/week.
---

# schedule

Turn "tell me every morning at 7 what my customer reach is" into a job that
actually fires.

A scheduled job is a **stored prompt**. When it fires, this bot runs that prompt
unattended and posts the result into a channel. It has the bot's normal tool
access, so treat creating one with the same care as running the request yourself.

## Commands

All paths come from the environment. **Never name a file.**

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/schedule.mjs" list
node "$CLAUDE_PLUGIN_ROOT/bin/schedule.mjs" add --cron "0 7 * * 1,2,3,4,5" --prompt "..." --by "<who asked>"
node "$CLAUDE_PLUGIN_ROOT/bin/schedule.mjs" remove <id>
node "$CLAUDE_PLUGIN_ROOT/bin/schedule.mjs" history [id]
```

`add` defaults to the current channel. Pass `--channel <id>` only if the user
explicitly asks for it to post somewhere else — a job that quietly posts into a
different channel is a surprise nobody wants.

## Writing the cron — read this before composing one

The scheduler evaluates `*` and **comma-separated numbers only**.

**Ranges and steps are not supported.** Write `1,2,3,4,5`, never `1-5`. The
script rejects a range rather than accepting it, because `1-5` would otherwise
parse as `1` and a "weekdays" job would fire on Mondays alone — a wrong schedule
is worse than a rejected one, since nobody notices until it doesn't happen.

Fields are `minute hour day month weekday`, weekday `0` = Sunday.

| ask | cron |
|---|---|
| every morning at 7 | `0 7 * * *` |
| every weekday at 7 | `0 7 * * 1,2,3,4,5` |
| Mondays at 9:30 | `30 9 * * 1` |
| 1st of the month at 8 | `0 8 1 * *` |

Times are interpreted in the bot's configured timezone, not the server's.

## The prompt matters more than the schedule

The stored prompt runs with **no one watching and no conversation around it**.
Write it to stand alone:

- Bad: `"tell me the reach"` — no context, and "me" means nothing at 7am.
- Good: `"Post the current customer reach numbers for jerky.com, with the change since last week. Lead with the number."`

Include what to fetch, what to compare against, and how to present it. If the
user's request is vague, ask **before** scheduling — a bad prompt scheduled daily
is a bad answer delivered daily.

## After creating one

The script reads the job back and reports the interpreted schedule and the **next
fire time**. Show the user both, in plain language:

> Scheduled **job-abc** — every weekday at 07:00 America/Chicago.
> Next run: 2026-08-11 12:00 UTC. Posts here.

If the next run is `NEVER`, the cron matches no time in the next 90 days — say so
and fix it rather than leaving it.

## One-off reminders

Pass `--expires <iso>` and the job removes itself after it fires. Use it for
"remind me on Friday" so a one-time ask does not become a permanent job.

## When something did not happen

Run `history`. It shows what fired, when, and what failed. A job that never
appears there did not run — check `list` to confirm it still exists and that its
next fire time is what the user expected.
