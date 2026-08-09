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
