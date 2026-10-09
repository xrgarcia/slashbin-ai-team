/**
 * Paperclip — a board task is answered once, through the bot's own run path,
 * and never sees the Discord conversation buffer.
 */
const assert = require("assert");
const { readFileSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { pickOpenRun, alreadyAnswered, buildTaskPrompt, createPaperclipPoller, FALLBACK_REPLY } = require("../lib/paperclip");

const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const ME = { id: "agent-1", name: "Bot" };

function board({ runs, comments = [], wakeCommentId }) {
  const writes = [];
  const routes = {
    "GET /agents/me": ME,
    "GET /agents/me/inbox-lite": [{ id: "iss-1" }],
    "GET /issues/iss-1/runs": runs,
    "GET /issues/iss-1": { id: "iss-1", identifier: "T-1", title: "A question", createdAt: "2026-01-01T00:00:00Z" },
    "GET /issues/iss-1/comments": comments,
    "GET /heartbeat-runs/run-1": { contextSnapshot: { wakeCommentId } },
  };
  const fetch = async (url, init) => {
    const key = `${init.method} ${url.replace(/^.*\/api/, "")}`;
    if (init.method === "PATCH") { writes.push({ key, body: JSON.parse(init.body), runId: init.headers["x-paperclip-run-id"] }); return { ok: true, text: async () => "{}" }; }
    if (!(key in routes)) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, text: async () => JSON.stringify(routes[key]) };
  };
  return { fetch, writes };
}
const running = [{ id: "run-1", agentId: ME.id, status: "running" }];
const poller = (b, answer) => createPaperclipPoller({
  url: "https://board.example.com", apiKey: "k", stateFile: join(mkdtempSync(join(tmpdir(), "pc-")), "s.json"),
  answer, log: silent, fetch: b.fetch,
});

(async () => {
  await check("only this agent's running, unhandled run is picked", () => {
    const runs = [{ id: "a", agentId: "other", status: "running" }, { id: "b", agentId: ME.id, status: "succeeded" },
      { id: "c", agentId: ME.id, status: "running" }];
    assert.strictEqual(pickOpenRun(runs, ME.id, new Set()).id, "c");
    assert.strictEqual(pickOpenRun(runs, ME.id, new Set(["c"])), null);
  });

  await check("a run whose wake the agent already replied to is not answered again", () => {
    const comments = [{ id: "w", authorAgentId: null, createdAt: "1" }, { id: "r", authorAgentId: ME.id, createdAt: "2" }];
    assert.strictEqual(alreadyAnswered(comments, "w", ME.id, "0"), true);
    assert.strictEqual(alreadyAnswered([comments[0]], "w", ME.id, "0"), false);
  });

  await check("the prompt carries the task and its thread", () => {
    const p = buildTaskPrompt({ identifier: "T-1", title: "Q", description: "details" },
      [{ authorAgentId: null, createdAt: "1", body: "first ask" }], ME, "https://board.example.com");
    assert.match(p, /T-1: Q/); assert.match(p, /details/); assert.match(p, /first ask/);
  });

  await check("the answer is posted under the open run and the task closed", async () => {
    const b = board({ runs: running });
    await poller(b, async () => "the answer").tick();
    assert.deepStrictEqual(b.writes, [{ key: "PATCH /issues/iss-1", body: { status: "done", comment: "the answer" }, runId: "run-1" }]);
  });

  await check("a failed run still ends the wait, with the fallback", async () => {
    const b = board({ runs: running });
    await poller(b, async () => { throw new Error("boom"); }).tick();
    assert.strictEqual(b.writes[0].body.comment, FALLBACK_REPLY);
  });

  await check("a run is answered once across ticks", async () => {
    const b = board({ runs: running });
    let calls = 0;
    const p = poller(b, async () => { calls++; return "x"; });
    await p.tick(); await p.tick();
    assert.strictEqual(calls, 1);
  });

  await check("a failed post is retried without running the task again, even across a restart", async () => {
    // Second-pass review of 2.7.0: the run's answer was dropped when the PATCH
    // failed, so the next tick ran the task again — a second email, a second record.
    const b = board({ runs: running });
    let failPatch = 2;
    const flaky = async (url, init) => {
      if (init.method === "PATCH" && failPatch-- > 0) return { ok: false, status: 502, text: async () => "bad gateway" };
      return b.fetch(url, init);
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile,
      answer: async () => { calls++; return "the answer"; }, log: silent, fetch: flaky });
    await make().tick();          // runs the task; the post fails
    await make().tick();          // a restarted bot: the post fails again
    await make().tick();          // the post lands
    assert.strictEqual(calls, 1, "the task ran more than once");
    assert.deepStrictEqual(b.writes.map((w) => w.body.comment), ["the answer"]);
    const p = make(); await p.tick();
    assert.strictEqual(calls, 1); assert.strictEqual(b.writes.length, 1);
    assert.deepStrictEqual(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies, {});
  });

  await check("one task whose post keeps failing does not hold up the rest of the inbox", async () => {
    // Second-pass review of 2.7.0: a failure on task 1 left the loop, so task 2
    // was never reached on any tick.
    const writes = [];
    const routes = { "GET /agents/me": ME, "GET /agents/me/inbox-lite": [{ id: "iss-1" }, { id: "iss-2" }] };
    for (const n of [1, 2]) {
      routes[`GET /issues/iss-${n}/runs`] = [{ id: `run-${n}`, agentId: ME.id, status: "running" }];
      routes[`GET /issues/iss-${n}`] = { id: `iss-${n}`, identifier: `T-${n}`, title: "Q", createdAt: "2026-01-01T00:00:00Z" };
      routes[`GET /issues/iss-${n}/comments`] = [];
      routes[`GET /heartbeat-runs/run-${n}`] = { contextSnapshot: {} };
    }
    const fetch = async (url, init) => {
      const key = `${init.method} ${url.replace(/^.*\/api/, "")}`;
      if (init.method === "PATCH") {
        if (key === "PATCH /issues/iss-1") return { ok: false, status: 500, text: async () => "boom" };
        writes.push(key); return { ok: true, text: async () => "{}" };
      }
      return key in routes ? { ok: true, text: async () => JSON.stringify(routes[key]) } : { ok: false, status: 404, text: async () => "" };
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const asked = [];
    const p = createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile,
      answer: async (_, issue) => { asked.push(issue.identifier); return "a"; }, log: silent, fetch });
    await p.tick(); await p.tick();
    assert.deepStrictEqual(writes, ["PATCH /issues/iss-2"]);
    assert.deepStrictEqual(asked, ["T-1", "T-2"], "each task runs once; task 1 only retries its post");
    assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies), ["run-1"]);
  });

  await check("no unposted answer is dropped, however many pile up across a restart", async () => {
    // Second-pass review of 2.7.0: only the last 50 unposted answers were saved,
    // so the 51st failure made a restarted bot run the oldest task again.
    const N = 60, routes = { "GET /agents/me": ME, "GET /agents/me/inbox-lite": [] };
    for (let n = 1; n <= N; n++) {
      routes["GET /agents/me/inbox-lite"].push({ id: `iss-${n}` });
      routes[`GET /issues/iss-${n}/runs`] = [{ id: `run-${n}`, agentId: ME.id, status: "running" }];
      routes[`GET /issues/iss-${n}`] = { id: `iss-${n}`, identifier: `T-${n}`, title: "Q", createdAt: "2026-01-01T00:00:00Z" };
      routes[`GET /issues/iss-${n}/comments`] = [];
      routes[`GET /heartbeat-runs/run-${n}`] = { contextSnapshot: {} };
    }
    let down = true; const writes = [];
    const fetch = async (url, init) => {
      const key = `${init.method} ${url.replace(/^.*\/api/, "")}`;
      if (init.method === "PATCH") {
        if (down) return { ok: false, status: 503, text: async () => "down" };
        writes.push(key); return { ok: true, text: async () => "{}" };
      }
      return key in routes ? { ok: true, text: async () => JSON.stringify(routes[key]) } : { ok: false, status: 404, text: async () => "" };
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile,
      answer: async () => { calls++; return "a"; }, log: silent, fetch });
    await make().tick();          // every task runs; every post fails
    down = false;
    await make().tick();          // a restarted bot posts them all
    assert.strictEqual(calls, N, "a task ran more than once");
    assert.strictEqual(writes.length, N);
  });

  await check("bot.js: board runs never see the buffer, and the key never reaches Claude", () => {
    assert.match(bot, /noBufferContext: true/);
    assert.match(bot, /opts\.noBufferContext \? "" : buildContextPrompt/);
    assert.match(bot, /delete cleanEnv\.PAPERCLIP_API_KEY/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
