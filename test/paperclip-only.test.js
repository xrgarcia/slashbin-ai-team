/**
 * Discord is optional (issue #89): a bot with a usable board and no
 * DISCORD_TOKEN starts on its board alone, polls, answers and reports ready —
 * with BOT_SURFACES unset or declaring paperclip. A bot with neither a token
 * nor a board refuses to start, naming both, and a bot that declares a surface
 * without its prerequisite refuses, naming it.
 *
 * These spawn bot.js for real. Paperclip is a stub HTTP server on loopback that
 * answers the two reads a poll makes with an empty inbox; Discord is never
 * reached, because with no token there is no client to log in.
 */
const assert = require("assert");
const { spawn } = require("child_process");
const { createServer } = require("http");
const { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, chmodSync } = require("fs");
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

  console.log("\nSurfaces — unset answers wherever the bot is configured; a declared surface is a prerequisite");

  await check("botSurfaces: unset is Discord with a token, plus any board", () => {
    const { botSurfaces } = require("../lib/surfaces");
    const s = botSurfaces({ DISCORD_TOKEN: "t" }, 1);
    assert.deepStrictEqual([s.discord, s.paperclip, s.paperclipRequired, s.errors.length], [true, true, false, 0]);
    assert.deepStrictEqual([botSurfaces({ DISCORD_TOKEN: "t" }, 0).paperclip], [false]);
  });

  await check("botSurfaces: unset with a board and no token is Paperclip-only (#89), the board its one surface", () => {
    const { botSurfaces, discordOffReason } = require("../lib/surfaces");
    const s = botSurfaces({}, 1);
    assert.deepStrictEqual([s.discord, s.paperclip, s.paperclipRequired, s.declared, s.errors.length], [false, true, true, false, 0]);
    assert.match(discordOffReason(s), /^Discord off — Paperclip-only: no DISCORD_TOKEN/);
    assert.match(discordOffReason(botSurfaces({ BOT_SURFACES: "paperclip" }, 1)), /^Discord off — Paperclip-only: BOT_SURFACES=paperclip/);
  });

  await check("botSurfaces: unset with neither a token nor a board names both", () => {
    const { botSurfaces } = require("../lib/surfaces");
    const s = botSurfaces({}, 0);
    assert.strictEqual(s.errors.length, 1);
    assert.match(s.errors[0], /neither DISCORD_TOKEN nor a usable Paperclip board/);
    assert.match(s.errors[0], /set DISCORD_TOKEN for Discord, or for a Paperclip board set PAPERCLIP_URL and PAPERCLIP_API_KEY/);
  });

  await check("botSurfaces: an explicit discord without a token is still refused", () => {
    const { botSurfaces } = require("../lib/surfaces");
    assert.match(botSurfaces({ BOT_SURFACES: "discord" }, 1).errors.join(), /BOT_SURFACES includes discord, so DISCORD_TOKEN is required/);
    assert.match(botSurfaces({ BOT_SURFACES: "discord,paperclip" }, 1).errors.join(), /DISCORD_TOKEN is required/);
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

  await check("no DISCORD_TOKEN and no board → exit EXIT_CONFIG (78), naming both", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-none", base), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /neither DISCORD_TOKEN nor a usable Paperclip board is configured/);
    assert.match(out, /PAPERCLIP_URL and PAPERCLIP_API_KEY/);
    assert.ok(!/Discord login failed|Discord off/.test(out), "tried to start a surface");
  });

  await check("no DISCORD_TOKEN and only a half-configured board → EXIT_CONFIG, with the board's problem said", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-undeclared", base + 4, { PAPERCLIP_URL: "http://127.0.0.1:1" }), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /PAPERCLIP_URL and PAPERCLIP_API_KEY must both be set/);
    assert.match(out, /neither DISCORD_TOKEN nor a usable Paperclip board/);
  });

  await check("BOT_SURFACES=discord with no token → EXIT_CONFIG, even with a board", async () => {
    const { code, out } = await runBot(botEnv(dir, "pctest-discordonly", base + 7,
      { BOT_SURFACES: "discord", PAPERCLIP_URL: "http://127.0.0.1:1", PAPERCLIP_API_KEY: "test-key" }), run);
    assert.strictEqual(code, 78, `exit ${code}\n${out}`);
    assert.match(out, /BOT_SURFACES includes discord, so DISCORD_TOKEN is required/);
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

  await check("doctor:fleet reads a board bot without a token as Paperclip-only, declared or not, and fails one with neither", async () => {
    const { parseFleet, checkFleet, PASS, FAIL } = await import("../scripts/lib/checks.mjs");
    const eco = join(dir, "ecosystem.config.js");
    // One app per block, each opening on a line of its own, as parseFleet splits them.
    const app = (n, extra) => `  {\n    BOT_NAME: '${n}',\n${extra}    PAPERCLIP_URL: 'https://board.example',\n    PAPERCLIP_API_KEY: process.env.TL_PAPERCLIP_KEY,\n  },\n`;
    const nowhere = `  {\n    BOT_NAME: 'nowhere',\n  },\n`;
    writeFileSync(eco, `module.exports = { apps: [\n${app("tech-lead", "    BOT_SURFACES: 'paperclip',\n")}${app("sre", "")}${nowhere}] };\n`);
    const [b] = parseFleet(eco);
    assert.strictEqual(b.discordTokenAbsent, true);
    assert.strictEqual(b.surfaces, "paperclip");
    assert.strictEqual(b.paperclipUrl, "https://board.example");
    const rows = await checkFleet(eco, REPO, {});
    const row = (n) => rows.find((r) => r.name === n);
    assert.strictEqual(row("  tech-lead: token").status, PASS);
    assert.match(row("  tech-lead: token").detail, /Discord off — Paperclip-only/);
    assert.ok(!row("  tech-lead: BOT_SURFACES"), "a declared Paperclip-only bot was failed");
    assert.strictEqual(row("  sre: token").status, PASS);
    assert.match(row("  sre: token").detail, /Discord off — Paperclip-only \(no DISCORD_TOKEN, board configured\)/);
    assert.ok(!row("  sre: BOT_SURFACES"), "a Paperclip-only bot by configuration was failed");
    assert.strictEqual(row("  nowhere: BOT_SURFACES").status, FAIL);
    assert.match(row("  nowhere: BOT_SURFACES").detail, /neither DISCORD_TOKEN nor a usable Paperclip board/);
    assert.match(row("  nowhere: BOT_SURFACES").fix, /DISCORD_TOKEN, or put it on its Paperclip board/);
  });

  await check("no Discord login is ever attempted", () => {
    assert.ok(!/Discord login failed|Bot online/.test(out), out);
  });

  await stop(child);
  server.close();

  await check("shutdown removes the ready and surfaces files", () => {
    assert.ok(!existsSync(readyFile) && !existsSync(surfacesFile));
  });

  console.log("\nPaperclip-only by configuration (#89) — no BOT_SURFACES, no DISCORD_TOKEN, one board: up, answering, ready");

  {
    // One assigned task. The answer is a PATCH carrying the comment; the run is
    // a stand-in CLI that prints one stream-json reply.
    const ME = { id: "agent-1", name: "Throwaway" };
    const issue = { id: "iss-1", identifier: "T-1", title: "A question", status: "in_progress", assigneeAgentId: ME.id, createdAt: "2026-01-01T00:00:00Z" };
    const comments = [{ id: "h1", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "what is two plus two?" }];
    const runs = [{ id: "run-1", agentId: ME.id, status: "running" }];
    const activity = [];
    const answers = [];
    const routes = { "/agents/me": ME, "/agents/me/inbox-lite": [{ id: "iss-1" }], "/issues/iss-1": issue,
      "/issues/iss-1/comments": comments, "/issues/iss-1/runs": runs, "/issues/iss-1/activity": activity,
      "/heartbeat-runs/run-1": { contextSnapshot: {} } };
    const board = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const path = req.url.replace(/^\/api/, "").split("?")[0];
        if (req.method === "PATCH" && path === "/issues/iss-1") {
          const body = JSON.parse(raw || "{}");
          if (body.comment) {
            answers.push(body.comment);
            comments.push({ id: `a${comments.length}`, authorAgentId: ME.id, createdByRunId: req.headers["x-paperclip-run-id"], createdAt: "2026-01-02T00:02:00Z", body: body.comment });
          }
          if (body.status) {
            activity.unshift({ runId: req.headers["x-paperclip-run-id"], action: "issue.updated", actorType: "agent", actorId: ME.id,
              details: { changes: { status: { from: issue.status, to: body.status } } } });
            issue.status = body.status;
            if (body.status === "done") runs[0].status = "succeeded";
          }
          return res.end("{}");
        }
        if (req.method === "GET" && path in routes) return res.end(JSON.stringify(routes[path]));
        res.statusCode = 404; res.end("{}");
      });
    });
    await new Promise((r) => board.listen(0, "127.0.0.1", r));
    const fake = join(dir, "claude.cjs");   // .cjs: a package.json above tmp may declare ESM
    writeFileSync(fake, `#!/usr/bin/env node
for (const e of [{ type: "system", subtype: "init", session_id: "s-1" },
  { type: "assistant", message: { content: [{ type: "text", text: "BOARD-ANSWER-4" }] } },
  { type: "result", subtype: "success", is_error: false, result: "BOARD-ANSWER-4", session_id: "s-1" }]) console.log(JSON.stringify(e));
`);
    chmodSync(fake, 0o755);
    const n = "pctest-inferred";
    const ready = join(REPO, `.${n}.ready`);
    const surfaces = join(REPO, `.${n}.surfaces.json`);
    const res = await runBot(botEnv(dir, n, base + 8, { PAPERCLIP_URL: `http://127.0.0.1:${board.address().port}`, PAPERCLIP_API_KEY: "test-key", CLAUDE_BIN: fake }),
      run, { until: (o) => /Paperclip board ready/.test(o) });

    await check("the process stays up and logs Discord off — Paperclip-only, with no BOT_SURFACES", () => {
      assert.strictEqual(res.code, null, `exited ${res.code}\n${res.out}`);
      assert.match(res.out, /Discord off — Paperclip-only: no DISCORD_TOKEN and a Paperclip board configured/);
      assert.match(res.out, /Paperclip connector on/);
    });

    await check("it answers the assigned task on the board", async () => {
      await waitFor(() => answers.length > 0, 20000);
      assert.match(answers[0], /BOARD-ANSWER-4/);
    });

    await check("it reports ready: ready file written, Discord off and the board ready", async () => {
      await waitFor(() => existsSync(ready));
      const s = JSON.parse(readFileSync(surfaces, "utf8"));
      assert.strictEqual(s.discord, "off");
      assert.deepStrictEqual(s.boards, { paperclip: "ready" });
    });

    await check("no Discord client is built or logged in", () => {
      assert.ok(!/Discord login failed|Bot online|BOT_SURFACES/.test(res.out), res.out);
    });

    await stop(res.child);
    board.close();
  }

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
  for (const n of ["pctest-none", "pctest-undeclared", "pctest-discordonly", "pctest-noboard", "pctest-half", "pctest-bad", "pctest-board", "pctest-inferred", "pctest-discord"]) {
    for (const f of [`.${n}.pid`, `.${n}.ready`, `.${n}.surfaces.json`]) rmSync(join(REPO, f), { force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
