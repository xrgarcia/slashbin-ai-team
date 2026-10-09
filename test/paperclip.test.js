/**
 * Paperclip — a board task is answered once, through the bot's own run path,
 * and never sees the Discord conversation buffer.
 */
const assert = require("assert");
const { readFileSync, readdirSync, writeFileSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { pickOpenRun, askOf, askKey, buildTaskPrompt, replyCollector, createPaperclipPoller, FALLBACK_REPLY, ALREADY_ANSWERED } = require("../lib/paperclip");

const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const ME = { id: "agent-1", name: "Bot" };

function board({ runs, comments = [], wakeCommentId }) {
  const writes = [], activity = [];
  let race = null, lose = 0;
  const routes = {
    "GET /issues/iss-1/activity": activity,
    "GET /agents/me": ME,
    "GET /agents/me/inbox-lite": [{ id: "iss-1" }],
    "GET /issues/iss-1/runs": runs,
    "GET /issues/iss-1": { id: "iss-1", identifier: "T-1", title: "A question", createdAt: "2026-01-01T00:00:00Z" },
    "GET /issues/iss-1/comments": comments,
    "GET /heartbeat-runs/run-1": { contextSnapshot: { wakeCommentId } },
  };
  const fetch = async (url, init) => {
    const key = `${init.method} ${url.replace(/^.*\/api/, "")}`;
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      writes.push({ key, body, runId: init.headers["x-paperclip-run-id"] });
      const issue = routes["GET /issues/iss-1"];
      // A person's status change that lands just before this write, after the bot's last read.
      if (race && body.status === "done") { issue.status = race; race = null; }
      if (body.status) {
        // Paperclip records each update's from/to under the row lock, newest first.
        activity.unshift({ runId: init.headers["x-paperclip-run-id"], action: "issue.updated",
          details: { changes: { status: { from: issue.status ?? "todo", to: body.status } } } });
        issue.status = body.status;
      }
      if (lose-- > 0) return { ok: false, status: 502, text: async () => "bad gateway" };
      return { ok: true, text: async () => "{}" };
    }
    if (!(key in routes)) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, text: async () => JSON.stringify(routes[key]) };
  };
  return { fetch, writes, setStatus: (st) => { routes["GET /issues/iss-1"].status = st; },
    status: () => routes["GET /issues/iss-1"].status,
    raceClose: (st, { loseResponse = false } = {}) => { race = st; lose = loseResponse ? 1 : 0; } };
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

  await check("the ask is the latest comment from a person still on the thread — never the bot's own", () => {
    const comments = [{ id: "h1", authorAgentId: null, createdAt: "1" }, { id: "h2", authorAgentId: null, createdAt: "2" },
      { id: "r", authorAgentId: ME.id, createdAt: "3" }];
    assert.strictEqual(askOf(comments, ME.id).id, "h2", "the newest comment from a person, as the prompt says");
    assert.strictEqual(askOf([...comments, { id: "h3", authorAgentId: null, createdAt: "4", deletedAt: "5" }], ME.id).id, "h2",
      "a deleted comment is not on the thread the bot sees");
    assert.strictEqual(askOf([], ME.id), null);
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

  await check("a comment that lands while the bot is answering keeps the task open for it", async () => {
    const comments = [{ id: "h1", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "first ask" }];
    const b = board({ runs: running, comments });
    const p = poller(b, async () => {
      comments.push({ id: "h2", authorAgentId: null, createdAt: "2026-01-03T00:00:00Z", body: "and another thing" });
      return "answer to the first";
    });
    await p.tick();
    assert.deepStrictEqual(b.writes, [{ key: "PATCH /issues/iss-1", body: { comment: "answer to the first" }, runId: "run-1" }],
      "the answer posts, but the task is not marked done over an ask it never saw");
  });

  await check("a comment that lands as the task closes reopens it, for the answer and for a re-wake note", async () => {
    // Second-pass review of 2.7.0: a comment between the last read and the close
    // was closed over — the newer ask sat unanswered on a done task.
    for (const rewake of [false, true]) {
      const comments = [{ id: "h1", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "first ask" }];
      let runs = running, landing = false;
      const b = board({ runs, comments });
      const fetch = async (url, init) => {
        if (url.endsWith("/issues/iss-1/runs")) return { ok: true, text: async () => JSON.stringify(runs) };
        if (init.method === "PATCH") {
          comments.push({ id: `a${comments.length}`, authorAgentId: ME.id, createdByRunId: init.headers["x-paperclip-run-id"], createdAt: "2026-01-02T00:02:00Z", body: JSON.parse(init.body).comment ?? "" });
          if (landing) { landing = false; comments.push({ id: "h2", authorAgentId: null, createdAt: "2026-01-02T00:03:00Z", body: "one more" }); }
        }
        return b.fetch(url, init);
      };
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
        answer: async () => "the answer" });
      if (rewake) { await make().tick(); runs = [{ id: "run-2", agentId: ME.id, status: "running" }]; b.writes.length = 0; }
      landing = true;
      await make().tick();
      const run = rewake ? "run-2" : "run-1";
      assert.deepStrictEqual(b.writes.map((w) => [w.runId, w.body]),
        [[run, { status: "done", comment: rewake ? ALREADY_ANSWERED : "the answer" }], [run, { status: "todo" }]],
        `${rewake ? "re-wake note" : "answer"}: the newer ask was left on a done task`);
    }
  });

  await check("a reopen that fails is retried on later polls, across a restart, without running the ask again", async () => {
    // Second-pass review of 2.7.0: the run was marked handled before the reopen,
    // so one failed reopen left the newer ask on a done task for good.
    for (const rewake of [false, true]) {
      const comments = [{ id: "h1", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "first ask" }];
      const issue = { id: "iss-1", identifier: "T-1", title: "A question", status: "in_progress", createdAt: "2026-01-01T00:00:00Z" };
      let runs = running, landing = false, reopenFails = 0;
      const writes = [];
      const fetch = async (url, init) => {
        const path = url.replace(/^.*\/api/, "");
        if (init.method === "PATCH") {
          const body = JSON.parse(init.body);
          if (body.status === "todo" && reopenFails-- > 0) return { ok: false, status: 503, text: async () => "unavailable" };
          writes.push([init.headers["x-paperclip-run-id"], body]);
          if (body.status) issue.status = body.status;
          if (body.comment) comments.push({ id: `a${comments.length}`, authorAgentId: ME.id, createdByRunId: init.headers["x-paperclip-run-id"], createdAt: "2026-01-02T00:02:00Z", body: body.comment });
          if (landing) { landing = false; comments.push({ id: "h2", authorAgentId: null, createdAt: "2026-01-02T00:03:00Z", body: "one more" }); }
          return { ok: true, text: async () => "{}" };
        }
        const routes = { "/agents/me": ME, "/agents/me/inbox-lite": [{ id: "iss-1" }], "/issues/iss-1": issue,
          "/issues/iss-1/comments": comments, "/issues/iss-1/runs": runs, "/issues/iss-1/activity": [] };
        return path in routes ? { ok: true, text: async () => JSON.stringify(routes[path]) } : { ok: false, status: 404, text: async () => "" };
      };
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      let calls = 0;
      const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
        answer: async () => { calls++; return "the answer"; } });
      if (rewake) { await make().tick(); runs = [{ id: "run-2", agentId: ME.id, status: "running" }]; writes.length = 0; issue.status = "in_progress"; }
      landing = true; reopenFails = 1;
      await make().tick();          // closes; the newer ask lands; the reopen fails
      assert.strictEqual(issue.status, "done");
      await make().tick();          // a restarted bot retries the reopen
      await make().tick();          // and does nothing more once it is done
      const run = rewake ? "run-2" : "run-1";
      assert.strictEqual(calls, 1, "the answered ask ran again");
      assert.deepStrictEqual(writes, [[run, { status: "done", comment: rewake ? ALREADY_ANSWERED : "the answer" }], [run, { status: "todo" }]],
        `${rewake ? "re-wake note" : "answer"}: the reopen was not retried`);
      assert.deepStrictEqual(JSON.parse(readFileSync(stateFile, "utf8")).closing, {});
    }
  });

  await check("a task a person cancelled or blocked as it closed is never reopened", async () => {
    // Second-pass review of 2.7.0: the look after closing reopened any task whose
    // ask moved, so a comment-and-cancel came back as todo.
    for (const decided of ["cancelled", "blocked"]) {
      const comments = [{ id: "h1", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "first ask" }];
      const issue = { id: "iss-1", identifier: "T-1", title: "A question", status: "in_progress", createdAt: "2026-01-01T00:00:00Z" };
      const writes = [];
      const fetch = async (url, init) => {
        const path = url.replace(/^.*\/api/, "");
        if (init.method === "PATCH") {
          const body = JSON.parse(init.body);
          writes.push(body);
          comments.push({ id: "h2", authorAgentId: null, createdAt: "2026-01-02T00:03:00Z", body: "never mind" });
          issue.status = decided;     // the person's decision lands right after the close
          return { ok: true, text: async () => "{}" };
        }
        const routes = { "/agents/me": ME, "/agents/me/inbox-lite": [{ id: "iss-1" }], "/issues/iss-1": issue,
          "/issues/iss-1/comments": comments, "/issues/iss-1/runs": running };
        return path in routes ? { ok: true, text: async () => JSON.stringify(routes[path]) } : { ok: false, status: 404, text: async () => "" };
      };
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      await createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
        answer: async () => "the answer" }).tick();
      assert.deepStrictEqual(writes, [{ status: "done", comment: "the answer" }], `a ${decided} task was reopened`);
      assert.strictEqual(issue.status, decided);
    }
  });

  await check("a task a person blocked or cancelled while the bot answered keeps that status", async () => {
    // Second-pass review of 2.7.0: the close compared only the ask, so a status
    // change with no comment was overwritten with done — answer and re-wake alike.
    for (const decided of ["cancelled", "blocked"]) for (const rewake of [false, true]) {
      const comments = [{ id: "h1", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
      let runs = running;
      const b = board({ runs, comments });
      const fetch = async (url, init) => {
        if (url.endsWith("/issues/iss-1/runs")) return { ok: true, text: async () => JSON.stringify(runs) };
        return b.fetch(url, init);
      };
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const make = (ans) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch, answer: ans });
      if (rewake) {
        await make(async () => "the answer").tick();
        runs = [{ id: "run-2", agentId: ME.id, status: "running" }]; b.writes.length = 0;
        b.setStatus(decided);
        await make(async () => "unused").tick();
      } else {
        await make(async () => { b.setStatus(decided); return "the answer"; }).tick();
      }
      assert.deepStrictEqual(b.writes.map((w) => w.body), [{ comment: rewake ? ALREADY_ANSWERED : "the answer" }],
        `${decided}, ${rewake ? "re-wake" : "answer"}: the status was overwritten`);
    }
  });

  await check("a task a person blocked or cancelled just before the close lands gets that status back", async () => {
    // Second-pass review of 2.7.0: a decision made after the bot's last read but
    // before its close was overwritten with done, and nothing put it back — not
    // even when the close's response was lost and a restarted bot looked again.
    for (const decided of ["cancelled", "blocked"]) for (const rewake of [false, true]) for (const lost of [false, true]) {
      const comments = [{ id: "h1", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
      let runs = running;
      const b = board({ runs, comments });
      const fetch = async (url, init) => {
        if (url.endsWith("/issues/iss-1/runs")) return { ok: true, text: async () => JSON.stringify(runs) };
        return b.fetch(url, init);
      };
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
        answer: async () => "the answer" });
      const label = `${decided}, ${rewake ? "re-wake" : "answer"}${lost ? ", response lost" : ""}`;
      if (rewake) { await make().tick(); runs = [{ id: "run-2", agentId: ME.id, status: "running" }]; b.writes.length = 0; b.setStatus("in_progress"); }
      b.raceClose(decided, { loseResponse: lost });
      await make().tick();
      if (lost) await make().tick();   // a restarted bot finishes the look after closing
      await make().tick();             // and does nothing more
      assert.strictEqual(b.status(), decided, `${label}: the decision was overwritten`);
      const run = rewake ? "run-2" : "run-1";
      assert.deepStrictEqual(b.writes.filter((w) => w.body.status).map((w) => [w.runId, w.body.status]),
        [[run, "done"], [run, decided]], `${label}: unexpected status writes`);
      assert.deepStrictEqual(JSON.parse(readFileSync(stateFile, "utf8")).closing, {}, `${label}: the close was never settled`);
    }
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

  await check("an answered ask stays answered across a restart, however many came after it", async () => {
    // Second-pass review of 2.7.0: answeredAsks kept only the newest 5,000, so an
    // older task re-woken after a restart ran again.
    const runs = [{ id: "run-1", agentId: ME.id, status: "running" }];
    const b = board({ runs });
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile,
      answer: async () => { calls++; return "the answer"; }, log: silent, fetch: b.fetch });
    await make().tick();
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    s.answeredAsks.push(...Array.from({ length: 6000 }, (_, i) => `other-${i}:k`));
    writeFileSync(stateFile, JSON.stringify(s));
    runs.splice(0, 1, { id: "run-2", agentId: ME.id, status: "running" });
    await make().tick();          // a re-wake after a restart; the state is saved back
    runs.splice(0, 1, { id: "run-3", agentId: ME.id, status: "running" });
    await make().tick();          // and again
    assert.strictEqual(calls, 1, "the task ran again");
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
        comments.push({ id: "a", authorAgentId: ME.id, createdByRunId: init.headers["x-paperclip-run-id"], createdAt: "2026-01-02T00:02:00Z", body: JSON.parse(init.body).comment });
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
      if (init.method === "PATCH") comments.push({ id: "a", authorAgentId: ME.id, createdByRunId: init.headers["x-paperclip-run-id"], createdAt: "2026-01-02T00:02:00Z", body: JSON.parse(init.body).comment });
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
    // Second-pass review of 2.7.0: the re-wake was marked handled with nothing
    // under it, and a run is held open until a comment lands under it.
    assert.deepStrictEqual(b.writes.map((w) => [w.runId, w.body.comment]), [["run-1", "the answer"], ["run-2", ALREADY_ANSWERED]]);
    await make().tick();
    assert.strictEqual(b.writes.length, 2, "the re-wake was acknowledged twice");
  });

  await check("a bot that dies mid-answer does not run the ask again after a restart", async () => {
    // Second-pass review of 2.7.0: the attempt was saved only after the run, so
    // a crash in between ran the ask twice — a second email, a second record.
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    let runs = running;
    const b = board({ runs, comments });
    const fetch = async (url, init) => url.endsWith("/issues/iss-1/runs")
      ? { ok: true, text: async () => JSON.stringify(runs) } : b.fetch(url, init);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0, started;
    const inRun = new Promise((r) => { started = r; });
    createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
      answer: () => { calls++; started(); return new Promise(() => {}); } }).tick();   // dies mid-run
    await inRun;
    runs = [{ id: "run-2", agentId: ME.id, status: "running" }];
    await createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
      answer: async () => { calls++; return "the answer"; } }).tick();
    assert.strictEqual(calls, 1, "the ask ran a second time");
    assert.deepStrictEqual(b.writes.map((w) => [w.runId, w.body.comment]), [["run-2", FALLBACK_REPLY]]);
  });

  await check("a damaged state file stops board tasks rather than running answered ones again", async () => {
    // Second-pass review of 2.7.0: the state was overwritten in place and an
    // unreadable file was read as empty, so a torn write re-ran every task.
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    let runs = running;
    const b = board({ runs, comments });
    const fetch = async (url, init) => url.endsWith("/issues/iss-1/runs")
      ? { ok: true, text: async () => JSON.stringify(runs) } : b.fetch(url, init);
    const dir = mkdtempSync(join(tmpdir(), "pc-")), stateFile = join(dir, "s.json");
    let calls = 0, errors = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, fetch,
      log: { ...silent, error() { errors++; } }, answer: async () => { calls++; return "the answer"; } });
    await make().tick();
    assert.deepStrictEqual(readdirSync(dir), ["s.json"], "the state is written through a temp file that is renamed into place");
    const whole = readFileSync(stateFile, "utf8");
    writeFileSync(stateFile, whole.slice(0, whole.length >> 1));
    runs = [{ id: "run-2", agentId: ME.id, status: "running" }];
    await make().tick();
    assert.strictEqual(calls, 1, "an answered ask ran again from a damaged state file");
    assert.strictEqual(b.writes.length, 1);
    assert.strictEqual(errors, 1, "the damaged file is reported");
  });

  await check("a re-wake note that fails to send is retried until it lands, never dropped", async () => {
    // Second-pass review of 2.7.0: the run was marked handled though its note
    // never reached the board, so the board waited on it for good.
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    const b = board({ runs: running, comments });
    let runs = running, down = 0;
    const fetch = async (url, init) => {
      const path = url.replace(/^.*\/api/, "");
      if (path === "/issues/iss-1/runs") return { ok: true, text: async () => JSON.stringify(runs) };
      if (init.method === "PATCH" && down-- > 0) return { ok: false, status: 503, text: async () => "unavailable" };
      if (init.method === "PATCH") comments.push({ id: `a${comments.length}`, authorAgentId: ME.id, createdByRunId: init.headers["x-paperclip-run-id"], createdAt: "2026-01-02T00:02:00Z", body: JSON.parse(init.body).comment });
      return b.fetch(url, init);
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
      answer: async () => { calls++; return "the answer"; } });
    await make().tick();
    runs = [{ id: "run-2", agentId: ME.id, status: "running" }];
    down = 1;
    await make().tick();          // the note fails, unapplied
    await make().tick();          // a restarted bot retries it
    await make().tick();          // and does not send it again once it landed
    assert.strictEqual(calls, 1, "the task ran again");
    assert.deepStrictEqual(b.writes.map((w) => [w.runId, w.body.comment]), [["run-1", "the answer"], ["run-2", ALREADY_ANSWERED]]);
  });

  await check("an answer is filed under the comment it answers, not the one that woke the run", async () => {
    // Second-pass review of 2.7.0: comment B arrived before A's wake ran, the
    // answer to B was saved under A, and B's own wake ran B again.
    const comments = [{ id: "A", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask A" },
      { id: "B", authorAgentId: null, createdAt: "2026-01-02T00:00:30Z", body: "ask B" }];
    const b = board({ runs: running, comments, wakeCommentId: "A" });
    let runs = running, failPatch = 1;
    const fetch = async (url, init) => {
      const path = url.replace(/^.*\/api/, "");
      if (init.method === "PATCH" && failPatch-- > 0) return { ok: false, status: 502, text: async () => "bad gateway" };
      if (path === "/issues/iss-1/runs") return { ok: true, text: async () => JSON.stringify(runs) };
      if (path === "/heartbeat-runs/run-2") return { ok: true, text: async () => JSON.stringify({ contextSnapshot: { wakeCommentId: "B" } }) };
      return b.fetch(url, init);
    };
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let calls = 0;
    const make = () => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
      answer: async () => { calls++; return "answer to B"; } });
    await make().tick();                                            // A's wake answers B; the post fails
    runs = [{ id: "run-2", agentId: ME.id, status: "running" }];    // B's wake
    await make().tick();
    assert.strictEqual(calls, 1, "B was run twice");
    assert.deepStrictEqual(b.writes.map((w) => w.body.comment), ["answer to B"]);
  });

  await check("an edited ask or a revised task is answered again; an unchanged re-wake is not", async () => {
    // Second-pass review of 2.7.0: the key named the ask but not its content, so
    // a reopened task with a new description, or an edited ask, was never answered.
    const comments = [{ id: "w", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "ask" }];
    const issue = { id: "iss-1", identifier: "T-1", title: "A question", description: "v1", createdAt: "2026-01-01T00:00:00Z" };
    let run = 0;
    const fetch = async (url, init) => {
      const path = url.replace(/^.*\/api/, "");
      if (init.method === "PATCH") { writes.push(JSON.parse(init.body).comment); return { ok: true, text: async () => "{}" }; }
      const routes = { "/agents/me": ME, "/agents/me/inbox-lite": [{ id: "iss-1" }], "/issues/iss-1": issue,
        "/issues/iss-1/comments": comments, "/issues/iss-1/runs": [{ id: `run-${run}`, agentId: ME.id, status: "running" }] };
      return path in routes ? { ok: true, text: async () => JSON.stringify(routes[path]) } : { ok: false, status: 404, text: async () => "" };
    };
    const writes = [];
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const tick = () => { run++; return createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch,
      answer: async () => `answer ${++n}` }).tick(); };
    await tick();                          // answered
    await tick();                          // unchanged re-wake: nothing
    comments[0] = { ...comments[0], body: "ask, edited" };
    await tick();                          // the ask was edited
    issue.description = "v2";
    await tick();                          // the task was revised and reopened
    assert.deepStrictEqual(writes, ["answer 1", ALREADY_ANSWERED, "answer 2", "answer 3"]);
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
    assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies),
      [askKey("iss-1", { id: "iss-1", identifier: "T-1", title: "Q", createdAt: "2026-01-01T00:00:00Z" }, null)]);
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

  await check("a file the run made is named as not delivered, never left to read as attached", () => {
    // Second-pass review of 2.7.0: the collector kept only text, so "the report
    // is attached" closed the task with no report.
    const r = replyCollector();
    r.collect("The report is attached.");
    r.collect({ files: [{ attachment: "/home/bot/outbox/report.csv" }] });
    assert.strictEqual(r.text(), "The report is attached.\n\nNot delivered: report.csv. Files cannot be attached to a board task — ask for it in a channel that takes files.");
    const plain = replyCollector(); plain.collect("just text");
    assert.strictEqual(plain.text(), "just text");
    assert.match(buildTaskPrompt({ identifier: "T-1", title: "Q" }, [], ME, "u"), /cannot attach a file/);
    assert.match(bot, /reply\.collect, \{\}, "paperclip"/, "the board run collects through replyCollector");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
