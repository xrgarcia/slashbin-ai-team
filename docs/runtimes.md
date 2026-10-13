# Runtimes: Claude Code or Codex

Each bot runs on one agent CLI, chosen by `BOT_RUNTIME`:

| `BOT_RUNTIME` | CLI | Sign-in |
|---|---|---|
| `claude` (default) | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `claude` once, interactively |
| `codex` | [OpenAI Codex CLI](https://github.com/openai/codex) | `codex login` |

Every run the bot makes uses that CLI: Discord messages, reactions, wakes,
scheduled jobs, buffer and daily summaries, and Paperclip board tasks. `npm run
doctor` checks only that CLI. So a bot on Codex needs only Codex installed and
signed in, and a bot on Claude needs only Claude Code.

There is deliberately **no** load balancing, no fallback from one to the other, and
no moving a conversation between them. A session remembers the runtime that started
it and is resumed only by that runtime; after a switch, each channel starts a fresh
session. The bot's summaries and buffer are plain text and carry over, so the
channel's memory survives the switch.

Bots in one team can differ: the PO on Claude and the EM on Codex is fine. Set the
variable per bot (its `.env`, or its `env` block in `ecosystem.config.js`).

## Switch a bot

```sh
BOT_RUNTIME=codex
BOT_MODEL=<a model your Codex account offers>   # optional; the CLI default otherwise
# CODEX_BIN=/path/to/codex                      # optional; `codex` on PATH otherwise
```

Remove any Claude-only setting (below), run `npm run doctor`, then restart the bot.
The startup log says which runtime it runs on:

```
Runtime: codex — every run of this bot uses it
```

To go back, remove `BOT_RUNTIME` (or set `claude`) and restart.

## What stays the same

- **The role.** Codex reads the bot's `CLAUDE.md` in `CLAUDE_CWD` as its project
  instructions, so one repo serves either runtime. A repo that also has an
  `AGENTS.md` gives Codex that file instead.
- **The harness prompt, memory and channel prompts.** Built the same way and passed
  as Codex's developer instructions.
- **The skill pack.** Its hooks run on Codex with the same contract, and its skills
  (`schedule`, `land`, `remember`, `bot-state`) are listed in the instructions with
  the file to read. The mail and calendar gates guard the claude.ai Gmail and
  Calendar connectors, which a Codex bot does not have.
- **Permission modes.** `BOT_PERMISSION_MODE=restricted` and `bypass` mean the same
  thing on both.
- **Board runs.** `BOT_BOARD_EXECUTION=readonly|engineering` and its paths, with the
  same isolation of Discord memory; `parity` runs the board task as the Codex
  session, MCP servers included. See
  [paperclip-board-execution.md](paperclip-board-execution.md#on-codex).

## What differs on Codex

| Area | Claude | Codex |
|---|---|---|
| Restricted session | `BOT_ALLOWED_TOOLS` (read tools, web fetch and search), MCP servers | Reads `CLAUDE_CWD` and the uploads folder; no writes, no network, no web search, no MCP servers |
| Bypass session | Every tool, MCP servers from `MCP_CONFIG` or the repo's `.mcp.json` | Unsandboxed, the operator's own Codex config, plus the bot's local (stdio) MCP servers from the same files; HTTP/SSE servers there are skipped and logged — define those in the Codex config instead |
| Board run, `readonly` | Read tools only, no shell | A shell inside a read-only profile, no network |
| Board run, `engineering` | Sandboxed shell, host allow list | Sandboxed shell, **no network**; `BOT_BOARD_NETWORK_ALLOW` is refused |
| Step cap | `CLAUDE_MAX_TURNS` (`0` = none) | None; `CLAUDE_TIMEOUT_MS` bounds a run |
| Background commands | Refused by the pack's gate | Codex background terminals are off; commands run to completion |

Every Codex board run has a shell, `readonly` included. On either runtime a board
run is denied the Discord memory folders, and where one lies in a git repository,
also that repository's git folder and the same folder in each of its worktrees. So a
readonly Codex run with the memory inside `CLAUDE_CWD` cannot read it, live or
committed. As on Claude, only `engineering` needs the memory out of `CLAUDE_CWD`.

## Settings Codex cannot honor

These are written in Claude Code's own syntax. Set on a Codex bot, the bot refuses
to start and the log names each one; unset them or go back to `claude`:

`BOT_ALLOWED_TOOLS`, `BOT_PERMISSION_ALLOW`, `BOT_PERMISSION_DENY`, `BOT_SETTINGS`,
`BOT_SUMMARIZER_TOOLS`, `BOT_BOARD_TOOLS`, `BOT_BOARD_ENGINEERING_TOOLS`,
`BOT_BOARD_PERMISSION_ALLOW`, `CLAUDE_MODEL` (use `BOT_MODEL`).

## Prerequisites for Codex

- The Codex CLI, signed in (`codex login status` says so). Doctor runs both checks.
- For board runs, **Codex 0.162.x**. Its permission profiles are beta, so the bot
  takes board tasks only on the version they were measured on; on another version
  the connector stays off and says so. Discord is unaffected.
- `bwrap` (bubblewrap) on Linux for restricted sessions, summaries and board runs.
  Without it those runs fail closed.

## Verify a selected runtime

1. `npm run doctor` (or `npm run doctor:fleet` for a team): `Agent CLI (codex)` is
   `PASS` with the version and "signed in", and each bot's `runtime` line names its
   CLI.
2. Restart the bot; the log shows `Runtime: codex — every run of this bot uses it`
   and `Bot online`.
3. Message the bot on Discord. The reply comes back as usual, and the log shows
   `Starting fresh Codex session`, then `Resuming Codex session` on the next message.
4. A summary (the buffer rotation or the daily run) is written as usual.

## Symptom → fix

| Symptom | Cause | Fix |
|---|---|---|
| Bot exits at startup: `… is Claude Code syntax and has no Codex equivalent` | A Claude-only setting on a Codex bot | Unset it, or `BOT_RUNTIME=claude` |
| Bot exits at startup: `BOT_RUNTIME="…" is not one of claude, codex` | Typo | Fix the value |
| Log: `BOT_RUNTIME=codex but the Codex CLI did not run` | Not installed, not on PATH | Install it, or set `CODEX_BIN` |
| Doctor: `Agent CLI (codex)` FAIL, not signed in | No Codex login on this host user | `codex login` as the user the bot runs as |
| Every reply fails with `Codex exited with code 1` | Sign-in expired, or the model is not on the account | `codex login status`; check `BOT_MODEL` |
| Restricted replies fail with a sandbox error | No `bwrap` | Install bubblewrap |
| Log: `MCP server not passed to Codex — skipped` | An HTTP/SSE server in the MCP config | Define it in the Codex config the session loads — the repo's `.codex/config.toml` (trusted project) or `~/.codex/config.toml` — with its credentials from the environment (`env_http_headers`, `bearer_token_env_var`) or a header helper, never literal; check with `codex mcp list` in `CLAUDE_CWD` |
| Log: `Paperclip connector off — … tested on Codex 0.162.x` | Another Codex version | Install 0.162.x for board work; Discord keeps working |
| After switching, the bot has forgotten the conversation | Sessions are not moved between runtimes | Expected; the summaries still carry the channel's memory |
