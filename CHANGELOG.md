# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — unreleased

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
