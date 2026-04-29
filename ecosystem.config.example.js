// PM2 ecosystem config for running multiple bots from a single clone.
// Copy this file to ecosystem.config.js and fill in your values.
//
// Secrets: use .env (via dotenv) or Doppler (via doppler run).
// ecosystem.config.js is in .gitignore — safe to put real values there.
//
// Usage:
//   cp ecosystem.config.example.js ecosystem.config.js
//   pm2 start ecosystem.config.js
//
// With Doppler:
//   doppler run --project my-project --config prd -- pm2 start ecosystem.config.js

require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'product-owner',
      script: 'bot.js',
      cwd: '/path/to/this/repo',         // path to slashbin-ai-team clone
      env: {
        BOT_NAME: 'product-owner',
        DISCORD_TOKEN: process.env.PO_DISCORD_TOKEN,
        CLAUDE_CWD: '/path/to/product-owner-repo',
        CLAUDE_MODEL: 'claude-opus-4-6',
        SUMMARIZE_MODEL: 'claude-haiku-4-5-20251001',
        MONITOR_CHANNELS: '',             // channel IDs where bot responds without @mention
        ALLOWED_CHANNELS: '',             // channel IDs where bot can respond (DMs always allowed)
        ALLOWED_BOTS: '',                 // bot user IDs allowed to interact (for bot-to-bot)
        MAX_BOT_EXCHANGES: '10',          // max consecutive bot-to-bot exchanges
        RECENT_CONTEXT_CHANNELS: '',      // channels to pull recent messages from for context
        SUMMARIZE_CHANNELS: '',           // channels to summarize on interval
        SUMMARIZE_INTERVAL_MS: '3600000', // background summarization interval (1 hour)
        BOT_HISTORY_DIR: '/path/to/product-owner-repo/bot-history',
        CLAUDE_TIMEOUT_MS: '1200000',     // max time per Claude session (20 min)
        WS_PORT: '9801',                  // WebSocket bridge port (unique per bot)
        REACTION_HANDLER_ENABLED: 'false', // set 'true' to opt this bot in (requires ALLOWED_USERS)
        REACTION_TRIGGER_EMOJI: '👍',
        REACTION_ACK_EMOJI: '✅',
        REACTION_FAIL_EMOJI: '❌',
        NODE_ENV: 'production',
      }
    },
    {
      name: 'engineering-manager',
      script: 'bot.js',
      cwd: '/path/to/this/repo',
      env: {
        BOT_NAME: 'engineering-manager',
        DISCORD_TOKEN: process.env.EM_DISCORD_TOKEN,
        CLAUDE_CWD: '/path/to/engineering-manager-repo',
        CLAUDE_MODEL: 'claude-opus-4-6',
        SUMMARIZE_MODEL: 'claude-haiku-4-5-20251001',
        MONITOR_CHANNELS: '',
        ALLOWED_CHANNELS: '',
        ALLOWED_BOTS: '',
        MAX_BOT_EXCHANGES: '10',
        RECENT_CONTEXT_CHANNELS: '',
        SUMMARIZE_CHANNELS: '',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: '/path/to/engineering-manager-repo/bot-history',
        CLAUDE_TIMEOUT_MS: '1200000',
        WS_PORT: '9802',
        REACTION_HANDLER_ENABLED: 'false', // set 'true' to opt this bot in (requires ALLOWED_USERS)
        REACTION_TRIGGER_EMOJI: '👍',
        REACTION_ACK_EMOJI: '✅',
        REACTION_FAIL_EMOJI: '❌',
        NODE_ENV: 'production',
      }
    },
  ]
};
