# Install guide

From nothing to a bot answering you in Discord. No prior Discord-developer or
Claude Code knowledge assumed.

**Time:** about 10 minutes, most of it in the Discord portal.

---

## 1. Prerequisites

Three things. Check each one before continuing — a missing prerequisite is the
most common reason the later steps behave strangely.

```bash
node -v          # need v18.0.0 or newer
claude --version # need the Claude Code CLI
```

If `node -v` is missing or too old, install Node 18+ from [nodejs.org](https://nodejs.org).

If `claude --version` fails, install the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/getting-started).

**Then authenticate it**, which is separate from installing it:

```bash
claude -p -- "say ok"
```

If that prints `ok`, you're authenticated. If it asks you to log in, do that first
— the bot runs `claude` non-interactively and cannot log in on your behalf.

You also need a Discord account and a server you can add a bot to. Creating a
server is free: Discord → **+** in the left sidebar → **Create My Own**.

---

## 2. Create the Discord bot

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

Then edit `.env`. Only `DISCORD_TOKEN` is strictly required, but set `CLAUDE_CWD`
too or the bot has no role. Run `npm run doctor` afterwards.
</details>

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

Still stuck? [Open an issue](https://github.com/xrgarcia/slashbin-ai-team/issues/new/choose)
and paste your `npm run doctor` output — it answers most of the first round of
questions.

---

## Next

- [README](../README.md#configuration) — the full configuration reference
- [UPGRADING.md](../UPGRADING.md) — coming from 1.x
- [SECURITY.md](../SECURITY.md) — hardening checklist
