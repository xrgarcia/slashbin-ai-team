/**
 * Paperclip — a board task is answered once, through the bot's own run path,
 * and never sees the Discord conversation buffer.
 */
const assert = require("assert");
const { readFileSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { pickOpenRun, askOf, buildTaskPrompt, createPaperclipPoller, FALLBACK_REPLY } = require("../lib/paperclip");

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

  await check("the ask is the wake comment, else the latest human one — never the bot's own", () => {
    const comments = [{ id: "h1", authorAgentId: null, createdAt: "1" }, { id: "h2", authorAgentId: null, createdAt: "2" },
      { id: "r", authorAgentId: ME.id, createdAt: "3" }];
    assert.strictEqual(askOf(comments, "h1", ME.id).id, "h1");
    assert.strictEqual(askOf(comments, undefined, ME.id).id, "h2");
    assert.strictEqual(askOf(comments, "r", ME.id).id, "h2", "a run woken by the bot's own comment is not a new ask");
    assert.strictEqual(askOf([], undefined, ME.id), null);
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

  await check("a progress comment written during the run does not stop the saved answer being posted", async () => {
    // Second-pass review of 2.7.0: the progress note looked like an answer, so the
    // run was marked handled and the real answer was never posted.
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    const b = board({ runs: running, comments, wakeCommentId: "w" });
    let failPatch = 1;
    const flaky = async (url, init) => (init.method === "PATCH" && failPatch-- > 0)
      ? { ok: false, status: 502, text: async () => "bad gateway" } : b.fetch(url, init);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch: flaky,
      answer: async () => { calls++; comments.push({ id: "p", authorAgentId: ME.id, createdAt: "2026-01-02T00:01:00Z", body: "working on it" }); return "the answer"; } });
    await make().tick();          // runs; writes a progress note; the post fails
    await make().tick();          // a restarted bot
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(b.writes.map((w) => w.body.comment), ["the answer"]);
    assert.deepStrictEqual(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies, {});
  });

  await check("a saved answer whose post landed but whose response was lost is not posted twice", async () => {
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    const b = board({ runs: running, comments, wakeCommentId: "w" });
    let lost = 1;
    const flaky = async (url, init) => {
      if (init.method === "PATCH" && lost-- > 0) {
        comments.push({ id: "a", authorAgentId: ME.id, createdAt: "2026-01-02T00:02:00Z", body: JSON.parse(init.body).comment });
        return { ok: false, status: 504, text: async () => "gateway timeout" };
      }
      return b.fetch(url, init);
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch: flaky,
      answer: async () => "the answer" });
    await make().tick(); await make().tick();
    assert.strictEqual(b.writes.length, 0, "the answer was posted a second time");
    assert.deepStrictEqual(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies, {});
  });

  await check("a saved answer survives Paperclip re-waking the task under a new run", async () => {
    // Second-pass review of 2.7.0: saved answers were keyed by run id, so a
    // re-wake under run-2 found nothing and ran the same ask again.
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    const b = board({ runs: running, comments, wakeCommentId: "w" });
    let runs = running, failPatch = 1;
    const flaky = async (url, init) => {
      const path = url.replace(/^.*\/api/, "");
      if (init.method === "PATCH" && failPatch-- > 0) return { ok: false, status: 502, text: async () => "bad gateway" };
      if (path === "/issues/iss-1/runs") return { ok: true, text: async () => JSON.stringify(runs) };
      if (path === "/heartbeat-runs/run-2") return { ok: true, text: async () => JSON.stringify({ contextSnapshot: {} }) };
      return b.fetch(url, init);
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch: flaky,
      answer: async () => { calls++; return "the answer"; } });
    await make().tick();                                            // run-1 answers; the post fails
    runs = [{ id: "run-2", agentId: ME.id, status: "running" }];    // Paperclip re-wakes the open task
    await make().tick();
    assert.strictEqual(calls, 1, "the same ask ran twice");
    assert.deepStrictEqual(b.writes.map((w) => [w.body.comment, w.runId]), [["the answer", "run-2"]]);
  });

  await check("a new ask on the same task is answered, and an earlier unposted answer goes out with it", async () => {
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    const b = board({ runs: running, comments, wakeCommentId: "w" });
    let runs = running, failPatch = 1;
    const flaky = async (url, init) => {
      const path = url.replace(/^.*\/api/, "");
      if (init.method === "PATCH" && failPatch-- > 0) return { ok: false, status: 502, text: async () => "bad gateway" };
      if (path === "/issues/iss-1/runs") return { ok: true, text: async () => JSON.stringify(runs) };
      if (path === "/heartbeat-runs/run-2") return { ok: true, text: async () => JSON.stringify({ contextSnapshot: { wakeCommentId: "w2" } }) };
      return b.fetch(url, init);
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const answers = ["first answer", "second answer"];
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch: flaky,
      answer: async () => answers.shift() });
    await make().tick();
    comments.push({ id: "w2", authorAgentId: null, createdAt: "2026-01-02T00:05:00Z", body: "another ask" });
    runs = [{ id: "run-2", agentId: ME.id, status: "running" }];
    await make().tick();
    assert.deepStrictEqual(b.writes.map((w) => w.body.comment), ["first answer\n\n---\n\nsecond answer"],
      "the earlier ask's unposted answer must go out with the new one, not be dropped");
    assert.deepStrictEqual(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies, {});
  });

  await check("a progress note left by a run that never finished does not count as the answer", async () => {
    // Second-pass review of 2.7.0: any later comment of ours marked the ask
    // handled, so a restart mid-run left the task unanswered and open for good.
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" },
      { id: "p", authorAgentId: ME.id, createdAt: "2026-01-02T00:01:00Z", body: "working on it" }];
    const b = board({ runs: running, comments, wakeCommentId: "w" });
    let calls = 0;
    await poller(b, async () => { calls++; return "the answer"; }).tick();
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(b.writes.map((w) => w.body.comment), ["the answer"]);
  });

  await check("an answered ask is not answered again when Paperclip re-wakes it under a new run", async () => {
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    const b = board({ runs: running, comments, wakeCommentId: "w" });
    let runs = running;
    const fetch = async (url, init) => {
      const path = url.replace(/^.*\/api/, "");
      if (path === "/issues/iss-1/runs") return { ok: true, text: async () => JSON.stringify(runs) };
      if (path === "/heartbeat-runs/run-2") return { ok: true, text: async () => JSON.stringify({ contextSnapshot: {} }) };
      if (init.method === "PATCH") comments.push({ id: "a", authorAgentId: ME.id, createdAt: "2026-01-02T00:02:00Z", body: JSON.parse(init.body).comment });
      return b.fetch(url, init);
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
      answer: async () => { calls++; return "the answer"; } });
    await make().tick();
    runs = [{ id: "run-2", agentId: ME.id, status: "running" }];
    await make().tick();
    assert.strictEqual(calls, 1, "a re-wake answered the same ask twice");
    assert.strictEqual(b.writes.length, 1);
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
    assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies), ["iss-1:task"]);
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
