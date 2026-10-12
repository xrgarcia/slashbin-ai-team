# Paperclip board execution

A bot with `PAPERCLIP_URL` and `PAPERCLIP_API_KEY` set answers the tasks a
[Paperclip](https://paperclip.ing) board assigns it. `BOT_BOARD_EXECUTION` decides
what such a run may do. Discord behaviour does not change with it, in either mode.

| Mode | A board run gets | Use it for |
|---|---|---|
| `readonly` (default) | `BOT_BOARD_TOOLS` (`Read,Glob,Grep`), confined to `CLAUDE_CWD` | Questions, reviews, status |
| `engineering` | `BOT_BOARD_ENGINEERING_TOOLS` (`Read,Glob,Grep,Edit,Write,Bash`): edit and write in `CLAUDE_CWD` and the write paths, read the read paths, a sandboxed shell reaching only the listed hosts | Tasks that change code: edit, test, `git`, `gh` |

What stays closed in **both** modes: the bot's Discord memory (buffer, summaries,
sessions, uploads, scheduled jobs, the state folder, the outbox), the harness folder
(its `.env`, logs, default state), every settings file, project auto-memory, and the
bot's own credentials (`DISCORD_TOKEN`, `BRIDGE_TOKEN`, Paperclip keys, `BOT_*`,
`MCP_CONFIG*`). `engineering` adds tools and the folders and hosts you name; it never
lifts those.

## Prerequisites

- A board, an agent on it, and that agent's own API key (never one shared with
  another bot, never a board or admin key).
- The agent's command on the board holds its run open until a comment lands, so the
  bot can post under the run (see the README's Paperclip section).
- `CLAUDE_CWD` is the repo board tasks work in — not the harness or state folder,
  nor inside one (the connector stays off otherwise).
- For `engineering`: Claude Code's sandbox on the host — `bwrap` and `socat` on
  Linux. If either lives outside the system folders (`/usr`, `/bin`, `/lib`, `/etc`),
  list its folder in `BOT_BOARD_READ_PATHS`, plus any folder a wrapper script loads
  from.

## Enable

In the bot's environment (`.env`, or its `env` block in `ecosystem.config.js`):

```sh
PAPERCLIP_URL=https://board.example.com
PAPERCLIP_API_KEY=<this agent's key>
BOT_BOARD_EXECUTION=engineering
BOT_BOARD_READ_PATHS=/srv/code/shared-lib          # optional, absolute, comma-separated
BOT_BOARD_WRITE_PATHS=/srv/scratch                 # optional
BOT_BOARD_NETWORK_ALLOW=github.com,api.github.com  # optional; hosts the shell may reach
```

Restart the bot. Rules a setting must meet, or the connector stays off and logs why
(Discord keeps working):

- every path absolute; none of them `/`, the home folder, or inside the bot's state
  or harness folder;
- a read path must not contain `CLAUDE_CWD` or a write path — name the folders beside
  them instead (the sandbox cannot open a writable folder inside a read-only one);
- a host is a plain name such as `github.com` or `*.example.com`;
- none of the bot's Discord memory folders — `BOT_HISTORY_DIR` (summaries),
  `BOT_STATE_DIR`, attachments, outbox — may lie inside `CLAUDE_CWD`. The sandbox
  hides them from the shell by path, but a shell with `git` reads every committed
  copy straight from the repo's history, and sees the folder as deleted, so a
  "commit everything" would remove it. Move the folder out of `CLAUDE_CWD` first;
  if it was ever committed, its history is still readable, so also remove it from
  the repo's history or give board runs a repo that never held it. `readonly` has
  no shell and is unaffected.

## Disable

Remove `BOT_BOARD_EXECUTION` (or set `readonly`) and restart. The other
`BOT_BOARD_*` engineering settings are then ignored. To stop board work entirely,
remove `PAPERCLIP_URL` or `PAPERCLIP_API_KEY`.

## Verify

1. **Startup log.** The bot logs the mode it runs with —
   `Paperclip board runs: engineering — …` or `Paperclip board runs: readonly — …` —
   with the effective tools, paths and hosts as fields. A refused setting logs
   `Paperclip connector off — <reason>` instead.
2. **Doctor.** `npm run doctor:fleet` prints `board runs: <mode>` on each bot's
   Paperclip line, fails on a setting the bot would refuse, and warns when `socat` or
   `bwrap` sits outside the readable folders.
3. **Pickup and return.** Assign the bot a task such as *"add a line to
   NOTES.md in the repo and say what you changed"*.
   - `engineering`: the file changes, the reply lands as a comment, the task is **done**.
   - `readonly`: nothing changes, the reply says it could not, the task is **blocked**.
4. **Isolation.** Assign a task asking it to read the bot's buffer or state folder
   (give the path). In both modes the reply reports it was refused or not found, and
   no Discord content appears in the comment.
5. **Discord.** Message the bot on Discord as usual; the reply is unchanged by the
   mode.

## Outcomes

A run that could not do what was asked ends its reply with
`PAPERCLIP-OUTCOME: blocked`. The bot strips that line, posts the rest as the
comment, and leaves the task **blocked** instead of **done**. A person commenting on a
blocked task reopens it, and the bot picks it up again.

## Symptom → fix

| Symptom | Cause | Fix |
|---|---|---|
| Log: `Paperclip connector off — <reason>` | A `BOT_BOARD_*` value breaks a rule above, or `CLAUDE_CWD` is the harness or state folder |
| Log: `… is the bot's Discord memory and lies inside CLAUDE_CWD …` | `engineering` with summaries (or other memory) kept in the repo | Move `BOT_HISTORY_DIR` out of `CLAUDE_CWD` and clear it from the repo's history, or keep the bot `readonly` | Fix the named value, restart |
| Task blocked, reply says no Edit/Write/Bash | Bot is in `readonly` | Set `BOT_BOARD_EXECUTION=engineering`, restart, check the startup log |
| Shell commands fail with `bwrap` errors | A read path contains `CLAUDE_CWD` or a write path, or the sandbox is missing | Name sibling folders instead; install `bwrap`/`socat` |
| Every network call from the shell fails | `socat` unreadable inside the sandbox | Add its folder (and its wrapper's) to `BOT_BOARD_READ_PATHS`; see `doctor:fleet` |
| `CONNECT tunnel failed, response 403` / `deny network-outbound <host>` | Host not on the allow list | Add it to `BOT_BOARD_NETWORK_ALLOW` |
| Write refused in a folder you expected writable | Not `CLAUDE_CWD` and not in `BOT_BOARD_WRITE_PATHS`, or inside the state/harness folder | Add it to `BOT_BOARD_WRITE_PATHS`; state and harness are never writable |
| Log: `HTTP 403 cross_issue_influence_run_context_required` | A write reached Paperclip without the agent's run behind it — e.g. a comment posted with the agent key from a script or another session, not from the task's own run | Make the write from a run: assign the task to the agent and let the bot answer it, or send the call from inside that run with its `X-Paperclip-Run-Id`. Never switch to a board or admin key — that hides who acted |
| Log: `HTTP 403 …` with another code | Paperclip refused the write; the code names the rule | Look the code up in Paperclip's issue-write denial reasons; the response's `whoCanAct` and `sanctionedPath` say who may do it and how |
| Log: `HTTP 401` | Key wrong or revoked | Issue the agent a new key; update `PAPERCLIP_API_KEY` |
| Task stays `todo`, nothing in the log | Not assigned to this agent, or the connector is off | Check the assignee and the startup log |
