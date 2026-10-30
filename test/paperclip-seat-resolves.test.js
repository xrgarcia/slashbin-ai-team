/**
 * Paperclip — a card the seat blocked itself (PAPERCLIP_RESOLVE_OWN). A
 * scheduled job that fails ends its card blocked on the seat; with the setting
 * on that block is no one's hold, and the model is started to fix the card,
 * hand it to its owner or put it to the owner. A block a person set, and a card
 * in Paperclip's reconciliation hold, stay untouched. An escalation ruled to
 * stand gets one more look.
 */
const assert = require("assert");
const { ASK_OPERATION, ASK_CARD_FIELD, ASK_CARD_IDENTIFIER_FIELD } = require("../lib/owner-asks");
const { mkdtempSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, parseResolveOwn, resolveOwnRouteProblem, parseEscalateTo, OUTCOME_MARK, COMMENT_WAKES, QUIET_MARK } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const SEATS = [{ id: "agent-em", name: "Engineering Manager" }, { id: "agent-po", name: "Product Owner" }];
const PEOPLE = [{ principalId: "user-avery", status: "active", user: { id: "user-avery", name: "Avery" } }];

/** One task held by the bot, handed to it by a person, with a live run on it. */
function board({ description = "Ship the release.", by = { createdByAgentId: "agent-po" }, reportsTo = null } = {}) {
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
    if (path === "/agents/me") return ok({ id: "agent-em", name: "Engineering Manager", companyId: "co-1", ...(reportsTo ? { reportsTo } : {}) });
    if (path === "/issues/own-1") return ok({ id: "own-1", identifier: "R-1", status: "todo", description: "**Decision**\n> Which way?\n\n**Recommendation**\n> Go.\n\n**Evidence**\n> Seen." });
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
      if (Array.isArray(body.blockedByIssueIds)) card.blockedBy = body.blockedByIssueIds.map((id) => (card.blockedBy ?? []).find((x) => x.id === id) ?? { id, identifier: id, status: "todo" });
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
const ROUTE = { escalateTo: parseEscalateTo("user:user-avery|Avery") };
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
    const on = await blockedLater(SEAT, { opts: { resolveOwn: true, ...ROUTE } });
    assert.strictEqual(on.prompts.length, on.first + 1, "on: the model was not started");
    const p = on.prompts.at(-1);
    assert.match(p, /the block is your own/);
    assert.match(p, /Fixed:/);
    assert.match(p, /Handed to its owner: call process\.escalate/);
    assert.match(p, /Put to the owner: .*with the operation/);
  });

  await check("a seat's own block is resolved once: the look is not repeated on the wakes after it", async () => {
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true, ...ROUTE } });
    const looked = t.prompts.length;
    assert.strictEqual(looked, t.first + 1, "the look");
    // The look handed the card on (escalateTo): wakes after it start nothing.
    for (const id of ["r3", "r4"]) { t.b.wake(id); await t.seat(t.answer).tick(); }
    assert.strictEqual(t.prompts.length, looked, "the same block was looked at twice");
  });

  await check("a card a person blocked is untouched, setting on", async () => {
    const t = await blockedLater(PERSON, { opts: { resolveOwn: true, ...ROUTE } });
    assert.strictEqual(t.prompts.length, t.first, "the model was started on a person's block");
  });

  await check("a card in Paperclip's legacy reconciliation hold is untouched, setting on", async () => {
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true, ...ROUTE },
      mutate: (b) => { b.card.executionBlocker = { cause: "legacy_execution_requires_reconciliation", runId: "rJob", recoveryActionId: "ra-1" }; } });
    assert.strictEqual(t.prompts.length, t.first, "the model was started under the reconciliation hold");
  });

  await check("a card waiting on an open linked card is untouched, setting on", async () => {
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true, ...ROUTE }, mutate: (b) => { b.card.blockedBy = [{ id: "c-9", identifier: "T-9", status: "todo" }]; } });
    assert.strictEqual(t.prompts.length, t.first, "the model was started on a card that waits on an open card");
  });

  await check("an escalation ruled to stand gets one more look with the three ways out; setting off, it does not", async () => {
    for (const on of [false, true]) {
      const b = board({ by: { createdByAgentId: "agent-po" } });
      b.card.labels = [{ name: "Needs EM ruling" }];
      b.card.status = "blocked";
      b.record(PERSON, { status: { from: "in_progress", to: "blocked" } }, null);
      const seat = seatOn(b, on ? { resolveOwn: true, ...ROUTE } : {});
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

  // A recovery run that ends in a plain blocked reply is not an ending: the
  // code puts the question to the owner (announced in that wake), else hands
  // the card up, else to the configured holder; with no route, nothing is
  // started or used up.
  const marker = (record) => `<!-- process.escalate:${Buffer.from(JSON.stringify(record)).toString("base64url")} -->`;
  function routes() {
    const r = { calls: [], asks: [], warns: [], board: null };
    // As the live action: an ask records its hop and the owner's card on the seat's card; a hand-up gives it to the manager.
    r.escalate = async (body) => {
      r.calls.push(body);
      const b = r.board;
      if (body.operation === ASK_OPERATION) {
        b.comments.push({ id: `m${b.comments.length}`, authorAgentId: "agent-em", createdAt: new Date(Date.now() + b.comments.length).toISOString(), createdByRunId: "r2",
          body: marker({ card: "c-1", [ASK_CARD_FIELD]: "own-1", [ASK_CARD_IDENTIFIER_FIELD]: "R-1", hops: [{ from: "agent-em", to: "user-avery", operation: ASK_OPERATION, idempotencyKey: body.idempotencyKey, [ASK_CARD_FIELD]: "own-1" }] }) });
        b.card.status = "blocked";
        // As the real action: the owner's card is added to the card's blockers.
        b.card.blockedBy = [...(b.card.blockedBy ?? []), { id: "own-1", identifier: "R-1", status: "todo" }];
      } else if (body.operation === "hand_up") { b.card.assigneeAgentId = "agent-po"; b.card.status = "blocked"; }
      return { ok: true, operation: body.operation, holder: { id: "agent-po" }, hops: [] };
    };
    r.log = { ...silent, warn: (_o, m) => r.warns.push(String(m ?? _o)), child() { return r.log; } };
    r.onOwnerAsk = async (a) => { r.asks.push(a); return true; };
    return r;
  }
  const askCalls = (r) => r.calls.filter((c) => c.operation === ASK_OPERATION);
  const withBoard = (r) => (b) => { r.board = b; };
  const heldBoard = () => {
    const b = board({ by: { createdByAgentId: "agent-po" }, reportsTo: "agent-po" });
    b.card.labels = [{ name: "Needs EM ruling" }];
    b.card.status = "blocked";
    b.record(PERSON, { status: { from: "in_progress", to: "blocked" } }, null);
    return b;
  };
  async function heldTicks(b, seat, answer) {
    for (const id of ["r1", "r2", "r3"]) { b.wake(id); await seat(answer).tick(); }
  }

  await check("self-block second look, plain blocked reply, ask route: one ask is made and announced in that wake, never announced twice", async () => {
    const r = routes();
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true, escalate: r.escalate, onOwnerAsk: r.onOwnerAsk, log: r.log }, mutate: withBoard(r) });
    assert.strictEqual(t.prompts.length, t.first + 1);
    assert.strictEqual(askCalls(r).length, 1, `calls: ${r.calls.map((c) => c.operation)}`);
    assert.match(askCalls(r)[0].decision, /Nothing here is mine to do; it needs a decision\./);
    assert.ok(askCalls(r)[0].evidence && askCalls(r)[0].recommendation);
    assert.strictEqual(r.asks.length, 1, "announced in the recovery wake");
    assert.strictEqual(r.asks[0].ownerCardId, "own-1");
    // The following polls scan the card again: the same ask is not announced twice.
    t.b.wake("r3"); await t.seat(t.answer).tick();
    assert.strictEqual(r.asks.length, 1, "announced again by the scan");
  });

  await check("self-block second look, plain reply, hand-up route (reporting line, no ask channel, no holder): the card is handed up", async () => {
    const r = routes();
    const b = board({ by: { createdByAgentId: "agent-em" }, reportsTo: "agent-po" });
    r.board = b;
    const seat = seatOn(b, { resolveOwn: true, escalate: r.escalate, log: r.log });
    const prompts = [];
    const answer = async (p) => { prompts.push(p); return STUCK; };
    await seat(answer).tick();
    blockAgain(b, SEAT, "rJob"); b.wake("r2");
    await seat(answer).tick();
    assert.strictEqual(prompts.length, 2);
    assert.deepStrictEqual(r.calls.map((c) => c.operation), ["hand_up"]);
    assert.strictEqual(b.card.assigneeAgentId, "agent-po");
  });

  await check("self-block second look, plain reply, escalateTo only: the card goes to the holder", async () => {
    const r = routes();
    const t = await blockedLater(SEAT, { opts: { resolveOwn: true, log: r.log, ...ROUTE }, mutate: withBoard(r) });
    assert.strictEqual(r.calls.length, 0);
    assert.strictEqual(t.b.card.assigneeUserId, "user-avery");
    assert.strictEqual(t.b.card.status, "blocked");
  });

  await check("held escalation second look, plain reply: ask route asks and announces in that wake; hand-up route hands up; holder route escalates", async () => {
    for (const mode of ["ask", "hand_up", "holder"]) {
      const r = routes();
      const b = heldBoard();
      r.board = b;
      const opts = mode === "ask" ? { escalate: r.escalate, onOwnerAsk: r.onOwnerAsk } : mode === "hand_up" ? { escalate: r.escalate } : ROUTE;
      const seat = seatOn(b, { resolveOwn: true, log: r.log, ...opts });
      await heldTicks(b, seat, async () => STUCK);
      if (mode === "ask") {
        assert.strictEqual(askCalls(r).length, 1, `ask calls: ${r.calls.map((c) => c.operation)}`);
        assert.strictEqual(r.asks.length, 1, "announced in the recovery wake");
        b.wake("r4"); await seat(async () => STUCK).tick();
        assert.strictEqual(r.asks.length, 1, "announced twice");
      } else if (mode === "hand_up") {
        assert.deepStrictEqual(r.calls.map((c) => c.operation), ["hand_up"]);
        assert.strictEqual(b.card.assigneeAgentId, "agent-po");
      } else {
        assert.strictEqual(b.card.assigneeUserId, "user-avery", "escalated to the configured holder");
      }
    }
  });

  await check("a model that made its own hand-off or ask in the run is not overridden", async () => {
    const r = routes();
    const b = board({ by: { createdByAgentId: "agent-em" }, reportsTo: "agent-po" });
    r.board = b;
    const seat = seatOn(b, { resolveOwn: true, escalate: r.escalate, onOwnerAsk: r.onOwnerAsk, log: r.log });
    const answer = async (p) => {
      // Second look: the model asks the owner itself, through the action, then reports.
      if (/the block is your own/.test(p)) await r.escalate({ operation: ASK_OPERATION, issue: "c-1", idempotencyKey: "own-choice", decision: "Which way?" });
      return STUCK;
    };
    await seat(answer).tick();
    blockAgain(b, SEAT, "rJob"); b.wake("r2");
    await seat(answer).tick();
    assert.strictEqual(askCalls(r).length, 1, "the code asked on top of the model's own ask");
    assert.strictEqual(r.asks.length, 1, "the model's ask was announced in that wake");
  });

  await check("no route is refused at construction: the poller is not built with the setting on and nowhere to send a card", () => {
    const mk = (extra) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile: join(mkdtempSync(join(tmpdir(), "pc-")), "s.json"),
      log: silent, fetch: async () => ({ ok: false, status: 404, text: async () => "" }), answer: async () => STUCK, resolveOwn: true, ...extra });
    assert.throws(() => mk({}), /PAPERCLIP_RESOLVE_OWN.*PAPERCLIP_ESCALATE_URL.*PAPERCLIP_ESCALATE_TO/);
    const r = routes();
    for (const route of [{ escalate: r.escalate }, ROUTE]) assert.doesNotThrow(() => mk(route));
    assert.doesNotThrow(() => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile: join(mkdtempSync(join(tmpdir(), "pc-")), "s.json"),
      log: silent, fetch: async () => ({ ok: false, status: 404, text: async () => "" }), answer: async () => STUCK }), "setting off needs no route");
  });

  // A Foreman-style card: its description's first line names the writer that
  // keeps its status (PAPERCLIP_EXTERNAL_WRITER). Recovery still has its routes.
  const FOREMAN = "source: acme/service#42\nThe escalation body.";
  await check("a Foreman-style (external-writer) card: self-block recovery asks the owner, hands up, or goes to the holder", async () => {
    for (const mode of ["ask", "hand_up", "holder"]) {
      const r = routes();
      const b = board({ description: FOREMAN, by: { createdByAgentId: "agent-em" }, reportsTo: "agent-po" });
      r.board = b;
      const opts = mode === "ask" ? { escalate: r.escalate, onOwnerAsk: r.onOwnerAsk } : mode === "hand_up" ? { escalate: r.escalate } : ROUTE;
      const seat = seatOn(b, { resolveOwn: true, log: r.log, ...opts });
      const prompts = [];
      const answer = async (p) => { prompts.push(p); return STUCK; };
      await seat(answer).tick();
      blockAgain(b, SEAT, "rJob"); b.wake("r2");
      await seat(answer).tick();
      assert.strictEqual(prompts.length, 2, `${mode}: the model was not started`);
      if (mode === "ask") { assert.strictEqual(askCalls(r).length, 1, `${mode}: ${r.calls.map((c) => c.operation)}`); assert.strictEqual(r.asks.length, 1); }
      else if (mode === "hand_up") assert.deepStrictEqual(r.calls.map((c) => c.operation), ["hand_up"]);
      else assert.strictEqual(b.card.assigneeUserId, "user-avery");
    }
  });

  await check("a Foreman-style (external-writer) held escalation: the second look asks the owner, hands up, or goes to the holder", async () => {
    for (const mode of ["ask", "hand_up", "holder"]) {
      const r = routes();
      const b = heldBoard();
      b.card.description = FOREMAN;
      r.board = b;
      const opts = mode === "ask" ? { escalate: r.escalate, onOwnerAsk: r.onOwnerAsk } : mode === "hand_up" ? { escalate: r.escalate } : ROUTE;
      const seat = seatOn(b, { resolveOwn: true, log: r.log, ...opts });
      const prompts = [];
      await heldTicks(b, seat, async (p) => { prompts.push(p); return STUCK; });
      assert.strictEqual(prompts.length, 2, `${mode}: ${prompts.length} runs`);
      if (mode === "ask") { assert.strictEqual(askCalls(r).length, 1, `${mode}: ${r.calls.map((c) => c.operation)}`); assert.strictEqual(r.asks.length, 1); }
      else if (mode === "hand_up") assert.deepStrictEqual(r.calls.map((c) => c.operation), ["hand_up"]);
      else assert.strictEqual(b.card.assigneeUserId, "user-avery");
    }
  });

  // An ask counts only when announcing it returned true (a message is bound).
  const unbound = (r) => async (a) => { r.asks.push(a); return false; };
  await check("an ask that could not be announced (no chat channel) is handed up through process.escalate in that wake, on both paths", async () => {
    for (const path of ["self-block", "held"]) {
      const r = routes();
      r.onOwnerAsk = unbound(r);
      const prompts = [];
      const answer = async (p) => { prompts.push(p); return STUCK; };
      let b, seat;
      if (path === "held") { b = heldBoard(); r.board = b; seat = seatOn(b, { resolveOwn: true, log: r.log, escalate: r.escalate, onOwnerAsk: r.onOwnerAsk }); await heldTicks(b, seat, answer); }
      else {
        b = board({ by: { createdByAgentId: "agent-em" }, reportsTo: "agent-po" }); r.board = b;
        seat = seatOn(b, { resolveOwn: true, log: r.log, escalate: r.escalate, onOwnerAsk: r.onOwnerAsk });
        await seat(answer).tick(); blockAgain(b, SEAT, "rJob"); b.wake("r2"); await seat(answer).tick();
      }
      assert.deepStrictEqual(r.calls.map((c) => c.operation), [ASK_OPERATION, "hand_up"], `${path}: ${r.calls.map((c) => c.operation)}`);
      assert.match(r.calls[1].blocker, /Handed up instead/);
      assert.strictEqual(b.card.assigneeAgentId, "agent-po", `${path}: not handed up`);
      // The recovery was used: the next wakes do not start the model again.
      const n = prompts.length;
      b.wake("r9"); await seat(answer).tick();
      assert.strictEqual(prompts.length, n, `${path}: looked again after a hand-up`);
    }
  });

  await check("an ask that could not be announced and cannot be handed up leaves nothing used up: warned, and the next wake tries again", async () => {
    for (const path of ["self-block", "held"]) {
      const r = routes();
      r.onOwnerAsk = unbound(r);
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const prompts = [];
      const answer = async (p) => { prompts.push(p); return STUCK; };
      // No reporting line: nowhere to hand up to.
      const b = path === "held" ? heldBoard() : board({ by: { createdByAgentId: "agent-em" } });
      r.board = b;
      const noLine = async (url, init) => {
        const out = await b.fetch(url, init);
        if (/\/agents\/me$/.test(url)) return { ok: true, text: async () => JSON.stringify({ id: "agent-em", name: "Engineering Manager", companyId: "co-1" }) };
        return out;
      };
      const mkNoLine = (extra = {}) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: r.log, fetch: noLine, answer,
        externalWriter: /^source: \S+#\d+$/, resolveOwn: true, escalate: r.escalate, onOwnerAsk: r.onOwnerAsk, ...extra });
      if (path === "held") { for (const id of ["r1", "r2"]) { b.wake(id); await mkNoLine().tick(); } }
      else { await mkNoLine().tick(); blockAgain(b, SEAT, "rJob"); b.wake("r2"); await mkNoLine().tick(); }
      const before = prompts.length;
      assert.strictEqual(before, 2, `${path}: ${before} runs`);
      assert.ok(r.warns.some((w) => /nothing is used up, the next wake tries again/.test(w)), `${path}: warns ${r.warns}`);
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.ok(!JSON.stringify(saved).match(/ownLook|ownRun|heldLook/), `${path}: the look was persisted as used`);
      assert.deepStrictEqual(b.card.blockedBy ?? [], [], `${path}: the owner card is still a blocker`);
      // The channel is back: the next wake looks again.
      r.onOwnerAsk = async (a) => { r.asks.push(a); return true; };
      b.wake("r10");
      await mkNoLine({ onOwnerAsk: r.onOwnerAsk }).tick();
      assert.strictEqual(prompts.length, before + 1, `${path}: the next wake did not start the model`);
    }
  });

  await check("startup validation: on with no route is a problem; a route, or off, is not", () => {
    assert.match(resolveOwnRouteProblem({ PAPERCLIP_RESOLVE_OWN: "on" }), /PAPERCLIP_ESCALATE_URL.*PAPERCLIP_ESCALATE_TO/);
    assert.strictEqual(resolveOwnRouteProblem({ PAPERCLIP_RESOLVE_OWN: "off" }), null);
    assert.strictEqual(resolveOwnRouteProblem({}), null);
    assert.strictEqual(resolveOwnRouteProblem({ PAPERCLIP_RESOLVE_OWN: "on", PAPERCLIP_ESCALATE_TO: "agent:Product Owner" }), null);
    assert.strictEqual(resolveOwnRouteProblem({ PAPERCLIP_RESOLVE_OWN: "on", PAPERCLIP_ESCALATE_URL: "https://x.example.com/mcp", PAPERCLIP_ESCALATE_BEARER_ENV: "T", T: "v" }), null);
    // A URL whose bearer variable is empty is no route.
    assert.match(resolveOwnRouteProblem({ PAPERCLIP_RESOLVE_OWN: "on", PAPERCLIP_ESCALATE_URL: "https://x.example.com/mcp", PAPERCLIP_ESCALATE_BEARER_ENV: "T" }), /PAPERCLIP_RESOLVE_OWN=on/);
  });

  await check("doctor flags PAPERCLIP_RESOLVE_OWN=on with no route, and stays silent when off", async () => {
    const { checkResolveOwn, FAIL, PASS } = await import("../scripts/lib/checks.mjs");
    assert.strictEqual(checkResolveOwn({ PAPERCLIP_RESOLVE_OWN: "on" }).status, FAIL);
    assert.strictEqual(checkResolveOwn({ PAPERCLIP_RESOLVE_OWN: "on", PAPERCLIP_ESCALATE_TO: "agent:x" }).status, PASS);
    assert.strictEqual(checkResolveOwn({}), null);
    assert.strictEqual(checkResolveOwn({ PAPERCLIP_RESOLVE_OWN: "maybe" }).status, FAIL);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
