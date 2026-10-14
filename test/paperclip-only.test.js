/**
 * Discord is optional: a bot that declares BOT_SURFACES=paperclip starts, polls
 * and reports ready with no DISCORD_TOKEN. Paperclip-only is declared, never
 * inferred: a bot with no token and no declaration refuses to start, and a bot
 * that declares Paperclip without its connector refuses, naming the
 * prerequisite.
 *
 * These spawn bot.js for real. Paperclip is a stub HTTP server on loopback that
 * answers the two reads a poll makes with an empty inbox; Discord is never
 * reached, because with no token there is no client to log in.
 */
const assert = require("assert");
const { spawn } = require("child_process");
const { createServer } = require("http");
const { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const REPO = join(__dirname, "..");
const BOT = join(REPO, "bot.js");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

/** A clean env: no DISCORD_TOKEN or PAPERCLIP_* leaks in from the shell running the tests. */
function botEnv(dir, name, port, extra = {}) {
  const env = {};
  for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG"]) if (process.env[k]) env[k] = process.env[k];
  return { ...env, BOT_NAME: name, WS_PORT: String(port), CLAUDE_CWD: join(dir, "cwd"), BOT_STATE_DIR: join(dir, "state"),
    BOT_HISTORY_DIR: join(dir, "history"), SUMMARIZE_INTERVAL_MS: "0", ...extra };
}

/** Run bot.js until it exits or `until(output)` holds; resolves { code, out, child }. */
function runBot(env, cwd, { until = () => false, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BOT], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, child }); };
    const onData = (d) => { out += d; if (until(out)) finish(null); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => finish(code));
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

const stop = (child) => new Promise((r) => { if (child.exitCode !== null) return r(); child.on("exit", r); child.kill("SIGTERM"); });

function waitFor(cond, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error("timed out")); }
    }, 100);
  });
}

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-only-"));
  for (const d of ["cwd", "state", "history", "run"]) mkdirSync(join(dir, d));
  const run = join(dir, "run"); // the bot's working directory: an empty folder, so no dotenv file is loaded
  const base = 19000 + (process.pid % 500);

  const PREREQUISITE = /the Paperclip connector must be enabled first: set PAPERCLIP_URL and PAPERCLIP_API_KEY/;

  console.log("\nBOT_SURFACES — Paperclip-only is declared, and a declared surface is a prerequisite");

  await check("botSurfaces: unset is Discord, with any board as an addition", () => {
    const { botSurfaces } = require("../lib/surfaces");
    const s = botSurfaces({ DISCORD_TOKEN: "t" }, 1);
    assert.deepStrictEqual([s.discord, s.paperclip, s.paperclipRequired, s.errors.length], [true, true, false, 0]);
    assert.deepStrictEqual([botSurfaces({ DISCORD_TOKEN: "t" }, 0).paperclip], [false]);
  });

  await check("botSurfaces: declared is exactly what is named, and says what it ignores", () => {
    const { botSurfaces } = require("../lib/surfaces");
    const only = botSurfaces({ BOT_SURFACES: "paperclip", DISCORD_TOKEN: "t" }, 1);
    assert.deepStrictEqual([only.discord, only.paperclip, only.errors.length], [false, true, 0]);
    assert.match(only.notes.join(), /DISCORD_TOKEN is set, but BOT_SURFACES leaves Discord off/);
    const discord = botSurfaces({ BOT_SURFACES: "discord", DISCORD_TOKEN: "t" }, 1);
    assert.deepStrictEqual([discord.discord, discord.paperclip], [true, false]);
    assert.match(discord.notes.join(), /BOT_SURFACES leaves Paperclip off/);
    const both = botSurfaces({ BOT_SURFACES: " Discord , paperclip ", DISCORD_TOKEN: "t" }, 1);
    assert.deepStrictEqual([both.discord, both.paperclipRequired, both.errors.length], [true, true, 0]);
  });

  await check("botSurfaces: paperclip with no board names the prerequisite", () => {
    const { botSurfaces } = require("../lib/surfaces");
    assert.match(botSurfaces({ BOT_SURFACES: "paperclip" }, 0).errors.join(), PREREQUISITE);
    assert.match(botSurfaces({ BOT_SURFACES: "discord,paperclip", DISCORD_TOKEN: "t" }, 0).errors.join(), PREREQUISITE);
  });

  await check("no DISCORD_TOKEN and no board → exit EXIT_CONFIG (78), naming the token, BOT_SURFACES and the prerequisite", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-none", base), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /DISCORD_TOKEN is required/);
    assert.match(out, /BOT_SURFACES=paperclip/);
    assert.match(out, PREREQUISITE);
    assert.ok(!/Discord login failed/.test(out), "tried to log in to Discord");
  });

  await check("a board but no DISCORD_TOKEN and no BOT_SURFACES → EXIT_CONFIG, not a silent Paperclip-only bot", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-undeclared", base + 4,
      { PAPERCLIP_URL: "http://127.0.0.1:1", PAPERCLIP_API_KEY: "test-key" }), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /BOT_SURFACES is unset, so this bot answers on Discord/);
    assert.ok(!/Paperclip connector on|Discord off/.test(out), out);
  });

  await check("BOT_SURFACES=paperclip with no board → EXIT_CONFIG, naming the prerequisite", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-noboard", base + 5, { BOT_SURFACES: "paperclip" }), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /BOT_SURFACES includes paperclip, so the Paperclip connector must be enabled first/);
  });

  await check("BOT_SURFACES=paperclip with a half-configured board → EXIT_CONFIG, with the board's problem said", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-half", base + 1,
      { BOT_SURFACES: "paperclip", PAPERCLIP_URL: "http://127.0.0.1:1" }), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /PAPERCLIP_URL and PAPERCLIP_API_KEY must both be set/);
    assert.match(out, PREREQUISITE);
  });

  await check("an unknown surface → EXIT_CONFIG", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-bad", base + 6, { BOT_SURFACES: "slack" }), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /BOT_SURFACES=slack is not a surface list/);
  });

  console.log("\nPaperclip-only — up, polling, ready, and never on Discord");

  const hits = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/agents/me") return res.end(JSON.stringify({ id: "agent-1", name: "Throwaway" }));
    if (req.url === "/api/agents/me/inbox-lite") return res.end(JSON.stringify([]));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const name = "pctest-board";
  const readyFile = join(REPO, `.${name}.ready`);
  const surfacesFile = join(REPO, `.${name}.surfaces.json`);
  // A job aimed at a Discord channel, left from when the bot was on Discord.
  writeFileSync(join(dir, "state", "schedules.json"), JSON.stringify([{ id: "standup", cron: "0 9 * * 1-5", prompt: "post the standup", channel: "123456789012345678" }]));

  const { code, out, child } = await runBot(
    botEnv(dir, name, base + 2, { BOT_SURFACES: "paperclip", PAPERCLIP_URL: url, PAPERCLIP_API_KEY: "test-key" }), run,
    { until: (o) => /Paperclip board ready/.test(o) });

  await check("the process stays up and logs Discord off — Paperclip-only", async () => {
    assert.strictEqual(code, null, `exited ${code}\n${out}`);
    assert.match(out, /Discord off — Paperclip-only/);
    assert.match(out, /Paperclip connector on/);
  });

  await check("the first successful poll writes the ready file", async () => {
    await waitFor(() => existsSync(readyFile));
    assert.ok(hits.includes("GET /api/agents/me/inbox-lite"), `the board was never polled: ${hits.join(", ")}`);
  });

  await check("the surfaces file says Discord off and the board ready", () => {
    const s = JSON.parse(readFileSync(surfacesFile, "utf8"));
    assert.strictEqual(s.discord, "off");
    assert.deepStrictEqual(s.boards, { paperclip: "ready" });
  });

  await check("doctor's surface check reads it as ready, with Discord off", async () => {
    const { checkSurfaces, PASS } = await import("../scripts/lib/checks.mjs");
    const r = checkSurfaces(REPO, name);
    assert.strictEqual(r.status, PASS, r.detail);
    assert.match(r.detail, /Discord: off · board paperclip: ready/);
  });

  await check("a scheduled job aimed at a Discord channel is refused at load, and kept in the file", () => {
    assert.match(out, /Scheduled job refused — it posts to a Discord channel and Discord is off/);
    assert.ok(!/Scheduled job loaded/.test(out), "the job was loaded as if it could run");
    assert.strictEqual(JSON.parse(readFileSync(join(dir, "state", "schedules.json"), "utf8")).length, 1);
  });

  await check("doctor:fleet reads a bot declaring BOT_SURFACES=paperclip as Paperclip-only, and fails one that only lacks a token", async () => {
    const { parseFleet, checkFleet, PASS, FAIL } = await import("../scripts/lib/checks.mjs");
    const eco = join(dir, "ecosystem.config.js");
    // One app per block, each opening on a line of its own, as parseFleet splits them.
    const app = (n, extra) => `  {\n    BOT_NAME: '${n}',\n${extra}    PAPERCLIP_URL: 'https://board.example',\n    PAPERCLIP_API_KEY: process.env.TL_PAPERCLIP_KEY,\n  },\n`;
    writeFileSync(eco, `module.exports = { apps: [\n${app("tech-lead", "    BOT_SURFACES: 'paperclip',\n")}${app("lost-token", "")}] };\n`);
    const [b] = parseFleet(eco);
    assert.strictEqual(b.discordTokenAbsent, true);
    assert.strictEqual(b.surfaces, "paperclip");
    assert.strictEqual(b.paperclipUrl, "https://board.example");
    const rows = await checkFleet(eco, REPO, {});
    const row = (n) => rows.find((r) => r.name === n);
    assert.strictEqual(row("  tech-lead: token").status, PASS);
    assert.match(row("  tech-lead: token").detail, /Discord off — Paperclip-only/);
    assert.ok(!row("  tech-lead: BOT_SURFACES"), "a declared Paperclip-only bot was failed");
    assert.strictEqual(row("  lost-token: BOT_SURFACES").status, FAIL);
    assert.match(row("  lost-token: BOT_SURFACES").fix, /BOT_SURFACES: 'paperclip'/);
  });

  await check("no Discord login is ever attempted", () => {
    assert.ok(!/Discord login failed|Bot online/.test(out), out);
  });

  await stop(child);
  server.close();

  await check("shutdown removes the ready and surfaces files", () => {
    assert.ok(!existsSync(readyFile) && !existsSync(surfacesFile));
  });

  console.log("\nDiscord on — unchanged");

  await check("with a DISCORD_TOKEN and no board, the bot goes to Discord and needs nothing new", async () => {
    // A malformed token: Discord rejects it (or the network is absent). Either
    // way the login is what decides, not anything Paperclip-only added.
    const { code, out } = await runBot(botEnv(dir, "pctest-discord", base + 3, { DISCORD_TOKEN: "not-a-real-token" }), run, { timeoutMs: 30000 });
    assert.ok(code === 78 || code === 1, `exit ${code}\n${out}`);
    assert.match(out, /Discord login failed/);
    assert.ok(!/BOT_SURFACES|Discord off/.test(out), out);
  });

  rmSync(dir, { recursive: true, force: true });
  for (const n of ["pctest-none", "pctest-undeclared", "pctest-noboard", "pctest-half", "pctest-bad", "pctest-board", "pctest-discord"]) {
    for (const f of [`.${n}.pid`, `.${n}.ready`, `.${n}.surfaces.json`]) rmSync(join(REPO, f), { force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
