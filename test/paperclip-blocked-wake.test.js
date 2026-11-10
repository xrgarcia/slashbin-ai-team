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
const { createPaperclipPoller, outcomeOf, OUTCOME_MARK, buildTaskPrompt, unchangedNote, COMMENT_WAKES, QUIET_MARK } = require("../lib/paperclip");

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
      // As the live board (issue-execution-policy.ts): the review stage's
      // current participant moving the card out of review is its decision,
      // and a decision without a comment is refused.
      if (card.status === "in_review" && card.executionState?.currentParticipant?.agentId === "agent-em"
        && body.status && body.status !== "in_review" && !("comment" in body)) {
        return { ok: false, status: 422, text: async () => JSON.stringify({ error: "Requesting changes requires a comment." }) };
      }
      // With its comment it is recorded: done approves; any other status is
      // changes requested, and the board itself moves the card to in progress
      // with whoever did the work, so an unblock note sent with it is refused.
      if (card.status === "in_review" && card.executionState?.currentParticipant?.agentId === "agent-em"
        && body.status && body.status !== "in_review") {
        if (body.status === "done") card.executionState = { ...card.executionState, status: "completed", currentParticipant: null, lastDecisionOutcome: "approved" };
        else {
          if (body.unblockDescriptor) return { ok: false, status: 422, text: async () => JSON.stringify({ error: "unblockDescriptor requires blocked status" }) };
          const back = card.executionState.returnAssignee;
          card.executionState = { ...card.executionState, status: "changes_requested", currentParticipant: null, lastDecisionOutcome: "changes_requested" };
          body.status = "in_progress"; body.assigneeAgentId = back.agentId ?? null; body.assigneeUserId = back.userId ?? null;
          delete body.blockedByIssueIds;
        }
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
    if (!m[2]) return ok({ ...card, blockedBy: [] });
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
  return { card, writes, comments, fetch, wake, runs };
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

  // SLA-2088: the board showed the answer, then "Nothing has changed since my
  // last answer: ..." once or twice within the minute — one wake for comments
  // the answer already covered, one for Paperclip's review-path recovery.
  await check("SLA-2088 burst: an answer, then two re-wakes with nothing new: no new comment, the card back in its block, each run ended by the quiet mark", async () => {
    const b = board({ by: { createdByAgentId: "agent-em" } }), seat = seatOn(b);
    let calls = 0;
    const answer = async () => { calls++; return STUCK; };
    await seat(answer).tick();
    const posted = visible(b).length;
    assert.strictEqual(b.card.status, "blocked");
    for (const [run, reason] of [["r2", "issue_unblock_requested"], ["r3", "issue_review_path_lost"]]) {
      b.wake(run, reason);
      assert.strictEqual(b.card.status, "in_progress", "the wake's checkout");
      await seat(answer).tick();
      assert.strictEqual(visible(b).length, posted, `${reason} posted: ${visible(b).at(-1).body}`);
      assert.strictEqual(b.card.status, "blocked", `${reason} left the card ${b.card.status}`);
      assert.strictEqual(b.runs[0].status, "succeeded", `${reason}: the run was not ended`);
      const mine = b.writes.filter((w) => w.runId === run);
      assert.ok(mine.length >= 1 && mine.every((w) => !("comment" in w.body)), JSON.stringify(mine));
      assert.ok(mine.some((w) => w.body[QUIET_MARK] === 0), `no write of ${run} carried the quiet mark: ${JSON.stringify(mine)}`);
      // A tick after: nothing more.
      await seat(answer).tick();
      assert.strictEqual(visible(b).length, posted);
    }
    assert.strictEqual(calls, 1, "a re-wake with nothing new ran the model again");
  });

  // The bot is the current reviewer of its own card. Paperclip's
  // review-recovery wake is not one it holds to a comment, but the reviewer's
  // status write is a decision and needs one: the quiet close was refused
  // every tick and the run held the seat for days.
  await check("a re-wake with nothing new on a card this seat is reviewing ends with a comment, not the quiet close", async () => {
    const b = board({ by: { createdByAgentId: "agent-em" } }), seat = seatOn(b);
    await seat(async () => `Checked.\n${OUTCOME_MARK} done`).tick();
    const posted = visible(b).length;
    b.card.status = "in_review";
    b.card.executionState = { status: "pending", currentStageType: "review", currentParticipant: { type: "agent", agentId: "agent-em", userId: null } };
    b.wake("r2", "execution_review_participant_recovery");
    await seat(async () => `Checked.\n${OUTCOME_MARK} done`).tick();
    assert.strictEqual(b.runs[0].status, "succeeded", `the run was not ended: ${JSON.stringify(b.writes.filter((w) => w.runId === "r2"))}`);
    assert.strictEqual(visible(b).length, posted + 1);
    assert.strictEqual(visible(b).at(-1).createdByRunId, "r2");
    assert.ok(!b.writes.some((w) => w.runId === "r2" && QUIET_MARK in w.body), "a write carried the quiet mark");
  });

  // The bot is the requester and the review stage's participant on work
  // another seat did. Its answer is the stage's decision: a held answer
  // (blocked, return) was refused by the stage, landed as a comment only, and
  // the board moved the card to blocked with no decision (live 2026-11-10,
  // SLA-4513: "the originating requester needs to provide final acceptance").
  const inReview = () => {
    const b = board({ by: { createdByAgentId: "agent-em" } });
    b.card.status = "in_review";
    b.card.executionState = { status: "pending", currentStageType: "review", returnAssignee: { type: "agent", agentId: "agent-po", userId: null },
      currentParticipant: { type: "agent", agentId: "agent-em", userId: null } };
    b.comments.push({ id: "cw", authorAgentId: "agent-po", authorUserId: null, createdAt: new Date(Date.now() + 1000).toISOString(), body: "Done: the report was sent (exit 0)." });
    b.wake("r2", "execution_review_participant_recovery");
    return b;
  };
  for (const [said, answer] of [["blocked", `The requester must accept this.\n${OUTCOME_MARK} blocked`], ["return", `The requester must accept this.\n${OUTCOME_MARK} return`],
    ["follow-up", `The log summary is missing.\n${OUTCOME_MARK} follow-up`]]) {
    await check(`a reviewer's ${said} answer is recorded as changes requested: the card goes back to whoever did the work, with one comment`, async () => {
      const b = inReview(), seat = seatOn(b);
      await seat(async () => answer).tick();
      assert.strictEqual(b.card.executionState.lastDecisionOutcome, "changes_requested", JSON.stringify(b.writes));
      assert.strictEqual(b.card.status, "in_progress");
      assert.strictEqual(b.card.assigneeAgentId, "agent-po");
      assert.strictEqual(visible(b).filter((c) => c.createdByRunId === "r2").length, 1);
      assert.ok(!b.writes.some((w) => w.body?.unblockDescriptor), "a write carried an unblock note");
    });
  }

  await check("a reviewer's done answer approves the stage", async () => {
    const b = inReview(), seat = seatOn(b);
    await seat(async () => `Accepted: the send is verified.\n${OUTCOME_MARK} done`).tick();
    assert.strictEqual(b.card.executionState.lastDecisionOutcome, "approved", JSON.stringify(b.writes));
    assert.strictEqual(b.card.status, "done");
  });

  await check("the review prompt makes the reviewer the one who accepts, and reads a held answer as a send-back", async () => {
    const issue = { id: "c-1", identifier: "T-1", title: "Report", status: "in_review", assigneeAgentId: "agent-po", createdByAgentId: "agent-em",
      executionState: { currentParticipant: { type: "agent", agentId: "agent-em" } } };
    const p = buildTaskPrompt(issue, [], me, "u");
    assert.match(p, /board records your answer as the review decision/);
    assert.match(p, /that is you here/);
    assert.match(p, /Do not answer a review blocked/);
  });

  await check("a re-wake with nothing new on a wake Paperclip holds to a comment still gets the note, once", async () => {
    for (const reason of COMMENT_WAKES) {
      const b = board({ by: { createdByAgentId: "agent-em" } }), seat = seatOn(b);
      await seat(async () => STUCK).tick();
      const posted = visible(b).length;
      b.wake("r2", reason); await seat(async () => STUCK).tick();
      assert.strictEqual(visible(b).length, posted + 1, reason);
      assert.match(visible(b).at(-1).body, /^Nothing has changed since my last answer/, reason);
      assert.ok(!b.writes.some((w) => QUIET_MARK in w.body), `${reason}: a write carried the quiet mark`);
    }
  });

  await check("a new comment from someone else on a quiet wake is still answered", async () => {
    const b = board({ by: { createdByAgentId: "agent-em" } }), seat = seatOn(b);
    await seat(async () => STUCK).tick();
    b.comments.push({ id: "cx", authorAgentId: null, authorUserId: "user-avery", createdAt: new Date(Date.now() + 1000).toISOString(), body: "The decision: ship it." });
    b.wake("r2", "issue_commented");
    await seat(async () => `Shipped.\n${OUTCOME_MARK} done`).tick();
    assert.strictEqual(visible(b).at(-1).body.split("\n")[0], "Shipped.");
    assert.ok(!b.writes.some((w) => QUIET_MARK in w.body), "an answer carried the quiet mark");
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

  await check("a mirrored task's prompt says its hold is the source's to release, never cleared by the run", async () => {
    const issue = { identifier: "T-1", title: "Q", description: "source: acme/svc#185", status: "blocked" };
    const p = buildTaskPrompt(issue, [], me, "u", { mirrored: true });
    assert.match(p, /a hold here is the source's/);
    assert.match(p, /never call it cleared/);
    assert.match(p, /PAPERCLIP-OUTCOME: blocked\./);
    assert.doesNotMatch(buildTaskPrompt(issue, [], me, "u"), /mirrors another system/, "a task of the bot's own carries no such line");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
