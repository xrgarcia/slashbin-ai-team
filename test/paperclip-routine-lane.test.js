/**
 * Paperclip — a routine's card has a lane of its own. Ordinary cards are
 * worked one at a time and one can run for most of an hour; the daily routine
 * card behind it waited 25 minutes (2026-11-07). Cards a routine opened (originKind routine_execution) are worked
 * beside the serial lane, a few at once, and no card is ever held by two
 * handlers.
 */
const assert = require("assert");
const { mkdtempSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
const settle = () => new Promise((r) => setTimeout(r, 25));

/** cards: [{ n, routine }]. Each is assigned to the seat with a live run and one ask. */
function board(cards, { routineFilter = true } = {}) {
  const state = new Map(cards.map((c) => [c.n, {
    card: { id: `c-${c.n}`, identifier: `SLA-${c.n}`, title: "Q", description: "d", status: "in_progress", assigneeAgentId: "agent-em", assigneeUserId: null,
      labels: [], createdAt: "2026-01-01T00:00:00Z", createdByUserId: "user-avery", requestDepth: 0, originKind: c.routine ? "routine_execution" : "manual" },
    comments: [{ id: `k${c.n}`, authorAgentId: null, authorUserId: "user-avery", createdAt: "2026-01-01T00:00:01Z", body: "Go." }],
    runs: [{ id: `r${c.n}`, agentId: "agent-em", status: "running" }], activity: [],
  }]));
  const queries = [];
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-em", name: "Engineering Manager", companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok([{ id: "agent-em", name: "Engineering Manager" }]);
    if (path === "/companies/co-1/user-directory") return ok({ users: [] });
    if (path === "/agents/me/inbox-lite") return ok([...state.values()].map((s) => ({ id: s.card.id, identifier: s.card.identifier, status: s.card.status, unresolvedBlockerIssueIds: [] })));
    if (path.startsWith("/companies/co-1/issues?")) {
      queries.push(path);
      if (!routineFilter) return { ok: false, status: 500, text: async () => "boom" };
      return ok([...state.values()].filter((s) => s.card.originKind === "routine_execution").map((s) => s.card));
    }
    if (/^\/heartbeat-runs\/r\d+$/.test(path)) return ok({ contextSnapshot: {} });
    const m = path.match(/^\/issues\/c-(\d+)(\/[a-z]+)?$/);
    const s = m && state.get(Number(m[1]));
    if (!s) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      if (body.status) s.card.status = body.status;
      if ("comment" in body) { s.comments.push({ id: `c${s.comments.length}`, authorAgentId: "agent-em", createdAt: new Date().toISOString(), body: body.comment }); s.runs[0].status = "succeeded"; }
      return ok({});
    }
    if (!m[2]) return ok({ ...s.card, blockedBy: [] });
    if (m[2] === "/activity") return ok(s.activity);
    if (m[2] === "/comments") return ok(s.comments);
    if (m[2] === "/runs") return ok(s.runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { fetch, queries, state };
}

/** An answer the test ends by hand, that records what overlapped. */
function gate() {
  const started = [], releases = new Map();
  let concurrent = 0, peak = 0, twice = 0;
  const answer = (_, issue) => new Promise((resolve, reject) => {
    if (started.includes(issue.identifier)) twice++;
    started.push(issue.identifier); concurrent++; peak = Math.max(peak, concurrent);
    releases.set(issue.identifier, (refuse) => { concurrent--; refuse ? reject(Object.assign(new Error("limit"), { refusal: { reason: "usage limit" } })) : resolve("done"); });
  });
  return { answer, started, release: (id) => releases.get(id)(), refuse: (id) => releases.get(id)(true), get peak() { return peak; }, get twice() { return twice; } };
}
const poller = (b, g, stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json")) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile,
  answer: g.answer, log: silent, fetch: b.fetch });

(async () => {
  await check("a routine card is dispatched while an ordinary card is still in flight", async () => {
    const g = gate();
    const p = poller(board([{ n: 1 }, { n: 2, routine: true }]), g);
    const first = p.tick("poll");            // the serial lane takes SLA-1 and holds it
    await settle();
    assert.deepStrictEqual(g.started.sort(), ["SLA-1", "SLA-2"], "SLA-2 ran beside SLA-1 on the same poll");
    g.release("SLA-1"); g.release("SLA-2"); await first; await p.idle();

    // A routine card that appears while the serial lane is busy is taken by the next poll.
    const g2 = gate();
    const b2 = board([{ n: 1 }]);
    const p2 = poller(b2, g2);
    const long = p2.tick("poll");
    await settle();
    assert.deepStrictEqual(g2.started, ["SLA-1"]);
    b2.state.set(3, { card: { id: "c-3", identifier: "SLA-3", title: "Daily", description: "d", status: "in_progress", assigneeAgentId: "agent-em", assigneeUserId: null,
      labels: [], createdAt: "2026-01-01T00:00:00Z", createdByUserId: "user-avery", requestDepth: 0, originKind: "routine_execution" },
      comments: [{ id: "k3", authorAgentId: null, authorUserId: "user-avery", createdAt: "2026-01-01T00:00:01Z", body: "Go." }],
      runs: [{ id: "r3", agentId: "agent-em", status: "running" }], activity: [] });
    await p2.tick("poll");                   // returns at once: the serial lane is busy
    await settle();
    assert.deepStrictEqual(g2.started.sort(), ["SLA-1", "SLA-3"], "the routine card did not wait for SLA-1");
    g2.release("SLA-3"); g2.release("SLA-1"); await long; await p2.idle();
  });

  await check("the same card is never handled twice at once, across overlapping polls", async () => {
    const g = gate();
    const p = poller(board([{ n: 1 }, { n: 2, routine: true }]), g);
    const first = p.tick("poll"); await settle();
    for (let i = 0; i < 4; i++) { await p.tick("poll"); await settle(); }
    assert.deepStrictEqual(g.started.sort(), ["SLA-1", "SLA-2"], "each card started once however many polls ran");
    assert.strictEqual(g.twice, 0);
    g.release("SLA-1"); g.release("SLA-2"); await first; await p.idle();
  });

  await check("ordinary cards stay serial and routine cards are capped", async () => {
    const g = gate();
    const p = poller(board([{ n: 1 }, { n: 2 }, { n: 3, routine: true }, { n: 4, routine: true }, { n: 5, routine: true }]), g);
    const first = p.tick("poll"); await settle();
    assert.deepStrictEqual(g.started.sort(), ["SLA-1", "SLA-3", "SLA-4"], "one ordinary card, two routine cards; SLA-2 and SLA-5 wait");
    g.release("SLA-1"); await settle();
    assert.ok(g.started.includes("SLA-2"), "the next ordinary card starts only once the first has ended");
    assert.ok(!g.started.includes("SLA-5"), "a third routine card waits for a free routine worker");
    g.release("SLA-3"); await settle();
    assert.ok(g.started.includes("SLA-5"), "and takes the worker a routine card frees");
    for (const id of ["SLA-2", "SLA-4", "SLA-5"]) g.release(id);
    await first; await p.idle();
    assert.strictEqual(g.twice, 0);
    // Ordinary cards alone: strictly one at a time, as before.
    const g2 = gate();
    const p2 = poller(board([{ n: 1 }, { n: 2 }, { n: 3 }]), g2);
    const t = p2.tick("poll"); await settle();
    assert.deepStrictEqual(g2.started, ["SLA-1"]);
    g2.release("SLA-1"); await settle();
    assert.deepStrictEqual(g2.started, ["SLA-1", "SLA-2"]);
    g2.release("SLA-2"); await settle(); g2.release("SLA-3"); await t;
    assert.strictEqual(g2.peak, 1);
  });

  await check("when the routine cards cannot be read every card is ordinary: one handler each, serial", async () => {
    const g = gate();
    const p = poller(board([{ n: 1 }, { n: 2, routine: true }], { routineFilter: false }), g);
    const t = p.tick("poll"); await settle();
    assert.deepStrictEqual(g.started, ["SLA-1"]);
    g.release("SLA-1"); await settle();
    assert.deepStrictEqual(g.started, ["SLA-1", "SLA-2"]);
    g.release("SLA-2"); await t; await p.idle();
    assert.strictEqual(g.peak, 1);
    assert.strictEqual(g.twice, 0);
  });

  await check("a refusal on one card leaves the other card's saved state and its answer alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-")), file = join(dir, "s.json");
    // A ordinary completes, then B (routine) is refused: A's completion records stay saved.
    const g = gate(), b = board([{ n: 1 }, { n: 2, routine: true }]);
    const p = poller(b, g, file);
    const first = p.tick("poll"); await settle();
    g.release("SLA-1"); await settle();
    g.refuse("SLA-2"); await first; await p.idle();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(saved.handledRuns.includes("r1"), "A's handled run survived B's rollback");
    assert.ok(saved.answeredAsks.some((k) => k.startsWith("c-1:")), "A's answered ask survived B's rollback");
    assert.strictEqual(b.state.get(1).card.status, "done");

    // A refused while B is active: B keeps its pending state and its answer closes the card.
    const file2 = join(dir, "s2.json");
    const g2 = gate(), b2 = board([{ n: 1 }, { n: 2, routine: true }]);
    const p2 = poller(b2, g2, file2);
    const t = p2.tick("poll"); await settle();
    g2.refuse("SLA-1"); await settle();
    const mid = JSON.parse(readFileSync(file2, "utf8"));
    assert.ok(Object.keys(mid.pendingReplies).some((k) => k.startsWith("c-2:")), "B's pending reply survived A's rollback");
    g2.release("SLA-2"); await t; await p2.idle();
    assert.strictEqual(b2.state.get(2).card.status, "done", "B's answer closed its card");
  });

  await check("a refusal stops the cards queued behind it in both lanes", async () => {
    const g = gate();
    const p = poller(board([{ n: 1 }, { n: 2 }, { n: 3, routine: true }, { n: 4, routine: true }, { n: 5, routine: true }]), g);
    const first = p.tick("poll"); await settle();
    assert.deepStrictEqual(g.started.sort(), ["SLA-1", "SLA-3", "SLA-4"]);
    g.refuse("SLA-3"); await settle();
    g.release("SLA-4"); g.release("SLA-1"); await settle();
    assert.deepStrictEqual(g.started.sort(), ["SLA-1", "SLA-3", "SLA-4"], "neither SLA-2 nor SLA-5 started during the backoff");
    await first; await p.idle();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
