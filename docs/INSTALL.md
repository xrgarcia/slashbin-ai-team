# Install guide

From nothing to a bot answering you in Discord. No prior Discord-developer or
agent-CLI knowledge assumed.

**Time:** about 10 minutes, most of it in the Discord portal.

---

## 1. Prerequisites

Three things. Check each one before continuing — a missing prerequisite is the
most common reason the later steps behave strangely.

```bash
node -v          # need v18.0.0 or newer
```

If `node -v` is missing or too old, install Node 18+ from [nodejs.org](https://nodejs.org).

**One agent CLI.** Each bot runs on Claude Code or Codex; you need only the one it
uses. Pick one path:

<details open>
<summary><b>Claude Code</b> (the default)</summary>

```bash
claude --version
```

If that fails, install the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/getting-started).
**Then authenticate it**, which is separate from installing it:

```bash
claude -p -- "say ok"
```

If that prints `ok`, you're authenticated. If it asks you to log in, do that first
— the bot runs `claude` non-interactively and cannot log in on your behalf.
</details>

<details>
<summary><b>Codex</b></summary>

```bash
codex --version
codex login          # once, as the user the bot will run as
codex login status   # must say you are logged in
```

If `codex` is missing, install the [Codex CLI](https://github.com/openai/codex).
On Linux also install `bwrap` (bubblewrap), which Codex uses to sandbox the bot's
read-only runs. In step 4, add `BOT_RUNTIME=codex` to the bot's `.env`.
[docs/runtimes.md](runtimes.md) lists what differs on Codex.
</details>

You also need a Discord account and a server you can add a bot to. Creating a
server is free: Discord → **+** in the left sidebar → **Create My Own**.

---

## 2. Create the Discord bot

> **Discord and Paperclip are peer surfaces.** A bot that only takes tasks on a
> [Paperclip](../README.md#paperclip) board needs no Discord bot at all: skip
> this section, enable the [Paperclip connector](#paperclip-connector) and leave
> `DISCORD_TOKEN` unset (see [Paperclip-only](#paperclip-only) under step 4).

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. **New Application** → give it a name (this is what people see — e.g. "Product Owner") → **Create**.
3. Left sidebar → **Bot**.
4. **Reset Token** → **Yes, do it** → **Copy**. Keep it somewhere safe for a minute.
   You cannot view it again — only reset it.

### 5. Turn on Message Content Intent — do not skip this

Still on the **Bot** page, scroll to **Privileged Gateway Intents** and switch on
**MESSAGE CONTENT INTENT**. Save.

> **Why this gets its own step:** without it, your bot will connect successfully,
> appear online, and then **ignore every message you send** — with no error
> anywhere. It looks exactly like a working bot that hates you. This is the single
> most common hour lost during setup.
>
> `npm run setup` and `npm run doctor` both check it and will tell you if it's off.

### 6. Invite the bot to your server

1. Left sidebar → **OAuth2** → **URL Generator**.
2. **Scopes:** tick `bot`.
3. **Bot Permissions:** tick `Send Messages`, `Read Message History`, and
   `Add Reactions` (the last only if you plan to use reaction triggers).
4. Copy the generated URL at the bottom, open it in a browser, pick your server,
   **Authorize**.

The bot appears in your member list, offline. That's expected — nothing is running yet.

---

## 3. Install the harness

```bash
git clone https://github.com/xrgarcia/slashbin-ai-team.git
cd slashbin-ai-team
npm install
```

---

## 4. Configure

```bash
npm run setup
```

It asks for a handful of values and **validates each one as you go** — it will not
write a broken config. In particular it proves your token works by reporting your
bot's own name back to you, and it tells you if Message Content Intent is off.

It asks for:

| Prompt | What to give it |
|---|---|
| Bot name | Any short label, e.g. `product-owner`. Scopes this bot's files. |
| Discord token | The one you copied in step 2 |
| Project directory | **Your** repo — see below |
| Your Discord user ID | See below. Leave blank only if you accept the bot being open to everyone |
| Monitored channels | Blank is fine; the bot then answers DMs and @mentions |
| WebSocket port | Accept the default unless you're running a second bot |
| Timezone | Accept the default (your host's) |

**Your Discord user ID:** Discord → **Settings** → **Advanced** → turn on
**Developer Mode**. Then right-click your own name anywhere → **Copy User ID**.

**Project directory (`CLAUDE_CWD`)** is the most misunderstood setting. It is
**your** project — the repo you want the bot to work on and whose `CLAUDE.md`
gives it its role. It is *not* this harness directory. Pointing it here gives the
bot no role and lets it edit its own source; setup refuses if you try.

<details>
<summary>Prefer to edit a file by hand?</summary>

```bash
cp .env.example .env
```

Then edit `.env`. A bot answers on Discord when it has a `DISCORD_TOKEN`, and
on its board alone when it has only a Paperclip board (below). Set
`CLAUDE_CWD` too or the bot has no role. Run `npm run doctor` afterwards.
</details>

### Paperclip connector

The Paperclip connector is what puts a bot on a Paperclip board: it polls the
bot's inbox and answers the tasks assigned to it. It is on when the bot has a
board — `PAPERCLIP_URL` and `PAPERCLIP_API_KEY` (this agent's own key), or
`PAPERCLIP_EXTRA_BOARDS` — and its `CLAUDE_CWD` is not the harness or state
folder. It is the prerequisite for a Paperclip-only bot: without it that bot
refuses to start (exit 78) and says so. The
settings are in the README, [Paperclip](../README.md#paperclip).

### Paperclip-only

A bot can listen on a Paperclip board alone. Enable the Paperclip connector
(above) and leave `DISCORD_TOKEN` (and the channel settings) unset.
`BOT_SURFACES=paperclip` declares it explicitly; it is optional:

```bash
CLAUDE_CWD=/path/to/your/project-repo   # not this harness folder
BOT_NAME=tech-lead
WS_PORT=9803                            # unique per bot on the host
BOT_SURFACES=paperclip                  # optional: no DISCORD_TOKEN + a board is Paperclip-only
PAPERCLIP_URL=https://board.example.com
PAPERCLIP_API_KEY=<this agent's own key>
```

It logs `Discord off — Paperclip-only`, never builds a Discord client, and is
ready once its first poll reaches the board. Scheduled jobs and the background
summarizer post to and read from Discord, so they are off: a scheduled job left
in its file is refused when it is loaded, with a log line, and runs again once
Discord is back. Without the Paperclip connector it exits with code 78, saying
the Paperclip connector must be enabled first. A bot with neither a
`DISCORD_TOKEN` nor a usable board exits 78 too, naming both.

---

## 5. Give the bot a role

The `CLAUDE.md` in your project directory is the bot's job description.

```bash
cp CLAUDE.md.example /path/to/your/project-repo/CLAUDE.md
```

Edit it: who the bot is, what it can look up, what it's allowed to do, your
domain terms, your repos. Keep it under about 100 lines — it's loaded on every
message, so lean context means faster replies.

Without a `CLAUDE.md` the bot still works; it just behaves like a generic
assistant that happens to have access to your files.

---

## 6. Check before you start

```bash
npm run doctor
```

Every line should read `PASS`. This is the step that turns "why isn't it working"
into a specific answer. Fix any `FAIL` — each one prints what to do — and re-run.

`WARN` lines are safe to start with. The common one is an empty `ALLOWED_USERS`,
which means every Discord user who can reach the bot can drive it.

---

## 7. Start it

```bash
npm start
```

Expect:

```
Bot 'product-owner' started and connected to Discord (PID 12345)
Logs: /path/to/slashbin-ai-team/product-owner.log
```

**"started and connected"** is the phrase that matters. If it says *started but
not yet connected*, wait a few seconds and run `npm run status`. If it says
**failed to start**, the cause is printed right underneath.

Confirm from the other side too:

```bash
npm run status
# Bot 'product-owner' is running and connected to Discord (PID 12345)
```

Then in Discord, **DM your bot**: `hello, what repo are you working in?`

You should see it start typing, then reply. That's a working install.

The ready marker means **every** surface the bot runs is up: Discord once it
connects (if on), and each Paperclip board once its first poll succeeds (if on).
`npm run doctor:fleet` shows each one separately, e.g.
`Discord: off · board paperclip: ready`. A Paperclip-only bot is checked by
assigning it a task on its board.

---

## 8. Add tools (optional)

Give the bot access to real systems with an `.mcp.json` in your **project**
directory:

```json
{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@host/db"]
    }
  }
}
```

Restart (`npm restart`), then confirm it actually connected rather than assuming —
ask the bot directly: *"list the tables in the database"*. A misconfigured MCP
server doesn't error loudly; the tool is simply absent.

If the bot seems to hang after adding one, remove `.mcp.json`, confirm it responds
again, then add servers back one at a time.

---

## 9. Let it do more (optional)

By default the bot can read and search, but not write files or run commands. To
let it act:

```env
BOT_PERMISSION_MODE=bypass
```

**Only do this alongside a real `ALLOWED_USERS`.** In `bypass` mode, anyone who can
reach the bot can run commands on your machine. The bot warns about this on every
start.

To widen more narrowly instead, keep `restricted` and add tools:

```env
BOT_ALLOWED_TOOLS=Read,Glob,Grep,WebFetch,WebSearch,TodoWrite,Edit,Write
```

---

## 10. Run a team

```bash
cp ecosystem.config.example.js ecosystem.config.js
```

Edit the three path constants at the top, then give each bot its own `BOT_NAME`,
token variable, `CLAUDE_CWD`, and **a unique `WS_PORT`** — a collision crashes the
second bot at startup.

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # follow the printed command so it survives reboot
```

**Check every bot before you start them.** `npm run doctor` validates whichever bot's
configuration is in your current environment; on a multi-bot host run
`npm run doctor:fleet` instead — it walks `ecosystem.config.js` and checks each bot's
token, schedules and running code in one pass. Run it in the same environment PM2
launches from, or the tokens cannot be verified:

```bash
doppler run -- npm run doctor:fleet     # or however you supply secrets
```

**Tell PM2 not to retry a failure that cannot succeed.** A bot exits **78** when its
configuration is wrong — a rejected token, a `CLAUDE_CWD` that does not exist, an
unrecognised permission mode. Restarting changes none of those, so without this the
bot loops forever and its log drowns every sibling that is healthy:

```js
stop_exit_codes: [78],   // in each app entry
```

Every other failure exits 1 and stays restartable, because a network blip does
deserve another go. Run `npm run doctor` to see the reason before restarting.

Tokens are read from the environment, never written into that file. Use `.env` or
a secrets manager:

```bash
doppler run --project my-project --config prd -- pm2 start ecosystem.config.js
```

<details>
<summary>systemd instead of PM2</summary>

```ini
# ~/.config/systemd/user/ai-employee.service
[Unit]
Description=AI Employee (Discord)
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/slashbin-ai-team
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ai-employee
journalctl --user -u ai-employee -f
```
</details>

---

## Troubleshooting

**Start here, in order.** Each step rules out everything above it.

1. **`npm run doctor`** — catches most problems and names the fix. It prints no secrets.
2. **`npm run status`** — does it say *connected to Discord*, or only that a process is alive? "Alive but not connected" means the login failed; the cause is printed.
3. **`npm run logs 50`** — the last error line usually names the variable at fault.
4. **Is the bot in the channel?** DMs always work for allowed users; channels need the bot invited and, for no-@mention replies, listed in `MONITOR_CHANNELS`.
5. **Are you allowed?** If `ALLOWED_USERS` is set and your ID isn't in it, you are silently ignored — by design.

| Symptom | Cause | Fix |
|---|---|---|
| Online, ignores everything | Message Content Intent off | Turn it on (step 2.5), restart |
| Ignores you specifically | Not in `ALLOWED_USERS` | Add your user ID |
| "failed to start" | Bad token, or a missing `CLAUDE_CWD` | Read the printed cause |
| Replies, but won't edit files or run commands | `restricted` mode | See step 9 |
| Ignores another bot | Bot-to-bot not configured | Both bots list each other in `ALLOWED_BOTS` |
| Hangs, exit code 143 | Timeout or an unreachable MCP server | Raise `CLAUDE_TIMEOUT_MS`; bisect `.mcp.json` |
| Second bot won't start | `WS_PORT` collision | One port per bot |
| "Claude exited with code 1" on every message | CLI not authenticated | Run `claude -p -- "say ok"` yourself |
| "Codex exited with code 1" on every message | Codex not signed in, or `BOT_MODEL` not on the account | `codex login status`; check `BOT_MODEL` |

Still stuck? [Open an issue](https://github.com/xrgarcia/slashbin-ai-team/issues/new/choose)
and paste your `npm run doctor` output — it answers most of the first round of
questions.

---

## Next

- [README](../README.md#configuration) — the full configuration reference
- [UPGRADING.md](../UPGRADING.md) — coming from 1.x
- [SECURITY.md](../SECURITY.md) — hardening checklist
