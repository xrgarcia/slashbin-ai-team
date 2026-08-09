// PM2 config for running several bots from one clone.
//
//   cp ecosystem.config.example.js ecosystem.config.js
//   pm2 start ecosystem.config.js
//
// SECRETS DO NOT GO IN THIS FILE. Tokens are read from the environment and
// referenced here by name only. A gitignored file is not a safe place for a
// credential — it still travels in backups, in copies to other hosts, and in
// pasted bug reports. Supply them with a .env file (loaded below) or a secrets
// manager:
//
//   doppler run --project my-project --config prd -- pm2 start ecosystem.config.js
//
// `npm run doctor` fails if it finds a literal credential in this file.
//
// Host-specific paths are hoisted into the three constants below, so everything
// after them is portable between machines.

require('dotenv').config();

const REPO = '/path/to/slashbin-ai-team';        // this clone
const PO_REPO = '/path/to/product-owner-repo';   // the PO bot's project (its CLAUDE.md)
const EM_REPO = '/path/to/eng-manager-repo';     // the EM bot's project

module.exports = {
  apps: [
    {
      name: 'product-owner',
      script: 'bot.js',
      cwd: REPO,
      env: {
        BOT_NAME: 'product-owner',
        DISCORD_TOKEN: process.env.PO_DISCORD_TOKEN,   // name only — never a literal
        CLAUDE_CWD: PO_REPO,

        // Who may drive this bot. EMPTY MEANS EVERY DISCORD USER who can DM it
        // or post in a channel it watches. Comma-separated user IDs.
        ALLOWED_USERS: '',
        // Set true to refuse to start rather than run open to everyone.
        BOT_REQUIRE_ALLOWLIST: 'false',

        // Which tools the bot may use.
        //   restricted (default) — only BOT_ALLOWED_TOOLS, plus connected MCP tools
        //   bypass               — every tool, no permission checks
        // Use bypass only for a bot you intend to let write code and run commands,
        // and only alongside a real ALLOWED_USERS.
        BOT_PERMISSION_MODE: 'restricted',
        // BOT_ALLOWED_TOOLS: 'Read,Glob,Grep,WebFetch,WebSearch,TodoWrite',

        // Channels answered without an @mention. Empty = mention-only (DMs always work).
        MONITOR_CHANNELS: '',
        ALLOWED_CHANNELS: '',
        ALLOWED_BOTS: '',                              // peer bot IDs, for bot-to-bot
        MAX_BOT_EXCHANGES: '2',                        // matches the code default

        SUMMARIZE_CHANNELS: '',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: `${PO_REPO}/bot-history`,     // summaries, attachments, outbox

        CLAUDE_MODEL: 'claude-opus-5',
        SUMMARIZE_MODEL: 'claude-haiku-4-5-20251001',  // a cheaper model is fine here
        CLAUDE_TIMEOUT_MS: '1200000',
        BOT_TIMEZONE: 'America/Chicago',               // the bot's sense of "today"

        WS_PORT: '9801',                               // MUST be unique per bot
        REACTION_HANDLER_ENABLED: 'false',             // requires ALLOWED_USERS
        NODE_ENV: 'production',
      },
    },
    {
      name: 'engineering-manager',
      script: 'bot.js',
      cwd: REPO,
      env: {
        BOT_NAME: 'engineering-manager',
        DISCORD_TOKEN: process.env.EM_DISCORD_TOKEN,
        CLAUDE_CWD: EM_REPO,

        ALLOWED_USERS: '',
        BOT_REQUIRE_ALLOWLIST: 'false',
        BOT_PERMISSION_MODE: 'restricted',

        MONITOR_CHANNELS: '',
        ALLOWED_CHANNELS: '',
        ALLOWED_BOTS: '',
        MAX_BOT_EXCHANGES: '2',

        SUMMARIZE_CHANNELS: '',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: `${EM_REPO}/bot-history`,

        CLAUDE_MODEL: 'claude-opus-5',
        SUMMARIZE_MODEL: 'claude-haiku-4-5-20251001',
        CLAUDE_TIMEOUT_MS: '1200000',
        BOT_TIMEZONE: 'America/Chicago',

        WS_PORT: '9802',
        REACTION_HANDLER_ENABLED: 'false',
        NODE_ENV: 'production',
      },
    },
  ],
};
