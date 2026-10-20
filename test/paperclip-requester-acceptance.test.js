// The requester accepts (SLA-C1 task-completion, epic 651): a finished answer
// on a task the seat did not create is left in its creator's review, never
// closed by the answerer; the reviewer accepts (done) or asks a follow-up,
// which goes back to whoever did the work; and each run reads the policy live.
const assert = require("assert");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, outcomeOf, OUTCOME_MARK, REVIEW_ROUNDS, requesterOf, parsePolicy } = require("../lib/paperclip");


let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const SEATS = [{ id: "agent-em", name: "Engineering Manager" }, { id: "agent-po", name: "Product Owner" }];
const POLICY = { caseId: "182016d6-9cb6-4b2f-9960-5cac2d82e5f5", key: "task-completion" };

/**
 * One task held by the EM seat, with a live run on it. `status`/`assignee`
 * place it; an in_review write with a review path hands it to the reviewer, a
 * reviewer's non-done write returns it to `returnTo` (Paperclip's changes-requested).
 */
function board({ createdBy = { createdByAgentId: "agent-po" }, status = "in_progress", returnTo = null, policy = "ok" } = {}) {
  const card = { id: "c-1", identifier: "SLA-1", title: "Publish the roadmap", description: "Make it publish reliably.",
    status, assigneeAgentId: "agent-em", assigneeUserId: null, labels: [], createdAt: "2026-01-01T00:00:00Z", ...createdBy };
  const activity = [], comments = [], writes = [], reads = [];
  const runs = [{ id: "r1", agentId: "agent-em", status: "running" }];
  let last = 0, ids = 0;
  const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();
  const record = (actor, changes, runId) => activity.unshift({ id: `a${++ids}`, action: "issue.updated", createdAt: now(), ...actor, runId, details: { changes } });
  comments.push({ id: "c0", authorAgentId: "agent-po", authorUserId: null, createdAt: now(), body: "Please make the publish reliable." });
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-em", name: "Engineering Manager", companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok(SEATS);
    if (path === "/agents/me/inbox-lite") return ok(card.assigneeAgentId === "agent-em" && card.status !== "in_review" ? [{ id: card.id, status: card.status, unresolvedBlockerIssueIds: [] }] : []);
    if (path.startsWith("/companies/co-1/issues?")) return ok(card.assigneeAgentId === "agent-em" && card.status === "in_review" ? [{ ...card }] : []);
    if (path === `/cases/${POLICY.caseId}/documents/${POLICY.key}`) {
      reads.push(path);
      if (policy !== "ok") return { ok: false, status: 403, text: async () => JSON.stringify({ error: "forbidden" }) };
      return ok({ key: POLICY.key, latestBody: "# Requester acceptance\nThe requester closes.", latestRevisionId: "d84938ad-5446-44e9-b7c5-b194c638d903", latestRevisionNumber: 2 });
    }
    const m = path.match(/^\/issues\/([^/]+)(\/[a-z]+)?$/);
    if (!m || ![card.id, card.identifier].includes(decodeURIComponent(m[1]))) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      const runId = init.headers["x-paperclip-run-id"];
      const body = JSON.parse(init.body);
      writes.push({ runId, body });
      const actor = { actorType: "agent", actorId: "agent-em" };
      const from = { a: card.assigneeAgentId, u: card.assigneeUserId };
      if (body.status === "in_review") {
        const [p] = body.executionPolicy?.stages?.[0]?.participants ?? [];
        // Paperclip gives an id-less stage a new id; a review state left on
        // another stage id is orphaned, and the write has no reviewer (SLA-1871).
        const orphaned = card.executionState?.currentStageId && body.executionPolicy?.stages?.[0]?.id !== card.executionState.currentStageId;
        if (!p || orphaned) return { ok: false, status: 422, text: async () => JSON.stringify({ error: "invalid_issue_disposition: in_review needs a review path" }) };
        card.assigneeAgentId = p.agentId ?? null; card.assigneeUserId = p.userId ?? null;
      } else if (card.status === "in_review" && body.status && body.status !== "done" && returnTo) {
        card.assigneeAgentId = returnTo; card.assigneeUserId = null;
      }
      if (body.status && body.status !== card.status) { record(actor, { status: { from: card.status, to: body.status } }, runId); card.status = body.status; }
      if (from.a !== card.assigneeAgentId || from.u !== card.assigneeUserId) record(actor, { assigneeAgentId: { from: from.a, to: card.assigneeAgentId }, assigneeUserId: { from: from.u, to: card.assigneeUserId } }, runId);
      if (body.comment) { comments.push({ id: `c${comments.length}`, authorAgentId: "agent-em", createdAt: now(), body: body.comment, createdByRunId: runId }); runs[0].status = "succeeded"; }
      return ok({});
    }
    if (!m[2]) return ok({ ...card, blockedBy: [] });
    if (m[2] === "/activity") return ok(activity);
    if (m[2] === "/comments") return ok(comments);
    if (m[2] === "/runs") return ok(runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { card, writes, comments, reads, fetch };
}
const seat = (b, answer, extra = {}) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k",
  stateFile: join(mkdtempSync(join(tmpdir(), "pc-")), "s.json"), log: silent, fetch: b.fetch, answer, externalWriter: /^source: \S+#\d+$/, policy: POLICY, ...extra });

(async () => {
  await check("the requester is the task's creator from its record, never the seat itself", async () => {
    assert.strictEqual(requesterOf({ createdByAgentId: "agent-po" }, "agent-em"), "agent:agent-po");
    assert.strictEqual(requesterOf({ createdByUserId: "user-ray" }, "agent-em"), "user:user-ray");
    assert.strictEqual(requesterOf({ createdByAgentId: "agent-em" }, "agent-em"), null);
    assert.strictEqual(requesterOf({}, "agent-em"), null);
  });

  await check("an answer on a task another seat created is left open in its review, in one write under the run", async () => {
    const b = board();
    await seat(b, async () => "Done: the publish retries now.").tick();
    assert.strictEqual(b.writes.length, 1, JSON.stringify(b.writes));
    const [w] = b.writes;
    assert.strictEqual(w.runId, "r1");
    assert.strictEqual(w.body.status, "in_review");
    assert.deepStrictEqual(w.body.executionPolicy, { maxReviewRounds: REVIEW_ROUNDS, stages: [{ type: "review", participants: [{ type: "agent", agentId: "agent-po" }] }] });
    assert.strictEqual(w.body.comment, "Done: the publish retries now.");
    assert.strictEqual(b.card.assigneeAgentId, "agent-po");
  });

  await check("a second answer after the requester's follow-up reuses the card's review stage, so it returns to review", async () => {
    const b = board();
    b.card.executionState = { status: "changes_requested", currentStageId: "st-1", changesRequestedCount: 1 };
    await seat(b, async () => "Second answer: the limit is covered.").tick();
    assert.strictEqual(b.writes.length, 1, JSON.stringify(b.writes));
    assert.strictEqual(b.writes[0].body.executionPolicy.stages[0].id, "st-1");
    assert.strictEqual(b.card.status, "in_review");
    assert.strictEqual(b.card.assigneeAgentId, "agent-po");
    assert.strictEqual(b.comments.at(-1).body, "Second answer: the limit is covered.");
  });

  await check("a task a person created waits for that person's review: no agent accepts for them", async () => {
    const b = board({ createdBy: { createdByAgentId: null, createdByUserId: "user-ray" } });
    await seat(b, async () => "Here is the result.").tick();
    assert.strictEqual(b.card.status, "in_review");
    assert.deepStrictEqual(b.writes[0].body.executionPolicy.stages[0].participants, [{ type: "user", userId: "user-ray" }]);
    assert.strictEqual(b.card.assigneeUserId, "user-ray");
  });

  await check("a board with no company policy keeps answerer-closes: done", async () => {
    const b = board();
    let prompt = "";
    await seat(b, async (p) => { prompt = p; return "Result."; }, { policy: null }).tick();
    assert.strictEqual(b.writes[0].body.status, "done");
    assert.strictEqual(b.reads.length, 0);
    assert.doesNotMatch(prompt, /you do not close it|Task completion policy/);
  });

  await check("a task the seat created itself closes done on its answer", async () => {
    const b = board({ createdBy: { createdByAgentId: "agent-em" } });
    await seat(b, async () => "All done.").tick();
    assert.strictEqual(b.writes[0].body.status, "done");
  });

  await check("blocked and return answers are unchanged by requester review", async () => {
    const b = board();
    await seat(b, async () => `Waiting on access.\n${OUTCOME_MARK} blocked`).tick();
    assert.strictEqual(b.writes[0].body.status, "blocked");
    assert.strictEqual(b.writes[0].body.executionPolicy, undefined);
  });

  await check("an answer ending `return` to the task's creator goes to that creator's review, not up as a hand-off", async () => {
    const b = board();
    await seat(b, async () => `Result is in.\n${OUTCOME_MARK} return`).tick();
    assert.strictEqual(b.writes.length, 1, JSON.stringify(b.writes));
    assert.strictEqual(b.writes[0].body.status, "in_review");
    assert.deepStrictEqual(b.writes[0].body.executionPolicy.stages[0].participants, [{ type: "agent", agentId: "agent-po" }]);
    assert.strictEqual(b.card.assigneeAgentId, "agent-po");
  });

  await check("the reviewer's plain answer accepts: the task is done", async () => {
    const b = board({ createdBy: { createdByAgentId: "agent-em" }, status: "in_review", returnTo: "agent-po" });
    await seat(b, async () => "Accepted: the evidence checks out.").tick();
    assert.strictEqual(b.writes.at(-1).body.status, "done", JSON.stringify(b.writes));
    assert.strictEqual(b.writes.at(-1).body.executionPolicy, undefined);
  });

  await check("the reviewer's follow-up sends it back to whoever did the work, on the same task, with the comment", async () => {
    assert.strictEqual(outcomeOf(`More please.\n${OUTCOME_MARK} follow-up`).followUp, true);
    assert.strictEqual(outcomeOf(`x\n${OUTCOME_MARK} blocked\n${OUTCOME_MARK} follow-up`).followUp, false);
    const b = board({ createdBy: { createdByAgentId: "agent-em" }, status: "in_review", returnTo: "agent-po" });
    await seat(b, async () => `Also cover the retry limit.\n${OUTCOME_MARK} follow-up`).tick();
    const w = b.writes.at(-1);
    assert.strictEqual(w.body.status, "in_progress", JSON.stringify(b.writes));
    assert.strictEqual(w.body.comment, "Also cover the retry limit.");
    assert.strictEqual(b.card.assigneeAgentId, "agent-po");
  });

  await check("a follow-up line from a seat that is not reviewing means nothing: the answer goes to review", async () => {
    const b = board();
    await seat(b, async () => `Result.\n${OUTCOME_MARK} follow-up`).tick();
    assert.strictEqual(b.writes[0].body.status, "in_review");
  });

  await check("the policy is read live for the run and its revision goes in the prompt", async () => {
    const b = board();
    let prompt = "";
    await seat(b, async (p) => { prompt = p; return "ok"; }, { policy: POLICY }).tick();
    assert.strictEqual(b.reads.length, 1);
    assert.match(prompt, /--- Task completion policy ---\n# Requester acceptance/);
    assert.match(prompt, /revision 2, d84938ad-5446-44e9-b7c5-b194c638d903/);
    assert.match(prompt, /you do not close it/);
  });

  await check("an unreadable policy is said in the prompt, never left out", async () => {
    const b = board({ policy: "refused" });
    let prompt = "";
    await seat(b, async (p) => { prompt = p; return "ok"; }, { policy: POLICY }).tick();
    assert.match(prompt, /POLICY UNAVAILABLE: the company policy task-completion could not be read \(HTTP 403\)/);
  });

  await check("a policy setting is <caseId>/<documentKey>", async () => {
    assert.deepStrictEqual(parsePolicy(`${POLICY.caseId}/task-completion`), POLICY);
    assert.strictEqual(parsePolicy(""), null);
    assert.throws(() => parsePolicy("task-completion"), /<caseId>\/<documentKey>/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
