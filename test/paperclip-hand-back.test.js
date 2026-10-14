/**
 * Paperclip — a task the bot cannot finish because what is left belongs to
 * whoever gave it the task is handed back to them, still blocked, inside the
 * bot's own run (`PAPERCLIP-OUTCOME: return`). The giver is read from the
 * board's own record: the holder it was last assigned from, else its creator.
 */
const assert = require("assert");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, buildTaskPrompt, outcomeOf, OUTCOME_MARK, UNBLOCK_ACTION } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const SEATS = [{ id: "agent-em", name: "Engineering Manager" }, { id: "agent-po", name: "Product Owner" }];

/** One task held by the EM seat, with a live run on it. */
function board({ createdBy = { createdByAgentId: "agent-po" }, handedBy = null, refuseHandOff = false } = {}) {
  const card = { id: "c-1", identifier: "SLA-1", title: "Publish the roadmap", description: "Make it publish reliably.",
    status: "in_progress", assigneeAgentId: "agent-em", assigneeUserId: null, labels: [], createdAt: "2026-01-01T00:00:00Z", ...createdBy };
  const activity = [], comments = [], writes = [];
  const runs = [{ id: "r1", agentId: "agent-em", status: "running" }];
  let last = 0, ids = 0;
  const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();
  const record = (actor, changes, runId) => activity.unshift({ id: `a${++ids}`, action: "issue.updated", createdAt: now(), ...actor, runId, details: { changes } });
  if (handedBy) record({ actorType: handedBy.agentId ? "agent" : "user", actorId: handedBy.agentId ?? handedBy.userId },
    { assigneeAgentId: { from: handedBy.agentId ?? null, to: "agent-em" }, assigneeUserId: { from: handedBy.userId ?? null, to: null } });
  comments.push({ id: "c0", authorAgentId: null, authorUserId: "user-avery", createdAt: now(), body: "Please make the publish reliable." });
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-em", name: "Engineering Manager", companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok(SEATS);
    if (path === "/agents/me/inbox-lite") return ok(card.assigneeAgentId === "agent-em" ? [{ id: card.id, status: card.status, unresolvedBlockerIssueIds: [] }] : []);
    const m = path.match(/^\/issues\/([^/]+)(\/[a-z]+)?$/);
    if (!m || ![card.id, card.identifier].includes(decodeURIComponent(m[1]))) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      const runId = init.headers["x-paperclip-run-id"];
      const body = JSON.parse(init.body);
      const handing = "assigneeAgentId" in body || "assigneeUserId" in body;
      if (handing && refuseHandOff) return { ok: false, status: 403, text: async () => JSON.stringify({ error: "not allowed" }) };
      // As the live board: no block without blockers or a note naming who unblocks it.
      if (body.status === "blocked" && card.status !== "blocked" && !body.unblockDescriptor && !body.blockedByIssueIds?.length) {
        return { ok: false, status: 422, text: async () => JSON.stringify({ error: "Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor" }) };
      }
      writes.push({ runId, body });
      const actor = { actorType: "agent", actorId: "agent-em" };
      if (body.status && body.status !== card.status) { record(actor, { status: { from: card.status, to: body.status } }, runId); card.status = body.status; }
      if (handing) {
        record(actor, { assigneeAgentId: { from: card.assigneeAgentId, to: body.assigneeAgentId ?? null }, assigneeUserId: { from: card.assigneeUserId, to: body.assigneeUserId ?? null } }, runId);
        card.assigneeAgentId = body.assigneeAgentId ?? null; card.assigneeUserId = body.assigneeUserId ?? null;
      }
      if (body.comment) { comments.push({ id: `c${comments.length}`, authorAgentId: "agent-em", createdAt: now(), body: body.comment, createdByRunId: runId }); runs[0].status = "succeeded"; }
      return ok({});
    }
    if (!m[2]) return ok({ ...card, blockedBy: [] });
    if (m[2] === "/activity") return ok(activity);
    if (m[2] === "/comments") return ok(comments);
    if (m[2] === "/runs") return ok(runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { card, writes, comments, fetch };
}
const seat = (b, answer) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k",
  stateFile: join(mkdtempSync(join(tmpdir(), "pc-")), "s.json"), log: silent, fetch: b.fetch, answer, externalWriter: /^source: \S+#\d+$/ });
const RETURNED = `Only the Product Owner can change its own routine.\n1. Fix the skill path.\n${OUTCOME_MARK} return`;

(async () => {
  await check("`return` is a blocked outcome that asks for a hand-back", async () => {
    assert.deepStrictEqual(outcomeOf(`Fix the path.\n${OUTCOME_MARK} return`), { comment: "Fix the path.", status: "blocked", waitsOn: [], escalate: false, giveBack: true });
    assert.strictEqual(outcomeOf(`x\n${OUTCOME_MARK} blocked`).giveBack, false);
  });

  await check("a task created already assigned to the bot goes back to its creator, blocked, in one write under the run", async () => {
    const b = board();
    await seat(b, async () => RETURNED).tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-po", JSON.stringify(b.writes));
    assert.strictEqual(b.card.status, "blocked");
    assert.strictEqual(b.writes.length, 1, JSON.stringify(b.writes));
    const [w] = b.writes;
    assert.strictEqual(w.runId, "r1");
    assert.deepStrictEqual(w.body, { status: "blocked", unblockDescriptor: { owner: { agentId: "agent-em" }, action: UNBLOCK_ACTION }, blockedByIssueIds: [],
      assigneeAgentId: "agent-po", assigneeUserId: null, comment: "Only the Product Owner can change its own routine.\n1. Fix the skill path." });
  });

  await check("a task handed to the bot goes back to whoever handed it, not its creator", async () => {
    const b = board({ createdBy: { createdByAgentId: "agent-po" }, handedBy: { userId: "user-avery" } });
    await seat(b, async () => RETURNED).tick();
    assert.strictEqual(b.card.assigneeUserId, "user-avery", JSON.stringify(b.writes));
    assert.strictEqual(b.card.assigneeAgentId, null);
    assert.strictEqual(b.card.status, "blocked");
  });

  await check("a task nobody else gave the bot stays with it, blocked, and the comment says why", async () => {
    const b = board({ createdBy: { createdByAgentId: "agent-em" } });
    await seat(b, async () => RETURNED).tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-em");
    assert.strictEqual(b.card.status, "blocked");
    assert.match(b.writes.at(-1).body.comment, /could not hand this task back: the board has no record/);
    assert.ok(b.writes.at(-1).body.unblockDescriptor, "a block kept by the bot names it as the one who unblocks");
  });

  await check("a hand-back the board refuses closes blocked with the bot, and says so", async () => {
    const b = board({ refuseHandOff: true });
    await seat(b, async () => RETURNED).tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-em");
    assert.strictEqual(b.card.status, "blocked");
    assert.match(b.writes.at(-1).body.comment, /could not hand this task back to Product Owner: the board refused it \(403\)/);
  });

  await check("a plain `blocked` answer still keeps the task with the bot", async () => {
    const b = board();
    await seat(b, async () => `No access.\n${OUTCOME_MARK} blocked`).tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-em");
    assert.strictEqual(b.card.status, "blocked");
    assert.ok(b.writes.every((w) => !("assigneeAgentId" in w.body)));
  });

  await check("a normal task's prompt offers `return`; one that may not hand back does not", async () => {
    const me = { id: "agent-em", name: "Engineering Manager" };
    assert.match(buildTaskPrompt({ identifier: "T-1", title: "Q" }, [], me, "u"), new RegExp(`${OUTCOME_MARK} return`));
    assert.doesNotMatch(buildTaskPrompt({ identifier: "T-1", title: "Q" }, [], me, "u", { returnable: false }), /return instead/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
