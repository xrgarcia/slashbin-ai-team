/**
 * Paperclip — a card the seat blocked itself (PAPERCLIP_RESOLVE_OWN). A
 * scheduled job that fails ends its card blocked on the seat; with the setting
 * on that block is no one's hold, and the model is started to fix the card,
 * hand it to its owner or put it to the owner. A block a person set, and a card
 * in Paperclip's reconciliation hold, stay untouched. An escalation ruled to
 * stand gets one more look.
 */
const assert = require("assert");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, parseResolveOwn, parseEscalateTo, OUTCOME_MARK, COMMENT_WAKES, QUIET_MARK } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const SEATS = [{ id: "agent-em", name: "Engineering Manager" }, { id: "agent-po", name: "Product Owner" }];
const PEOPLE = [{ principalId: "user-avery", status: "active", user: { id: "user-avery", name: "Avery" } }];

/** One task held by the bot, handed to it by a person, with a live run on it. */
function board({ description = "Ship the release.", by = { createdByAgentId: "agent-po" } } = {}) {
  const card = { id: "c-1", identifier: "T-1", title: "Release the change", description,
    status: "in_progress", assigneeAgentId: "agent-em", assigneeUserId: null, labels: [], createdAt: "2026-01-01T00:00:00Z", requestDepth: 0, ...by };
  const activity = [], comments = [], writes = [];
  const runs = [{ id: "r1", agentId: "agent-em", status: "running" }];
  // Why each run woke, as Paperclip records it (none: the run does not say).
  const reasons = {};
  let last = 0, ids = 0, clock = 0;
  const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();
  const record = (actor, changes, runId) => activity.unshift({ id: `a${++ids}`, action: "issue.updated", createdAt: now(), ...actor, runId, details: { changes } });
  comments.push({ id: "c0", authorAgentId: null, authorUserId: "user-avery", createdAt: now(), body: "Handing this to you: release it when it is ready." });
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-em", name: "Engineering Manager", companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok(SEATS);
    if (path === "/companies/co-1/user-directory") return ok({ users: PEOPLE });
    if (path === "/agents/me/inbox-lite") return ok(card.assigneeAgentId === "agent-em" ? [{ id: card.id, status: card.status, unresolvedBlockerIssueIds: [] }] : []);
    if (/^\/heartbeat-runs\/r\d$/.test(path)) return ok({ contextSnapshot: reasons[path.slice("/heartbeat-runs/".length)] ? { wakeReason: reasons[path.slice("/heartbeat-runs/".length)] } : {} });
    const del = path.match(/^\/issues\/c-1\/comments\/([^/]+)$/);
    if (del && init.method === "DELETE") {
      // As the live board: a deleted comment stays listed, with a blank body.
      const c = comments.find((x) => x.id === del[1]);
      c.deletedAt = now(); c.body = ""; writes.push({ runId: init.headers["x-paperclip-run-id"], deleted: c.id });
      return ok({});
    }
    const m = path.match(/^\/issues\/([^/]+)(\/[a-z]+)?$/);
    if (!m || ![card.id, card.identifier].includes(decodeURIComponent(m[1]))) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      const runId = init.headers["x-paperclip-run-id"];
      const body = JSON.parse(init.body);
      // As the live board: an agent may name only itself as the unblock owner.
      if (body.unblockDescriptor && body.unblockDescriptor.owner?.agentId !== "agent-em") {
        return { ok: false, status: 403, text: async () => JSON.stringify({ error: "Agents may only name themselves as an unblock owner" }) };
      }
      if (body.status === "blocked" && card.status !== "blocked" && !body.unblockDescriptor && !body.blockedByIssueIds?.length) {
        return { ok: false, status: 422, text: async () => JSON.stringify({ error: "Entering blocked requires unblockDescriptor" }) };
      }
      writes.push({ runId, body });
      const actor = { actorType: "agent", actorId: "agent-em" };
      // As the live board: entering blocked starts the clock and clears the wake marker.
      if (body.status === "blocked" && card.status !== "blocked") { card.blockedTransitionAt = ++clock; card.blockedOwnerNotifiedAt = null; }
      if (body.status && body.status !== card.status) { record(actor, { status: { from: card.status, to: body.status } }, runId); card.status = body.status; }
      if (body.unblockDescriptor) card.unblockDescriptor = body.unblockDescriptor;
      if ("assigneeAgentId" in body || "assigneeUserId" in body) {
        record(actor, { assigneeAgentId: { from: card.assigneeAgentId, to: body.assigneeAgentId ?? null }, assigneeUserId: { from: card.assigneeUserId, to: body.assigneeUserId ?? null } }, runId);
        card.assigneeAgentId = body.assigneeAgentId ?? null; card.assigneeUserId = body.assigneeUserId ?? null;
      }
      if ("comment" in body) { comments.push({ id: `c${comments.length}`, authorAgentId: "agent-em", createdAt: now(), body: body.comment, createdByRunId: runId }); runs[0].status = "succeeded"; }
      // As the live board: the sent fields are on the write's record. The
      // board waiter ends a run on the quiet mark, on a wake not held to a comment.
      else if (QUIET_MARK in body) {
        activity.unshift({ id: `a${++ids}`, action: "issue.updated", createdAt: now(), actorType: "agent", actorId: "agent-em", agentId: "agent-em", runId, details: { ...body, changes: {} } });
        if (reasons[runId] && !COMMENT_WAKES.includes(reasons[runId]) && runs[0].id === runId) runs[0].status = "succeeded";
      }
      return ok({});
    }
    if (!m[2]) return ok({ ...card, blockedBy: card.blockedBy ?? [] });
    if (m[2] === "/activity") return ok(activity);
    if (m[2] === "/comments") return ok(comments);
    if (m[2] === "/runs") return ok(runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  /** A wake the bot caused itself: a new run on the same, unchanged ask. */
  const wake = (id, reason) => {
    runs[0] = { id, agentId: "agent-em", status: "running" };
    if (reason) reasons[id] = reason;
    // The board's checkout of a wake: a blocked card the bot holds is in progress for the run.
    if (card.status === "blocked" && card.assigneeAgentId === "agent-em") { card.status = "in_progress"; card.blockedTransitionAt = null; }
  };
  return { card, writes, comments, fetch, wake, runs, record };
}
const seatOn = (b, opts = {}) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
  return (answer) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch: b.fetch, answer,
    externalWriter: /^source: \S+#\d+$/, ...opts });
};
const visible = (b) => b.comments.filter((c) => !c.deletedAt);
const STUCK = `Nothing here is mine to do; it needs a decision.\n${OUTCOME_MARK} blocked`;
const SEAT = { actorType: "agent", actorId: "agent-em" };
const PERSON = { actorType: "user", actorId: "user-avery" };

/** A job run moves the card out of its block, then ends it blocked again as `actor`: two recorded moves. */
function blockAgain(b, actor, runId) {
  b.record(SEAT, { status: { from: "blocked", to: "in_progress" } }, runId);
  b.record(actor, { status: { from: "in_progress", to: "blocked" } }, runId);
  b.card.status = "blocked";
}

/**
 * The seat answers the ask blocked (run r1), then a job run (rJob) checks the
 * card out and ends it blocked as `actor`; the board wakes the seat again (r2).
 * Resolves to the prompts the model was given, and the count after the first.
 */
async function blockedLater(actor, { opts = {}, mutate = () => {} } = {}) {
  const b = board({ by: { createdByAgentId: "agent-em" } });
  const seat = seatOn(b, opts);
  const prompts = [];
  const answer = async (p) => { prompts.push(p); return STUCK; };
  await seat(answer).tick();
  const first = prompts.length;
  blockAgain(b, actor, "rJob");
  mutate(b);
  b.wake("r2");
  await seat(answer).tick();
  return { b, prompts, first, seat, answer };
}

(async () => {
  await check("PAPERCLIP_RESOLVE_OWN reads on and off, and refuses what it cannot read", () => {
    assert.strictEqual(parseResolveOwn(undefined), false);
    assert.strictEqual(parseResolveOwn("off"), false);
    assert.strictEqual(parseResolveOwn(" ON "), true);
    for (const bad of ["1", "true", "yes"]) assert.throws(() => parseResolveOwn(bad), /PAPERCLIP_RESOLVE_OWN/, bad);
  });

  await check("a card the seat blocked itself: the model is started and told the three ways out; setting off, it is not", async () => {
    const off = await blockedLater(SEAT);
    assert.strictEqual(off.prompts.length, off.first, "off: the model was started on the seat's own block");
    const on = await blockedLater(SEAT, { opts: { resolveOwn: true } });
    assert.strictEqual(on.prompts.length, on.first + 1, "on: the model was not started");
    const p = on.prompts.at(-1);
    assert.match(p, /the block is your own/);
    assert.match(p, /Fixed:/);
    assert.match(p, /Handed to its owner: call process\.escalate/);
    assert.match(p, /Put to the owner: .*with the operation/);
  });

  await check("a seat's own block is resolved once: its look is not repeated, and a later block is looked at again", async () => {
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true } });
    const looked = t.prompts.length;
    // The look ended blocked again (its answer): a wake after it is the answer's wait.
    t.b.wake("r3"); await t.seat(t.answer).tick();
    assert.strictEqual(t.prompts.length, looked, "the same block was looked at twice");
    // A new failure of a job run is a new block.
    blockAgain(t.b, SEAT, "rJob2");
    t.b.wake("r4"); await t.seat(t.answer).tick();
    assert.strictEqual(t.prompts.length, looked + 1, "a new block was not looked at");
  });

  await check("a card a person blocked is untouched, setting on", async () => {
    const t = await blockedLater(PERSON, { opts: { resolveOwn: true } });
    assert.strictEqual(t.prompts.length, t.first, "the model was started on a person's block");
  });

  await check("a card in Paperclip's legacy reconciliation hold is untouched, setting on", async () => {
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true },
      mutate: (b) => { b.card.executionBlocker = { cause: "legacy_execution_requires_reconciliation", runId: "rJob", recoveryActionId: "ra-1" }; } });
    assert.strictEqual(t.prompts.length, t.first, "the model was started under the reconciliation hold");
  });

  await check("a card waiting on an open linked card is untouched, setting on", async () => {
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true }, mutate: (b) => { b.card.blockedBy = [{ id: "c-9", identifier: "T-9", status: "todo" }]; } });
    assert.strictEqual(t.prompts.length, t.first, "the model was started on a card that waits on an open card");
  });

  await check("an escalation ruled to stand gets one more look with the three ways out; setting off, it does not", async () => {
    for (const on of [false, true]) {
      const b = board({ by: { createdByAgentId: "agent-po" } });
      b.card.labels = [{ name: "Needs EM ruling" }];
      b.card.status = "blocked";
      b.record(PERSON, { status: { from: "in_progress", to: "blocked" } }, null);
      const seat = seatOn(b, on ? { resolveOwn: true } : {});
      const prompts = [];
      const answer = async (p) => { prompts.push(p); return STUCK; };
      b.wake("r1"); await seat(answer).tick();
      assert.strictEqual(prompts.length, 1, "the ruling");
      for (const r of ["r2", "r3"]) { b.wake(r); await seat(answer).tick(); }
      assert.strictEqual(prompts.length, on ? 2 : 1, `resolveOwn ${on}: ${prompts.length} runs`);
      if (on) assert.match(prompts[1], /the hold stands, and nothing on the card has changed since/);
      assert.strictEqual(b.card.status, "blocked");
    }
  });

  // The model's plain blocked reply on a recovery run is not an ending: the
  // code puts the question to the owner (announced), else escalates, else warns.
  function routes() {
    const calls = [], asks = [], warns = [];
    const escalate = async (body) => { calls.push(body); return { ok: true, operation: body.operation, holder: { id: "user-avery" }, hops: [] }; };
    const log = { ...silent, warn: (_o, m) => warns.push(String(m ?? _o)), child() { return log; } };
    return { calls, asks, warns, escalate, log, onOwnerAsk: async (a) => { asks.push(a); return true; } };
  }
  const opsOf = (r) => r.calls.map((c) => c.operation);

  await check("R1: a self-block second look ending in a plain blocked reply puts the reply to the owner as an ask", async () => {
    const r = routes();
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true, escalate: r.escalate, onOwnerAsk: r.onOwnerAsk, log: r.log } });
    assert.strictEqual(t.prompts.length, t.first + 1);
    const asked = r.calls.filter((c) => c.operation !== "hand_up" && c.operation !== "resolve" && c.operation !== "return");
    assert.strictEqual(asked.length, 1, `calls: ${opsOf(r)}`);
    assert.match(asked[0].decision, /Nothing here is mine to do; it needs a decision\./);
    assert.ok(asked[0].evidence && asked[0].recommendation, "the ask carries its evidence and recommendation");
  });

  await check("R2: with no owner-ask channel, the same reply escalates to the configured holder", async () => {
    const r = routes();
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true, escalate: r.escalate, log: r.log, escalateTo: parseEscalateTo("user:user-avery|Avery") } });
    assert.strictEqual(opsOf(r).length, 0, `no ask expected: ${opsOf(r)}`);
    assert.strictEqual(t.b.card.assigneeUserId, "user-avery", "the card went to the escalation holder");
    assert.strictEqual(t.b.card.status, "blocked");
  });

  await check("R3: with neither an ask channel nor an escalation holder, a warning is logged and the card is left", async () => {
    const r = routes();
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true, log: r.log } });
    assert.strictEqual(t.b.card.assigneeAgentId, "agent-em");
    assert.ok(r.warns.some((w) => /no owner ask or escalation is configured/.test(w)), `warns: ${r.warns}`);
  });

  await check("R4: a held escalation's second look ending in a plain blocked reply is put to the owner; without a channel it escalates", async () => {
    for (const mode of ["ask", "escalate"]) {
      const r = routes();
      const b = board({ by: { createdByAgentId: "agent-po" } });
      b.card.labels = [{ name: "Needs EM ruling" }];
      b.card.status = "blocked";
      b.record(PERSON, { status: { from: "in_progress", to: "blocked" } }, null);
      const opts = mode === "ask" ? { escalate: r.escalate, onOwnerAsk: r.onOwnerAsk } : { escalateTo: parseEscalateTo("user:user-avery|Avery") };
      const seat = seatOn(b, { resolveOwn: true, log: r.log, ...opts });
      const answer = async () => STUCK;
      b.wake("r1"); await seat(answer).tick();
      for (const id of ["r2", "r3"]) { b.wake(id); await seat(answer).tick(); }
      if (mode === "ask") {
        assert.deepStrictEqual(r.calls.filter((c) => c.operation !== "resolve" && c.operation !== "return" && c.operation !== "hand_up").length, 1, `calls: ${opsOf(r)}`);
      } else {
        assert.strictEqual(b.card.assigneeUserId, "user-avery", "escalated to the configured holder");
      }
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
