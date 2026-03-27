require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'klaviyo-karl',
      script: 'bot.js',
      env: {
        BOT_NAME: 'klaviyo-karl',
        DISCORD_TOKEN: process.env.KARL_DISCORD_TOKEN,
        CLAUDE_CWD: '/Users/karl/Code/jerky_com_marketing/karl-bot',
        MONITOR_CHANNELS: '1484366434543992932',
        SUMMARIZE_INTERVAL_MS: '86400000',
        BOT_HISTORY_DIR: '/Users/karl/Code/jerky_com_marketing/karl-bot/.bot-history',
        WS_PORT: '9801',
        NODE_ENV: 'production',
      }
    },
    {
      name: 'ben',
      script: 'bot.js',
      env: {
        BOT_NAME: 'ben',
        DISCORD_TOKEN: process.env.BEN_DISCORD_TOKEN,
        CLAUDE_CWD: '/Users/karl/Code/jerky_com_marketing/ben-bot',
        MONITOR_CHANNELS: '1482469628700655737',
        SUMMARIZE_INTERVAL_MS: '86400000',
        BOT_HISTORY_DIR: '/Users/karl/Code/jerky_com_marketing/ben-bot/.bot-history',
        WS_PORT: '9802',
        NODE_ENV: 'production',
      }
    },
    {
      name: 'frank',
      script: 'bot.js',
      env: {
        BOT_NAME: 'frank',
        DISCORD_TOKEN: process.env.FRANK_DISCORD_TOKEN,
        CLAUDE_CWD: '/Users/karl/Code/jerky_com_marketing/frank-bot',
        MONITOR_CHANNELS: '1484737193346994238',
        SUMMARIZE_INTERVAL_MS: '86400000',
        BOT_HISTORY_DIR: '/Users/karl/Code/jerky_com_marketing/frank-bot/.bot-history',
        WS_PORT: '9803',
        NODE_ENV: 'production',
      }
    },
  ]
};
