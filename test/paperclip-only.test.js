/**
 * Discord is optional: a bot on a Paperclip board starts, polls and reports
 * ready with no DISCORD_TOKEN, and a bot with neither surface refuses to start.
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

  console.log("\nNo surface — refuse to start, naming both");

  await check("no DISCORD_TOKEN and no board → exit EXIT_CONFIG (78), naming Discord and Paperclip", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-none", base), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /DISCORD_TOKEN/);
    assert.match(out, /PAPERCLIP_URL/);
    assert.ok(!/Discord login failed/.test(out), "tried to log in to Discord");
  });

  await check("a half-configured board is no board: still EXIT_CONFIG, with the board's problem said", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-half", base + 1, { PAPERCLIP_URL: "http://127.0.0.1:1" }), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /PAPERCLIP_URL and PAPERCLIP_API_KEY must both be set/);
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
    botEnv(dir, name, base + 2, { PAPERCLIP_URL: url, PAPERCLIP_API_KEY: "test-key" }), run,
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

  await check("doctor:fleet reads a bot with a board and no DISCORD_TOKEN as Paperclip-only", async () => {
    const { parseFleet } = await import("../scripts/lib/checks.mjs");
    const eco = join(dir, "ecosystem.config.js");
    writeFileSync(eco, `module.exports = { apps: [ { env: {\n  BOT_NAME: 'tech-lead',\n  PAPERCLIP_URL: 'https://board.example',\n  PAPERCLIP_API_KEY: process.env.TL_PAPERCLIP_KEY,\n} } ] };\n`);
    const [b] = parseFleet(eco);
    assert.strictEqual(b.discordTokenAbsent, true);
    assert.strictEqual(b.paperclipUrl, "https://board.example");
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
    assert.ok(!/No surface to answer on|Discord off/.test(out), out);
  });

  rmSync(dir, { recursive: true, force: true });
  for (const n of ["pctest-none", "pctest-half", "pctest-board", "pctest-discord"]) {
    for (const f of [`.${n}.pid`, `.${n}.ready`, `.${n}.surfaces.json`]) rmSync(join(REPO, f), { force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
