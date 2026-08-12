# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] — 2026-08-12

### Security

- **Five advisories cleared — three rated high.** `npm audit` now reports zero.
  Two were in direct dependencies: **`ws`** 8.20.0 → 8.21.3 (uninitialized memory
  disclosure, and memory exhaustion from tiny fragments — this is the WebSocket
  bridge bots use to talk to each other) and **`discord.js`** 14.25.1 → 14.27.0.
  Upgrading those cleared the three underneath: `lodash` 4.17.23 → 4.18.1,
  `undici` 6.21.3 → 6.28.0, `@discordjs/rest` 2.6.0 → 2.6.3.

  Every fix fell inside the version ranges already declared, so `package.json` is
  unchanged and this is a lockfile-only upgrade — nothing for an installer to do
  beyond `npm install`.

  Thanks to **@anupamme**, who reported the lodash vulnerability in #47. The
  report was right; the pin was not — npm marks lodash 4.18.0 a bad release, and
  4.18.1 is the clean one. Upgrading `discord.js` pulls it in transitively, which
  fixes the cause rather than pinning around it.

## [2.1.0] — 2026-08-12

### Fixed

- **`Error: spawn E2BIG` on the first message after a restart.** A fresh session
  carried every daily summary in the lookback window plus the whole conversation
  buffer in one `--append-system-prompt` argument. Linux caps a *single* argv
  string at 128KB — separately from the much larger total `ARG_MAX` — and while
  the buffer had `BUFFER_MAX_BYTES`, summaries had no ceiling in the code or the
  config. Two busy days measured 137,242 bytes against a limit of 131,071, and
  every fresh session died at spawn with an error naming neither the cause nor a
  setting. It read as a reboot fault because a *resumed* session skips context
  injection entirely; in truth any conversation idle longer than
  `SESSION_TIMEOUT_MS` would have hit it.

  The summarizer had the same exposure — it hands a `SUMMARIZE_BATCH_SIZE`
  transcript through argv — where a crossing would have taken down the daily
  summary that recall depends on.

- **A user's schedules no longer live in a git working tree.** `schedules.json`,
  the job run log and the summarizer's read position moved from `BOT_HISTORY_DIR`
  to `BOT_STATE_DIR`, alongside the buffer and sessions. They were gitignored,
  which is not safe — only invisible: one `git clean -x` or a re-clone and the
  user's scheduled jobs are gone, and a schedule that silently stops firing is a
  failure nobody notices. `BOT_HISTORY_DIR` holds summaries, the reviewable record
  people deliberately keep in a repo; runtime state is not that. **Existing files
  are migrated on first start**, not stranded, and `summarize.js` resolves the
  checkpoint the same way — when those two disagreed, the summarizer re-read from
  the wrong position.

### Added

- **`CONTEXT_MAX_BYTES`** (default `65536`) — a declared ceiling on remembered
  context. Over budget, the oldest summaries are dropped and the prompt states
  that they were, pointing at `$BOT_SUMMARIES_DIR`, so a bot never reports that
  nothing happened on a day it merely was not shown. `/remember` still reaches
  every summary on disk. Independently, no argument now leaves the harness above
  the OS limit whatever the configuration says, so this failure is unreachable
  rather than merely unlikely.

## [2.0.0] — 2026-08-09

First release aimed at people who are not us. See [UPGRADING.md](UPGRADING.md) —
the upgrade is one line.

### Added

- **`npm run setup`** — interactive configuration that validates every answer
  live and writes a working `.env`. Catches Message Content Intent being off,
  which otherwise produces a bot that connects and then ignores every message.
- **`npm run doctor`** — the same checks, non-interactive, exits non-zero. For CI,
  container entrypoints, and bug reports. Prints no secrets.
- **`BOT_PERMISSION_MODE`** — `restricted` (default) or `bypass`.
- **`BOT_REQUIRE_ALLOWLIST`** — refuse to start with an empty `ALLOWED_USERS`.
- **`BOT_TIMEZONE`** — the bot's clock, validated at startup.
- **Live progress.** While a request runs the bot posts one status line, edited in
  place as it works, removed when the answer arrives. It reports activity only —
  the reply is still delivered once, at the end, unsplit — which is what lets
  progress return without reviving the "bot answered twice" bug that removed
  streaming in the first place (3c79e5e, 2026-03-28). Tool inputs are never shown.
  Disable with `BOT_PROGRESS_ENABLED=false`.
- **`/slashbin-harness:remember`** — recall across every store a bot has: all daily
  summaries (not just the injected window), the conversation buffer, attachments,
  live sessions and scheduled runs. Reports which sources it actually searched, so
  a missing store is never mistaken for an empty one. Works on resumed sessions.
- **Harness skill pack** — skills ship with the harness in `skill-pack/` and load
  into every bot, namespaced `slashbin-harness:<name>`, instead of being copied
  into each bot's repo where they hardcode paths and rot.
- **Scheduled jobs can be created from chat.** "Every weekday at 7am, post the
  standup" now works. The scheduler has always RUN jobs; nothing could create
  one — `schedules.json` had to be hand-written on the host, and the bot was never
  told the file existed. `/slashbin-harness:schedule` handles create, list, remove
  and run history, and reads a created job back to report the interpreted schedule
  and next fire time — a cron accepted silently is one nobody notices is wrong
  until it fails to fire.
- `BOT_MAX_SCHEDULED_JOBS` caps jobs per bot.
- **`npm run list`** — every bot instance this checkout has state for.
- Settings for previously frozen constants: `BOT_SCHEDULE_CHECK_MS`,
  `BOT_SCHEDULE_LOOKBACK_MINUTES`, `BOT_OUTBOX_MTIME_TOLERANCE_MS`,
  `BOT_BOT_EXCHANGE_PRUNE_MS`, `WS_HEARTBEAT_MS`, `WS_HEARTBEAT_MAX_MISSES`,
  `BUFFER_ROTATE_PERCENT`, `WS_HOST`. Every default unchanged.
- MIT `LICENSE` — the repository previously had none, which made it
  all-rights-reserved by default.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates.
- CI on Node 18 and 20, including a gate that fails if the example config names a
  setting the code does not read or stores a literal credential.
- `test/startup-safety.test.js` — 21 assertions covering startup, permissions,
  configuration, and the process manager.

### Changed

- **BREAKING: tool exposure is restricted by default.** Set
  `BOT_PERMISSION_MODE=bypass` for the previous behaviour.
- `npm run status` distinguishes *connected to Discord* from *process alive*.
- The process manager scopes pid and log files by `BOT_NAME`, so several bots can
  be managed from one checkout. Single-bot filenames are unchanged.
- The process manager loads dotenv config, so it can no longer disagree with
  `bot.js` about which instance it is managing.
- An empty `ALLOWED_USERS` warns loudly on every start.
- Numeric settings that are not numbers, or below their minimum, fall back to the
  default **and log it**, instead of being silently swallowed.
- `package.json` carries real metadata; the package is named after the repository.

### Fixed

- **A bot command sharing a name with a harness command is no longer invisible.**
  The harness intercepts `/fresh`, `/status` and the stop words before Claude sees
  the message, so a same-named command in a bot's own repo could never run — while
  still appearing in that bot's list of what it can do, because from inside Claude
  the command is real. Nothing errored, nothing logged. Found live: the PO bot
  advertised a `/status` that had never once executed. Now warned at startup,
  failed by `doctor`, and the reserved names are injected into every session so a
  bot can finally answer "what commands can I use here" correctly.
- **Cron fired in the host's timezone, not `BOT_TIMEZONE`.** A bot configured for
  London running `0 7 * * *` on a Chicago host fired at 7am Chicago — 1pm London.
  "Every morning at 7am local" meant "7am wherever the server is". Jobs now record
  the zone they were created under so a config move cannot silently reinterpret
  them, and the already-ran key is computed in the same zone as the match — they
  could otherwise disagree across a DST boundary and double or drop a run.
- **A cron range (`1-5`) was accepted and silently wrong.** The matcher understands
  `*` and comma lists only, so `1-5` parsed as `1` and a "weekdays" job fired on
  Mondays alone. Ranges and steps are now rejected with a message naming the fix.
- **Asking a bot to stop no longer answers with an error.** The stop path killed
  the run without marking the kill intentional, so the close handler treated it as
  a crash and replied `Error: Claude exited with code 143`. The bare `stop` form
  never sent "Stopped." at all — that error was its only feedback. Stopping now
  acknowledges whenever it actually stopped something, however it was phrased.
- **`stop x, y, z` now stops.** The matcher required an exact `stop` / `/stop`, so
  anything with trailing words fell through to Claude and *started a new run* — the
  opposite of the intent, at the moment you least want it. A message opening with
  `stop` / `halt` / `abort` / `cancel` now stops a run in flight. With nothing
  running it is still an ordinary message, so "stop sending the Friday digest"
  remains a request the bot thinks about rather than a silent no-op.
- **Every summarizer run destroyed that day's summary.** `writeSummary` used
  `writeFileSync`, and the checkpoint means each run only covers messages since
  the last one — so an hourly summarizer replaced the whole day with a summary of
  the last hour. Observed on a live host: a day with 14 completed conversations
  had a "daily" summary reading *6 messages summarized*. Summaries now append,
  each batch timestamped. This silently truncated the memory that cross-session
  recall reads, in both `bot.js` and `summarize.js`.
- **Two channels with the same name shared one summary file.** The owning channel
  id is now recorded in the file, and a second channel with the same (or
  same-sanitising) name gets its own.
- **A file written for one channel could be attached in another.** The outbox was
  a single shared directory, `MAX_CONCURRENT_CLAUDE` defaults to 2, and each run
  claimed every file whose mtime fell after its own start — including the other
  run's. A document produced for one client could land in another client's
  channel, which is exactly the separation this project advertises. The outbox is
  now scoped per channel; the shared root is only swept when nothing else is in
  flight, so a bot whose own context hardcodes the old path still works.
- **Two attachments with the same name on one message resolved to one file.** The
  saved path was keyed on the message id, so two `report.csv` on a single message
  produced the same path and the already-downloaded short-circuit handed back the
  first file's contents for the second — the bot described two attachments and
  read one, silently. Now keyed on the attachment id, which Discord guarantees
  unique per file.
- **A failed Discord login no longer leaves a zombie.** `client.login()` was an
  un-awaited promise whose rejection only reached the global handler, so the
  process stayed alive — the WebSocket server and scheduler keep the event loop
  busy — while reporting "Bot started" and "Bot is running". It now logs the cause
  and exits non-zero.
- **`ALLOWED_USERS` no longer vetoes bots already allowed by `ALLOWED_BOTS`.**
  Securing a bot with a user allowlist silently broke bot-to-bot coordination.
- The injected clock said `CDT CDT` in summer and `CST CDT` in winter, for every
  user regardless of location.
- `CLAUDE_CWD` is validated at startup instead of failing on the first message.
- The example config no longer advises storing real tokens in a JavaScript file,
  no longer configures a setting the code never read (`RECENT_CONTEXT_CHANNELS`),
  and no longer carries a stale model id.

### Removed

- `.claude/skills/implement-approved-issues` and `revise-pr-feedback` — the
  maintainers' internal delivery process, never loaded by the bot.

## [1.1.1] — 2026-05-20

Bot resilience and README positioning. See the
[release notes](https://github.com/xrgarcia/slashbin-ai-team/releases/tag/v1.1.1).

[2.0.0]: https://github.com/xrgarcia/slashbin-ai-team/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/xrgarcia/slashbin-ai-team/releases/tag/v1.1.1
