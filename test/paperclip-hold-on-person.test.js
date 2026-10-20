/**
 * Paperclip — a hold that waits on a person. An answer that says it is
 * blocked on someone (`PAPERCLIP-OUTCOME: blocked on <Name>`) hands the task to
 * that person, still blocked, inside the run, so it waits with them. The
 * self-caused wakes a hand-off brings (a comment wake, the board's review-path
 * recovery) never bury the held answer under an empty or "answered above" note.
 */
const assert = require("assert");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, outcomeOf, OUTCOME_MARK } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const SEATS = [{ id: "agent-em", name: "Engineering Manager" }, { id: "agent-po", name: "Product Owner" }];
const PEOPLE = [{ principalId: "user-avery", status: "active", user: { id: "user-avery", name: "Avery" } }];

/** One task held by the bot, handed to it by a person, with a live run on it. */
function board({ description = "Ship the release." } = {}) {
  const card = { id: "c-1", identifier: "SLA-1", title: "Release the change", description,
    status: "in_progress", assigneeAgentId: "agent-em", assigneeUserId: null, labels: [], createdAt: "2026-01-01T00:00:00Z", createdByUserId: "user-avery", requestDepth: 0 };
  const activity = [], comments = [], writes = [];
  const runs = [{ id: "r1", agentId: "agent-em", status: "running" }];
  // Why each run woke, as Paperclip records it (none: the run does not say).
  const reasons = {};
  let last = 0, ids = 0;
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
      if (body.status && body.status !== card.status) { record(actor, { status: { from: card.status, to: body.status } }, runId); card.status = body.status; }
      if (body.unblockDescriptor) card.unblockDescriptor = body.unblockDescriptor;
      if ("assigneeAgentId" in body || "assigneeUserId" in body) {
        record(actor, { assigneeAgentId: { from: card.assigneeAgentId, to: body.assigneeAgentId ?? null }, assigneeUserId: { from: card.assigneeUserId, to: body.assigneeUserId ?? null } }, runId);
        card.assigneeAgentId = body.assigneeAgentId ?? null; card.assigneeUserId = body.assigneeUserId ?? null;
      }
      if ("comment" in body) { comments.push({ id: `c${comments.length}`, authorAgentId: "agent-em", createdAt: now(), body: body.comment, createdByRunId: runId }); runs[0].status = "succeeded"; }
      return ok({});
    }
    if (!m[2]) return ok({ ...card, blockedBy: [] });
    if (m[2] === "/activity") return ok(activity);
    if (m[2] === "/comments") return ok(comments);
    if (m[2] === "/runs") return ok(runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  /** A wake the bot caused itself: a new run on the same, unchanged ask. */
  const wake = (id, reason) => { runs[0] = { id, agentId: "agent-em", status: "running" }; if (reason) reasons[id] = reason; };
  return { card, writes, comments, fetch, wake };
}
const seatOn = (b, opts = {}) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
  return (answer) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch: b.fetch, answer,
    externalWriter: /^source: \S+#\d+$/, ...opts });
};
const HELD = `Built and verified, but not releasing yet: Avery must approve the release window.\n${OUTCOME_MARK} blocked on Avery`;
const visible = (b) => b.comments.filter((c) => !c.deletedAt);

(async () => {
  await check("`blocked on <Name>` reads the person; plain `blocked` names nobody", async () => {
    assert.strictEqual(outcomeOf(HELD).person, "Avery");
    assert.strictEqual(outcomeOf(`x\n${OUTCOME_MARK} blocked on Avery, SLA-9.`).person, "Avery");
    assert.strictEqual(outcomeOf(`x\n${OUTCOME_MARK} blocked`).person, null);
  });

  await check("a hand-off, a held answer and two self-caused wakes: the held answer stays newest, blocked on the person", async () => {
    const b = board(), seat = seatOn(b);
    let calls = 0;
    const answer = async () => { calls++; return HELD; };
    await seat(answer).tick();
    b.wake("r2"); await seat(answer).tick();      // the comment wake the hand-off brought
    b.wake("r3"); await seat(answer).tick();      // the board's review-path recovery
    assert.strictEqual(calls, 1, "the held ask ran again");
    assert.strictEqual(b.card.status, "blocked");
    assert.strictEqual(b.card.assigneeUserId, "user-avery", JSON.stringify(b.writes));
    assert.strictEqual(b.card.assigneeAgentId, null);
    assert.deepStrictEqual(b.card.unblockDescriptor.owner, { agentId: "agent-em" }, "the board refuses an agent naming anyone else as unblock owner");
    assert.match(b.card.unblockDescriptor.action, /Waits on Avery/);
    assert.strictEqual(visible(b).at(-1).body, HELD.split("\n")[0], "the held answer is not the newest visible comment");
    assert.ok(b.writes.every((w) => w.runId === "r1"), `a self-caused wake wrote: ${JSON.stringify(b.writes)}`);
    assert.ok(b.comments.every((c) => c.body.trim()), "an empty comment is on the card");
    assert.ok(b.comments.every((c) => !/answered above|anything new/.test(c.body)));
  });

  await check("the hand-off write names the bot as unblock owner and the person as assignee only (the board's 403 rule)", async () => {
    const b = board(), seat = seatOn(b);
    await seat(async () => HELD).tick();
    const [w] = b.writes;
    assert.strictEqual(b.writes.length, 1, JSON.stringify(b.writes));
    assert.deepStrictEqual(w.body.unblockDescriptor.owner, { agentId: "agent-em" });
    assert.strictEqual(w.body.assigneeUserId, "user-avery");
    assert.strictEqual(w.body.assigneeAgentId, null);
    assert.strictEqual(w.body.status, "blocked");
    assert.ok(!b.comments.some((c) => /refused/.test(c.body)), "the board refused the hand-off");
  });

  await check("a person the board does not have leaves the task with the bot, blocked, and says so", async () => {
    const b = board(), seat = seatOn(b);
    await seat(async () => `Waiting on a sign-off.\n${OUTCOME_MARK} blocked on Quinn`).tick();
    assert.strictEqual(b.card.status, "blocked");
    assert.strictEqual(b.card.assigneeAgentId, "agent-em");
    assert.match(b.writes.at(-1).body.comment, /could not hand this task to Quinn: the board has no person by that name/);
  });

  // A mirrored card held on a person is blocked by the bot's answer, its holder
  // and links left to its writer; each re-wake is the model's to decide once,
  // and an answer that only repeats the last one escalates (SLA-1775).
  await check("on a task another writer owns, a held answer blocks it in place, and a re-wake the model looks at never restates it", async () => {
    const b = board({ description: "source: org/docs#456\nShip the release." }), seat = seatOn(b, { rewake: 4 });
    const answer = async () => HELD;
    await seat(answer).tick();
    assert.strictEqual(b.card.status, "blocked");
    assert.strictEqual(b.card.assigneeAgentId, "agent-em", "another writer's task changed holder");
    assert.ok(b.writes.every((w) => !("assigneeUserId" in w.body) && !("blockedByIssueIds" in w.body)), "another writer's holder or links were written");
    b.wake("r2"); await seat(answer).tick();
    b.wake("r3"); await seat(answer).tick();
    assert.ok(b.writes.every((w) => !w.deleted), "a note was taken down, leaving a blank comment");
    const later = b.writes.filter((w) => w.runId !== "r1").map((w) => w.body.comment);
    assert.strictEqual(later.length, 2, JSON.stringify(later));
    assert.ok(later.every((n) => /Escalating: I would only repeat my last answer/.test(n) && !/Nothing has changed since my last/.test(n)), JSON.stringify(later));
    assert.strictEqual(b.card.status, "blocked");
    assert.ok(b.comments.every((c) => c.body.trim()), "an empty comment is on the card");
  });

  // SLA-2088: a wake Paperclip does not hold to a comment may end with nothing
  // said, but a re-wake the model looks at decides, and a repeat still goes to
  // whoever decides: the escalation is posted, never swallowed.
  await check("a hold on a person re-woken on wakes that need no comment: the looked-at re-wake still escalates, in a comment", async () => {
    const b = board({ description: "source: org/docs#456\nShip the release." }), seat = seatOn(b, { rewake: 4 });
    const answer = async () => HELD;
    await seat(answer).tick();
    b.wake("r2", "issue_commented"); await seat(answer).tick();
    b.wake("r3", "issue_review_path_lost"); await seat(answer).tick();
    const later = b.writes.filter((w) => w.runId !== "r1").map((w) => w.body.comment);
    assert.strictEqual(later.length, 2, JSON.stringify(later));
    assert.ok(later.every((n) => /Escalating: I would only repeat my last answer/.test(n)), JSON.stringify(later));
    assert.ok(!b.writes.some((w) => "requestDepth" in w.body), "an escalation was closed without a comment");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
