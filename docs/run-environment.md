# The run environment

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
| 3 | **Server channel** — the MCP servers' env (`MCP_CONFIG`, `MCP_CONFIG_EXTRA`, the repo's `.mcp.json`, read once at startup with `${VAR}` expanded against the bot's whole environment and inline values as written; the `${VAR}`s a server's command line expands are checked under rule 11), and the seat key `PAPERCLIP_RUN_AGENT_KEY` with `PAPERCLIP_RUN_ID` for a board task | Codex in `bypass`, session or parity run only |
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
even when `DISCORD_TOKEN` itself was never inherited. Value matching
decides only rules 2–4 (a class withheld outright) and rules 8 and 9 (a
setting that is never dropped). A listed variable is never hidden for a value
it holds (rule 7).

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

**What hiding is.** On a Codex `bypass` session or parity run a command runs
as the bot's own user with no sandbox: it can read the environment of the
processes above it under `/proc` and the operator's MCP config file. Hiding a
variable from such a command guards against accidents; it is not
containment. So these rules are deterministic — a selected variable is decided
by its name and the shape of its value, never by comparing its value with
another variable's — and the builder does not try to find every place a
credential's value has been copied. Value matching is kept only where a class
is withheld outright (rules 2–4) and for the settings that are never dropped
(rules 8, 9).

Evaluated over the final environment, for each variable:

1. **`BOT_RUN_ENV` set**: it lists exact variable names, comma-separated. A
   variable that is not listed, not an operating basic (`PATH`, `HOME`,
   locale, `TMPDIR`, `XDG_*`, `CODEX_HOME`…) and not a harness policy setting
   (the mail, calendar and landing gates, the BOT_* paths, commit identity…)
   is **withheld**. A `*` or a `NAME_*` entry, and the names `__proto__`,
   `constructor` and `prototype`, **refuse** the configuration: a prefix would
   select variables its operator never saw. Unset, everything is inherited,
   as before. A credential under a basic's prefix (`XDG_API_KEY`) is not a
   basic, so it is withheld unless listed.
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
6. A variable the **server channel** writes is **hidden** — an inherited one
   of the same name and another value included — unless it is an operating
   basic, a listed variable rule 7 keeps, or the same name and the same value
   as an inherited variable that would be **kept**. That last is a fact about
   one name, not a search for copies: a different name holding the value is
   never looked for.
7. **`BOT_RUN_ENV` set, Codex `bypass` session or parity run**: a listed
   variable that is not an operating basic or a harness policy setting is
   **hidden** when its name is a credential's, **kept** when its whole value
   is a single absolute path (`GH_CONFIG_DIR=/home/bot/.config/gh`: a leading
   `/`, then letters, digits and `. _ - ~ @ + /` only), and **hidden**
   otherwise. Its value is never compared with any other variable's. On
   Claude a listed variable is kept: Claude cannot hide.
8. A **harness policy setting** (or a harness path) that holds a credential a
   command must not see — a rule 2–4 identity, any credential identity under
   `BOT_RUN_ENV`, or a whole value the server channel writes and hides —
   **refuses** the configuration. It can neither be dropped (the mail and
   calendar gates allow everything when their variable is unset) nor kept (it
   would hand the credential to every command).
9. An **operating basic** is never hidden for what it holds (a credential
   naming a folder on `PATH` must not take `PATH` away), and **refuses** the
   configuration when it holds a rule 2–4 identity or a whole value the server
   channel writes and hides.
   Under rules 8 and 9 a server value counts when it is at least 6 characters
   and either has a credential name or is not a single absolute path.
10. A server-channel variable that would replace a harness policy setting with
    another value **refuses** the configuration.
11. An MCP server's **command line** (its `command`, `args` or `cwd`) may
    expand `${VAR}` or `${VAR:-default}` only when `VAR` is **kept** for that
    run's commands; any other expansion **refuses** the configuration, naming
    the server and the variable. The harness writes those into Codex's own
    arguments, and a process's arguments are readable by every process on the
    host (`ps`). A server takes a credential through its `env`. A `VAR` that
    is unset expands to its default, a literal — see *Not covered*.
12. A board's key variable (the connector key, a `keyEnv` in
    `PAPERCLIP_EXTRA_BOARDS`) named as a harness policy setting, a path or
    flag the harness publishes, or an operating basic **refuses** the
    configuration. Rule 4 withholds the key from every run and the setting
    must be kept, so no outcome holds both: withheld, the gate or path is
    gone; kept, every command reads the key.
13. A rule 2–4 identity whose value is shorter than 6 characters **refuses**
    the configuration on every run that withholds it: too short to be matched
    by value, a copy of it under another name could not be withheld.
14. With board tasks running, a `BOT_SETTINGS` that carries an `env` block
    **refuses** startup. The runtime applies that block after this builder,
    so no rule here reaches it, and a parity run would hand it to every
    command. (A narrow board run drops the bot's settings env already.)
15. If clamping a Codex run's arguments to the kernel's limit would cut its
    shell policy (`shell_environment_policy`), the run is **refused** before
    it spawns: a cut exclusion list would let commands read what it hides.

`shellExclude` is every hidden name, plus the connector key names and the seat
key name whether present or not.

## Not covered

- **The summarizer** (`lib/summarize-core.js`) is not a reply run: on Claude it
  has `Read` only and no shell; on Codex it runs narrow, with only the core
  variables. It does not use this builder.
- **An ancestor's environment.** On a run with no sandbox (a bypass session
  or a parity run, either runtime) a command can read the environment file
  under `/proc` of the processes above it — the runtime's and the bot's own —
  as the same user, and the operator's MCP config file. What this page
  withholds or hides is kept out of the child's environment and its shell
  policy, not out of those files. Closing it needs the bot to start without
  the credentials in its own environment, which is outside this builder.
- **A literal credential in the operator's own configuration**: written into
  the MCP config, a settings file, or a server's command line as a value
  rather than a `${VAR}` reference (including a `${VAR:-default}` whose `VAR`
  is unset). The same command can read that file.
- **`BOT_RUN_ENV` unset**: a value that is not a Discord, Paperclip or
  connector identity stays visible to commands, `MCP_CONFIG*` carriers and an
  inherited alias of a server value included. That is how the bot ran before
  this builder; list the run's variables to narrow it.
- **Fragments of a value**: a password inside a URL, or a credential nested in
  a JSON carrier, matched against another variable. Rules 2–4, 8 and 9 match a
  whole identity's value only.
- **The project's own `.claude/settings*.json` env**: the operator's
  configuration, read by the runtime. Rule 14 covers `BOT_SETTINGS` only.
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
`args` as written in its config, split on spaces (command `node`); its
`${VAR}`s are expanded against the process env as the bot expands them
(rule 11).

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
| B9 | codex | bypass | session | `ALIAS` | `DISCORD_TOKEN={D}; ALIAS={D}` | — | — | `ALIAS` | hidden | rule 7: listed, neither a credential name nor a path |
| B10 | codex | bypass | parity | — | `DISCORD_TOKEN={D}; HEADER=Bot {D}` | — | — | `HEADER` | withheld | rule 2, a substring |
| B11 | codex | bypass | parity | — | `DISCORD_TOKEN={D}` | `TOKEN={D}` | — | `TOKEN` | withheld | rule 2, `TOKEN=${DISCORD_TOKEN}` in the server env |
| B12 | codex | bypass | parity | — | — | `DISCORD_TOKEN={D}` | — | `DISCORD_TOKEN` | withheld | rule 2, inline in the server env |
| B13 | codex | bypass | parity | — | `OPS_RELAY={O}` | `DISCORD_TOKEN={O}` | — | `OPS_RELAY` | withheld | rule 2, a value the server env names as a Discord token |
| B14 | codex | bypass | session | — | `DISCORD_TOKEN={D}` | `DISCORD_TOKEN={D}` | — | `DISCORD_TOKEN` | kept | rule 6: the same name and value as an inherited kept variable |
| C1 | claude | bypass | session | — | `PAPERCLIP_API_KEY={P}` | — | — | `PAPERCLIP_API_KEY` | withheld | rule 4, Discord sessions included |
| C2 | claude | bypass | session | — | `PAPERCLIP_API_KEY={P}; EM_PAPERCLIP_API_KEY={P}` | — | — | `EM_PAPERCLIP_API_KEY` | withheld | rule 4, the connector key under a second name |
| C3 | claude | bypass | session | — | `PO_PAPERCLIP_API_KEY={Q}` | — | — | `PO_PAPERCLIP_API_KEY` | kept | another board's key is not this bot's connector |
| C4 | claude | bypass | parity | — | `PO_PAPERCLIP_API_KEY={Q}` | — | — | `PO_PAPERCLIP_API_KEY` | withheld | rule 3 |
| C5 | claude | bypass | parity | `ALIAS` | `EM_PAPERCLIP_API_KEY={Q}; ALIAS={Q}` | — | — | `ALIAS` | withheld | round 4 S1: a Paperclip alias survived the parity scrub |
| C6 | codex | bypass | parity | `ALIAS` | `EM_PAPERCLIP_API_KEY={Q}; ALIAS={Q}` | — | — | `ALIAS` | withheld | round 4 S1, on Codex |
| C7 | claude | bypass | board | — | `PO_PAPERCLIP_API_KEY={Q}; BOARD_AUTH=Bearer {Q}` | — | — | `BOARD_AUTH` | withheld | rule 3, a carrier on a narrow board |
| C8 | codex | bypass | session | — | `BOT_SURFACES=discord; PAPERCLIP_URL=https://board.example.com; PAPERCLIP_EXTRA_BOARDS=[{"id":"acme","url":"https://acme.example.com","keyEnv":"ACME_BOARD_KEY"}]; ACME_BOARD_KEY={A}` | — | — | `ACME_BOARD_KEY` | withheld | round 2: boards off, keys still scrubbed |
| C9 | codex | bypass | session | — | `BOT_SURFACES=discord; PAPERCLIP_EXTRA_BOARDS=[{"id":"two","url":"https://two.example.com","keyEnv":"BOARD_TWO"}]; BOARD_TWO={A}` | — | — | `BOARD_TWO` | withheld | a key variable with no credential name |
| C10 | codex | bypass | session | — | `PAPERCLIP_API_KEY={P}` | `PAPERCLIP_API_KEY={P}` | — | `PAPERCLIP_API_KEY` | hidden | rule 6: the inherited one is withheld (rule 4), so the server's is hidden |
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
| D6 | codex | bypass | session | `NOVA_*` | `NOVA_ROUTER_BEARER={N}` | — | — | `BOT_RUN_ENV` | refused | rule 1: a prefix entry is refused, never expanded (round 6 R6, R40) |
| D7 | codex | bypass | session | `NOVA_AUTH` | `NOVA_AUTH={N}` | — | — | `NOVA_AUTH` | hidden | round 3, rule 7: an exact AUTH name |
| D8 | codex | bypass | session | `NOVA_URL` | `NOVA_URL=https://router.example` | — | — | `NOVA_URL` | hidden | rule 7: listed, not a credential name, not a path |
| D9 | codex | bypass | session | `NOVA_DIR` | `EM_GITHUB_TOKEN={G}; NOVA_DIR=/srv/{G}` | — | — | `NOVA_DIR` | kept | rule 7: a listed path is kept; what its value holds is never looked for |
| D10 | claude | bypass | session | `NOVA_AUTH` | `NOVA_AUTH={N}` | — | — | `NOVA_AUTH` | kept | Claude cannot hide |
| D11 | codex | bypass | session | `SIGNING_KEY_DIR` | `SIGNING_KEY_DIR={K}; PATH=/usr/bin:{K}` | — | — | `PATH` | kept | rule 9 |
| D12 | codex | bypass | session | `SIGNING_KEY_DIR` | `SIGNING_KEY_DIR={K}; PATH=/usr/bin:{K}` | — | — | `SIGNING_KEY_DIR` | hidden | rule 7: a credential name |
| D13 | codex | bypass | session | `NOVA_BEARER` | `GIT_AUTHOR_TOKEN={G}` | — | — | `GIT_AUTHOR_TOKEN` | withheld | a credential under a policy prefix is a credential |
| D14 | codex | bypass | session | `NOVA_BEARER,GIT_AUTHOR_TOKEN` | `GIT_AUTHOR_TOKEN={G}` | — | — | `GIT_AUTHOR_TOKEN` | hidden | rule 7: a credential under a policy prefix |
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
| D30 | codex | bypass | session | `LC_API_KEY` | `LC_API_KEY={K}` | — | — | `LC_API_KEY` | hidden | round 5 R127: rule 7, under the locale prefix, listed by its exact name |
| D31 | codex | bypass | session | `NOVA_BEARER` | `XDG_API_KEY={K}` | — | — | `XDG_API_KEY` | withheld | rule 1: a credential under a basic's prefix is withheld unless listed |
| D32 | claude | bypass | session | — | `PAPERCLIP_EXTRA_BOARDS=[{"id":"two","url":"https://two.example.com","keyEnv":"BOARD_TWO"}]; BOARD_TWO={A}; BOT_MAIL_ALLOWED_RECIPIENTS=owner@example.com` | — | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | kept | rule 12 refuses a collision only |
| D33 | codex | bypass | session | `DATABASE_URL` | `DATABASE_URL=postgres://app:{P}@db.example/app` | — | — | `DATABASE_URL` | hidden | rule 7: listed, a URL is not a path (round 6 R2) |
| D34 | codex | bypass | session | `GH_CONFIG_DIR` | `GH_CONFIG_DIR=/srv/gh` | — | — | `GH_CONFIG_DIR` | kept | rule 7: a listed absolute path |
| D35 | codex | bypass | session | `DATABASE_URL` | `DATABASE_URL=postgres://{P}` | `DATABASE_URL=postgres://{P}` | — | `DATABASE_URL` | hidden | rule 6: the server's same value is no reason to keep it (round 6 R1) |
| D36 | codex | bypass | parity | `NOVA_SLASHBIN_MCP_ROUTER_BEARER,GH_CONFIG_DIR,DOPPLER_CONFIG_DIR` | `NOVA_SLASHBIN_MCP_ROUTER_BEARER={N}; GH_CONFIG_DIR=/home/bot/.config/gh; DOPPLER_CONFIG_DIR=/home/bot/.doppler` | — | — | `NOVA_SLASHBIN_MCP_ROUTER_BEARER` | hidden | a parity bot's list: the bearer |
| D37 | codex | bypass | parity | `NOVA_SLASHBIN_MCP_ROUTER_BEARER,GH_CONFIG_DIR,DOPPLER_CONFIG_DIR` | `NOVA_SLASHBIN_MCP_ROUTER_BEARER={N}; GH_CONFIG_DIR=/home/bot/.config/gh; DOPPLER_CONFIG_DIR=/home/bot/.doppler` | — | — | `GH_CONFIG_DIR` | kept | a parity bot's list: a path |
| D38 | codex | bypass | parity | `NOVA_SLASHBIN_MCP_ROUTER_BEARER,GH_CONFIG_DIR,DOPPLER_CONFIG_DIR` | `NOVA_SLASHBIN_MCP_ROUTER_BEARER={N}; GH_CONFIG_DIR=/home/bot/.config/gh; DOPPLER_CONFIG_DIR=/home/bot/.doppler` | — | — | `DOPPLER_CONFIG_DIR` | kept | a parity bot's list: a path |
| D39 | claude | bypass | session | `__proto__` | — | — | — | `BOT_RUN_ENV` | refused | rule 1: a name objects reserve (round 6 R21) |
| D40 | codex | bypass | session | `NOVA_BEARER,constructor` | — | — | — | `BOT_RUN_ENV` | refused | rule 1 |
| D41 | codex | bypass | parity | `prototype` | — | — | — | `BOT_RUN_ENV` | refused | rule 1 |
| D42 | codex | bypass | parity | — | `DISCORD_TOKEN=abc` | — | — | `DISCORD_TOKEN` | refused | rule 13: a Discord token too short to match by value (round 6 R14) |
| D43 | claude | bypass | session | — | `PAPERCLIP_API_KEY=k1` | — | — | `PAPERCLIP_API_KEY` | refused | rule 13: a connector key, on every run (round 6 R15) |
| D44 | claude | bypass | session | — | `DISCORD_TOKEN=abc` | — | — | `DISCORD_TOKEN` | kept | rule 13: a session keeps its Discord token, so it need not match |
| D45 | codex | bypass | session | — | `XDG_CACHE_HOME=/srv/cache-{S}` | `SMTP_PASSWORD={S}` | — | `XDG_CACHE_HOME` | refused | rule 9: a basic holding a whole server value (round 6 R17) |
| D46 | codex | bypass | session | — | `XDG_CONFIG_HOME=/srv/cfg` | `ROUTER_DIR=/srv/cfg` | — | `XDG_CONFIG_HOME` | kept | rule 9: a server path is not a credential |
| D47 | codex | bypass | parity | `NOVA_BEARER` | `NOVA_BEARER={N}; BOT_MAIL_SUBJECT_PREFIX=[ops]` | `ROUTER_URL=https://router.example` | — | `BOT_MAIL_SUBJECT_PREFIX` | kept | rule 8 refuses a whole server value only |
| E1 | codex | bypass | session | `ROUTER_BEARER` | `ROUTER_BEARER={R}` | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | hidden | round 4 S1: an inline server value over a listed name |
| E2 | codex | bypass | session | `ROUTER_BEARER` | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | hidden | round 4 S1: inline, listed, never inherited |
| E3 | codex | bypass | session | `ROUTER_BEARER` | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `ROUTER_BEARER` | hidden | round 4 S1: `ROUTER_BEARER=${NOVA_BEARER}` |
| E4 | codex | bypass | session | `ROUTER_DIR` | — | `ROUTER_DIR=/srv/router` | — | `ROUTER_DIR` | kept | rules 6, 7: a listed path the server writes |
| E5 | codex | bypass | session | `ROUTER_BEARER` | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `NOVA_BEARER` | withheld | rule 1 |
| E6 | codex | bypass | session | — | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | hidden | rule 6 under unset |
| E7 | codex | bypass | session | — | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `ROUTER_BEARER` | hidden | rule 6 |
| E8 | codex | bypass | session | — | `NOVA_BEARER={N}` | `ROUTER_BEARER={N}` | — | `NOVA_BEARER` | kept | unset: the shell already holds it, a server naming it changes nothing |
| E9 | codex | bypass | session | — | `GH_TOKEN={G}` | `GH_TOKEN={G}` | — | `GH_TOKEN` | kept | rule 6: the same name and value as an inherited kept variable |
| E10 | codex | bypass | session | — | `GH_TOKEN={G}` | `GITHUB_TOKEN={G}` | — | `GITHUB_TOKEN` | hidden | rule 6 |
| E11 | codex | bypass | session | — | — | `ROUTER_URL=https://router.example` | — | `ROUTER_URL` | hidden | rule 6: a server-only value |
| E12 | codex | bypass | parity | `ROUTER_BEARER` | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | hidden | round 4 S1, parity |
| E13 | codex | bypass | session | `NOVA_BEARER` | `NOVA_BEARER={N}` | `ROUTER=prefix-{N}` | — | `ROUTER` | hidden | rule 6 |
| E14 | codex | bypass | session | — | `RELAY_HEADER=Bearer {X}` | `ROUTER_BEARER={X}` | — | `RELAY_HEADER` | kept | *Not covered*: unset, an inherited alias of a server value is not looked for (round 6 R10) |
| E15 | codex | bypass | session | — | `BOT_MAIL_ALLOWED_RECIPIENTS={U}` | `SMTP_PASS={U}` | — | `BOT_MAIL_ALLOWED_RECIPIENTS` | refused | rule 8: a policy setting holding a whole server value |
| E16 | codex | bypass | session | — | `BOT_LAND_PATHS=notes/**` | `BOT_LAND_PATHS=**` | — | `BOT_LAND_PATHS` | refused | rule 10 |
| E17 | codex | bypass | session | — | `PATH=/usr/bin` | `PATH=/opt/node/bin:/usr/bin` | — | `PATH` | kept | rule 9: a basic is never hidden |
| E18 | codex | restricted | session | — | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | withheld | no server channel outside bypass |
| E19 | codex | bypass | board | — | — | `ROUTER_BEARER={X}` | — | `ROUTER_BEARER` | withheld | no server channel on a narrow board |
| E20 | codex | bypass | session | `XDG_API_KEY` | `XDG_API_KEY={T}` | `XDG_API_KEY={S}` | — | `XDG_API_KEY` | hidden | round 5 R48: a server's credential under a basic's prefix is not a basic (rule 6) |
| E21 | codex | bypass | session | — | — | `XDG_API_KEY={S}` | — | `XDG_API_KEY` | hidden | round 5 R47: rule 6 |
| F1 | claude | bypass | board | — | — | — | — | `BOT_SUMMARIES_DIR` | withheld | rule 5: private Discord memory |
| F2 | claude | bypass | parity | — | — | — | — | `BOT_SUMMARIES_DIR` | kept | a parity run is the Discord session |
| F3 | claude | bypass | board | — | — | — | — | `BOT_STATE_DIR` | kept | a board setting |
| F4 | claude | bypass | board | — | `MCP_CONFIG=/srv/mcp.json` | — | — | `MCP_CONFIG` | withheld | rule 5 |
| F5 | claude | bypass | board | — | `BOT_SETTINGS=/srv/settings.json` | — | — | `BOT_SETTINGS` | withheld | rule 5 |
| F6 | claude | bypass | parity | — | `MCP_CONFIG=/srv/mcp.json` | — | — | `MCP_CONFIG` | kept | a parity run is the Discord session |
| F7 | claude | bypass | board | — | `PAPERCLIP_URL=https://board.example.com` | — | — | `PAPERCLIP_URL` | withheld | rule 5 |
| F8 | claude | bypass | board | — | — | — | — | `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | kept | the board run's flag |
| F9 | claude | restricted | session | — | — | — | — | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | kept | the restricted run's flag |
| F10 | claude | bypass | session | — | — | — | — | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | withheld | not a bypass session's |
| F11 | claude | bypass | session | — | `CLAUDECODE=1` | — | — | `CLAUDECODE` | withheld | nesting |
| F12 | claude | bypass | board | — | `DISCORD_TOKEN={D}; HOME=/home/{D}` | — | — | `HOME` | refused | rule 9 |
| F13 | claude | bypass | session | — | `DISCORD_TOKEN={D}; HOME=/home/{D}` | — | — | `HOME` | kept | rule 9: the session may hold it |
| F14 | claude | bypass | parity | — | `BOT_SETTINGS={"env":{"X":"y"}}` | — | — | `BOT_SETTINGS` | refused | rule 14: a settings env block with board tasks (round 6 R18) |
| F15 | codex | bypass | board | — | `BOT_SETTINGS={"env":{"X":"y"}}` | — | — | `BOT_SETTINGS` | refused | rule 14, either runtime |
| F16 | claude | bypass | session | — | `BOT_SETTINGS={"env":{"X":"y"}}` | — | — | `BOT_SETTINGS` | kept | rule 14 is a board task's: startup refuses through the bot's parity or board run |
| F17 | claude | bypass | parity | — | `BOT_SETTINGS={"sandbox":{"enabled":true}}` | — | — | `BOT_SETTINGS` | kept | rule 14: settings without an env block |
| G1 | codex | bypass | session | `NOVA_BEARER` | `NOVA_BEARER={N}` | `@router=--bearer=${NOVA_BEARER}` | — | `NOVA_BEARER` | refused | rule 11: a listed credential is hidden, so no command line may expand it (round 6 R5) |
| G2 | codex | bypass | parity | — | `DISCORD_TOKEN={D}` | `@relay=--token=${DISCORD_TOKEN}` | — | `DISCORD_TOKEN` | refused | rule 11 on a parity run: a withheld variable |
| G3 | codex | bypass | session | — | — | `ROUTER_BEARER={X}; @router=--auth={X}` | — | `ROUTER_BEARER` | hidden | *Not covered*: a literal in the operator's config is not looked for (round 6 R26) |
| G4 | codex | bypass | session | — | `NOVA_URL=https://router.example` | `@router=--url=${NOVA_URL}` | — | `NOVA_URL` | kept | rule 11: a kept variable may be expanded |
| G5 | codex | bypass | board | — | `NOVA_BEARER={N}` | `@router=--bearer=${NOVA_BEARER}` | — | `NOVA_BEARER` | hidden | rule 11: a narrow run is passed no server |
| G6 | claude | bypass | session | `NOVA_BEARER` | `NOVA_BEARER={N}` | `@router=--bearer=${NOVA_BEARER}` | — | `NOVA_BEARER` | kept | rule 11 is the server channel's: Claude expands a server's `${VAR}` itself |
| G7 | codex | bypass | session | `GH_CONFIG_DIR` | `GH_CONFIG_DIR=/srv/gh` | `@gh=--config=${GH_CONFIG_DIR}` | — | `GH_CONFIG_DIR` | kept | rule 11: a listed path is kept, so it may be expanded |
| G8 | codex | bypass | session | `NOVA_URL` | `NOVA_BEARER={N}; NOVA_URL=/srv/nova` | `@router=--bearer=${NOVA_BEARER:-none}` | — | `NOVA_BEARER` | refused | rule 11: a default does not change what a set variable expands to |
| G9 | codex | bypass | session | `NOVA_URL` | `NOVA_URL=/srv/nova` | `@router=--port=${ROUTER_PORT:-8080}` | — | `ROUTER_PORT` | withheld | rule 11: an unset variable expands to its literal default |
| G10 | codex | bypass | session | — | `GH_TOKEN={G}` | `GH_TOKEN={X}; @gh=--token=${GH_TOKEN}` | — | `GH_TOKEN` | refused | rules 6, 11: the server channel's own value is hidden, so it may not be expanded |
| G11 | codex | bypass | parity | `ROUTER_URL` | `ROUTER_URL=https://router.example` | `@router=--url=${ROUTER_URL}` | — | `ROUTER_URL` | refused | rules 7, 11: a listed URL is hidden, so it may not be expanded |
| G12 | codex | bypass | session | — | `EM_GITHUB_TOKEN={G}` | `@gh=--token=${EM_GITHUB_TOKEN}` | — | `EM_GITHUB_TOKEN` | kept | rule 11 under unset: the commands read it already (*Not covered*) |
| G13 | codex | bypass | session | — | `GH_TOKEN={G}` | `GH_TOKEN={G}; @gh=--token=${GH_TOKEN}` | — | `GH_TOKEN` | kept | rules 6, 11: the same name and value as an inherited kept variable is kept, so it may be expanded |
