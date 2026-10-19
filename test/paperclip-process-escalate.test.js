/**
 * Paperclip — the bridge's own hand-offs go through the shared escalate action
 * (`process.escalate`, SLA-1493) when one is configured: a `return` goes up the
 * reporting line, back down a recorded hand-up the bot holds, and a refusal
 * leaves the card blocked with the bot, each refusal's code and message on it.
 * `review` sends finished work to review with whoever gave it, in one write.
 */
const assert = require("assert");
const { readFileSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, buildTaskPrompt, outcomeOf, OUTCOME_MARK } = require("../lib/paperclip");
const { latestRecord, openHandUps, processEscalateClient, escalateClientFor, escalateBoard, MARKER_PREFIX } = require("../lib/process-escalate");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const SEATS = [{ id: "agent-em", name: "Engineering Manager", reportsTo: "agent-po" }, { id: "agent-po", name: "Product Owner" }];
const clock = { t: 0 };
const marker = (record) => `${MARKER_PREFIX}${Buffer.from(JSON.stringify(record)).toString("base64url")} -->`;

/** One task held by the EM seat, which reports to the PO seat, with a live run on it. */
function board({ comments: prior = [], status = "in_progress", labels = [], activity = [] } = {}) {
  const card = { id: "c-1", identifier: "SLA-1", title: "Publish the roadmap", status, assigneeAgentId: "agent-em",
    assigneeUserId: null, labels, createdAt: "2026-01-01T00:00:00Z", createdByAgentId: "agent-po" };
  const comments = [{ id: "c0", authorAgentId: null, authorUserId: "user-avery", createdAt: "2026-01-01T00:00:01Z", body: "Please publish it." }, ...prior];
  const writes = [];
  const runs = [{ id: "r1", agentId: "agent-em", status: "running" }];
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ ...SEATS[0], companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok(SEATS);
    if (path === "/agents/me/inbox-lite") return ok(card.assigneeAgentId === "agent-em" ? [{ id: card.id, status: card.status, unresolvedBlockerIssueIds: [] }] : []);
    const m = path.match(/^\/issues\/([^/]+)(\/[a-z]+)?$/);
    if (!m || ![card.id, card.identifier].includes(decodeURIComponent(m[1]))) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      writes.push({ runId: init.headers["x-paperclip-run-id"], body, at: ++clock.t });
      if (body.status) card.status = body.status;
      if (body.comment) runs[0].status = "succeeded";
      return ok({});
    }
    if (!m[2]) return ok({ ...card, blockedBy: [] });
    if (m[2] === "/activity") return ok(activity);
    if (m[2] === "/comments") return ok(comments);
    if (m[2] === "/runs") return ok(runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { card, writes, fetch, runs, activity };
}
/** A stand-in for the action: records each call, answers from `answers` by operation. */
function action(answers = {}) {
  const calls = [];
  const escalate = async (args, opts) => {
    calls.push({ args, opts, at: ++clock.t });
    return answers[args.operation] ?? { ok: true, operation: args.operation, holder: { id: "agent-po" }, replayed: false, hops: [] };
  };
  return { calls, escalate };
}
const seat = (b, answer, escalate, stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json")) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k",
  stateFile, log: silent, fetch: b.fetch, answer, escalate });
const RETURNED = `Only the Product Owner can rule on scope.\n${OUTCOME_MARK} return`;

(async () => {
  await check("a `return` goes up the reporting line through the action, under the run, keyed to the ask", async () => {
    const b = board(), a = action();
    await seat(b, async () => RETURNED, a.escalate).tick();
    assert.strictEqual(a.calls.length, 1, JSON.stringify(a.calls));
    const [{ args, opts }] = a.calls;
    assert.strictEqual(args.operation, "hand_up");
    assert.strictEqual(args.issue, "c-1");
    assert.strictEqual(args.blocker, "Only the Product Owner can rule on scope.");
    assert.match(args.idempotencyKey, /:hand_up$/);
    assert.strictEqual(opts.runId, "r1");
    assert.strictEqual(b.writes.length, 0, "the action makes the write; the bridge adds none");
  });

  await check("a `return` on a card handed up to the bot goes back down as `return`", async () => {
    const hops = [{ from: "agent-dev", to: "agent-em", operation: "hand_up" }];
    const b = board({ comments: [{ id: "m1", authorAgentId: "agent-dev", createdAt: "2026-01-01T00:00:02Z", body: marker({ card: "c-1", hops }) }] });
    const a = action();
    await seat(b, async () => RETURNED, a.escalate).tick();
    assert.deepStrictEqual(a.calls.map((c) => c.args.operation), ["return"]);
    assert.strictEqual(a.calls[0].args.resolution, "Only the Product Owner can rule on scope.");
  });

  await check("a hand-off refused twice stays blocked with the bot, and both refusals are on the card", async () => {
    const hops = [{ from: "agent-dev", to: "agent-em", operation: "hand_up" }];
    const b = board({ comments: [{ id: "m1", authorAgentId: "agent-dev", createdAt: "2026-01-01T00:00:02Z", body: marker({ card: "c-1", hops }) }] });
    const a = action({ return: { ok: false, code: "not_holder", message: "the card is not with you" },
      hand_up: { ok: false, code: "paperclip_unavailable", message: "move: PATCH /issues/c-1 -> HTTP 403" } });
    await seat(b, async () => RETURNED, a.escalate).tick();
    assert.deepStrictEqual(a.calls.map((c) => c.args.operation), ["return", "hand_up"]);
    const { body, runId } = b.writes.at(-1);
    assert.strictEqual(runId, "r1");
    assert.strictEqual(body.status, "blocked");
    assert.deepStrictEqual(body.unblockDescriptor.owner, { agentId: "agent-em" });
    assert.match(body.unblockDescriptor.action, /process\.escalate return: not_holder: the card is not with you/);
    assert.match(body.unblockDescriptor.action, /process\.escalate hand_up: paperclip_unavailable: move: PATCH \/issues\/c-1 -> HTTP 403/);
    assert.match(body.comment, /- return: not_holder: the card is not with you/);
    assert.match(body.comment, /- hand_up: paperclip_unavailable: move: PATCH \/issues\/c-1 -> HTTP 403/);
    assert.strictEqual(b.card.assigneeAgentId, "agent-em");
  });

  // A card the developer seat handed up to the EM through the action: blocked, no label.
  const handedUp = (extra = {}) => board({ status: "blocked", ...extra, comments: [{ id: "m1", authorAgentId: "agent-dev", createdAt: "2026-01-01T00:00:02Z",
    body: marker({ card: "c-1", hops: [{ from: "agent-dev", to: "agent-em", operation: "hand_up" }] }) }] });

  await check("a card handed up and answered `return` goes back down through the action, once across retries", async () => {
    const b = handedUp(), a = action(), s = seat(b, async () => RETURNED, a.escalate);
    await s.tick(); await s.tick();
    assert.deepStrictEqual(a.calls.map((c) => c.args.operation), ["return"], JSON.stringify(a.calls));
    assert.strictEqual(a.calls[0].args.resolution, "Only the Product Owner can rule on scope.");
  });

  await check("a label-only escalation answered `escalate` hands up through the action, not a direct reassignment", async () => {
    const b = board({ status: "blocked", labels: [{ name: "Needs EM ruling" }] }), a = action();
    await seat(b, async () => `Needs a product call.\n${OUTCOME_MARK} escalate`, a.escalate).tick();
    assert.deepStrictEqual(a.calls.map((c) => c.args.operation), ["hand_up"]);
    assert.ok(b.writes.every((w) => !("assigneeAgentId" in w.body)), JSON.stringify(b.writes));
  });

  await check("a refused resolve handed up instead carries the exact refusal on the card", async () => {
    const b = handedUp(), a = action({ resolve: { ok: false, code: "paperclip_unavailable", message: "EXACT_BOARD_REFUSAL" } });
    await seat(b, async () => "Scope approved; resume the work.", a.escalate).tick();
    assert.deepStrictEqual(a.calls.map((c) => c.args.operation), ["resolve", "hand_up"]);
    assert.match(a.calls[1].args.attempted, /process\.escalate resolve: paperclip_unavailable: EXACT_BOARD_REFUSAL/);
    assert.strictEqual(a.calls[1].args.blocker, "Scope approved; resume the work.");
    // Written before the fallback moves the card: a hand-off ends the run, and a write after it is refused.
    const step = b.writes.find((w) => w.body.unblockDescriptor && !w.body.status);
    assert.ok(step, JSON.stringify(b.writes));
    assert.ok(step.at < a.calls[1].at, "the unblock step was written after the hand-off ended the run");
    assert.deepStrictEqual(step.body.unblockDescriptor.owner, { agentId: "agent-em" });
    assert.match(step.body.unblockDescriptor.action, /process\.escalate resolve: paperclip_unavailable: EXACT_BOARD_REFUSAL/);
  });

  // R7: the resolve is refused and the unblock step written; a person retitles
  // the card before the fallback hand-up. The card is read again right before
  // that hand-up, so the old answer is not handed up over the change.
  await check("R7: a refused resolve, the card retitled after the unblock step: the fallback hand-up is not made", async () => {
    const b = handedUp(), a = action({ resolve: { ok: false, code: "paperclip_unavailable", message: "EXACT_BOARD_REFUSAL" } });
    const inner = b.fetch;
    b.fetch = async (url, init = {}) => {
      const r = await inner(url, init);
      if (init.method === "PATCH" && JSON.parse(init.body).unblockDescriptor && !JSON.parse(init.body).status) {
        b.card.title = "Publish the roadmap, revised";
        b.activity.unshift({ id: "h-r7", action: "issue.updated", actorType: "user", actorId: "user-avery", createdAt: "2026-01-01T00:00:09Z",
          details: { changes: { title: { from: "Publish the roadmap", to: b.card.title } } } });
      }
      return r;
    };
    await seat(b, async () => "Scope approved; resume the work.", a.escalate).tick();
    assert.deepStrictEqual(a.calls.map((c) => c.args.operation), ["resolve"], JSON.stringify(a.calls));
    assert.ok(b.writes.some((w) => /changed while I worked on it/.test(w.body.comment ?? "")), JSON.stringify(b.writes));
  });

  await check("a person who blocks a handed-up card while it is being answered keeps it: the answer is said, nothing handed on", async () => {
    const b = handedUp(), a = action();
    await seat(b, async () => {
      b.activity.unshift({ id: "h1", action: "issue.updated", actorType: "user", actorId: "user-avery", createdAt: "2026-01-01T00:00:03Z",
        details: { changes: { status: { from: "blocked", to: "blocked" } } } });
      return "Scope approved; resume the work.";
    }, a.escalate).tick();
    assert.strictEqual(a.calls.length, 0, JSON.stringify(a.calls));
    assert.ok(b.writes.some((w) => w.body.comment === "Scope approved; resume the work."), JSON.stringify(b.writes));
  });

  await check("a `review` answer stays in review across a restart and a fresh wake on the same ask", async () => {
    const b = board(), file = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let ran = 0;
    const answer = async () => { ran++; return `Done; please check the copy.\n${OUTCOME_MARK} review`; };
    await seat(b, answer, action().escalate, file).tick();
    assert.strictEqual(b.card.status, "in_review");
    b.runs.push({ id: "r2", agentId: "agent-em", status: "running" });
    const before = b.writes.length;
    await seat(b, answer, action().escalate, file).tick();
    assert.strictEqual(ran, 1, "the answer ran again");
    assert.strictEqual(b.card.status, "in_review", JSON.stringify(b.writes.slice(before)));
    assert.ok(b.writes.slice(before).every((w) => !w.body.status), JSON.stringify(b.writes.slice(before)));
  });

  await check("a person's block on a handed-up card holds: no run, no hand-off", async () => {
    const hold = { id: "h1", action: "issue.updated", actorType: "user", actorId: "user-avery", createdAt: "2026-01-01T00:00:03Z",
      details: { changes: { status: { from: "blocked", to: "blocked" } } } };
    let ran = 0;
    const b = handedUp({ activity: [hold] }), a = action();
    await seat(b, async () => { ran++; return "Scope approved."; }, a.escalate).tick();
    assert.strictEqual(ran, 0, "the manager worked a card a person holds");
    assert.strictEqual(a.calls.length, 0);
  });

  await check("`review` closes in review with the giver as reviewer, in one write", async () => {
    const b = board();
    await seat(b, async () => `Done; please check the copy.\n${OUTCOME_MARK} review`, action().escalate).tick();
    const close = b.writes.find((w) => w.body.status);
    assert.ok(close, JSON.stringify(b.writes));
    assert.strictEqual(close.body.status, "in_review");
    assert.deepStrictEqual(close.body.executionPolicy, { maxReviewRounds: 10, stages: [{ type: "review", participants: [{ type: "agent", agentId: "agent-po" }] }] });
    assert.strictEqual(close.body.comment, "Done; please check the copy.");
  });

  await check("without the action, `return` is the old direct hand-back", async () => {
    const b = board();
    await seat(b, async () => RETURNED, null).tick();
    assert.strictEqual(b.writes.at(-1).body.assigneeAgentId, "agent-po");
  });

  await check("`review` parses, is outranked by a block, and is offered only when the task may be handed back", () => {
    assert.strictEqual(outcomeOf(`x\n${OUTCOME_MARK} review`).status, "in_review");
    assert.strictEqual(outcomeOf(`x\n${OUTCOME_MARK} review\n${OUTCOME_MARK} blocked`).status, "blocked");
    const me = { id: "agent-em", name: "Engineering Manager" };
    assert.match(buildTaskPrompt({ identifier: "T-1", title: "Q" }, [], me, "u"), new RegExp(`${OUTCOME_MARK} review`));
    assert.doesNotMatch(buildTaskPrompt({ identifier: "T-1", title: "Q" }, [], me, "u", { returnable: false }), new RegExp(`${OUTCOME_MARK} review`));
  });

  await check("only an agent's marker counts, the longest record wins, and each step down closes the latest hand-up", () => {
    const one = { card: "c-1", hops: [{ from: "a", to: "b", operation: "hand_up" }] };
    const two = { card: "c-1", hops: [...one.hops, { from: "b", to: "c", operation: "hand_up" }] };
    const comments = [{ authorAgentId: "a", body: marker(one) }, { authorAgentId: null, authorUserId: "u", body: marker(two) }];
    assert.deepStrictEqual(latestRecord(comments, "c-1"), one, "a person's pasted marker moved the chain");
    assert.strictEqual(latestRecord(comments, "c-2"), null);
    assert.deepStrictEqual(openHandUps([...two.hops, { from: "c", to: "b", operation: "resolve" }]).map((h) => h.to), ["b"]);
  });

  await check("the client opens a session, acts as the seat in headers, and reads an event-stream reply", async () => {
    const seen = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ method: body.method, headers: init.headers });
      const headers = { get: (h) => (h === "mcp-session-id" ? "s-9" : null) };
      if (!("id" in body)) return { ok: false, status: 202, headers, text: async () => "" };
      const result = body.method === "initialize" ? {} : { content: [{ type: "text", text: JSON.stringify({ ok: true, operation: "hand_up", replayed: true }) }] };
      return { ok: true, status: 200, headers, text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n` };
    };
    const escalate = processEscalateClient({ url: "https://mcp.example.com/process/mcp", bearer: "B", agentKey: "K", fetch });
    const out = await escalate({ operation: "hand_up", issue: "c-1" }, { runId: "r1" });
    assert.deepStrictEqual(out, { ok: true, operation: "hand_up", replayed: true });
    assert.deepStrictEqual(seen.map((s) => s.method), ["initialize", "notifications/initialized", "tools/call"]);
    const last = seen.at(-1).headers;
    assert.strictEqual(last["mcp-session-id"], "s-9");
    assert.strictEqual(last["x-paperclip-agent-key"], "K");
    assert.strictEqual(last["x-paperclip-run-id"], "r1");
    assert.strictEqual(last.authorization, "Bearer B");
  });

  await check("an unreachable action answers a refusal, never throws", async () => {
    const escalate = processEscalateClient({ url: "u", bearer: "B", agentKey: "K", fetch: async () => { throw new Error("ECONNREFUSED"); } });
    assert.deepStrictEqual(await escalate({ operation: "hand_up", issue: "c-1" }), { ok: false, code: "escalate_unreachable", message: "ECONNREFUSED" });
  });

  await check("the action's bearer never reaches a run, and only the served board uses it", () => {
    const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
    // The bearer is a connector key to the one run-environment builder: no
    // run of any runtime has it, and no command can read it.
    assert.match(bot, /connectorKeys: \[\.\.\.boardKeyEnvs\(process\.env\), \.\.\.escalateBearer\(\)\],/);
    const { buildRunEnv } = require("../lib/permission-mode");
    const env = { PATH: "/usr/bin", HOME: "/home/bot", ESCALATE_BEARER: "bearer-value-long-enough-0123456789" };
    for (const runtime of ["claude", "codex"]) for (const run of ["session", "parity", "board"]) {
      const built = buildRunEnv({ env, runtime, mode: "bypass", run, connectorKeys: ["ESCALATE_BEARER"] });
      assert.ok(built.env && !("ESCALATE_BEARER" in built.env), `${runtime}/${run}: the bearer leaves the run's environment`);
      assert.ok(built.shellExclude.includes("ESCALATE_BEARER"), `${runtime}/${run}: no command reads the bearer`);
    }
    assert.match(bot, /const escalate = escalateClientFor\(board, \{ boards: PAPERCLIP_BOARDS \}\);/);
    assert.match(bot, /^\s+escalate,$/m);
  });

  // The served board: a bot whose first board is another company's names the
  // action's board by origin, and gets the client there, with that board's key.
  const first = { id: null, url: "https://board.other.example", apiKey: "FIRST-KEY" };
  const extra = { id: "home", url: "https://board.example.com", apiKey: "EXTRA-KEY" };
  const boards = [first, extra];
  const made = [];
  const client = (opts) => { made[made.length] = opts; return { opts }; };
  const env = { PAPERCLIP_ESCALATE_URL: "https://mcp.example.com/process/mcp", PAPERCLIP_ESCALATE_BEARER_ENV: "BOT_BEARER", BOT_BEARER: "B" };

  await check("unset PAPERCLIP_ESCALATE_BOARD: the first board gets the client, an extra board gets none", () => {
    made.length = 0;
    assert.ok(escalateClientFor(first, { boards, env, client }));
    assert.strictEqual(escalateClientFor(extra, { boards, env, client }), null);
    assert.deepStrictEqual(made, [{ url: env.PAPERCLIP_ESCALATE_URL, bearer: "B", agentKey: "FIRST-KEY" }]);
  });

  await check("PAPERCLIP_ESCALATE_BOARD names an extra board: it gets the client with its own key, the first board gets null", () => {
    made.length = 0;
    const named = { ...env, PAPERCLIP_ESCALATE_BOARD: "https://Board.Example.com/" };
    assert.strictEqual(escalateClientFor(first, { boards, env: named, client }), null);
    assert.ok(escalateClientFor(extra, { boards, env: named, client }));
    assert.deepStrictEqual(made, [{ url: env.PAPERCLIP_ESCALATE_URL, bearer: "B", agentKey: "EXTRA-KEY" }]);
  });

  await check("a served board matching none, or no URL or bearer, gives no board a client", () => {
    made.length = 0;
    const none = { ...env, PAPERCLIP_ESCALATE_BOARD: "https://elsewhere.example" };
    assert.strictEqual(escalateBoard(boards, none), null);
    for (const b of boards) {
      assert.strictEqual(escalateClientFor(b, { boards, env: none, client }), null);
      assert.strictEqual(escalateClientFor(b, { boards, env: { ...env, PAPERCLIP_ESCALATE_URL: "" }, client }), null);
      assert.strictEqual(escalateClientFor(b, { boards, env: { ...env, BOT_BEARER: "" }, client }), null);
      assert.strictEqual(escalateClientFor(b, { boards, env: { ...env, PAPERCLIP_ESCALATE_BEARER_ENV: undefined }, client }), null);
    }
    assert.strictEqual(made.length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
