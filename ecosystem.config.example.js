// PM2 ecosystem config for running multiple bots from a single clone.
// Copy this file to ecosystem.config.js and fill in your values.
// Tokens go in .env — this file is safe to commit.
//
// Usage:
//   cp ecosystem.config.example.js ecosystem.config.js
//   pm2 start ecosystem.config.js

require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'my-first-bot',
      script: 'bot.js',
      env: {
        BOT_NAME: 'my-first-bot',
        DISCORD_TOKEN: process.env.FIRST_BOT_TOKEN,
        CLAUDE_CWD: '/path/to/your/project/first-bot',
        CLAUDE_MODEL: 'claude-sonnet-4-6',
        MONITOR_CHANNELS: '',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: '/path/to/your/project/first-bot/.bot-history',
        WS_PORT: '9801',
        NODE_ENV: 'production',
      }
    },
    {
      name: 'my-second-bot',
      script: 'bot.js',
      env: {
        BOT_NAME: 'my-second-bot',
        DISCORD_TOKEN: process.env.SECOND_BOT_TOKEN,
        CLAUDE_CWD: '/path/to/your/project/second-bot',
        CLAUDE_MODEL: 'claude-sonnet-4-6',
        MONITOR_CHANNELS: '',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: '/path/to/your/project/second-bot/.bot-history',
        WS_PORT: '9802',
        NODE_ENV: 'production',
      }
    },
  ]
};
