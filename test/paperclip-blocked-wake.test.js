/**
 * Paperclip — a blocked card the bot holds with nothing it can clear (the
 * blocked-owner re-wake loop), and a board run reading its card from the prompt.
 *
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
const { createPaperclipPoller, outcomeOf, OUTCOME_MARK, buildTaskPrompt, unchangedNote } = require("../lib/paperclip");

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
    status: "in_progress", assigneeAgentId: "agent-em", assigneeUserId: null, labels: [], createdAt: "2026-01-01T00:00:00Z", ...by };
  const activity = [], comments = [], writes = [];
  const runs = [{ id: "r1", agentId: "agent-em", status: "running" }];
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
    if (/^\/heartbeat-runs\/r\d$/.test(path)) return ok({ contextSnapshot: {} });
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
      return ok({});
    }
    if (!m[2]) return ok({ ...card, blockedBy: [] });
    if (m[2] === "/activity") return ok(activity);
    if (m[2] === "/comments") return ok(comments);
    if (m[2] === "/runs") return ok(runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  /** A wake the bot caused itself: a new run on the same, unchanged ask. */
  const wake = (id) => {
    runs[0] = { id, agentId: "agent-em", status: "running" };
    // The board's checkout of a wake: a blocked card the bot holds is in progress for the run.
    if (card.status === "blocked" && card.assigneeAgentId === "agent-em") { card.status = "in_progress"; card.blockedTransitionAt = null; }
  };
  return { card, writes, comments, fetch, wake };
}
const seatOn = (b, opts = {}) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
  return (answer) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile, log: silent, fetch: b.fetch, answer,
    externalWriter: /^source: \S+#\d+$/, ...opts });
};
const HELD = `Built and verified, but not releasing yet: Avery must approve the release window.\n${OUTCOME_MARK} blocked on Avery`;
const visible = (b) => b.comments.filter((c) => !c.deletedAt);

const STUCK = `Nothing here is mine to do; it needs a decision.\n${OUTCOME_MARK} blocked`;
const me = { id: "agent-em", name: "Engineering Manager" };

(async () => {
  await check("a plain block on a card another agent created hands it to that agent in the first write: one comment, the clock set once, no wake of the bot", async () => {
    const b = board(), seat = seatOn(b);
    const answer = async () => STUCK;
    await seat(answer).tick();
    assert.strictEqual(b.card.status, "blocked");
    assert.strictEqual(b.card.assigneeAgentId, "agent-po", JSON.stringify(b.writes));
    assert.deepStrictEqual(b.card.unblockDescriptor.owner, { agentId: "agent-em" }, "the board refuses an agent naming anyone else as unblock owner");
    assert.match(visible(b).at(-1).body, /goes back to Product Owner, who created it/);
    const [posted, clock] = [visible(b).length, b.card.blockedTransitionAt];
    for (const r of ["r2", "r3"]) { b.wake(r); await seat(answer).tick(); }
    assert.strictEqual(visible(b).length, posted, "a card the creator holds was written to again");
    assert.strictEqual(b.card.blockedTransitionAt, clock, "the blocked clock moved");
  });

  await check("a card blocked earlier with the bot as holder is handed to its creator on the next wake", async () => {
    const b = board(), seat = seatOn(b);
    // The block of an older version: the bot holds the card.
    b.card.createdByAgentId = null; b.card.createdByUserId = "user-avery";
    const answer = async () => STUCK;
    await seat(answer).tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-em");
    b.card.createdByAgentId = "agent-po"; b.card.createdByUserId = null;
    b.wake("r2"); await seat(answer).tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-po", JSON.stringify(b.writes));
    assert.match(visible(b).at(-1).body, /goes back to Product Owner, who created it/);
  });

  await check("`blocked on <an agent seat>` hands the card to that agent in the first write", async () => {
    const b = board(), seat = seatOn(b);
    await seat(async () => `Needs your call.\n${OUTCOME_MARK} blocked on Product Owner`).tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-po", JSON.stringify(b.writes));
    assert.strictEqual(visible(b).length, 2, "the ask and one answer");
  });

  await check("a card the bot created itself stays with it: nothing to hand to", async () => {
    const b = board({ by: { createdByAgentId: "agent-em" } }), seat = seatOn(b);
    await seat(async () => STUCK).tick();
    b.wake("r2"); await seat(async () => STUCK).tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-em");
    assert.match(visible(b).at(-1).body, /^Nothing has changed since my last answer/);
  });

  await check("a card waiting on a person is not taken to its creator", async () => {
    const b = board(), seat = seatOn(b);
    const answer = async () => `Needs sign-off.\n${OUTCOME_MARK} blocked on Avery`;
    await seat(answer).tick();
    b.wake("r2"); await seat(answer).tick();
    assert.strictEqual(b.card.assigneeUserId, "user-avery");
    assert.strictEqual(b.card.assigneeAgentId, null);
  });

  await check("the note states the card, not an earlier answer's claim that the run could not read it", async () => {
    const said = "I can't read T-1's card state from this run. That includes its status.";
    assert.strictEqual(unchangedNote(said, null, "the card is blocked."), "Nothing has changed since my last answer: the card is blocked.");
    assert.match(unchangedNote("Waiting on the vendor.", null, "the card is blocked."), /Waiting on the vendor\./, "an ordinary reason is still quoted");
    assert.match(unchangedNote(said, null), /I can't read/, "with no state to give, the quote stands");
  });

  await check("the prompt carries the card: status, holder, creator, reviewer, unblock owner and action, blockers", async () => {
    const issue = { identifier: "T-1", title: "Q", status: "in_review", assigneeAgentId: "agent-em", createdByAgentId: "agent-po",
      executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: "agent-po" }] }] },
      unblockDescriptor: { owner: { agentId: "agent-em" }, action: "Reply on the card." }, blockedBy: [{ identifier: "T-9", status: "todo" }] };
    const names = (id) => ({ "agent-po": "Product Owner" })[id];
    const p = buildTaskPrompt(issue, [], me, "u", { names, runId: "run-abc-123" });
    assert.match(p, /This run: run-abc-123/);
    assert.match(p, /Status: in_review/);
    assert.match(p, /Assigned to: Engineering Manager \(you\)/);
    assert.match(p, /Created by: Product Owner/);
    assert.match(p, /Reviewer: Product Owner/);
    assert.match(p, /Unblock owner: Engineering Manager \(you\)/);
    assert.match(p, /Unblock action: Reply on the card\./);
    assert.match(p, /Blocked by: T-9 \(todo\)/);
    assert.ok(p.indexOf("Card now") < p.indexOf("Answer the latest ask"));
    assert.doesNotMatch(buildTaskPrompt({ identifier: "T-1", title: "Q" }, [], me, "u"), /Card now/, "a card with no read status carries no block");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
