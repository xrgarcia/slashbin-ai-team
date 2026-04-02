// Secrets injected by Doppler via: doppler run --project slashbin-io --config prd -- pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: 'em-bot',
      script: '/home/xrgarcia/code/slashbin-ai-team/bot.js',
      cwd: '/home/xrgarcia/code/slashbin-ai-team/bots/em',
      env: {
        BOT_NAME: 'em-bot',
        DISCORD_TOKEN: process.env.EM_DISCORD_TOKEN,
        CLAUDE_CWD: '/home/xrgarcia/code/slashbin-engineering-manager',
        CLAUDE_MODEL: 'claude-opus-4-6',
        SUMMARIZE_MODEL: 'claude-haiku-4-5-20251001',
        MONITOR_CHANNELS: '1481021985994838026',
        ALLOWED_CHANNELS: '1481021985994838026,1481045991821148332',
        RECENT_CONTEXT_CHANNELS: '1481021985994838026,1481045991821148332',
        SUMMARIZE_CHANNELS: '1481021985994838026,1481045991821148332',
        ALLOWED_BOTS: '1480958401663078597',
        MAX_BOT_EXCHANGES: '10',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: '/home/xrgarcia/code/slashbin-engineering-manager/bot-history/sre',
        CLAUDE_TIMEOUT_MS: '1200000',
        WS_PORT: '9800',
        NODE_ENV: 'production',
      }
    },
    {
      name: 'po-bot',
      script: '/home/xrgarcia/code/slashbin-ai-team/bot.js',
      cwd: '/home/xrgarcia/code/slashbin-ai-team/bots/po',
      env: {
        BOT_NAME: 'po-bot',
        DISCORD_TOKEN: process.env.PO_DISCORD_TOKEN,
        CLAUDE_CWD: '/home/xrgarcia/code/slashbin-product-owner',
        CLAUDE_MODEL: 'claude-opus-4-6',
        SUMMARIZE_MODEL: 'claude-sonnet-4-6',
        MONITOR_CHANNELS: '1480957723624603782',
        ALLOWED_CHANNELS: '1480957723624603782,1481045991821148332',
        ALLOWED_BOTS: '1481013230389432523',
        MAX_BOT_EXCHANGES: '10',
        RECENT_CONTEXT_CHANNELS: '1480957723624603782,1481045991821148332',
        SUMMARIZE_CHANNELS: '1480957723624603782,1481045991821148332',
        SUMMARIZE_INTERVAL_MS: '3600000',
        BOT_HISTORY_DIR: '/home/xrgarcia/code/slashbin-product-owner/history',
        CLAUDE_TIMEOUT_MS: '1200000',
        WS_PORT: '9801',
        NODE_ENV: 'production',
      }
    },
  ]
};
