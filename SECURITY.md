# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: go to the repository's **Security** tab →
**Report a vulnerability**. That opens a private advisory only the maintainers can
see.

We aim to acknowledge a report within 3 working days and to agree a disclosure
timeline with you before anything is published.

## What this software actually does — read this before reporting

This harness gives a Claude Code agent a chat surface. **A correctly configured
bot can read and write files, run shell commands, and reach every MCP server you
connect.** That is the product, not a flaw.

That makes the line between a vulnerability and a configuration choice worth
stating plainly.

### In scope — please report these

- Anyone reaching the bot who is **not** permitted by `ALLOWED_USERS`,
  `ALLOWED_CHANNELS`, or `ALLOWED_BOTS`.
- A tool being usable that `BOT_PERMISSION_MODE=restricted` and
  `BOT_ALLOWED_TOOLS` should have excluded.
- A credential leaking into a log, an error message, a Discord message, a summary,
  or a file written by the bot.
- Path traversal out of the attachments or outbox directory.
- The WebSocket bridge being reachable from off-host, or accepting commands
  without a handshake.
- Any way to make the bot act on input from an unauthorised user — including via
  an attachment, a reaction, or a message from another bot.

### Out of scope — these are configuration, not vulnerabilities

- **`BOT_PERMISSION_MODE=bypass` allows arbitrary command execution.** That is
  what it is for, it is not the default, and it logs a warning on every start.
- **An empty `ALLOWED_USERS` allows every Discord user who can reach the bot.**
  Also warned about on every start; set `BOT_REQUIRE_ALLOWLIST=true` to refuse to
  start without one.
- The bot doing something destructive when an *authorised* user asked it to.
- Prompt injection changing the bot's answers **within** the tools it has been
  granted. Injection that escalates *beyond* its granted tools is in scope.

## Supported versions

| Version | Supported |
|---|---|
| 2.x | Yes |
| 1.x | No — upgrade (see `UPGRADING.md`) |

## Hardening checklist

Run `npm run doctor` — it checks most of this for you.

- Set `ALLOWED_USERS`, and `BOT_REQUIRE_ALLOWLIST=true`.
- Leave `BOT_PERMISSION_MODE` at `restricted` unless the bot genuinely needs to
  write code or run commands.
- Keep tokens in the environment or a secrets manager, never in
  `ecosystem.config.js` — `doctor` fails if it finds one there.
- Point `CLAUDE_CWD` at the project you want the bot to work on, and nothing wider.
- Leave the WebSocket bridge on `127.0.0.1` unless you have a specific reason.
