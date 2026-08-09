---
name: bot-state
description: Show where this bot's memory actually lives — state root, summaries, attachments, outbox, buffer, sessions — and what is in each. Use when asked where files go, why a summary or attachment is missing, or to check the bot's storage layout.
---

# bot-state

Report this bot's **resolved** storage layout and what each location holds.

## How to do it

Every path comes from the environment. **Do not guess a path and do not hardcode
one** — the harness resolves these per bot and they move.

| variable | holds |
|---|---|
| `$BOT_STATE_DIR` | root of everything this bot remembers |
| `$BOT_SUMMARIES_DIR` | daily summary files, `<date>-<channel>.md` |
| `$BOT_ATTACHMENTS_DIR` | files people sent this bot |
| `$BOT_OUTBOX_DIR` | write a file here and it is attached to the reply |
| `$BOT_BUFFER_FILE` | rolling conversation buffer |
| `$BOT_SESSIONS_FILE` | per-channel session map |
| `$BOT_JOB_HISTORY_FILE` | scheduled job run history |

For each: report the resolved path, whether it exists, and a useful measure —
file count for directories, size and last-modified for files.

If a variable is unset, say so plainly rather than substituting a guess. An unset
variable means an older harness, not a missing directory.

## Answer format

Lead with the state root, then a short table. Flag anything notable:

- a directory that does not exist yet (normal if the bot is new — say so)
- a state root **inside a git working tree** — fine for summaries, which are meant
  to be reviewable, but attachments are arbitrary binaries and `git clean -x` or a
  re-clone will take them
- an empty summaries directory on a bot that has been running a while — that is a
  real problem worth naming, not a curiosity

Keep it short. This is a status answer, not an audit.
