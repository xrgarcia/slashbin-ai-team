# Harness skill pack

Skills that ship **with the harness** and load into every bot automatically, so
they do not have to be copied into each bot's repo.

Loaded via `--plugin-dir` on every session spawn and namespaced by the plugin, so
a pack skill is `/slashbin-harness:<name>` and can never shadow a bot's own.

## The one rule: never hardcode a path

The harness publishes its **resolved** paths into the environment of every run:

| variable | what |
|---|---|
| `BOT_STATE_DIR` | root of everything this bot remembers |
| `BOT_SUMMARIES_DIR` | daily summary files |
| `BOT_ATTACHMENTS_DIR` | inbound files |
| `BOT_OUTBOX_DIR` | write here and it is attached to the reply |
| `BOT_BUFFER_FILE` | rolling conversation buffer |
| `BOT_SESSIONS_FILE` | per-channel session map |
| `BOT_JOB_HISTORY_FILE` | scheduled job runs |
| `BOT_CHANNEL_ID` | the channel this run is answering in |

**Read those. Never name a file.** This pack exists because the per-repo copies of
`/remember` hardcoded harness internals and every path they used was dead by the
time anyone checked — `history/` had been stale for three months and both buffer
filenames predated a bot rename. A skill that reads `$BOT_BUFFER_FILE` cannot go
stale; one that names `.po-bot-conversation-buffer.txt` always will.

A pack skill containing a literal state filename fails the test suite.

## Adding one

Create `skills/<name>/SKILL.md` with frontmatter (`name`, `description`). That is
the whole process — no registration, no per-bot change.
