/**
 * Paperclip — an escalation climbs a chain of holders and unwinds back down
 * it, the card blocked the whole way: each bot either resolves (and hands the
 * card back to whoever handed it up) or escalates (and hands it up), inside its
 * own run, once per hop.
 */
const assert = require("assert");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, parseEscalateTo, OUTCOME_MARK } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const SEATS = [
  { id: "agent-foreman", name: "Foreman" }, { id: "agent-tl", name: "Tech Lead" },
  { id: "agent-em", name: "Engineering Manager" }, { id: "agent-po", name: "Product Owner" },
];
// Seats with no wake on assignment, as on the real board (display-only).
const ASLEEP = new Set(["agent-foreman", "agent-tl"]);

/** One card on a board several agents and a person act on, each with their own view. */
function board() {
  const card = { id: "c-1", identifier: "SLA-1", title: "Retry window", description: "source: acme/app#12\nstage review",
    status: "in_progress", assigneeAgentId: "agent-tl", assigneeUserId: null, labels: [{ name: "Needs EM ruling" }], createdAt: "2026-01-01T00:00:00Z" };
  const activity = [], comments = [], runs = [], writes = [];
  let last = 0, ids = 0;
  const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();
  const record = (actor, changes, runId) => activity.unshift({ id: `a${++ids}`, action: "issue.updated", createdAt: now(), ...actor, runId, details: { changes } });
  // Paperclip wakes an assigned agent seat, and the wake checks a blocked card out, unrecorded.
  const wake = (agentId) => {
    if (!agentId || ASLEEP.has(agentId)) return;
    runs.push({ id: `r${runs.length + 1}`, agentId, status: "running" });
    if (card.status === "blocked") card.status = "in_progress";
  };
  const assign = (actor, to, runId) => {
    record(actor, { assigneeAgentId: { from: card.assigneeAgentId, to: to.agentId ?? null }, assigneeUserId: { from: card.assigneeUserId, to: to.userId ?? null } }, runId);
    card.assigneeAgentId = to.agentId ?? null; card.assigneeUserId = to.userId ?? null;
  };
  const comment = (author, body, runId) => comments.push({ id: `c${comments.length + 1}`, ...author, createdAt: now(), body, createdByRunId: runId });
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const as = (agentId) => async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: agentId, name: agentId, companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok(SEATS);
    if (path === "/agents/me/inbox-lite") return ok(card.assigneeAgentId === agentId ? [{ id: card.id, status: card.status, unresolvedBlockerIssueIds: [] }] : []);
    const m = path.match(/^\/issues\/([^/]+)(\/[a-z]+)?$/);
    if (!m || ![card.id, card.identifier].includes(decodeURIComponent(m[1]))) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      const runId = init.headers["x-paperclip-run-id"];
      const run = runs.find((r) => r.id === runId && r.agentId === agentId);
      if (!run) return { ok: false, status: 403, text: async () => JSON.stringify({ error: "run needed", details: { code: "cross_issue_influence_run_context_required" } }) };
      if (card.status === "in_progress" && run.status !== "running") return { ok: false, status: 409, text: async () => JSON.stringify({ error: "Issue run ownership conflict" }) };
      const body = JSON.parse(init.body);
      writes.push({ agentId, runId, body });
      const actor = { actorType: "agent", actorId: agentId };
      if (body.status && body.status !== card.status) { record(actor, { status: { from: card.status, to: body.status } }, runId); card.status = body.status; }
      const handing = "assigneeAgentId" in body || "assigneeUserId" in body;
      if (handing) assign(actor, { agentId: body.assigneeAgentId, userId: body.assigneeUserId }, runId);
      // A comment ends the run; then the new holder is woken.
      if (body.comment) { comment({ authorAgentId: agentId }, body.comment, runId); run.status = "succeeded"; }
      if (handing) wake(body.assigneeAgentId);
      return ok({});
    }
    if (!m[2]) return ok({ ...card, blockedBy: [] });
    if (m[2] === "/activity") return ok(activity);
    if (m[2] === "/comments") return ok(comments);
    if (m[2] === "/runs") return ok(runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { card, runs, writes, comments, as, now,
    // The Foreman's sync (a board user's key) stops the card and hands it to the EM, with its reason.
    foremanEscalates() {
      record({ actorType: "user", actorId: "user-sync" }, { status: { from: card.status, to: "blocked" },
        assigneeAgentId: { from: card.assigneeAgentId, to: "agent-em" }, assigneeUserId: { from: null, to: null } });
      card.status = "blocked"; card.assigneeAgentId = "agent-em";
      comment({ authorAgentId: null, authorUserId: "user-sync" }, "Needs EM ruling: two specs disagree on the retry window.");
      wake("agent-em");
    },
    // A person rules on the card and hands it back down to a seat.
    personRules(userId, body, agentId) {
      comment({ authorAgentId: null, authorUserId: userId }, body);
      assign({ actorType: "user", actorId: userId }, { agentId });
      wake(agentId);
    } };
}
const seat = (b, agentId, answer, opts) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k",
  stateFile: join(mkdtempSync(join(tmpdir(), "pc-")), "s.json"), log: silent, fetch: b.as(agentId), answer,
  externalWriter: /^source: \S+#\d+$/, ...opts });

(async () => {
  await check("an escalation goes up two hops and back down two, ending with the Foreman, blocked, one run per hop", async () => {
    const b = board();
    const em = [], po = [], pings = [];
    const emAnswers = [
      `Need a product call on the retry window.\nBoth specs are in the repo; which one customers see is product shape.\n${OUTCOME_MARK} escalate`,
      "Wrote the ruling on acme/app#12: 30 s retry window.",
    ];
    const poAnswers = [
      `Need your call: do we commit customers to a 30 s retry window?\nIt is a commitment, not product shape.\n${OUTCOME_MARK} escalate`,
      "Avery ruled 30 s. Handing back to the EM to write it on the issue.",
    ];
    const EM = seat(b, "agent-em", async (p) => { em.push(p); return emAnswers[em.length - 1]; },
      { escalateTo: parseEscalateTo("agent:Product Owner"), escalationReturnTo: parseEscalateTo("agent:Foreman"), escalationAuthority: "scope and mechanism" });
    const PO = seat(b, "agent-po", async (p) => { po.push(p); return poAnswers[po.length - 1]; },
      { escalateTo: parseEscalateTo("user:user-avery|Avery"), escalationAuthority: "product shape", onEscalate: async (x) => pings.push(x) });
    const both = async () => { for (let n = 0; n < 2; n++) { await EM.tick(); await PO.tick(); } };

    b.foremanEscalates();
    await both();                                       // up: EM → PO → Avery
    assert.strictEqual(b.card.assigneeUserId, "user-avery", JSON.stringify(b.writes));
    assert.strictEqual(b.card.status, "blocked");
    assert.deepStrictEqual([em.length, po.length, pings.length], [1, 1, 1]);
    assert.deepStrictEqual(pings[0], { task: "SLA-1", link: "https://board.example.com/SLA/issues/SLA-1", to: "Avery", ask: "Need your call: do we commit customers to a 30 s retry window?" });

    b.personRules("user-avery", "30 s. We commit to it.", "agent-po");
    await both();                                       // down: Avery → PO → EM → Foreman
    assert.match(po[1], /Avery handed it back down to you with their resolution/);
    assert.match(po[1], /goes back to Engineering Manager/, "the PO was not told where the card goes next");
    assert.match(em[1], /Product Owner handed it back down to you/);
    assert.match(em[1], /goes back to Foreman/);
    assert.strictEqual(b.card.assigneeAgentId, "agent-foreman", JSON.stringify(b.writes.map((w) => [w.agentId, w.body])));
    assert.strictEqual(b.card.status, "blocked");
    assert.deepStrictEqual([em.length, po.length, pings.length], [2, 2, 1], "a hop ran more than once, or the person was pinged on the way down");
    assert.deepStrictEqual(b.runs.map((r) => r.agentId), ["agent-em", "agent-po", "agent-po", "agent-em"]);
    // No bot ever moved the card out of blocked; the Foreman's mirror does that from GitHub.
    assert.ok(b.writes.every((w) => !w.body.status || w.body.status === "blocked"), JSON.stringify(b.writes));
    assert.deepStrictEqual(b.writes.filter((w) => "assigneeAgentId" in w.body).map((w) => [w.agentId, w.body.assigneeAgentId ?? w.body.assigneeUserId]),
      [["agent-em", "agent-po"], ["agent-po", "user-avery"], ["agent-po", "agent-em"], ["agent-em", "agent-foreman"]]);
    await both();
    assert.deepStrictEqual([em.length, po.length], [2, 2], "an unchanged card was worked again");
  });

  await check("a bot with no return set hands a resolved card back to whoever handed it up", async () => {
    const b = board();
    const EM = seat(b, "agent-em", async () => "Ruled: 30 s.");
    b.foremanEscalates();
    await EM.tick();
    assert.strictEqual(b.card.assigneeAgentId, "agent-tl");
    assert.strictEqual(b.card.status, "blocked");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
