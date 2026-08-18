# Upgrading

Newest first. Each entry says whether you have to do anything, and exactly what.

---

## 2.2.0 → 2.2.1

**No action required.** One bug fix, no new configuration.

### Scheduled jobs no longer share the channel's conversation session

If you run a scheduled job on a cadence shorter than `SESSION_TIMEOUT_MS` (default 30
minutes), it was holding that channel's session open permanently: sessions expire on
*idle*, and a job firing every 10 minutes is never idle. Every fire re-sent the whole
accumulated history, and the job also shared its session with any human talking in the
same channel.

Each scheduled run now gets a clean session and leaves the channel's untouched.

**What changes for you:** if a job's prompt relied on remembering earlier runs, it no
longer will. Nothing else — remembered context (summaries and the buffer) is still
injected exactly as before, and interactive conversations are unaffected.

---

## 2.1.x → 2.2.0

**No action required.** Everything here is additive. Two changes are worth knowing
about if you run more than one bot.

### 1. A host-wide default for the permission mode

`BOT_PERMISSION_MODE` was per-bot and nothing else, so a host running eight bots
needed the same line in eight app entries — and missing one was silent: that bot
kept answering questions and had quietly lost the ability to write a file.

There is now a host-level default:

```
BOT_PERMISSION_MODE_DEFAULT=bypass
```

Resolution order, per bot:

1. `BOT_PERMISSION_MODE` — this bot. Always wins.
2. `BOT_PERMISSION_MODE_DEFAULT` — the host default.
3. `restricted` — unchanged built-in default.

**Nothing changes for an existing install.** Set neither and you still get
`restricted`; a bot that sets `BOT_PERMISSION_MODE` is unaffected by any host
default. The new variable is opt-in.

The startup log now names *where* the resolved value came from, so an explicit
`restricted` can be told apart from an unset one.

`summarize.js` resolves the mode through the same shared code as `bot.js`. It
previously read the environment variable directly, which would have honoured a host
default in the bot and ignored it in the summarizer.

### 2. A configuration failure exits 78 instead of 1

A process manager restarts on failure, which is right for a crash and wrong for a
typo. A rejected token is the same token next time, so restarting it is pure
thrash — on a multi-bot host, one stale token can loop endlessly and drown the logs
of every sibling that is healthy.

Failures a restart cannot fix now exit **78** (`EX_CONFIG`): a rejected Discord
token, a missing `DISCORD_TOKEN`, a `CLAUDE_CWD` that does not exist or is not a
directory, an unrecognised permission mode, an invalid `BOT_TIMEZONE`, and
`BOT_REQUIRE_ALLOWLIST=true` with an empty allowlist.

Everything else still exits 1 and stays restartable — a network failure reaching
Discord genuinely does deserve another go, and a duplicate-instance guard is
transient because the other process may stop.

**To act on it**, tell your process manager to stop rather than retry:

```js
stop_exit_codes: [78],   // PM2, in each app entry
```

```ini
# systemd
RestartPreventExitStatus=78
```

**If you do nothing**, behaviour is what it was — a non-zero exit that your manager
restarts. You just keep the loop.

### 3. A scheduled job with nothing to report posts nothing

A polling job whose honest answer is "nothing happened" could not say so quietly:
the model cannot emit an empty turn, so it reached for a placeholder (`[no output]`,
`.`) and every one became a Discord ping. Those shapes are now suppressed for
**scheduled jobs only**. An interactive reply is never filtered — a human asked, and
silence would read as the bot being broken.

---

## 1.x → 2.0.0

**Action required: one line.** Everything else in this release is additive.

### 1. Tool exposure is now restricted by default — ACTION REQUIRED

Before 2.0, every bot ran with all tools and no permission checks, and there was
no way to change that. It is now a choice, and the default has flipped.

**To keep the previous behaviour, add this to your bot's environment:**

```
BOT_PERMISSION_MODE=bypass
```

The bot prints the same instruction at startup, so if you upgrade without reading
this, the log tells you what to do.

**If you do nothing**, your bot starts in `restricted` mode and can only use
`Read, Glob, Grep, WebFetch, WebSearch, TodoWrite` (plus any MCP tools you have
connected). It will still answer questions and read your code; it will not be
able to write files or run commands.

Choosing between them: use `bypass` for a bot you intend to let write code and
ship work, and only alongside a real `ALLOWED_USERS`. Use `restricted` — and
widen `BOT_ALLOWED_TOOLS` as needed — for anything else.

### 2. A failed Discord login now exits instead of lingering

Before 2.0, a bot that could not authenticate stayed alive and reported itself
healthy: `npm start` printed "Bot started", `npm run status` printed "Bot is
running", and the bot silently ignored every message.

It now logs the cause and exits non-zero. **If a bot of yours starts flapping
after upgrading, it was already broken** — it just had no way to tell you. Run
`npm run doctor` for the reason.

`npm run status` also now distinguishes *connected to Discord* from *process
alive*.

### 3. `CLAUDE_CWD` is validated at startup

A `CLAUDE_CWD` that does not exist, or is not a directory, is now a startup
failure rather than a confusing error on the first message. No action needed
unless it was already wrong.

### 4. The bot's clock follows the host, not America/Chicago

The time injected into every session was hardcoded to `America/Chicago` with a
literal `CDT` suffix — which read as `CDT CDT` in summer and `CST CDT` in winter.

It now uses the host timezone, correctly labelled. **To pin it**, set:

```
BOT_TIMEZONE=America/Chicago
```

Worth doing deliberately if you run scheduled jobs, since a bot's sense of "today"
drives them.

### 5. Scheduled jobs fire in `BOT_TIMEZONE`, not the host's zone

**Action required only if `BOT_TIMEZONE` differs from your server's timezone, and
you have existing jobs.**

Cron was evaluated with host-local time, so a bot set to `Europe/London` running
`0 7 * * *` on a Chicago host fired at **7am Chicago — 1pm London**. It now fires
at 7am in the configured zone. To keep an existing job on its old schedule, pin it:

```json
{ "id": "standup", "cron": "0 7 * * *", "tz": "America/Chicago", ... }
```

Jobs created from now on record their zone automatically. If your host and
`BOT_TIMEZONE` match, nothing changes.

Also new: you can create jobs by asking — *"every weekday at 7am, post the
standup"*. Note the scheduler accepts `*` and comma lists only; `1,2,3,4,5`, never
`1-5`, which parsed as `1` and would have fired on Mondays alone. That is now
rejected rather than accepted.

### 6. Multi-bot process management now works

`npm start` / `stop` / `status` / `logs` scope their pid and log files by
`BOT_NAME`, so several bots can be managed from one checkout. Added `npm run list`.

**Single-bot installs are unaffected** — with `BOT_NAME` unset the filenames are
identical to before. If you *had* set `BOT_NAME`, your bot previously wrote
`.bot.pid` / `bot.log` and will now write `.<name>.pid` / `<name>.log`. Nothing to
migrate; the old files are simply unused.

### 7. `ALLOWED_USERS` empty now warns loudly

An empty allowlist has always meant *every* Discord user who can reach the bot.
That is unchanged — but it now says so on every start.

Optional, recommended:

```
ALLOWED_USERS=<your Discord user ID>
BOT_REQUIRE_ALLOWLIST=true
```

`BOT_REQUIRE_ALLOWLIST=true` refuses to start rather than run open to everyone.

### 8. `ALLOWED_USERS` no longer vetoes allowlisted bots

Previously, setting `ALLOWED_USERS` silently broke bot-to-bot coordination: a peer
already listed in `ALLOWED_BOTS` was then dropped for not also appearing in
`ALLOWED_USERS`. Bots are authorised by `ALLOWED_BOTS`, humans by `ALLOWED_USERS`.

If you worked around this by putting bot IDs in `ALLOWED_USERS`, you can remove
them. Leaving them does no harm.

### 9. New: `npm run setup` and `npm run doctor`

`setup` writes a validated `.env`. `doctor` checks an existing install and exits
non-zero on failure — run it after upgrading, and paste it into any bug report.
Neither prints secrets.

### 10. Frozen constants are now settings

`BOT_SCHEDULE_CHECK_MS`, `BOT_SCHEDULE_LOOKBACK_MINUTES`,
`BOT_OUTBOX_MTIME_TOLERANCE_MS`, `BOT_BOT_EXCHANGE_PRUNE_MS`, `WS_HEARTBEAT_MS`,
`WS_HEARTBEAT_MAX_MISSES`, `BUFFER_ROTATE_PERCENT`, `WS_HOST`.

**Every default equals its previous hardcoded value.** Nothing changes unless you
set one.

Numeric settings are also parsed more strictly: a value that is not a number, or
below the minimum, now falls back to the default **and says so in the log**.
Previously `0`, a negative, or a typo was silently swallowed.

### 11. Removed: our internal skills

`.claude/skills/implement-approved-issues` and `revise-pr-feedback` shipped in the
package and encoded the maintainers' own delivery process. They were never loaded
by the bot. Removing them changes no runtime behaviour.

---

## Checklist

```bash
git pull
npm install
# add BOT_PERMISSION_MODE=bypass to your env if you want pre-2.0 tool access
npm run doctor          # must exit 0
npm restart             # or: systemctl --user restart <your unit>
npm run status          # must say "connected to Discord", not just "running"
```
