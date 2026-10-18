# The run environment

[README](../README.md) · [All documentation](../README.md#documentation-table-of-contents)

## Contents

- [The writers](#the-writers)
- [Run kinds](#run-kinds)
- [What a command can see, by runtime](#what-a-command-can-see-by-runtime)
- [Credentials: by name and by value](#credentials-by-name-and-by-value)
- [Outcomes](#outcomes)
- [The rules](#the-rules)
- [Not covered](#not-covered)
- [The matrix](#the-matrix)

Every Claude or Codex process the bot spawns for a reply — a Discord session, a
wake, a cron job, a Paperclip board task — gets an environment built by **one
function**, `buildRunEnv` in `lib/permission-mode.js`. It runs over the
complete final child environment, after every writer, and decides for each
variable whether the run has it and whether the run's commands can read it.
`spawnClaude()` in `bot.js` calls it once, at the point where the child env is
final, for both runtimes; startup calls it for every run kind the bot will run
and refuses to start (exit `78`) on any problem.

This page is the specification. `test/run-environment.test.js` reads the
matrix below and runs one check per row, so a row here is a test.

## The writers

In the order they write; a later writer wins on the same name.

| # | Writer | Applies to |
|---|---|---|
| 1 | **Inherit** — the bot's process environment, filtered by `BOT_RUN_ENV` | every run |
| 2 | **Harness** — the resolved paths (`BOT_STATE_DIR`, `BOT_SUMMARIES_DIR`, `BOT_ATTACHMENTS_DIR`, `BOT_OUTBOX_DIR`, `BOT_BUFFER_FILE`, `BOT_SESSIONS_FILE`, `BOT_JOB_HISTORY_FILE`, `BOT_SCHEDULES_FILE`, `BOT_CHANNEL_ID`), `CLAUDE_PLUGIN_ROOT` (Codex), and the run-kind flags (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` on a narrow board or restricted run; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and the private `TMPDIR` on a narrow board run) | every run |
| 3 | **Server channel** — the MCP servers' env (`MCP_CONFIG`, `MCP_CONFIG_EXTRA`, the repo's `.mcp.json`, read once at startup with `${VAR}` expanded against the bot's whole environment and inline values as written; a server's command line is checked under rule 11), and the seat key `PAPERCLIP_RUN_AGENT_KEY` with `PAPERCLIP_RUN_ID` for a board task | Codex in `bypass`, session or parity run only |
| 4 | **Nesting** — `CLAUDECODE`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` removed | every run |

On Claude the MCP config's env is not a writer: the CLI hands it to the server
it starts, never to the session's own environment, so a Bash command does not
see it.

## Run kinds

| Run | What it is |
|---|---|
| `session` | A Discord message, a wake, a cron job |
| `board` | A Paperclip task under `BOT_BOARD_EXECUTION` `readonly` or `engineering`: least privilege |
| `parity` | A Paperclip task under `BOT_BOARD_EXECUTION=parity`: built as the Discord session |

## What a command can see, by runtime

- **Claude** has no way to keep a variable in its environment from its
  commands: the Bash tool inherits all of it. On Claude a variable is either
  withheld or seen.
- **Codex, `bypass`, session or parity run**: commands see the environment less
  `shell_environment_policy.exclude`, which is `buildRunEnv`'s `shellExclude`.
  Codex still hands an excluded variable to an MCP server that names it.
- **Codex, any other run** (a narrow board run, or `restricted`): commands see
  only the core variables (`shell_environment_policy` `inherit = "core"`), and
  no MCP server is configured.

## Credentials: by name and by value

A **credential identity** is a variable whose name says it holds a credential
(`credentialName`: a `TOKEN`, `KEY`, `SECRET`, `PASS…`, `BEARER`, `AUTH`,
`CREDENTIALS`, `COOKIE` or `PAT` part, or a Discord or Paperclip key spelled
without one), a Paperclip connector key named by the board configuration
(`PAPERCLIP_API_KEY` and every `keyEnv` in `PAPERCLIP_EXTRA_BOARDS`, whatever
`BOT_SURFACES` turns on), or the seat key. Identities are collected from **every
source**: the bot's whole process environment (not the filtered one), the MCP
servers' env, and the seat. A variable **carries** an identity when it is named
as one or its value contains the identity's value (at least 6 characters).
Matching on the source value is what catches an alias: a variable named
anything at all that holds `DISCORD_TOKEN`'s value carries a Discord identity
even when `DISCORD_TOKEN` itself was never inherited.

| Class | Named by |
|---|---|
| Discord | `discordCredential`: `DISCORD_TOKEN`, `BRIDGE_TOKEN`, any DISCORD/BRIDGE + TOKEN/KEY/SECRET/PASS name |
| Paperclip | `paperclipCredential`: any PAPERCLIP + TOKEN/KEY/SECRET/PASS name |
| Connector | a configured board's key variable, and the seat key |
| Other | any other credential name |

A credential identity's name is never an **operating basic** or a **harness
policy setting**, whatever its prefix: `XDG_DISCORD_TOKEN` is a Discord
credential and `LC_API_KEY` a credential, not a locale, and a board's key
variable is a connector whatever it is called. The basics and the policy
settings below are the names left over once those are taken out.

## Outcomes

| Outcome | Meaning |
|---|---|
| `kept` | In the run's environment, and its commands can read it |
| `hidden` | In the run's environment for its MCP servers, and its commands cannot read it (Codex only) |
| `withheld` | Not in the run's environment at all |
| `refused` | The configuration cannot be held; the bot does not start, or the run does not spawn. The refusal names variables, never values |

## The rules

Evaluated over the final environment, for each variable:

1. **`BOT_RUN_ENV` set**: a variable that is not listed (a name, or a `NAME_*`
   prefix), not an operating basic (`PATH`, `HOME`, locale, `TMPDIR`, `XDG_*`,
   `CODEX_HOME`…) and not a harness policy setting (the mail, calendar and
   landing gates, the BOT_* paths, commit identity…) is **withheld**. Unset,
   everything is inherited, as before. A credential under a basic's prefix
   (`XDG_API_KEY`) is not a basic, so it is withheld unless listed.
2. A **Discord** identity is **withheld** from every board and parity run,
   whoever writes it — the server channel included.
3. A **Paperclip** identity is **withheld** from every board and parity run,
   unless the server channel writes it (then rule 6).
4. A **connector** identity is **withheld** from every run, Discord sessions
   included, unless the server channel writes it (then rule 6). A second name
   holding a board's key is that key.
5. On a narrow **board** run, every `BOT_*` variable outside the board's own
   settings, `MCP_CONFIG*`, and any `*PAPERCLIP*` name is **withheld** (the
   private Discord memory paths among them).
6. A variable the **server channel** writes is **hidden**, unless it has the
   same name and value as an inherited variable that is kept. A server value
   no inherited credential holds is a **server-only** credential: any inherited
   variable carrying it is hidden too.
7. **`BOT_RUN_ENV` set**: every inherited variable that carries any credential
   identity is **hidden**. Listing a credential makes it the run's, for its MCP
   servers — never its commands'. A listed variable holding an *unlisted*
   credential's value is hidden, not withheld, so a bot's listed key is never
   dropped for colliding with another.
8. A **harness policy setting** (or a harness path) that would carry a
   credential a command must not see — a rule 2–4 identity, any identity under
   `BOT_RUN_ENV`, or a server-only credential — **refuses** the configuration.
   It can neither be dropped (the mail and calendar gates allow everything when
   their variable is unset) nor kept (it would hand the credential to every
   command).
9. An **operating basic** is never hidden for what it carries (a credential
   naming a folder on `PATH` must not take `PATH` away), and **refuses** the
   configuration only when it carries a rule 2–4 identity.
10. A server-channel variable that would replace a harness policy setting with
    another value **refuses** the configuration.
11. A credential identity's value on an MCP server's **command line** (its
    `command`, `args` or `cwd` after `${VAR}` expansion) **refuses** the
    configuration wherever the server channel applies. The harness writes those
    into Codex's own arguments, and a process's arguments are readable by every
    process on the host (`ps`) — no exclusion keeps a command from them. A
    server takes a credential through its `env`.
12. A board's key variable (the connector key, a `keyEnv` in
    `PAPERCLIP_EXTRA_BOARDS`) named as a harness policy setting, a path or
    flag the harness publishes, or an operating basic **refuses** the
    configuration. Rule 4 withholds the key from every run and the setting
    must be kept, so no outcome holds both: withheld, the gate or path is
    gone; kept, every command reads the key.

`shellExclude` is every hidden name, plus the connector key names and the seat
key name whether present or not.

## Not covered

- **The summarizer** (`lib/summarize-core.js`) is not a reply run: on Claude it
  has `Read` only and no shell; on Codex it runs narrow, with only the core
  variables. It does not use this builder.
- **An ancestor's environment.** On a run with no sandbox (a bypass session
  or a parity run, either runtime) a command can read the environment file
  under `/proc` of the processes above it — the runtime's and the bot's own —
  as the same user. What this page withholds or hides is kept out of the
  child's environment and its shell policy, not out of those files. Closing it
  needs the bot to start without the credentials in its own environment, which
  is outside this builder.
- **Inline configuration on Claude's command line.** An inline JSON
  `MCP_CONFIG`, `MCP_CONFIG_EXTRA` or `BOT_SETTINGS` goes onto Claude's
  arguments as written. Claude expands a `${VAR}` reference itself, so a
  credential written as a reference stays off the command line; one written
  in as a literal value does not.
- **Claude cannot hide.** A credential listed in `BOT_RUN_ENV` on a Claude bot
  reaches its commands (rows marked *Claude cannot hide* below). Withhold it, or
  run the bot on Codex, to keep it from them.

## The matrix

Values: `{X}` is a distinct secret value, at least 6 characters; anything else
is literal. Every row also runs with the harness's paths published. *Seat*
names the board key a board task's seat key is taken from (run id `run-1`).
`—` is unset or empty. In the *MCP env* column, `@name=…` is server `name`'s
command line rather than an env entry (rule 11).

| id | runtime | mode | run | BOT_RUN_ENV | process env | MCP env | seat | variable | expected | case |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | claude | bypass | session | — | `GH_TOKEN={G}` | — | — | `GH_TOKEN` | kept | unset inherits everything, as before |
| A2 | codex | bypass | session | — | `GH_TOKEN={G}` | — | — | `GH_TOKEN` | kept | unset inherits everything, as before |
| A3 | codex | restricted | session | — | `GH_TOKEN={G}` | — | — | `GH_TOKEN` | hidden | a narrow Codex run's commands see only the core variables |
| A4 | codex | bypass | board | — | `GH_TOKEN={G}` | — | — | `GH_TOKEN` | hidden | a narrow Codex run's commands see only the core variables |
| A5 | claude | bypass | board | — | `GH_TOKEN={G}` | — | — | `GH_TOKEN` | kept | a Claude board run keeps a non-board credential (its gh) |
| A6 | codex | bypass | session | — | `PATH=/usr/bin` | — | — | `PATH` | kept | the basics |
| B1 | claude | bypass | session | — | `DISCORD_TOKEN={D}` | — | — | `DISCORD_TOKEN` | kept | the Discord session runs as the bot |
| B2 | claude | bypass | board | — | `DISCORD_TOKEN={D}` | — | — | `DISCORD_TOKEN` | withheld | rule 2 |
| B3 | claude | bypass | parity | — | `DISCORD_TOKEN={D}` | — | — | `DISCORD_TOKEN` | withheld | rule 2 |
| B4 | codex | bypass | parity | — | `EM_DISCORD_TOKEN={E}` | — | — | `EM_DISCORD_TOKEN` | withheld | rule 2, another bot's token |
| B5 | claude | bypass | parity | — | `DISCORD_TOKEN={D}; RELAY={D}` | — | — | `RELAY` | withheld | rule 2, an alias by value |
| B6 | claude | bypass | parity | `ALIAS` | `DISCORD_TOKEN={D}; ALIAS={D}` | — | — | `ALIAS` | withheld | round 4 S1: the original filtered out before the scrub ran |
| B7 | claude | bypass | board | `ALIAS` | `DISCORD_TOKEN={D}; ALIAS={D}` | — | — | `ALIAS` | withheld | round 4 S1, engineering board |
| B8 | codex | bypass | parity | `ALIAS` | `DISCORD_TOKEN={D}; ALIAS={D}` | — | — | `ALIAS` | withheld | round 4 S1, on Codex |
| B9 | codex | bypass | session | `ALIAS` | `DISCORD_TOKEN={D}; ALIAS={D}` | — | — | `ALIAS` | hidden | rule 7 |
| B10 | codex | bypass | parity | — | `DISCORD_TOKEN={D}; HEADER=Bot {D}` | — | — | `HEADER` | withheld | rule 2, a substring |
| B11 | codex | bypass | parity | — | `DISCORD_TOKEN={D}` | `TOKEN={D}` | — | `TOKEN` | withheld | rule 2, `TOKEN=${DISCORD_TOKEN}` in the server env |
| B12 | codex | bypass | parity | — | — | `DISCORD_TOKEN={D}` | — | `DISCORD_TOKEN` | withheld | rule 2, inline in the server env |
| B13 | codex | bypass | parity | — | `OPS_RELAY={O}` | `DISCORD_TOKEN={O}` | — | `OPS_RELAY` | withheld | rule 2, a value the server env names as a Discord token |
| B14 | codex | bypass | session | — | `DISCORD_TOKEN={D}` | `DISCORD_TOKEN={D}` | — | `DISCORD_TOKEN` | kept | rule 6, the same as an inherited kept variable |
| C1 | claude | bypass | session | — | `PAPERCLIP_API_KEY={P}` | — | — | `PAPERCLIP_API_KEY` | withheld | rule 4, Discord sessions included |
| C2 | claude | bypass | session | — | `PAPERCLIP_API_KEY={P}; EM_PAPERCLIP_API_KEY={P}` | — | — | `EM_PAPERCLIP_API_KEY` | withheld | rule 4, the connector key under a second name |
| C3 | claude | bypass | session | — | `PO_PAPERCLIP_API_KEY={Q}` | — | — | `PO_PAPERCLIP_API_KEY` | kept | another board's key is not this bot's connector |
| C4 | claude | bypass | parity | — | `PO_PAPERCLIP_API_KEY={Q}` | — | — | `PO_PAPERCLIP_API_KEY` | withheld | rule 3 |
| C5 | claude | bypass | parity | `ALIAS` | `EM_PAPERCLIP_API_KEY={Q}; ALIAS={Q}` | — | — | `ALIAS` | withheld | round 4 S1: a Paperclip alias survived the parity scrub |
| C6 | codex | bypass | parity | `ALIAS` | `EM_PAPERCLIP_API_KEY={Q}; ALIAS={Q}` | — | — | `ALIAS` | withheld | round 4 S1, on Codex |
| C7 | claude | bypass | board | — | `PO_PAPERCLIP_API_KEY={Q}; BOARD_AUTH=Bearer {Q}` | — | — | `BOARD_AUTH` | withheld | rule 3, a carrier on a narrow board |
| C8 | codex | bypass | session | — | `BOT_SURFACES=discord; PAPERCLIP_URL=https://board.example.com; PAPERCLIP_EXTRA_BOARDS=[{"id":"acme","url":"https://acme.example.com","keyEnv":"ACME_BOARD_KEY"}]; ACME_BOARD_KEY={A}` | — | — | `ACME_BOARD_KEY` | withheld | round 2: boards off, keys still scrubbed |
| C9 | codex | bypass | session | — | `BOT_SURFACES=discord; PAPERCLIP_EXTRA_BOARDS=[{"id":"two","url":"https://two.example.com","keyEnv":"BOARD_TWO"}]; BOARD_TWO={A}` | — | — | `BOARD_TWO` | withheld | a key variable with no credential name |
| C10 | codex | bypass | session | — | `PAPERCLIP_API_KEY={P}` | `PAPERCLIP_API_KEY={P}` | — | `PAPERCLIP_API_KEY` | hidden | rule 6: the server that names it gets it |
| C11 | codex | bypass | parity | — | `PAPERCLIP_API_KEY={P}` | — | `PAPERCLIP_API_KEY` | `PAPERCLIP_RUN_AGENT_KEY` | hidden | the seat key, for the escalate action only |
| C12 | codex | bypass | parity | — | `PAPERCLIP_API_KEY={P}` | — | `PAPERCLIP_API_KEY` | `PAPERCLIP_API_KEY` | withheld | rule 4 |
| C13 | codex | bypass | parity | — | `PAPERCLIP_API_KEY={P}` | — | `PAPERCLIP_API_KEY` | `PAPERCLIP_RUN_ID` | kept | a run id is not a credential |
| C14 | codex | bypass | board | — | `PAPERCLIP_API_KEY={P}` | — | `PAPERCLIP_API_KEY` | `PAPERCLIP_RUN_AGENT_KEY` | withheld | no server channel on a narrow run |
| C15 | codex | restricted | parity | — | `PAPERCLIP_API_KEY={P}` | — | `PAPERCLIP_API_KEY` | `PAPERCLIP_RUN_AGENT_KEY` | withheld | no server channel outside bypass |
| C16 | codex | bypass | parity | — | `PO_PAPERCLIP_API_KEY={Q}` | `BOARD_KEY={Q}` | — | `BOARD_KEY` | hidden | rule 6: a server's Paperclip key |
| C17 | codex | bypass | parity | — | `PO_PAPERCLIP_API_KEY={Q}` | `BOARD_KEY={Q}` | — | `PO_PAPERCLIP_API_KEY` | withheld | rule 3 |
| D1 | codex | bypass | session | `NOVA_BEARER` | `BOT_MAIL_ALLOWED_RECIPIENTS=owner@example.com` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | kept | round 1: a list never drops policy |
| D2 | codex | bypass | session | `NOVA_BEARER` | `BOT_CALENDAR_NO_ATTENDEES=true` | — | — | `BOT_CALENDAR_NO_ATTENDEES` | kept | round 1 |
| D3 | claude | bypass | session | `NOVA_BEARER` | `BOT_LAND_PATHS=notes/**` | — | — | `BOT_LAND_PATHS` | kept | round 1 |
| D4 | codex | bypass | session | `NOVA_BEARER` | `GIT_AUTHOR_NAME=bot` | — | — | `GIT_AUTHOR_NAME` | kept | commit identity is policy |
| D5 | codex | bypass | session | `NOVA_BEARER` | `EM_GITHUB_TOKEN={G}` | — | — | `EM_GITHUB_TOKEN` | withheld | rule 1 |
| D6 | codex | bypass | session | `NOVA_*` | `NOVA_ROUTER_BEARER={N}` | — | — | `NOVA_ROUTER_BEARER` | hidden | round 3: a prefix entry |
| D7 | codex | bypass | session | `NOVA_AUTH` | `NOVA_AUTH={N}` | — | — | `NOVA_AUTH` | hidden | round 3: an exact AUTH name |
| D8 | codex | bypass | session | `NOVA_*` | `NOVA_URL=https://router.example` | — | — | `NOVA_URL` | kept | not a credential |
| D9 | codex | bypass | session | `NOVA_*` | `EM_GITHUB_TOKEN={G}; NOVA_URL=https://r/?b={G}` | — | — | `NOVA_URL` | hidden | rule 7: a listed variable holding an unlisted credential |
| D10 | claude | bypass | session | `NOVA_AUTH` | `NOVA_AUTH={N}` | — | — | `NOVA_AUTH` | kept | Claude cannot hide |
| D11 | codex | bypass | session | `SIGNING_KEY_DIR` | `SIGNING_KEY_DIR={K}; PATH=/usr/bin:{K}` | — | — | `PATH` | kept | rule 9 |
| D12 | codex | bypass | session | `SIGNING_KEY_DIR` | `SIGNING_KEY_DIR={K}; PATH=/usr/bin:{K}` | — | — | `SIGNING_KEY_DIR` | hidden | rule 7 |
| D13 | codex | bypass | session | `NOVA_BEARER` | `GIT_AUTHOR_TOKEN={G}` | — | — | `GIT_AUTHOR_TOKEN` | withheld | a credential under a policy prefix is a credential |
| D14 | codex | bypass | session | `NOVA_BEARER,GIT_AUTHOR_TOKEN` | `GIT_AUTHOR_TOKEN={G}` | — | — | `GIT_AUTHOR_TOKEN` | hidden | rule 7 |
| D15 | codex | bypass | session | `NOVA_BEARER` | `SMTP_AUTH_USER={U}; BOT_MAIL_ALLOWED_RECIPIENTS={U}` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | refused | round 3: rule 8 |
| D16 | claude | bypass | session | `NOVA_BEARER` | `SMTP_AUTH_USER={U}; BOT_MAIL_ALLOWED_RECIPIENTS={U}` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | refused | rule 8, either runtime |
| D17 | codex | bypass | session | `NOVA_BEARER,SMTP_AUTH_USER` | `SMTP_AUTH_USER={U}; BOT_MAIL_ALLOWED_RECIPIENTS={U}` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | refused | rule 8, listing it does not help |
| D18 | codex | bypass | session | — | `SMTP_AUTH_USER={U}; BOT_MAIL_ALLOWED_RECIPIENTS={U}` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | kept | unset: nothing is kept from commands, nothing to refuse |
| D19 | codex | bypass | session | `NOVA_BEARER` | `SMTP_AUTH_USER={U}; BOT_MAIL_ALLOWED_RECIPIENTS=a@example.com,{U}` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | refused | rule 8, a substring |
| D20 | codex | bypass | session | `NOVA_BEARER` | `RETRY_AUTH=3; BOT_MAX_WAKE_ATTEMPTS=3` | — | — | `BOT_MAX_WAKE_ATTEMPTS` | kept | a value under 6 characters is not matched |
| D21 | codex | bypass | session | `*` | — | — | — | `BOT_RUN_ENV` | refused | a bare `*` would keep everything |
| D22 | claude | bypass | parity | — | `DISCORD_TOKEN={D}; BOT_MAIL_SUBJECT_PREFIX={D}` | — | — | `BOT_MAIL_SUBJECT_PREFIX` | refused | rule 8 under unset: a policy setting holding a Discord token |
| D23 | codex | bypass | parity | — | `XDG_DISCORD_TOKEN={D}` | — | — | `XDG_DISCORD_TOKEN` | withheld | round 5 R42: a Discord credential under a basic's prefix is not a basic (rule 2) |
| D24 | claude | bypass | parity | — | `XDG_PAPERCLIP_KEY={Q}` | — | — | `XDG_PAPERCLIP_KEY` | withheld | round 5 R43: a Paperclip credential under a basic's prefix (rule 3) |
| D25 | claude | bypass | session | — | `PAPERCLIP_EXTRA_BOARDS=[{"id":"two","url":"https://two.example.com","keyEnv":"XDG_BOARD"}]; XDG_BOARD={A}` | — | — | `XDG_BOARD` | refused | round 5 R44: rule 12, a board's key named as a basic |
| D26 | claude | bypass | session | — | `PAPERCLIP_EXTRA_BOARDS=[{"id":"two","url":"https://two.example.com","keyEnv":"BOT_MAIL_ALLOWED_RECIPIENTS"}]; BOT_MAIL_ALLOWED_RECIPIENTS={A}` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | refused | round 5 R45: rule 12, a board's key named as a policy setting |
| D27 | claude | bypass | session | — | `PAPERCLIP_EXTRA_BOARDS=[{"id":"two","url":"https://two.example.com","keyEnv":"BOT_STATE_DIR"}]; BOT_STATE_DIR=/srv/private-state` | — | — | `BOT_STATE_DIR` | refused | round 5 R46: rule 12, a board's key named as a published path |
| D28 | codex | bypass | parity | — | `XDG_DISCORD_TOKEN={D}; XDG_CACHE_HOME=/srv/cache` | — | — | `XDG_CACHE_HOME` | kept | a basic that holds no credential is still a basic |
| D29 | codex | bypass | session | `XDG_API_KEY` | `XDG_API_KEY={K}` | — | — | `XDG_API_KEY` | hidden | round 5 R41: rule 7, a listed credential under a basic's prefix |
| D30 | codex | bypass | session | `LC_*` | `LC_API_KEY={K}` | — | — | `LC_API_KEY` | hidden | round 5 R127: rule 7, under the locale prefix |
| D31 | codex | bypass | session | `NOVA_BEARER` | `XDG_API_KEY={K}` | — | — | `XDG_API_KEY` | withheld | rule 1: a credential under a basic's prefix is withheld unless listed |
| D32 | claude | bypass | session | — | `PAPERCLIP_EXTRA_BOARDS=[{"id":"two","url":"https://two.example.com","keyEnv":"BOARD_TWO"}]; BOARD_TWO={A}; BOT_MAIL_ALLOWED_RECIPIENTS=owner@example.com` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | kept | rule 12 refuses a collision only |
| E1 | codex | bypass | session | `ROUTER_BEARER` | `ROUTER_BEARER={R}` | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | hidden | round 4 S1: an inline server value over a listed name |
| E2 | codex | bypass | session | `ROUTER_*` | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | hidden | round 4 S1: inline, under a prefix, never inherited |
| E3 | codex | bypass | session | `ROUTER_BEARER` | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `ROUTER_BEARER` | hidden | round 4 S1: `ROUTER_BEARER=${NOVA_BEARER}` |
| E4 | codex | bypass | session | `ROUTER_*` | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `ROUTER_BEARER` | hidden | round 4 S1: renamed, under a prefix |
| E5 | codex | bypass | session | `ROUTER_BEARER` | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `NOVA_BEARER` | withheld | rule 1 |
| E6 | codex | bypass | session | — | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | hidden | rule 6 under unset |
| E7 | codex | bypass | session | — | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `ROUTER_BEARER` | hidden | rule 6 |
| E8 | codex | bypass | session | — | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `NOVA_BEARER` | kept | unset: the shell already holds it, a server naming it changes nothing |
| E9 | codex | bypass | session | — | `GH_TOKEN={G}` | `GH_TOKEN={G}` | — | `GH_TOKEN` | kept | rule 6: same name and value as a kept variable |
| E10 | codex | bypass | session | — | `GH_TOKEN={G}` | `GITHUB_TOKEN={G}` | — | `GITHUB_TOKEN` | hidden | rule 6 |
| E11 | codex | bypass | session | — | — | `ROUTER_URL=https://router.example` | — | `ROUTER_URL` | hidden | rule 6: a server-only value |
| E12 | codex | bypass | parity | `ROUTER_BEARER` | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | hidden | round 4 S1, parity |
| E13 | codex | bypass | session | `NOVA_BEARER` | `NOVA_BEARER={N}` | `ROUTER=prefix-{N}` | — | `ROUTER` | hidden | rule 6, a substring |
| E14 | codex | bypass | session | — | `RELAY_HEADER=Bearer {X}` | `ROUTER_BEARER={X}` | — | `RELAY_HEADER` | hidden | rule 6: a server-only credential carried by an inherited variable |
| E15 | codex | bypass | session | — | `BOT_MAIL_ALLOWED_RECIPIENTS={U}` | `SMTP_PASS={U}` | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | refused | rule 8: a policy setting holding a server-only credential |
| E16 | codex | bypass | session | — | `BOT_LAND_PATHS=notes/**` | `BOT_LAND_PATHS=**` | — | `BOT_LAND_PATHS` | refused | rule 10 |
| E17 | codex | bypass | session | — | `PATH=/usr/bin` | `PATH=/opt/node/bin:/usr/bin` | — | `PATH` | kept | rule 9: a basic is never hidden |
| E18 | codex | restricted | session | — | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | withheld | no server channel outside bypass |
| E19 | codex | bypass | board | — | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | withheld | no server channel on a narrow board |
| E20 | codex | bypass | session | `XDG_*` | `XDG_API_KEY={T}` | `XDG_API_KEY={S}` | — | `XDG_API_KEY` | hidden | round 5 R48: a server's credential under a basic's prefix is not a basic (rule 6) |
| E21 | codex | bypass | session | — | — | `XDG_API_KEY={S}` | — | `XDG_API_KEY` | hidden | round 5 R47: rule 6 |
| F1 | claude | bypass | board | — | — | — | — | `BOT_SUMMARIES_DIR` | withheld | rule 5: private Discord memory |
| F2 | claude | bypass | parity | — | — | — | — | `BOT_SUMMARIES_DIR` | kept | a parity run is the Discord session |
| F3 | claude | bypass | board | — | — | — | — | `BOT_STATE_DIR` | kept | a board setting |
| F4 | claude | bypass | board | — | `MCP_CONFIG=/srv/mcp.json` | — | — | `MCP_CONFIG` | withheld | rule 5 |
| F5 | claude | bypass | board | — | `BOT_SETTINGS={"env":{"X":"y"}}` | — | — | `BOT_SETTINGS` | withheld | rule 5 |
| F6 | claude | bypass | parity | — | `MCP_CONFIG=/srv/mcp.json` | — | — | `MCP_CONFIG` | kept | a parity run is the Discord session |
| F7 | claude | bypass | board | — | `PAPERCLIP_URL=https://board.example.com` | — | — | `PAPERCLIP_URL` | withheld | rule 5 |
| F8 | claude | bypass | board | — | — | — | — | `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | kept | the board run's flag |
| F9 | claude | restricted | session | — | — | — | — | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | kept | the restricted run's flag |
| F10 | claude | bypass | session | — | — | — | — | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | withheld | not a bypass session's |
| F11 | claude | bypass | session | — | `CLAUDECODE=1` | — | — | `CLAUDECODE` | withheld | nesting |
| F12 | claude | bypass | board | — | `DISCORD_TOKEN={D}; HOME=/home/{D}` | — | — | `HOME` | refused | rule 9 |
| F13 | claude | bypass | session | — | `DISCORD_TOKEN={D}; HOME=/home/{D}` | — | — | `HOME` | kept | rule 9: the session may hold it |
| G1 | codex | bypass | session | — | `NOVA_BEARER={N}` | `@router=--bearer={N}` | — | `NOVA_BEARER` | refused | rule 11: `args: ["--bearer=${NOVA_BEARER}"]` |
| G2 | codex | bypass | parity | — | `DISCORD_TOKEN={D}` | `@relay=--token={D}` | — | `DISCORD_TOKEN` | refused | rule 11 on a parity run |
| G3 | codex | bypass | session | — | — | `ROUTER_BEARER={X}; @router=--auth={X}` | — | `ROUTER_BEARER` | refused | rule 11: a server-only credential |
| G4 | codex | bypass | session | — | `NOVA_URL=https://router.example` | `@router=--url=https://router.example` | — | `NOVA_URL` | kept | rule 11: not a credential |
| G5 | codex | bypass | board | — | `NOVA_BEARER={N}` | `@router=--bearer={N}` | — | `NOVA_BEARER` | hidden | rule 11: a narrow run is passed no server |
| G6 | claude | bypass | session | — | `NOVA_BEARER={N}` | `@router=--bearer={N}` | — | `NOVA_BEARER` | kept | rule 11 is the server channel's: Claude expands a server's `${VAR}` itself |
