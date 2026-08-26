/**
 * A message the bridge cannot deliver must leave a log line naming the channel.
 *
 * The bridge resolved every destination with `client.channels.cache.get(id)` and
 * wrapped the send in a bare `if (channel)`. A channel the bot has no access to
 * is absent from that cache, so the message was discarded on the `else` branch
 * that did not exist — no error, no warning, nothing.
 *
 * Reproduced 2026-08-26: the Foreman published status to #tech-lead for hours
 * with the bot lacking access to it. The logs showed a healthy bridge and a
 * clean handshake, and the missing permission was mistaken for a cache bug.
 *
 * These assertions run against the source text — bot.js cannot be require()d
 * because importing it logs a live bot into Discord.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

function handler(type) {
  const start = bot.indexOf(`if (msg.type === "${type}")`);
  assert.ok(start > -1, `${type} handler not found`);
  const next = bot.indexOf("if (msg.type ===", start + 10);
  return bot.slice(start, next > -1 ? next : start + 2000);
}

console.log("\nBridge delivery — an undeliverable message must not vanish");

check("a shared channel resolver exists", () => {
  assert.ok(/async function resolveBridgeChannel\(/.test(bot),
    "no resolveBridgeChannel — each send site is resolving the channel on its own again");
});

check("the resolver falls back to a fetch when the cache misses", () => {
  const start = bot.indexOf("async function resolveBridgeChannel(");
  const body = bot.slice(start, bot.indexOf("\n}", start));
  assert.ok(/channels\.fetch\(/.test(body),
    "cache-only resolution drops messages after a gateway reconnect empties the cache");
});

check("the resolver logs an error when the channel cannot be reached", () => {
  const start = bot.indexOf("async function resolveBridgeChannel(");
  const body = bot.slice(start, bot.indexOf("\n}", start));
  assert.ok(/log\.error\(/.test(body),
    "an unreachable channel must be logged at error level, not swallowed");
  assert.ok(/channelId/.test(body),
    "the log must name the channel, otherwise it cannot be traced to a permission");
});

for (const type of ["status", "response"]) {
  check(`the ${type} handler resolves through resolveBridgeChannel`, () => {
    const body = handler(type);
    assert.ok(/resolveBridgeChannel\(/.test(body),
      `${type} resolves its own channel — a miss there is silent again`);
    assert.ok(!/channels\.cache\.get\(/.test(body),
      `${type} still reads channels.cache directly, which is the silent-drop path`);
  });
}

check("a status with no configured channel is logged, not dropped quietly", () => {
  const body = handler("status");
  assert.ok(/log\.warn\(/.test(body),
    "an agent sending status with no status channel configured must say so");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
