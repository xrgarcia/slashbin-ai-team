/**
 * A bot that cannot reach Discord must DIE, not linger.
 *
 * `client.login()` was called as a bare un-awaited promise. When it rejected the
 * only thing that caught it was the global `unhandledRejection` handler, which
 * logs and returns — and the process then stayed alive indefinitely, because the
 * WebSocket server and the scheduler's setInterval keep the event loop busy.
 *
 * The result, reproduced on a clean clone 2026-08-09: `npm start` printed
 * "Bot started", `npm run status` printed "Bot is running", and the bot was
 * permanently deaf. That is the worst state to hand a new user, and under PM2 it
 * means a bot on a revoked token reports `online` forever.
 *
 * These assertions run against the source text — bot.js cannot be require()d
 * because importing it logs a live bot into Discord.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const REPO = join(__dirname, "..");
const bot = readFileSync(join(REPO, "bot.js"), "utf8");
const manager = readFileSync(join(REPO, "bot-manager.mjs"), "utf8");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

console.log("\nStartup safety — a failed login must be fatal");

check("client.login has a rejection handler attached", () => {
  const m = /client\.login\([^)]*\)\s*\.catch\(/.test(bot);
  assert.ok(m, "client.login() is un-awaited with no .catch — a rejected login would leave a zombie");
});

check("the login rejection handler exits non-zero", () => {
  const start = bot.indexOf("client.login(");
  assert.ok(start > -1, "client.login not found");
  const tail = bot.slice(start);
  assert.ok(/process\.exit\(\s*[1-9]/.test(tail), "login failure must exit non-zero, not just log");
});

check("unhandledRejection is not the only guard on login", () => {
  // The handler may exist — it should just never be what catches a login failure.
  const loginIdx = bot.indexOf("client.login(");
  const catchIdx = bot.indexOf(".catch(", loginIdx);
  assert.ok(catchIdx > -1 && catchIdx - loginIdx < 200, "no .catch near client.login");
});

console.log("\nStartup validation — fail while someone is watching");

check("CLAUDE_CWD is validated at startup", () => {
  assert.ok(/existsSync\(CLAUDE_CWD\)/.test(bot), "CLAUDE_CWD is never checked for existence");
  assert.ok(/isDirectory\(\)/.test(bot), "CLAUDE_CWD is never checked to be a directory");
});

check("an empty ALLOWED_USERS produces a visible warning", () => {
  assert.ok(/ALLOWED_USER_IDS\.length === 0/.test(bot), "no empty-allowlist check");
  assert.ok(/log\.warn\(/.test(bot), "the empty-allowlist case must warn, not stay silent");
});

check("BOT_REQUIRE_ALLOWLIST can refuse to start open", () => {
  assert.ok(/BOT_REQUIRE_ALLOWLIST/.test(bot), "no strict-allowlist opt-in");
});

check("ALLOWED_USERS gates humans only — it must not veto an allowlisted bot", () => {
  // Securing a bot by setting ALLOWED_USERS used to silently kill bot-to-bot
  // coordination: a peer already whitelisted in ALLOWED_BOTS was then dropped
  // for not also appearing in ALLOWED_USERS.
  const m = /if \(!msg\.author\.bot && ALLOWED_USER_IDS\.length > 0/.test(bot);
  assert.ok(m, "the ALLOWED_USERS check must be scoped to non-bot authors");
});

console.log("\nConfiguration — nothing host-specific frozen into the source");

check("no hardcoded timezone or zone abbreviation remains", () => {
  assert.ok(!/America\/Chicago/.test(bot), "the host's timezone is still hardcoded");
  // The literal was appended on top of timeStyle:"long", which already emits the
  // abbreviation — so the prompt read "10:01 AM CDT CDT" in summer and
  // "6:00 AM CST CDT" in winter.
  assert.ok(!/\}\)\} CDT\)/.test(bot), "a literal zone abbreviation is still appended");
});

check("BOT_TIMEZONE is configurable and validated", () => {
  assert.ok(/BOT_TIMEZONE/.test(bot), "no BOT_TIMEZONE setting");
  assert.ok(/resolvedOptions\(\)\.timeZone/.test(bot), "default should be the host zone, not a baked-in city");
  assert.ok(/new Intl\.DateTimeFormat\("en-US", \{ timeZone: BOT_TIMEZONE \}\)/.test(bot),
    "an invalid IANA name must fail at startup, not on every message");
});

check("numeric settings are parsed safely, not with the ||-default idiom", () => {
  assert.ok(/function envInt\(/.test(bot), "no envInt helper");
  // `parseInt(x,10) || DEFAULT` swallows 0/NaN/negatives; for an interval a 0 that
  // slipped through would be a hot loop.
  assert.ok(/Number\.isFinite\(n\)/.test(bot), "envInt must reject non-numbers explicitly");
  assert.ok(/n < min/.test(bot), "envInt must clamp below a minimum");
});

check("the scheduler tick and WS bridge are configurable", () => {
  assert.ok(/BOT_SCHEDULE_CHECK_MS/.test(bot), "scheduler tick still frozen");
  assert.ok(/WS_HOST/.test(bot), "WS bind host still frozen");
  assert.ok(/const WS_HOST = process\.env\.WS_HOST \|\| "127\.0\.0\.1"/.test(bot),
    "the bridge must still default to loopback — it takes commands");
});

console.log("\nProcess manager — one checkout, many bots");

check("manager scopes pid/log by BOT_NAME", () => {
  assert.ok(/\.\$\{BOT_NAME\}\.pid/.test(manager), "PID file is not scoped by BOT_NAME");
  assert.ok(/\$\{BOT_NAME\}\.log/.test(manager), "log file is not scoped by BOT_NAME");
});

check("manager loads .env so it agrees with bot.js on BOT_NAME", () => {
  assert.ok(/dotenv\/config/.test(manager), "manager does not load .env — BOT_NAME set there would desync the two");
});

check("manager distinguishes connected from merely alive", () => {
  assert.ok(/\.ready/.test(manager), "manager has no readiness signal, so status cannot tell deaf from healthy");
});

check("bot writes a readiness marker only once Discord is ready", () => {
  assert.ok(/markReady\(\)/.test(bot), "no readiness marker written");
  const readyIdx = bot.indexOf('client.once("ready"');
  assert.ok(readyIdx > -1, "no ready handler");
  assert.ok(bot.indexOf("markReady()", readyIdx) - readyIdx < 100, "markReady must be inside the ready handler");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
