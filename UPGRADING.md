# Upgrading

Newest first. Each entry says whether you have to do anything, and exactly what.

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

### 5. Multi-bot process management now works

`npm start` / `stop` / `status` / `logs` scope their pid and log files by
`BOT_NAME`, so several bots can be managed from one checkout. Added `npm run list`.

**Single-bot installs are unaffected** — with `BOT_NAME` unset the filenames are
identical to before. If you *had* set `BOT_NAME`, your bot previously wrote
`.bot.pid` / `bot.log` and will now write `.<name>.pid` / `<name>.log`. Nothing to
migrate; the old files are simply unused.

### 6. `ALLOWED_USERS` empty now warns loudly

An empty allowlist has always meant *every* Discord user who can reach the bot.
That is unchanged — but it now says so on every start.

Optional, recommended:

```
ALLOWED_USERS=<your Discord user ID>
BOT_REQUIRE_ALLOWLIST=true
```

`BOT_REQUIRE_ALLOWLIST=true` refuses to start rather than run open to everyone.

### 7. `ALLOWED_USERS` no longer vetoes allowlisted bots

Previously, setting `ALLOWED_USERS` silently broke bot-to-bot coordination: a peer
already listed in `ALLOWED_BOTS` was then dropped for not also appearing in
`ALLOWED_USERS`. Bots are authorised by `ALLOWED_BOTS`, humans by `ALLOWED_USERS`.

If you worked around this by putting bot IDs in `ALLOWED_USERS`, you can remove
them. Leaving them does no harm.

### 8. New: `npm run setup` and `npm run doctor`

`setup` writes a validated `.env`. `doctor` checks an existing install and exits
non-zero on failure — run it after upgrading, and paste it into any bug report.
Neither prints secrets.

### 9. Frozen constants are now settings

`BOT_SCHEDULE_CHECK_MS`, `BOT_SCHEDULE_LOOKBACK_MINUTES`,
`BOT_OUTBOX_MTIME_TOLERANCE_MS`, `BOT_BOT_EXCHANGE_PRUNE_MS`, `WS_HEARTBEAT_MS`,
`WS_HEARTBEAT_MAX_MISSES`, `BUFFER_ROTATE_PERCENT`, `WS_HOST`.

**Every default equals its previous hardcoded value.** Nothing changes unless you
set one.

Numeric settings are also parsed more strictly: a value that is not a number, or
below the minimum, now falls back to the default **and says so in the log**.
Previously `0`, a negative, or a typo was silently swallowed.

### 10. Removed: our internal skills

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
