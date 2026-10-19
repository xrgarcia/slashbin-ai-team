/**
 * Paperclip — a task's card stays true after the work moves on: a block the
 * bot set itself, or one Paperclip set when it lost a run, is brought up to
 * date; a decision someone else made is left alone.
 */
const assert = require("assert");
const { mkdtempSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, decisionKind, lastDecision, personSince, markAt, handedWith, statusSetter, reconcilable, handedBack, movable, wakeStep, ESCALATION_KEPT, CARD_CHANGED, NEWER_ASK, outcomeOf, OUTCOME_MARK, TRANSPORT_NOTE, INTERRUPTED_NOTE, HANDED_AWAY, FALLBACK_REPLY, HELD_NOTE, PERSON_STANDS, decidedStatus, ESCALATION_LABELS, parseEscalateTo, paperclipBoards, UNBLOCK_ACTION, revisitNote, revisitAnswer, unchangedNote, isNote, REVISIT_MAX } = require("../lib/paperclip");
// How a re-wake on an ask answered as waiting opens its prompt (revisitNote, SLA-1775).
const REVISIT_LEAD = revisitNote().slice(0, 24);
const LOST_NOTE_START = "The board lost the run this work started under";

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const ME = { id: "agent-1", name: "Bot", companyId: "co-1" };
const KEEP_BLOCKED = { status: "blocked", unblockDescriptor: { owner: { agentId: ME.id }, action: UNBLOCK_ACTION } };
const SEATS = [{ id: "agent-1", name: "Bot" }, { id: "agent-po", name: "Product Owner" }];
const PERSON = { actorType: "user", actorId: "user-1" };

/** A board of several tasks. Each status write is recorded as Paperclip records it: actor, run, from/to. */
function board(tasks) {
  const issues = new Map(), activity = new Map(), comments = new Map(), runs = new Map();
  const writes = [], tries = [], wakes = [], state = {};
  for (const t of tasks) {
    issues.set(t.id, { createdAt: "2026-01-01T00:00:00Z", title: t.id, description: "", ...t });
    activity.set(t.id, []); comments.set(t.id, t.comments ?? []); runs.set(t.id, t.runs ?? []);
  }
  const byName = (n) => [...issues.values()].find((i) => i.identifier === n || i.id === n);
  // Every record is stamped as Paperclip stamps it, in the order it was written.
  let last = 0, ids = 0;
  const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();
  // One write is one record: its status change with whatever else it replaced (`also`).
  const setStatus = (id, to, actor, extra = {}, also = {}) => {
    const i = issues.get(id);
    activity.get(id).unshift({ action: "issue.updated", createdAt: now(), ...actor, ...extra, details: { changes: { status: { from: i.status, to }, ...also } } });
    i.status = to;
  };
  const blockedBy = (i) => (i.blockedByIssueIds ?? []).map((b) => ({ id: b, identifier: issues.get(b).identifier, status: issues.get(b).status }));
  const fetch = async (url, init) => {
    const path = url.replace(/^.*\/api/, "");
    const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
    if (path === "/agents/me") return ok(ME);
    // Why a run woke, as Paperclip records it (the run's contextSnapshot).
    if (path.startsWith("/heartbeat-runs/")) {
      const ctx = state.wakes?.[path.slice("/heartbeat-runs/".length)];
      return ctx ? ok({ contextSnapshot: ctx }) : { ok: false, status: 404, text: async () => "" };
    }
    if (path === `/companies/${ME.companyId}/agents`) return ok(state.seats ?? SEATS);
    if (path === `/agents/${ME.id}/wakeup` && init.method === "POST") {
      const { payload } = JSON.parse(init.body);
      wakes.push(payload);
      if (state.noWake) return ok({ status: "skipped", reason: "wakeup_skipped" });
      // A run the board settled "blocked, never replayed" refuses every wake on its card until its outcome is reconciled.
      if (state.holds?.has(payload.issueId)) return ok({ status: "skipped", reason: "execution_reconciliation_required" });
      const r = { id: `w${wakes.length}`, agentId: ME.id, status: "running" };
      runs.get(payload.issueId).push(r);
      const t = issues.get(payload.issueId);
      if (["todo", "backlog", "blocked"].includes(t.status)) t.status = "in_progress";   // the checkout, unrecorded
      return ok(r);
    }
    if (path === "/agents/me/inbox-lite") {
      return ok([...issues.values()].filter((i) => i.assigneeAgentId === ME.id && !["done", "cancelled"].includes(i.status))
        .map((i) => ({ id: i.id, status: i.status, unresolvedBlockerIssueIds: blockedBy(i).filter((b) => b.status !== "done").map((b) => b.id) })));
    }
    const rec = path.match(/^\/issues\/([^/]+)\/recovery-actions\/resolve$/);
    if (rec && init.method === "POST") {
      // The evidence path (EM#609): the settled action, a verified outcome, the card back to todo.
      const body = JSON.parse(init.body), runId = init.headers["x-paperclip-run-id"];
      const hold = state.holds?.get(rec[1]);
      if (!hold || body.actionId !== hold || body.outcome !== "restored" || body.sourceIssueStatus !== "todo" || !body.executionReconciliation) return { ok: false, status: 404, text: async () => JSON.stringify({ error: "Active recovery action not found" }) };
      state.holds.delete(rec[1]);
      (state.resolves ??= []).push({ id: rec[1], body, runId });
      setStatus(rec[1], "todo", { actorType: "agent", actorId: ME.id }, { runId });
      return ok({});
    }
    // A comment taken down: kept on the thread, marked deleted, as Paperclip lists it.
    const del = init?.method === "DELETE" && path.match(/^\/issues\/([^/]+)\/comments\/([^/]+)$/);
    if (del) {
      const c = comments.get(byName(decodeURIComponent(del[1]))?.id)?.find((x) => x.id === del[2]);
      if (!c) return { ok: false, status: 404, text: async () => "" };
      c.deletedAt = now();
      return ok({});
    }
    const m = path.match(/^\/issues\/([^/]+)(\/[a-z]+)?$/);
    if (m && state.down?.has(decodeURIComponent(m[1]))) return { ok: false, status: 503, text: async () => "unavailable" };
    const i = m && byName(decodeURIComponent(m[1]));
    if (!i) return { ok: false, status: 404, text: async () => "" };
    if (m[2] === "/comments" && init.method === "POST") {
      // A comment alone: no assignee run lock, only a run named, as on the board.
      const runId = init.headers["x-paperclip-run-id"];
      if (!runId) return { ok: false, status: 403, text: async () => JSON.stringify({ error: "run needed", details: { code: "cross_issue_influence_run_context_required" } }) };
      const c = { id: `c${writes.length}`, authorAgentId: ME.id, createdAt: now(), body: JSON.parse(init.body).body, createdByRunId: runId };
      comments.get(i.id).push(c);
      activity.get(i.id).unshift({ action: "issue.comment_added", createdAt: c.createdAt, actorType: "agent", actorId: ME.id, runId, details: { commentId: c.id } });
      writes.push({ id: i.id, body: { comment: c.body }, runId, via: "comments" });
      return ok(c);
    }
    if (init.method === "PATCH") {
      // Paperclip refuses an agent's write made outside any run.
      if (!init.headers["x-paperclip-run-id"]) return { ok: false, status: 403, text: async () => JSON.stringify({ error: "run needed", details: { code: "cross_issue_influence_run_context_required" } }) };
      // Nor may a seat update a card another seat has checked out (the assignee's run lock).
      if (i.assigneeAgentId && i.assigneeAgentId !== ME.id && i.status === "in_progress") return { ok: false, status: 409, text: async () => JSON.stringify({ error: "Issue run ownership conflict", details: { code: "issue_write_assignee_run_lock" } }) };
      const body = JSON.parse(init.body);
      // Only a live run may write to an in-progress task; and the board's
      // waiter ends a run once a comment lands under it.
      const actorRun = runs.get(i.id).find((r) => r.id === init.headers["x-paperclip-run-id"]);
      tries.push(init.headers["x-paperclip-run-id"]);
      if (actorRun?.status === "cancelled") return { ok: false, status: 403, text: async () => JSON.stringify({ error: "This run was cancelled", code: "agent_run_cancelled" }) };
      if (i.status === "in_progress" && actorRun?.status !== "running") return { ok: false, status: 409, text: async () => JSON.stringify({ error: "Issue run ownership conflict" }) };
      // An agent may name only itself as the one who unblocks a task.
      const owner = body.unblockDescriptor?.owner;
      if (owner && (owner === "board" || owner.userId)) return { ok: false, status: 403, text: async () => JSON.stringify({ error: "Agents may only name themselves as an unblock owner" }) };
      // A hand-off the board will not take (state.refuseHandOff).
      if (state.refuseHandOff && ("assigneeAgentId" in body || "assigneeUserId" in body)) return { ok: false, status: 403, text: async () => JSON.stringify({ error: "Agent cannot assign this issue" }) };
      // Nor does it move a task to in_progress while it waits on an open task.
      if (body.status === "in_progress" && (body.blockedByIssueIds ?? i.blockedByIssueIds ?? []).some((b) => issues.get(b).status !== "done")) {
        return { ok: false, status: 422, text: async () => JSON.stringify({ error: "Issue is blocked by unresolved blockers" }) };
      }
      // Whatever lands between the bot's last read and this write.
      if (state.beforeWrite && body.status) { const f = state.beforeWrite; delete state.beforeWrite; f(i); }
      if (body.comment && actorRun) actorRun.status = "succeeded";
      writes.push({ id: i.id, body, runId: init.headers["x-paperclip-run-id"] });
      const was = { blockedByIssueIds: i.blockedByIssueIds ?? [], unblockDescriptor: i.unblockDescriptor ?? null };
      const recorded = activity.get(i.id).length;
      if (body.blockedByIssueIds) i.blockedByIssueIds = body.blockedByIssueIds;
      if (body.unblockDescriptor) i.unblockDescriptor = body.unblockDescriptor;
      const runId = init.headers["x-paperclip-run-id"];
      const replaced = {};
      for (const k of Object.keys(was)) if (body[k] && JSON.stringify(body[k]) !== JSON.stringify(was[k])) replaced[k] = { from: was[k], to: body[k] };
      if (body.status && body.status !== i.status) setStatus(i.id, body.status, { actorType: "agent", actorId: ME.id }, { runId }, replaced);
      // Blocking a blocked task, or rewriting its waits, is recorded as a fresh
      // decision with no status change: a new statusVersion and what it replaced.
      else if (i.status === "blocked" && (body.status === "blocked" || body.blockedByIssueIds || body.unblockDescriptor)) {
        activity.get(i.id).unshift({ action: "issue.updated", createdAt: now(), actorType: "agent", actorId: ME.id, runId, details: { ...(body.status ? { status: body.status } : {}), changes: { statusVersion: { from: 1, to: 2 }, ...replaced } } });
      } else if (Object.keys(replaced).length) activity.get(i.id).unshift({ action: "issue.updated", createdAt: now(), actorType: "agent", actorId: ME.id, runId, details: { changes: replaced } });
      if ("assigneeAgentId" in body || "assigneeUserId" in body) {
        const changes = {};
        for (const k of ["assigneeAgentId", "assigneeUserId"]) if ((body[k] ?? null) !== (i[k] ?? null)) changes[k] = { from: i[k] ?? null, to: body[k] ?? null };
        i.assigneeAgentId = body.assigneeAgentId ?? null; i.assigneeUserId = body.assigneeUserId ?? null;
        activity.get(i.id).unshift({ action: "issue.updated", createdAt: now(), actorType: "agent", actorId: ME.id, runId, details: { changes } });
      }
      if (body.comment) {
        // One write, one time: a comment sent with a status or waits shares the time of their record.
        const at = activity.get(i.id).length > recorded ? activity.get(i.id)[0].createdAt : now();
        const c = { id: `c${writes.length}`, authorAgentId: ME.id, createdAt: at, body: body.comment, createdByRunId: runId };
        comments.get(i.id).push(c);
        // Paperclip records each comment's posting too, in the record's order.
        activity.get(i.id).unshift({ action: "issue.comment_added", createdAt: c.createdAt, actorType: "agent", actorId: ME.id, runId, details: { commentId: c.id, bodySnippet: c.body.slice(0, 120) } });
      }
      // Whatever lands just after this write, before the bot looks again.
      if (state.afterWrite && body.status) { const f = state.afterWrite; delete state.afterWrite; f(i); }
      return ok({});
    }
    if (!m[2]) {
      const v = ok({ ...i, blockedBy: blockedBy(i) });
      // Whatever lands just after the bot reads this task (the `nth` read of it).
      const r = state.afterRead;
      if (r && !r.on && r.of === decodeURIComponent(m[1]) && --r.nth === 0) { delete state.afterRead; r.f(i); }
      return v;
    }
    // Each entry has its own id, as Paperclip's do.
    if (m[2] === "/activity") { for (const a of activity.get(i.id)) a.id ??= `a${++ids}`; return ok(activity.get(i.id)); }
    if (m[2] === "/comments") {
      const v = ok(comments.get(i.id));
      // Or just after it reads this task's comments.
      const r = state.afterRead;
      if (r?.on === "comments" && r.of === decodeURIComponent(m[1]) && --r.nth === 0) { delete state.afterRead; r.f(i); }
      return v;
    }
    if (m[2] === "/runs") return ok(runs.get(i.id));
    return { ok: false, status: 404, text: async () => "" };
  };
  // Blocking a task that is already blocked changes no status string: Paperclip
  // records it as a new statusVersion and the wait's new owner, nothing more.
  const reassert = (id, actor) => {
    activity.get(id).unshift({ action: "issue.updated", createdAt: now(), ...actor, details: { status: "blocked",
      changes: { statusVersion: { from: 1, to: 2 }, unblockDescriptor: { from: null, to: { owner: { userId: actor.actorId } } } } } });
  };
  // A person changes what a blocked task waits on: a fresh decision, its status unchanged.
  const rehold = (id, actor, waits, note) => {
    const i = issues.get(id);
    activity.get(id).unshift({ action: "issue.updated", createdAt: now(), ...actor, details: { status: "blocked",
      changes: { statusVersion: { from: 2, to: 3 }, blockedByIssueIds: { from: i.blockedByIssueIds ?? [], to: waits }, unblockDescriptor: { from: i.unblockDescriptor ?? null, to: note } } } });
    i.blockedByIssueIds = waits; i.unblockDescriptor = note;
  };
  // A person changes what a task waits on and nothing else: no status, so no statusVersion.
  const relink = (id, actor, waits) => {
    const i = issues.get(id);
    activity.get(id).unshift({ action: "issue.updated", createdAt: now(), ...actor, details: { changes: { blockedByIssueIds: { from: i.blockedByIssueIds ?? [], to: waits } } } });
    i.blockedByIssueIds = waits;
  };
  // Someone hands the task to another holder, its status unchanged. Paperclip
  // bumps statusVersion on every change of holder (services/issues.ts:10950).
  const reassign = (id, actor, { agentId = null, userId = null }, extra = {}) => {
    const i = issues.get(id);
    activity.get(id).unshift({ action: "issue.updated", createdAt: now(), ...actor, ...extra, details: { changes: { statusVersion: { from: 1, to: 2 },
      assigneeAgentId: { from: i.assigneeAgentId ?? null, to: agentId }, assigneeUserId: { from: i.assigneeUserId ?? null, to: userId } } } });
    i.assigneeAgentId = agentId; i.assigneeUserId = userId;
  };
  // Time passes on the board's clock: every record after this is `ms` later.
  const skew = (ms) => { last = Math.max(Date.now(), last) + ms; };
  // The newest entry recorded in the same millisecond as the one before it.
  const tie = (id) => { const [a, b] = activity.get(id); a.createdAt = b.createdAt; };
  // Any write as Paperclip records it, given whole: `details` is { status?, source?, changes }.
  const record = (id, actor, details) => activity.get(id).unshift({ action: "issue.updated", createdAt: now(), ...actor, details });
  // Someone edits the task's title or description: recorded, its status untouched.
  const edit = (id, actor, field, to) => {
    const i = issues.get(id);
    record(id, actor, { changes: { [field]: { from: i[field] ?? null, to } } });
    i[field] = to;
  };
  // Someone who is not the bot comments, and Paperclip records its posting.
  let said = 0;
  const say = (id, actor, body) => {
    const c = { id: `u${++said}`, authorAgentId: actor.actorType === "agent" ? actor.actorId : null, authorUserId: actor.actorType === "user" ? actor.actorId : null, createdAt: now(), body };
    comments.get(id).push(c);
    activity.get(id).unshift({ action: "issue.comment_added", createdAt: c.createdAt, ...actor, details: { commentId: c.id, bodySnippet: body.slice(0, 120) } });
    return c;
  };
  return { fetch, writes, tries, wakes, state, issues, runs, comments, activity, setStatus, reassert, rehold, relink, reassign, tie, skew, now, record, edit, say,
    // Paperclip lost the run: it has ended, and the task is blocked.
    // With `hold`, as the board settles it after its own restart: never replayed, so no wake opens a run until it is reconciled.
    recover: (id, runId, { hold } = {}) => {
      const recoveryActionId = `ra-${runId}`;
      if (hold) (state.holds ??= new Map()).set(id, recoveryActionId);
      activity.get(id).unshift({ action: "issue.execution_recovery_settled", createdAt: now(), actorType: "system", actorId: "execution-recovery", runId, details: { recoveryActionId, outcome: "blocked" } });
      issues.get(id).status = "blocked";
      const r = runs.get(id).find((x) => x.id === runId);
      if (r) r.status = "failed";
    } };
}
const task = (id, extra = {}) => ({ id, identifier: id.toUpperCase(), status: "in_progress", assigneeAgentId: ME.id, ...extra });
const run = (id) => [{ id, agentId: ME.id, status: "running" }];
const poller = (b, answer, opts = {}) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k",
  stateFile: opts.stateFile ?? join(mkdtempSync(join(tmpdir(), "pc-")), "s.json"), log: silent, fetch: b.fetch, answer, ...opts });

(async () => {
  await check("the bot's own block and Paperclip's lost-run block are reconcilable; a person's, another agent's or an unexplained one is not", () => {
    const own = { action: "issue.updated", actorType: "agent", actorId: ME.id, details: { changes: { status: { from: "in_progress", to: "blocked" } } } };
    assert.ok(reconcilable(statusSetter([own], "blocked"), ME.id));
    assert.ok(reconcilable(statusSetter([{ action: "issue.execution_recovery_settled", actorType: "system", details: { outcome: "blocked" } }], "blocked"), ME.id));
    assert.ok(!reconcilable(statusSetter([{ ...own, ...PERSON }], "blocked"), ME.id), "a person's block");
    assert.ok(!reconcilable(statusSetter([{ ...own, actorId: "agent-2" }], "blocked"), ME.id), "another agent's block");
    assert.ok(!reconcilable(statusSetter([own], "cancelled"), ME.id), "a record that names another status");
    assert.ok(!reconcilable(statusSetter([], "blocked"), ME.id), "no record");
    const putBack = { ...own, details: { changes: { status: { from: "done", to: "blocked" } } } };
    assert.ok(!reconcilable(statusSetter([putBack], "blocked"), ME.id), "a person's block the bot put back");
  });

  await check("a blocked answer that names what it waits on links those tasks and says so on the card", async () => {
    assert.deepStrictEqual(outcomeOf(`No.\n${OUTCOME_MARK} blocked on T-2, T-3`).waitsOn, ["T-2", "T-3"]);
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" }), task("t-3", { assigneeAgentId: null, status: "todo" }), task("t-9", { assigneeAgentId: null, status: "done" })]);
    await poller(b, async () => `Waiting on the key.\n${OUTCOME_MARK} blocked on T-2, T-3, T-9, NOPE-1`).tick();
    const w = b.writes.find((x) => x.body.status === "blocked");
    assert.deepStrictEqual(w.body.blockedByIssueIds, ["t-2", "t-3"], "a done or unknown task is not linked");
    assert.match(w.body.unblockDescriptor.action, /^Waits on T-2, T-3\./);
    assert.strictEqual(w.body.comment, "Waiting on the key.");
  });

  // Paperclip's wake usually checks the card out first — blocked to in
  // progress with no activity record — so the bot may find either status.
  for (const checkedOut of [false, true]) await check(`case 1${checkedOut ? " (card already checked out by the wake)" : ""}: when the last task it waits on is done, the card says it resumes and why, then the work resumes`, async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const prompts = [];
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const answer = async (p) => { prompts.push(p); return prompts.length === 1 ? `Need T-2.\n${OUTCOME_MARK} blocked on T-2` : "Finished."; };
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    b.setStatus("t-2", "done", PERSON);
    b.runs.set("t-1", run("r2"));       // Paperclip's issue_blockers_resolved wake
    if (checkedOut) b.issues.get("t-1").status = "in_progress";
    await poller(b, answer, { stateFile }).tick();
    const r2 = b.writes.filter((x) => x.runId === "r2");
    // Back in progress first, by status alone: a comment would end the run
    // the answer still has to close the card under.
    assert.deepStrictEqual(r2.slice(0, -1).map((x) => x.body), checkedOut ? [] : [{ status: "in_progress" }]);
    const answerWrite = r2.at(-1);
    assert.strictEqual(answerWrite.body.status, "done");
    assert.strictEqual(answerWrite.body.comment, "Resuming: T-2, which this task waited on, is done.\n\nFinished.");
    assert.match(prompts[1], /was blocked waiting on T-2; it is now done/);
    assert.strictEqual(b.issues.get("t-1").status, "done");
  });

  await check("case 1, Paperclip's notice mid-resume: a system comment is no new ask, so the resumed answer still closes the card", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const answer = async () => {
      if (++n === 1) return `Need T-2.\n${OUTCOME_MARK} blocked on T-2`;
      b.comments.get("t-1").push({ id: "sys", authorAgentId: null, authorUserId: null, authorType: "system",
        createdAt: new Date().toISOString(), body: "Paperclip exhausted the bounded disposition repair." });
      return "Finished.";
    };
    await poller(b, answer, { stateFile }).tick();
    b.setStatus("t-2", "done", PERSON);
    b.runs.set("t-1", run("r2"));
    b.issues.get("t-1").status = "in_progress";
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "done");
    // A later wake on the same done waits does not resume it again.
    b.runs.set("t-1", run("r3"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 2, "the work ran again");
    assert.strictEqual(b.writes.filter((x) => /^Resuming/.test(x.body.comment ?? "")).length, 1);
  });

  await check("in progress after a recorded stop is that stop; only a recorded move lifts it", () => {
    const block = [{ action: "issue.updated", actorType: "agent", actorId: ME.id, details: { changes: { status: { from: "in_progress", to: "blocked" } } } }];
    assert.strictEqual(decidedStatus("in_progress", block), "blocked");
    assert.strictEqual(decidedStatus("in_progress", [{ ...block[0], details: { changes: { status: { from: "blocked", to: "in_progress" } } } }, ...block]), "in_progress");
    assert.strictEqual(decidedStatus("blocked", block), "blocked");
    assert.strictEqual(decidedStatus("in_progress", null), "in_progress");
  });

  await check("case 1, a person stops the resumed task mid-answer: the answer lands as a comment, and the stop holds on the next wake", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const answer = async () => {
      if (++n === 1) return `Need T-2.\n${OUTCOME_MARK} blocked on T-2`;
      b.setStatus("t-1", "blocked", PERSON);
      return "Finished.";
    };
    await poller(b, answer, { stateFile }).tick();
    b.setStatus("t-2", "done", PERSON);
    b.runs.set("t-1", run("r2"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.ok(b.comments.get("t-1").some((c) => /^Resuming: /.test(c.body)), "the answer was not posted");
    // Paperclip's next wake checks the stopped task out again.
    b.runs.set("t-1", run("r3"));
    b.issues.get("t-1").status = "in_progress";
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 2, "the work ran over the person's stop");
    assert.ok(!b.writes.some((x) => x.runId === "r3" && x.body.status), "a status was written over the person's stop");
  });

  await check("case 2: one of two waits done — still blocked, linked and described by the open one only", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" }), task("t-3", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    await poller(b, async () => `Need both.\n${OUTCOME_MARK} blocked on T-2, T-3`, { stateFile }).tick();
    b.runs.set("t-1", [{ id: "r1", agentId: ME.id, status: "succeeded" }]);
    b.setStatus("t-2", "done", PERSON);
    await poller(b, async () => assert.fail("a partial wait ran the task"), { stateFile }).tick();
    const t = b.issues.get("t-1");
    assert.strictEqual(t.status, "blocked");
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-3"]);
    assert.match(t.unblockDescriptor.action, /^Waits on T-3 \(T-2 done\)\./);
    assert.strictEqual(b.writes.find((x) => x.body.blockedByIssueIds?.length === 1).runId, "r1", "the trim is made under the task's own last run");
    const n = b.writes.length;
    await poller(b, async () => assert.fail("ran"), { stateFile }).tick();
    assert.strictEqual(b.writes.length, n, "an up-to-date card was written again");
  });

  await check("case 3: Paperclip loses the run mid-answer — noted once under the lost run, and the one answer closes it under the run the bot's wake opened", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let launches = 0;
    await poller(b, async () => {
      launches++;
      b.recover("t-1", "r1");
      await new Promise((r) => setTimeout(r, 60));
      return "sent";
    }, { watchMs: 10, stateFile }).tick();
    assert.strictEqual(launches, 1);
    const notes = b.writes.filter((x) => x.body.comment === TRANSPORT_NOTE);
    assert.strictEqual(notes.length, 1, "the transport note was not posted exactly once");
    assert.deepStrictEqual([notes[0].runId, notes[0].body.status], ["r1", undefined], "the note is a comment under the lost run");
    assert.deepStrictEqual(b.wakes, [{ issueId: "t-1" }]);
    // An ended run may not write to the in-progress task: the answer goes out under the new one.
    assert.deepStrictEqual(b.writes.filter((x) => x.body.comment === "sent").map((x) => x.runId), ["w1"]);
    assert.strictEqual(b.issues.get("t-1").status, "done");
    await poller(b, async () => assert.fail("ran again"), { stateFile }).tick();
  });

  await check("case 3, no new run: the card stays blocked with its note, and the answer closes it from there", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    b.state.noWake = true;
    await poller(b, async () => { b.recover("t-1", "r1"); await new Promise((r) => setTimeout(r, 60)); return "sent"; }, { watchMs: 10 }).tick();
    assert.strictEqual(b.writes.filter((x) => x.body.comment === TRANSPORT_NOTE).length, 1);
    assert.strictEqual(b.issues.get("t-1").status, "done");
    assert.ok(b.writes.every((x) => x.runId === "r1"));
  });

  await check("case 3b: Paperclip lost the run before the answer — the answer still closes it from its own outcome", async () => {
    for (const [reply, want] of [["sent", "done"], [`failed: bounce\n${OUTCOME_MARK} blocked`, "blocked"]]) {
      const b = board([task("t-1", { runs: run("r1") })]);
      await poller(b, async () => { b.recover("t-1", "r1"); return reply; }, { watchMs: 1e6 }).tick();
      assert.strictEqual(b.issues.get("t-1").status, want, reply);
    }
  });

  await check("case 3, twice: the run that replaced a lost one is lost too — noted again, and the one answer closes it under the third", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const until = async (f) => { for (let n = 0; !f() && n < 100; n++) await new Promise((r) => setTimeout(r, 5)); };
    let launches = 0;
    await poller(b, async () => {
      launches++;
      b.recover("t-1", "r1");
      await until(() => b.wakes.length === 1);
      b.recover("t-1", "w1");
      await until(() => b.wakes.length === 2);
      return "sent";
    }, { watchMs: 10 }).tick();
    assert.strictEqual(launches, 1);
    assert.deepStrictEqual(b.writes.filter((x) => x.body.comment === TRANSPORT_NOTE).map((x) => x.runId), ["r1", "w1"]);
    assert.deepStrictEqual(b.writes.filter((x) => x.body.comment === "sent").map((x) => x.runId), ["w2"]);
    assert.strictEqual(b.issues.get("t-1").status, "done");
  });

  await check("a person's hold that lands as the bot closes blocked stays theirs: not resumed when the wait is done, and its note is kept", async () => {
    const hold = { owner: { userId: PERSON.actorId }, action: "Hold for the legal review." };
    for (const personWaits of [[], ["t-3"], ["t-2"]]) {
      const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" }), task("t-3", { assigneeAgentId: null, status: "todo" })]);
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      b.state.beforeWrite = (i) => { b.setStatus("t-1", "blocked", PERSON); i.unblockDescriptor = hold; i.blockedByIssueIds = personWaits; };
      await poller(b, async () => `Need T-2.\n${OUTCOME_MARK} blocked on T-2`, { stateFile }).tick();
      const t = b.issues.get("t-1");
      assert.strictEqual(t.status, "blocked");
      assert.deepStrictEqual(t.blockedByIssueIds, personWaits, "the person's waits were not put back");
      assert.ok(b.comments.get("t-1").some((c) => c.authorAgentId === ME.id && c.body.includes(hold.action)), "the hold's note is lost");
      b.setStatus("t-2", "done", PERSON);
      b.runs.set("t-1", run("r2"));
      t.status = "in_progress";                          // the wake's checkout, unrecorded
      const before = b.writes.length;
      await poller(b, async () => assert.fail("worked the held task"), { stateFile }).tick();
      // Its ask was answered already: a note on the card, and nothing moves.
      const after = b.writes.slice(before);
      assert.ok(after.length === 1 && after[0].body.comment && !after[0].body.status, JSON.stringify(after));
      assert.strictEqual(t.status, "in_progress", "the held task was moved");
      assert.strictEqual(decidedStatus(t.status, await (await b.fetch("https://board.example.com/api/issues/t-1/activity", {})).text().then(JSON.parse), ME.id), "blocked");
    }
  });

  await check("case 4: a restart mid-run with its run gone — resumed once when allowed, closed from the verdict; else the fallback", async () => {
    for (const [verdict, want] of [["sent", "done"], [`failed\n${OUTCOME_MARK} blocked`, "blocked"]]) {
      const b = board([task("t-1", { runs: run("r1") })]);
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      // The first bot dies mid-run: its answer never returns.
      const dying = poller(b, () => new Promise(() => {}), { stateFile, resumeInterrupted: true, watchMs: 1e6 });
      dying.tick();
      await new Promise((r) => setTimeout(r, 20));
      b.recover("t-1", "r1");
      b.runs.set("t-1", [{ id: "r1", agentId: ME.id, status: "failed" }]);
      const prompts = [];
      await poller(b, async (p) => { prompts.push(p); return verdict; }, { stateFile, resumeInterrupted: true }).tick();
      assert.strictEqual(prompts.length, 1);
      assert.ok(prompts[0].includes(INTERRUPTED_NOTE));
      assert.strictEqual(b.issues.get("t-1").status, want);
      assert.ok(b.writes.filter((x) => x.body.status).every((x) => x.runId === "r1"), "written outside the run the attempt was under");
      await poller(b, async () => assert.fail("ran again"), { stateFile, resumeInterrupted: true }).tick();
      assert.deepStrictEqual(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies, {});
    }
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    poller(b, () => new Promise(() => {}), { stateFile, watchMs: 1e6 }).tick();
    await new Promise((r) => setTimeout(r, 20));
    b.recover("t-1", "r1");
    await poller(b, async () => assert.fail("ran again without resumeInterrupted"), { stateFile }).tick();
    assert.ok(b.writes.some((x) => x.body.comment === FALLBACK_REPLY && x.body.status === "blocked"));
  });

  await check("case 5, a person cancels the task mid-answer and Paperclip cancels its run: no retry under it; the answer waits for the task's next run", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const answer = async () => {
      if (++n > 1) return "Second answer.";
      b.setStatus("t-1", "cancelled", PERSON);
      b.runs.get("t-1")[0].status = "cancelled";
      return "First answer.";
    };
    await poller(b, answer, { stateFile }).tick();
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(b.writes.length, 0, "written under the cancelled run");
    assert.strictEqual(b.tries.filter((r) => r === "r1").length, 1, "retried under the cancelled run");
    assert.strictEqual(b.issues.get("t-1").status, "cancelled");
    // A person reopens it with a new ask: both answers go out under the new run.
    b.setStatus("t-1", "todo", PERSON);
    b.comments.get("t-1").push({ id: "p1", authorUserId: "user-1", createdAt: new Date().toISOString(), body: "And now?" });
    b.runs.set("t-1", run("r2"));
    await poller(b, answer, { stateFile }).tick();
    const w = b.writes.find((x) => x.runId === "r2" && x.body.comment);
    assert.ok(w && w.body.comment.includes("First answer.") && w.body.comment.includes("Second answer."), w?.body.comment);
    assert.strictEqual(b.issues.get("t-1").status, "done");
  });

  await check("case 5, a person blocks the task and stops the bot mid-run, and Paperclip cancels its run: the owed fallback is not retried under it (SLA-1337)", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    poller(b, () => new Promise(() => {}), { stateFile, watchMs: 1e6 }).tick();
    await new Promise((r) => setTimeout(r, 20));
    b.setStatus("t-1", "blocked", PERSON);
    b.runs.get("t-1")[0].status = "cancelled";
    // Blocked, the task stays in the inbox: every tick after the restart sees it.
    await poller(b, async () => assert.fail("ran again without resumeInterrupted"), { stateFile }).tick();
    await poller(b, async () => assert.fail("ran again without resumeInterrupted"), { stateFile }).tick();
    assert.strictEqual(b.tries.filter((r) => r === "r1").length, 0, "written under the cancelled run");
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
  });

  await check("case 5: a person's blocked or cancelled stands against every path", async () => {
    for (const decided of ["blocked", "cancelled"]) {
      // The answer lands on it.
      let b = board([task("t-1", { runs: run("r1") })]);
      await poller(b, async () => { b.setStatus("t-1", decided, PERSON); return "done it"; }).tick();
      assert.strictEqual(b.issues.get("t-1").status, decided, `${decided}: the answer closed over it`);
      // Its waits come done.
      b = board([task("t-1", { status: decided, blockedByIssueIds: ["t-2"], runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "done" })]);
      b.setStatus("t-1", decided, PERSON);
      await poller(b, async () => "resumed").tick();
      assert.strictEqual(b.issues.get("t-1").status, decided, `${decided}: resumed over it`);
      assert.ok(!b.writes.some((x) => x.body.status), `${decided}: a status was written`);
      // Partly done.
      b = board([task("t-1", { blockedByIssueIds: ["t-2", "t-3"] }), task("t-2", { assigneeAgentId: null, status: "done" }), task("t-3", { assigneeAgentId: null, status: "todo" })]);
      b.setStatus("t-1", "blocked", PERSON);
      await poller(b, async () => assert.fail("ran")).tick();
      assert.deepStrictEqual(b.writes, [], "a person's block was rewritten");
      // Paperclip loses the run after a person blocked it.
      b = board([task("t-1", { runs: run("r1") })]);
      await poller(b, async () => { b.setStatus("t-1", "blocked", PERSON); await new Promise((r) => setTimeout(r, 40)); return "x"; }, { watchMs: 5 }).tick();
      assert.ok(!b.writes.some((x) => x.body.comment === TRANSPORT_NOTE), "the transport note moved a person's block");
    }
  });

  await check("case 5, checked out: a person's stop that Paperclip's wake checked out with no record still stands", async () => {
    // A person re-blocks a task the bot had blocked on its wait; then the wait comes done.
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let ran = 0;
    let b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    await poller(b, async () => { ran++; return `Need T-2.\n${OUTCOME_MARK} blocked on T-2`; }, { stateFile }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    b.reassert("t-1", PERSON);
    b.setStatus("t-2", "done", PERSON);
    b.runs.set("t-1", run("r2"));
    b.issues.get("t-1").status = "in_progress";        // the wake's checkout, unrecorded
    const before = b.writes.length;
    await poller(b, async () => { ran++; return "resumed"; }, { stateFile }).tick();
    const after = b.writes.slice(before);
    assert.strictEqual(ran, 1, "the held task was worked");
    assert.deepStrictEqual(after.map((x) => x.body), [{ comment: HELD_NOTE }]);
    assert.strictEqual(after[0].runId, "r2");
    // A person's block, checked out by a later wake that carries a new comment.
    b = board([task("t-1", { runs: run("r1") })]);
    b.setStatus("t-1", "blocked", PERSON);
    b.issues.get("t-1").status = "in_progress";
    b.comments.get("t-1").push({ id: "h1", authorAgentId: null, createdAt: "2026-01-02T00:00:00Z", body: "holding this" });
    await poller(b, async () => assert.fail("ran")).tick();
    assert.deepStrictEqual(b.writes.map((x) => x.body), [{ comment: HELD_NOTE }]);
    // A person blocks it mid-answer and a wake checks it out before the answer lands: comment only.
    b = board([task("t-1", { runs: run("r1") })]);
    await poller(b, async () => { b.setStatus("t-1", "blocked", PERSON); b.issues.get("t-1").status = "in_progress"; return "done it"; }).tick();
    assert.ok(b.writes.length && b.writes.every((x) => !x.body.status), JSON.stringify(b.writes));
  });

  await check("case 5, interrupted: a person who stops the task while the bot is down holds it — the attempt is not run again", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    poller(b, () => new Promise(() => {}), { stateFile, resumeInterrupted: true, watchMs: 1e6 }).tick();
    await new Promise((r) => setTimeout(r, 20));
    b.runs.set("t-1", [{ id: "r1", agentId: ME.id, status: "failed" }, { id: "r2", agentId: ME.id, status: "running" }]);
    b.setStatus("t-1", "blocked", PERSON);
    b.issues.get("t-1").status = "in_progress";        // the wake's checkout, unrecorded
    await poller(b, async () => assert.fail("ran over the person's stop"), { stateFile, resumeInterrupted: true }).tick();
    assert.deepStrictEqual(b.writes.map((x) => [x.runId, x.body]), [["r2", { comment: HELD_NOTE }]]);
    assert.ok(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies).length, "the attempt was forgotten");
  });

  await check("blocked on tasks already done: the work goes on at once, and the card closes from the second answer", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "done" })]);
    const prompts = [];
    await poller(b, async (p) => { prompts.push(p); return prompts.length === 1 ? `Need T-2.\n${OUTCOME_MARK} blocked on T-2` : "Finished."; }).tick();
    assert.strictEqual(prompts.length, 2);
    assert.match(prompts[1], /blocked waiting on T-2; it is already done/);
    const w = b.writes.at(-1);
    assert.strictEqual(w.body.comment, "Need T-2.\n\nResuming: T-2, which this task waited on, is already done.\n\nFinished.");
    assert.strictEqual(b.issues.get("t-1").status, "done");
  });

  await check("blocked on tasks already done, but a person stopped it meanwhile: not worked again; the answer lands as a comment", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "done" })]);
    let n = 0;
    await poller(b, async () => { n++; b.setStatus("t-1", "blocked", PERSON); return `Need T-2.\n${OUTCOME_MARK} blocked on T-2`; }).tick();
    assert.strictEqual(n, 1, "worked over the person's stop");
    assert.ok(b.writes.some((x) => x.body.comment === "Need T-2."));
    assert.ok(!b.writes.some((x) => x.body.status), "a status was written over the person's stop");
  });

  await check("a blocked answer that names nothing replaces the links of an earlier wait", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    await poller(b, async () => `Need T-2.\n${OUTCOME_MARK} blocked on T-2`, { stateFile }).tick();
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2"]);
    // A person's new ask, answered blocked on an approval only.
    b.setStatus("t-1", "todo", PERSON);
    b.comments.get("t-1").push({ id: "p1", authorUserId: "user-1", createdAt: new Date().toISOString(), body: "Ship it?" });
    b.runs.set("t-1", run("r2"));
    await poller(b, async () => `Needs approval.\n${OUTCOME_MARK} blocked`, { stateFile }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, [], "the earlier wait is still linked");
  });

  await check("a wait that cannot be looked up is not dropped: the post is retried with it linked", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    b.state.down = new Set(["T-2"]);
    await poller(b, async () => `Need T-2.\n${OUTCOME_MARK} blocked on T-2`, { stateFile }).tick();
    assert.ok(!b.writes.some((x) => x.body.status), "closed without its wait");
    b.state.down = null;
    await poller(b, async () => assert.fail("ran again"), { stateFile }).tick();
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2"]);
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
  });

  await check("the newest answer decides: an older blocked answer still owed goes out as text, and a later success closes the card done", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const answer = async () => {
      if (++n > 1) return "Second answer.";
      b.setStatus("t-1", "cancelled", PERSON);
      b.runs.get("t-1")[0].status = "cancelled";
      return `First answer.\n${OUTCOME_MARK} blocked`;
    };
    await poller(b, answer, { stateFile }).tick();
    b.setStatus("t-1", "todo", PERSON);
    b.comments.get("t-1").push({ id: "p1", authorUserId: "user-1", createdAt: new Date().toISOString(), body: "And now?" });
    b.runs.set("t-1", run("r2"));
    await poller(b, answer, { stateFile }).tick();
    const w = b.writes.find((x) => x.runId === "r2" && x.body.comment);
    assert.ok(w.body.comment.includes("First answer.") && w.body.comment.includes("Second answer."));
    assert.strictEqual(b.issues.get("t-1").status, "done");
  });

  await check("the last task waited on finishes just before the block is posted: not blocked on nothing — the work goes on", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    // T-2 is read once after the answer, then finishes before the post reads it.
    let reads = 0;
    const fetch = async (url, init) => {
      if (/\/issues\/T-2$/.test(url) && (init?.method ?? "GET") === "GET" && ++reads === 2) b.issues.get("t-2").status = "done";
      return b.fetch(url, init);
    };
    const prompts = [];
    await poller({ ...b, fetch }, async (p) => { prompts.push(p); return prompts.length === 1 ? `Need T-2.\n${OUTCOME_MARK} blocked on T-2` : "Finished."; }, { fetch }).tick();
    assert.strictEqual(prompts.length, 2, "the work did not go on");
    assert.match(prompts[1], /already done[\s\S]*Need T-2\./, "the second attempt was not told what the first said");
    assert.ok(!b.writes.some((x) => x.body.status === "blocked"), JSON.stringify(b.writes));
    assert.strictEqual(b.issues.get("t-1").status, "done");
  });

  await check("a mirrored task a person stopped is not worked; one its own writer blocked still is", async () => {
    const mirror = /^source: \S+#\d+$/;
    let b = board([task("t-1", { description: "source: acme/app#12\nstage review", runs: run("r1") })]);
    b.setStatus("t-1", "blocked", PERSON);
    b.issues.get("t-1").status = "in_progress";        // the wake's checkout, unrecorded
    await poller(b, async () => assert.fail("worked a mirrored task over a person's stop"), { externalWriter: mirror }).tick();
    assert.deepStrictEqual(b.writes.map((x) => x.body), [{ comment: HELD_NOTE }]);
    b = board([task("t-1", { description: "source: acme/app#12\nstage review", runs: run("r1") })]);
    b.setStatus("t-1", "blocked", { actorType: "agent", actorId: "agent-sync" });
    b.issues.get("t-1").status = "in_progress";
    let n = 0;
    await poller(b, async () => { n++; return "Cleared."; }, { externalWriter: mirror }).tick();
    assert.strictEqual(n, 1, "a block its own writer set for the bot to clear held the bot");
  });

  await check("a mirrored task its sync blocked and handed to the bot, with a board user's key, is worked (SLA-1335)", async () => {
    const mirror = /^source: \S+#\d+$/;
    let b = board([task("t-1", { description: "source: acme/app#12\nstage review", runs: run("r1") })]);
    b.setStatus("t-1", "blocked", PERSON, {}, { assigneeAgentId: { from: "agent-foreman", to: ME.id } });
    b.issues.get("t-1").status = "in_progress";        // the wake's checkout, unrecorded
    let n = 0;
    await poller(b, async () => { n++; return "Ruled."; }, { externalWriter: mirror }).tick();
    assert.strictEqual(n, 1, "the sync's hand-off read as a person's stop");
    assert.ok(!b.writes.some((x) => x.body.comment === HELD_NOTE), JSON.stringify(b.writes));
    // A person's stop that hands the task to someone else still holds.
    b = board([task("t-1", { description: "source: acme/app#12\nstage review", runs: run("r1") })]);
    b.setStatus("t-1", "blocked", PERSON, {}, { assigneeAgentId: { from: ME.id, to: "agent-other" } });
    b.issues.get("t-1").status = "in_progress";
    await poller(b, async () => assert.fail("worked a mirrored task over a person's stop"), { externalWriter: mirror }).tick();
  });

  // The Foreman's mirror hands a card on in a burst (slashbin-ai-foreman
  // mirror.ts onBlocked): move() — blocked, the new holder, the unblock step
  // (its action is the note's text) and the stage label, one PATCH — then
  // note(), which finds the card blocked and restates blocked with its comment.
  // Released from a session hold (onSession), the move is followed by the
  // session's summary, another commented restatement, then the deferred note.
  // All carry a board user's key — one Ray's own writes may share.
  const SYNC = { actorType: "user", actorId: "user-sync" };
  const SYNC_NOTE = "Blocked at review: two specs disagree on the retry window.";
  const STAGE_STEP = { owner: { agentId: ME.id }, action: SYNC_NOTE };
  const SUMMARY = "**Review finished** — PR #12\n\n2 findings.";
  // A commented restatement as Paperclip records it: the write, then its comment.
  const restate = (b, actor, text) => {
    b.record("t-1", actor, { status: "blocked", source: "comment", changes: { statusVersion: { from: 2, to: 3 } } });
    b.say("t-1", actor, text);
  };
  const syncHandsOn = (b, { was = "in_progress", split = false, sameStep = false, session = false, between = null } = {}) => {
    const t = b.issues.get("t-1");
    if (was === "blocked") {
      // Blocked already, by the mirror, for another seat's stage.
      const desc = sameStep ? STAGE_STEP : { owner: { agentId: "agent-tl" }, action: "Review it." };
      b.setStatus("t-1", "blocked", SYNC, {}, { assigneeAgentId: { from: t.assigneeAgentId, to: "agent-tl" }, unblockDescriptor: { from: null, to: desc } });
      t.assigneeAgentId = "agent-tl";
      t.unblockDescriptor = desc;
    }
    const hand = { assigneeAgentId: { from: t.assigneeAgentId ?? null, to: ME.id } };
    const step = t.unblockDescriptor === STAGE_STEP ? {} : { unblockDescriptor: { from: t.unblockDescriptor ?? null, to: STAGE_STEP } };
    if (split) {
      b.setStatus("t-1", "blocked", SYNC, {}, step);
      b.reassign("t-1", SYNC, { agentId: ME.id });
    } else if (was === "blocked") {
      // Blocked over blocked: no status change, a new statusVersion.
      b.record("t-1", SYNC, { status: "blocked", changes: { statusVersion: { from: 1, to: 2 }, ...hand, ...step, labelIds: { from: ["l-review"], to: ["l-rule"] } } });
    } else b.setStatus("t-1", "blocked", SYNC, {}, { ...hand, ...step, labelIds: { from: [], to: ["l-rule"] } });
    t.assigneeAgentId = ME.id; t.unblockDescriptor = STAGE_STEP;
    between?.(b);
    // The session's summary first, when a session held the card.
    if (session) restate(b, SYNC, SUMMARY);
    // note(): the row reads blocked, so its comment rides on a write restating blocked.
    restate(b, SYNC, SYNC_NOTE);
    t.status = "in_progress";                          // the wake's checkout, unrecorded
  };

  await check("the Foreman's hand-off — its move, then the note restating blocked — is worked once; a hold after it stands, whoever's key made it", async () => {
    const mirror = /^source: \S+#\d+$/;
    const rows = [
      { name: "a card in progress, blocked and handed on", works: true },
      { name: "a card blocked already for another seat", works: true, opts: { was: "blocked" } },
      { name: "a card blocked already, its unblock step unchanged (the record carries the hand-off alone)", works: true, opts: { was: "blocked", sameStep: true } },
      { name: "status and holder recorded as two entries", works: true, opts: { split: true } },
      { name: "released from a session hold: the move, the session's summary, then the note", works: true, opts: { session: true } },
      { name: "released from a session hold, status and holder as two entries", works: true, opts: { session: true, split: true } },
      { name: "a person reasserts the block after it", works: false, after: (b) => b.reassert("t-1", PERSON) },
      { name: "a person restates blocked after it, changing nothing else", works: false,
        after: (b) => b.record("t-1", PERSON, { status: "blocked", changes: { statusVersion: { from: 3, to: 4 } } }) },
      { name: "a person blocks it between the move and the note", works: false, opts: { between: (b) => b.reassert("t-1", PERSON) } },
      { name: "a person holds it before the hand-off, which then hands it on", works: true,
        before: (b) => { b.setStatus("t-1", "blocked", PERSON); b.issues.get("t-1").status = "in_progress"; } },
      // The same key as the hand-off's writer (round 4): a hold all the same.
      { name: "the hand-off's own key restates blocked after it, changing nothing else", works: false,
        after: (b) => b.record("t-1", SYNC, { status: "blocked", changes: { statusVersion: { from: 3, to: 4 } } }) },
      { name: "the hand-off's own key reasserts the block, naming what unblocks it", works: false, after: (b) => b.reassert("t-1", SYNC) },
      { name: "the hand-off's own key restates blocked with a comment of its own, after the note", works: false,
        after: (b) => restate(b, SYNC, "Holding this until Monday.") },
      { name: "the hand-off's own key restates blocked between the move and the note", works: false,
        opts: { between: (b) => b.record("t-1", SYNC, { status: "blocked", changes: { statusVersion: { from: 2, to: 3 } } }) } },
      { name: "the hand-off's own key repeats the note's text, after the note", works: false,
        after: (b) => restate(b, SYNC, SYNC_NOTE) },
    ];
    for (const label of [false, true]) for (const row of rows) {
      const name = `${row.name}${label ? ", labelled an escalation" : ""}`;
      const b = board([task("t-1", { description: "source: acme/app#12\nstage review", assigneeAgentId: "agent-foreman", runs: run("r1"),
        ...(label ? { labels: [{ name: "Needs EM ruling" }] } : {}) })]);
      row.before?.(b);
      syncHandsOn(b, row.opts);
      if (row.after) { row.after(b); b.issues.get("t-1").status = "in_progress"; }
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const prompts = [];
      const p = poller(b, async (q) => { prompts.push(q); return "Ruled: 30 s."; }, { externalWriter: mirror, stateFile });
      await p.tick();
      // Escalation or not, a person's later hold is never worked over — but a
      // labelled card is worked whoever blocked it, so its hold rows are skipped.
      if (label && !row.works) continue;
      assert.strictEqual(prompts.length, row.works ? 1 : 0, `${name}: worked ${prompts.length} times`);
      if (!row.works) { assert.deepStrictEqual(b.writes.map((w) => w.body), [{ comment: HELD_NOTE }], name); continue; }
      assert.match(prompts[0], /two specs disagree/, `${name}: the run was not given the note`);
      assert.ok(!b.writes.some((w) => w.body.comment === HELD_NOTE), `${name}: ${JSON.stringify(b.writes)}`);
      // The note's comment wakes the bot again, and Paperclip re-wakes an unchanged card: neither works it again.
      for (const r of ["r2", "r3"]) { b.runs.set("t-1", run(r)); b.issues.get("t-1").status = "in_progress"; await p.tick(); }
      await poller(b, async (q) => { prompts.push(q); return "again"; }, { externalWriter: mirror, stateFile }).tick();
      assert.strictEqual(prompts.length, 1, `${name}: the hand-off was worked ${prompts.length} times`);
    }
  });

  await check("Paperclip settling a lost run on a task a person already blocked does not lift the person's hold", async () => {
    const mirror = /^source: \S+#\d+$/;
    for (const description of ["", "source: acme/app#12\nstage review"]) {
      const b = board([task("t-1", { description, runs: [{ id: "r1", agentId: ME.id, status: "running" }] })]);
      b.setStatus("t-1", "blocked", PERSON);
      b.recover("t-1", "r1");                          // already blocked: a separate hold may be on it
      b.runs.get("t-1").push({ id: "r2", agentId: ME.id, status: "running" });
      b.issues.get("t-1").status = "in_progress";      // the wake's checkout, unrecorded
      await poller(b, async () => assert.fail(`worked a held task (${description ? "mirrored" : "own"})`), { externalWriter: mirror }).tick();
      assert.deepStrictEqual(b.writes.map((x) => x.body), [{ comment: HELD_NOTE }], description);
    }
    // A run lost on a task no one stopped is still the bot's to bring up to date.
    const b = board([task("t-1", { runs: run("r1") })]);
    b.recover("t-1", "r1");
    b.runs.get("t-1").push({ id: "r2", agentId: ME.id, status: "running" });
    let n = 0;
    await poller(b, async () => { n++; return "Finished."; }).tick();
    assert.strictEqual(n, 1);
  });

  // A mirrored card answered blocked takes the bot's block, linked to what it
  // waits on (SLA-1775): left in progress as a comment only, it had no durable
  // wait, and Paperclip's disposition repair woke the bot on it again and again.
  await check("case 6: a mirrored task answered blocked is blocked on what it waits on, whoever writes the rest of it (SLA-1775)", async () => {
    const mirror = /^source: \S+#\d+$/;
    const b = board([task("t-1", { description: "source: acme/app#12\nstage review", runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    await poller(b, async () => { b.recover("t-1", "r1"); await new Promise((r) => setTimeout(r, 30)); return `x\n${OUTCOME_MARK} blocked on T-2`; },
      { externalWriter: mirror, watchMs: 5 }).tick();
    assert.ok(b.writes.some((x) => x.body.status === "blocked" && x.body.comment === "x"), JSON.stringify(b.writes));
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2"]);
    assert.strictEqual(b.issues.get("t-1").unblockDescriptor.owner.agentId, ME.id);
  });

  await check("a run gone with a newer ask on the task: the owed answer is posted as a comment, and the newer ask waits for a live run", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    // The bot dies mid-run; Paperclip settles the run as failed; a person asks again while it is down.
    poller(b, () => new Promise(() => {}), { stateFile, watchMs: 1e6 }).tick();
    await new Promise((r) => setTimeout(r, 20));
    b.recover("t-1", "r1");
    b.comments.get("t-1").push({ id: "h2", authorAgentId: null, createdAt: b.now(), body: "A newer ask." });
    let ran = 0;
    await poller(b, async () => { ran++; return "Answered early."; }, { stateFile }).tick();
    assert.strictEqual(ran, 0, "ran the newer ask under the failed run");
    const owed = b.writes.filter((x) => x.body.comment === FALLBACK_REPLY);
    assert.strictEqual(owed.length, 1, "the owed attempt was not posted");
    assert.ok(owed.every((x) => x.runId === "r1" && !x.body.status), JSON.stringify(owed));
    assert.strictEqual(b.issues.get("t-1").status, "blocked", "the card moved for an older ask");
    // The newer ask's own run: it is worked there, fresh — not as an interrupted retry.
    b.runs.set("t-1", run("r2"));
    b.issues.get("t-1").status = "in_progress";
    const prompts = [];
    await poller(b, async (p) => { prompts.push(p); return "Answered."; }, { stateFile }).tick();
    assert.strictEqual(prompts.length, 1);
    assert.ok(!prompts[0].includes(INTERRUPTED_NOTE));
    assert.ok(b.writes.some((x) => x.runId === "r2" && x.body.comment === "Answered."));
  });

  await check("a mirrored task answered blocked stays blocked; each re-wake is the model's to decide once, never a repeat, and a repeat escalates (SLA-1775)", async () => {
    const mirror = /^source: \S+#\d+$/;
    const b = board([task("t-1", { description: "source: acme/app#12\nstage review", runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const prompts = [];
    const replies = [`Need the spec.\n${OUTCOME_MARK} blocked`, `Still waiting on the spec from the PO, who has it.\n${OUTCOME_MARK} blocked`,
      `Still waiting on the spec from the PO, who has it.\n${OUTCOME_MARK} blocked`, "Did it."];
    const answer = async (p) => { prompts.push(p); return replies[prompts.length - 1]; };
    await poller(b, answer, { stateFile, externalWriter: mirror }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "blocked", "a mirrored blocked answer left the card open");
    for (const r of ["r2", "r3"]) {
      b.runs.set("t-1", run(r));
      b.issues.get("t-1").status = "in_progress";      // the wake's checkout, unrecorded
      await poller(b, answer, { stateFile, externalWriter: mirror }).tick();
      const mine = b.comments.get("t-1").filter((c) => c.createdByRunId === r);
      assert.strictEqual(mine.length, 1, `${r}: ${mine.length} comments`);
      assert.ok(!/Nothing has changed since my last/.test(mine[0].body), mine[0].body);
      assert.strictEqual(b.issues.get("t-1").status, "blocked", `${r}: the card was left open`);
    }
    assert.strictEqual(prompts.length, 3);
    assert.ok(prompts.slice(1).every((p) => p.includes(REVISIT_LEAD) && p.includes("Need the spec.")), "a re-wake was not told what it said");
    assert.strictEqual(b.writes.filter((x) => x.body.comment?.startsWith("Need the spec.")).length, 1, "its answer was posted again");
    // The third wake would only repeat the second: escalated, with no one configured to take it.
    assert.match(b.comments.get("t-1").at(-1).body, /Escalating: I would only repeat my last answer/);
    // Its writer moves the card back after the answer: that is a reopening, worked as the ask.
    b.setStatus("t-1", "todo", PERSON);
    b.setStatus("t-1", "in_progress", PERSON);
    b.runs.set("t-1", run("r4"));
    await poller(b, answer, { stateFile, externalWriter: mirror }).tick();
    assert.strictEqual(prompts.length, 4, "a recorded reopening did not bring the ask back");
    assert.ok(!prompts[3].includes(REVISIT_LEAD));
  });

  // SLA-1775 as it happened: the Foreman hands shop#636's card to the
  // EM for its dev verification, which cannot pass until #638 (SLA-1783) lands.
  const FOREMAN_SEAT = { actorType: "agent", actorId: "agent-foreman" };
  const sla1775 = () => {
    const b = board([task("t-1", { identifier: "SLA-1775", description: "source: acme/shop#636\nstage verify", runs: run("r1") }),
      task("t-1783", { identifier: "SLA-1783", title: "shop#638", assigneeAgentId: "agent-foreman", status: "in_progress", updatedAt: new Date().toISOString() })]);
    b.state.seats = [...SEATS, { id: "agent-foreman", name: "Foreman" }];
    return b;
  };
  const WAITING = `Dev verification of #636 cannot pass until #638 lands: it needs #638's column.\n${OUTCOME_MARK} blocked on SLA-1783`;
  const rewakeOn = (b, r, ctx) => {
    b.runs.set("t-1", run(r));
    b.issues.get("t-1").status = "in_progress";        // the wake's checkout, unrecorded
    if (ctx) (b.state.wakes ??= {})[r] = ctx;
  };
  const mirror1775 = /^source: \S+#\d+$/;

  await check("SLA-1775: answered blocked on SLA-1783, the mirrored card is blocked on it after one comment — no open card for the repair to wake", async () => {
    const b = sla1775();
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    await poller(b, async () => WAITING, { stateFile, externalWriter: mirror1775 }).tick();
    const t = b.issues.get("t-1");
    assert.strictEqual(t.status, "blocked");
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-1783"]);
    assert.strictEqual(t.unblockDescriptor.owner.agentId, ME.id);
    assert.deepStrictEqual(b.comments.get("t-1").filter((c) => c.authorAgentId === ME.id).map((c) => c.body), ["Dev verification of #636 cannot pass until #638 lands: it needs #638's column."]);
  });

  await check("SLA-1775: re-woken while the Foreman builds SLA-1783, one progress comment cites its new PR, and the card stays blocked on it", async () => {
    const b = sla1775();
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const prompts = [];
    const progress = `The Foreman is building #638 (SLA-1783): PR #640 is open, CI green, review requested; not merged to develop yet. This card stays blocked on it — once #638 merges to develop I re-run dev verification, then carry #636 to prod.\n${OUTCOME_MARK} blocked on SLA-1783`;
    const answer = async (p) => { prompts.push(p); return prompts.length === 1 ? WAITING : progress; };
    await poller(b, answer, { stateFile, externalWriter: mirror1775 }).tick();
    // The Foreman opens the blocker's PR and says so on its card.
    b.say("t-1783", FOREMAN_SEAT, "Opened PR #640 for #638: CI green, review requested.");
    b.issues.get("t-1783").updatedAt = b.now();
    rewakeOn(b, "r2", { wakeReason: "issue_commented" });
    await poller(b, answer, { stateFile, externalWriter: mirror1775 }).tick();
    assert.strictEqual(prompts.length, 2);
    assert.ok(prompts[1].includes(REVISIT_LEAD), "the re-wake was not told it woke again");
    assert.match(prompts[1], /SLA-1783 "shop#638": in_progress, held by Foreman/);
    assert.match(prompts[1], /Opened PR #640/, "the blocker's progress was not read at wake time");
    const posted = b.comments.get("t-1").filter((c) => c.createdByRunId === "r2");
    assert.strictEqual(posted.length, 1, JSON.stringify(posted));
    assert.match(posted[0].body, /PR #640/);
    assert.ok(!/Nothing has changed/.test(posted[0].body));
    const t = b.issues.get("t-1");
    assert.strictEqual(t.status, "blocked");
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-1783"]);
  });

  await check("SLA-1775: Paperclip's last disposition repair escalates — handed to the person who decides, pinged once, still blocked", async () => {
    const b = sla1775();
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const pings = [], prompts = [];
    const opts = { stateFile, externalWriter: mirror1775, escalateTo: parseEscalateTo("user:user-avery|Avery"), onEscalate: async (p) => pings.push(p) };
    const answer = async (p) => { prompts.push(p); return WAITING; };
    await poller(b, answer, opts).tick();
    rewakeOn(b, "r2", { wakeReason: "issue_disposition_repair", legacyDispositionEpisode: { attempt: 2, maxAttempts: 2 } });
    await poller(b, answer, opts).tick();
    assert.match(prompts[1], /repair attempt 2 of 2/);
    assert.match(prompts[1], /Escalate this card now: this is Paperclip's last disposition repair/);
    const posted = b.comments.get("t-1").filter((c) => c.createdByRunId === "r2");
    assert.strictEqual(posted.length, 1, JSON.stringify(posted));
    assert.match(posted[0].body, /Escalating: this is Paperclip's last disposition repair/);
    assert.strictEqual(b.issues.get("t-1").assigneeUserId, "user-avery");
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.strictEqual(pings.length, 1);
    assert.strictEqual(pings[0].to, "Avery");
  });

  await check("SLA-1775: a blocker nobody works and nothing changed escalates; a loop past REVISIT_MAX escalates whatever the model says", async () => {
    // Nobody holds what it waits on, and the second look finds it as the first did.
    let b = sla1775();
    b.issues.get("t-1783").assigneeAgentId = null;
    let stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let prompts = [];
    const answer = async (p) => { prompts.push(p); return WAITING; };
    await poller(b, answer, { stateFile, externalWriter: mirror1775 }).tick();
    rewakeOn(b, "r2");
    await poller(b, answer, { stateFile, externalWriter: mirror1775 }).tick();
    assert.ok(!/Escalate this card now/.test(prompts[1]), "escalated on its first look");
    rewakeOn(b, "r3");
    await poller(b, answer, { stateFile, externalWriter: mirror1775 }).tick();
    assert.match(prompts[2], /Escalate this card now: nothing changed since you last looked, and what it waits on is not being worked/);
    assert.match(b.comments.get("t-1").at(-1).body, /Escalating: nothing changed/);
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    // Being worked, a little progress on each wake: the model is asked each time, until the loop guard.
    b = sla1775();
    stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    prompts = [];
    await poller(b, answer, { stateFile, externalWriter: mirror1775 }).tick();
    for (let n = 1; n <= REVISIT_MAX + 1; n++) {
      b.say("t-1783", FOREMAN_SEAT, `Progress ${n}.`);
      rewakeOn(b, `r${n + 1}`);
      await poller(b, async (p) => { prompts.push(p); return `Progress ${n} on SLA-1783; still building.\n${OUTCOME_MARK} blocked on SLA-1783`; }, { stateFile, externalWriter: mirror1775 }).tick();
      assert.strictEqual(b.comments.get("t-1").filter((c) => c.createdByRunId === `r${n + 1}`).length, 1);
    }
    assert.ok(prompts.slice(0, REVISIT_MAX).every((p) => !/Escalate this card now/.test(p)), "escalated a blocker being worked before the loop guard");
    assert.match(prompts.at(-1), /Escalate this card now: it has been woken 4 times/);
    assert.match(b.comments.get("t-1").at(-1).body, /Escalating: it has been woken 4 times/);
  });

  await check("SLA-1775: a re-wake note never nests, and a model-written no-change comment is a note, never the answer", () => {
    const nested = "Nothing has changed since my last comment: Nothing has changed since my last comment: Blocked on SLA-1783.";
    assert.ok(isNote(nested));
    assert.ok(isNote("Nothing has changed since my last answer. Still blocked."));
    assert.ok(!isNote("Blocked on SLA-1783."));
    const note = unchangedNote(nested);
    assert.strictEqual((note.match(/Nothing has changed/g) ?? []).length, 1, note);
    assert.ok(note.endsWith("Blocked on SLA-1783."), note);
    assert.ok(!revisitNote({ previous: nested }).includes("Nothing has changed since my last comment: Nothing"));
    // The model failed: the mechanical note is the caller's, the card as it was — unless it must escalate.
    assert.strictEqual(revisitAnswer("", { said: "Blocked on SLA-1783." }), null);
    assert.match(revisitAnswer("", { said: "Blocked on SLA-1783.", mustEscalate: "it looped." }), /Escalating: it looped\.\nPAPERCLIP-OUTCOME: escalate$/);
    // A repeat while nothing changed escalates; a new answer, or one that escalates already, stands.
    const again = `Blocked on SLA-1783.\n${OUTCOME_MARK} blocked on SLA-1783`;
    assert.match(revisitAnswer(again, { said: "Blocked on SLA-1783.", unchanged: true }), /PAPERCLIP-OUTCOME: escalate$/);
    assert.match(revisitAnswer(again, { said: "Blocked on SLA-1783." }), /Escalating: I would only repeat my last answer\.\n/);
    const news = `PR #640 is open on SLA-1783.\n${OUTCOME_MARK} blocked on SLA-1783`;
    assert.strictEqual(revisitAnswer(news, { said: "Blocked on SLA-1783.", unchanged: true }), news);
    const up = `Avery decides.\n${OUTCOME_MARK} escalate`;
    assert.strictEqual(revisitAnswer(up, { said: "x", mustEscalate: "it looped." }), up);
  });

  // Every sequence of wait changes found in review, as one table. Each row is
  // played on t-1 (waits on t-2/t-3 as it says), a restart between every wake;
  // then two more unchanged wakes, which must run nothing: each ask resumes at
  // most once per wait, and an answer that is not blocked is final.
  await check("wait changes: each ask runs once per wait it is in, across restarts, and a final answer never runs again", async () => {
    const blockedOn = (t) => `Need ${t}.\n${OUTCOME_MARK} blocked on ${t}`;
    const until = async (f) => { for (let n = 0; !f() && n < 100; n++) await new Promise((r) => setTimeout(r, 5)); };
    const rows = [
      { name: "its wait done: resumes once", replies: [blockedOn("T-2"), "Finished."],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"]], ran: 2, status: "done" },
      { name: "re-added: waiting on the same task a second time resumes again",
        replies: [blockedOn("T-2"), blockedOn("T-3"), `T-2 again.\n${OUTCOME_MARK} blocked on T-2`, "Finished."],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"], ["done", "t-3"], ["open", "t-2"], ["wake", "r3"], ["done", "t-2"], ["wake", "r4"]], ran: 4, status: "done" },
      { name: "a resume that blocks on something new is not run again by that change", replies: [blockedOn("T-2"), blockedOn("T-3")],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"], ["wake", "r3"]], ran: 2, status: "blocked", links: ["t-3"] },
      { name: "unlinked while it waits: no resume", replies: [blockedOn("T-2")],
        steps: [["wake", "r1"], ["unlink"], ["wake", "r2"], ["done", "t-2"], ["wake", "r3"]], ran: 1, status: "blocked" },
      { name: "unlinked after its resume answered done", replies: [blockedOn("T-2"), "Finished."],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"], ["unlink"], ["wake", "r3"]], ran: 2 },
      { name: "its wait reopened after its resume answered done", replies: [blockedOn("T-2"), "Finished."],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"], ["open", "t-2"], ["wake", "r3"], ["done", "t-2"], ["wake", "r4"]], ran: 2 },
      { name: "a wait linked and done after its resume answered done", replies: [blockedOn("T-2"), "Finished."],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"], ["link", "t-3"], ["done", "t-3"], ["wake", "r3"]], ran: 2 },
      { name: "a close that clears done links", replies: [blockedOn("T-2"), "Done with it.", `Needs approval.\n${OUTCOME_MARK} blocked`],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"], ["ask", "Ship it?"], ["wake", "r3"]], ran: 3, status: "blocked", links: [] },
      { name: "its wait finishes mid-answer of a newer ask",
        replies: [blockedOn("T-2"), (b) => { b.setStatus("t-2", "done", PERSON); return "Did it."; }],
        steps: [["wake", "r1"], ["ask", "And this?"], ["wake", "r2"]], ran: 2, status: "done" },
      { name: "its wait finishes mid-answer: the work goes on at once",
        replies: [(b) => { b.setStatus("t-2", "done", PERSON); return blockedOn("T-2"); }, "Finished."],
        steps: [["wake", "r1"]], ran: 2, status: "done" },
      { name: "mid-retry: a linked wait finishes between an attempt and its post's retry", start: { blockedByIssueIds: ["t-2"] },
        replies: [(b) => { b.state.down = new Set(["t-1"]); return "Update sent."; }],
        steps: [["wake", "r1"], ["up"], ["done", "t-2"], ["retry"]], ran: 1, status: "done",
        check: (b) => assert.strictEqual(b.writes.filter((x) => x.body.comment?.includes("Update sent.")).length, 1) },
      { name: "mid-retry: a saved blocked answer whose wait finishes before the retry goes on, once",
        replies: [(b) => { b.state.down = new Set(["t-1"]); return blockedOn("T-2"); }, "Finished."],
        steps: [["wake", "r1"], ["up"], ["done", "t-2"], ["retry"]], ran: 2, status: "done",
        check: (b) => assert.match(b.writes.at(-1).body.comment, /^Need T-2\.\n\nResuming: T-2[\s\S]*Finished\.$/) },
      { name: "mid-retry of a resume: its post fails, then its wait reopens", replies: [blockedOn("T-2"), (b) => { b.state.down = new Set(["t-1"]); return "Finished."; }],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"], ["up"], ["open", "t-2"], ["retry"]], ran: 2, status: "done" },
      { name: "interrupted, then a linked wait finishes: the fallback, never a rerun", start: { blockedByIssueIds: ["t-2"] }, replies: [],
        steps: [["die", "r1"], ["done", "t-2"], ["retry"]], ran: 0, status: "blocked",
        check: (b) => assert.ok(b.writes.some((x) => x.body.comment === FALLBACK_REPLY)) },
      { name: "interrupted, then a linked wait finishes: run once more when allowed", start: { blockedByIssueIds: ["t-2"] }, opts: { resumeInterrupted: true },
        replies: ["sent"], steps: [["die", "r1"], ["done", "t-2"], ["retry"]], ran: 1, status: "done",
        check: (b, prompts) => assert.ok(prompts[0].includes(INTERRUPTED_NOTE)) },
      { name: "a resume interrupted: run once more when allowed, and its wait does not resume it again", opts: { resumeInterrupted: true },
        replies: [blockedOn("T-2"), "Finished."], steps: [["wake", "r1"], ["done", "t-2"], ["die", "r2"], ["retry"]], ran: 2, status: "done",
        check: (b, prompts) => assert.ok(prompts[1].includes(INTERRUPTED_NOTE)) },
      { name: "interrupted in two waits: each attempt is run once more when allowed", opts: { resumeInterrupted: true },
        replies: [blockedOn("T-2"), "Finished."], steps: [["die", "r1"], ["retry"], ["done", "t-2"], ["die", "r2"], ["retry"]], ran: 2, status: "done",
        check: (b, prompts) => assert.ok(prompts.every((p) => p.includes(INTERRUPTED_NOTE))) },
      { name: "blocked on a task already done in two waits: goes on once in each",
        replies: [blockedOn("T-2"), blockedOn("T-3"), blockedOn("T-2"), "Finished."],
        steps: [["done", "t-2"], ["wake", "r1"], ["done", "t-3"], ["wake", "r2"]], ran: 4, status: "done" },
      { name: "mid-retry in a later wait: the same blocked words as the wait before are posted, not taken as delivered",
        replies: [`Cannot yet.\n${OUTCOME_MARK} blocked`, (b) => { b.state.down = new Set(["t-1"]); return `Cannot yet.\n${OUTCOME_MARK} blocked`; }],
        steps: [["wake", "r1"], ["move", "todo"], ["wake", "r2"], ["up"], ["retry"]], ran: 2, status: "blocked" },
      { name: "interrupted in a later wait after a fallback: run once more when allowed, not taken as delivered", opts: { resumeInterrupted: true },
        replies: ["Done now."], steps: [["die", "r1"], ["die", "r1b"], ["retry"], ["move", "todo"], ["die", "r2"], ["retry"]], ran: 1, status: "done",
        check: (b, prompts) => assert.ok(prompts[0].includes(INTERRUPTED_NOTE)) },
      { name: "a person's hold lands as the bot closes blocked, then they change what it waits on: their newer hold stands",
        race: { before: (b, i) => { b.setStatus("t-1", "blocked", PERSON); i.unblockDescriptor = { owner: { userId: PERSON.actorId }, action: "Hold for T-3." }; i.blockedByIssueIds = ["t-3"]; },
          after: (b) => b.rehold("t-1", PERSON, ["t-4"], { owner: { userId: PERSON.actorId }, action: "Hold for T-4." }) },
        replies: [blockedOn("T-2")], steps: [["wake", "r1"]], ran: 1, status: "blocked", links: ["t-4"],
        check: (b) => {
          assert.strictEqual(b.issues.get("t-1").unblockDescriptor.action, "Hold for T-4.");
          assert.ok(b.comments.get("t-1").some((c) => c.body === PERSON_STANDS));
        } },
      { name: "a person's hold lands as the bot closes blocked, then they change it in the close's millisecond: their newer hold stands",
        race: { before: (b, i) => { b.setStatus("t-1", "blocked", PERSON); i.unblockDescriptor = { owner: { userId: PERSON.actorId }, action: "Hold for T-3." }; i.blockedByIssueIds = ["t-3"]; },
          after: (b) => { b.rehold("t-1", PERSON, ["t-4"], { owner: { userId: PERSON.actorId }, action: "Hold for T-4." }); b.tie("t-1"); } },
        replies: [blockedOn("T-2")], steps: [["wake", "r1"]], ran: 1, status: "blocked", links: ["t-4"],
        check: (b) => {
          assert.strictEqual(b.issues.get("t-1").unblockDescriptor.action, "Hold for T-4.");
          assert.ok(b.comments.get("t-1").some((c) => c.body === PERSON_STANDS));
        } },
      { name: "a person changes the card's waits as the bot closes blocked, then again in the close's millisecond: their newer waits stand",
        race: { before: (b) => b.relink("t-1", PERSON, ["t-3"]), after: (b) => { b.relink("t-1", PERSON, ["t-4"]); b.tie("t-1"); } },
        replies: [blockedOn("T-2")], steps: [["wake", "r1"]], ran: 1, links: ["t-4"],
        check: (b) => assert.ok(b.comments.get("t-1").some((c) => c.body === PERSON_STANDS)) },
      { name: "a person blocks the card with a comment mid-answer and the answer's post fails: the retry still posts it, a comment only",
        replies: [(b) => {
          b.setStatus("t-1", "blocked", PERSON);
          b.comments.get("t-1").push({ id: "p1", authorUserId: "user-1", createdAt: b.now(), body: "Holding this." });
          b.state.down = new Set(["t-1"]);
          return "Did it.";
        }], steps: [["wake", "r1"], ["up"], ["retry"]], ran: 1, status: "blocked",
        check: (b) => assert.ok(b.writes.some((x) => x.body.comment === "Did it." && !x.body.status)) },
      { name: "a person cancels as the bot closes: their cancel stands", race: { before: (b) => b.setStatus("t-1", "cancelled", PERSON) },
        replies: ["Did it."], steps: [["wake", "r1"]], ran: 1, status: "cancelled" },
      { name: "a person moves the card on as the bot closes: their status stands", race: { before: (b) => b.setStatus("t-1", "in_review", PERSON) },
        replies: ["Did it."], steps: [["wake", "r1"]], ran: 1, status: "in_review" },
      { name: "a person moves the card on mid-answer: the answer is a comment, their status stands",
        replies: [(b) => { b.setStatus("t-1", "in_review", PERSON); return "Did it."; }], steps: [["wake", "r1"]], ran: 1, status: "in_review",
        check: (b) => assert.ok(b.writes.some((x) => x.body.comment === "Did it." && !x.body.status)) },
      { name: "a person moves a blocked card on: asked again; a re-wake alone is not", replies: [`Cannot yet.\n${OUTCOME_MARK} blocked`, "Done now."],
        steps: [["wake", "r1"], ["wake", "r2"], ["move", "todo"], ["wake", "r3"]], ran: 2, status: "done" },
      { name: "lost run after a resume: the one answer closes it under the run the wake opened", opts: { watchMs: 10 },
        replies: [blockedOn("T-2"), async (b) => { b.recover("t-1", "r2"); await new Promise((r) => setTimeout(r, 60)); return "Finished."; }],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"]], ran: 2, status: "done",
        check: (b) => {
          assert.deepStrictEqual(b.writes.filter((x) => x.body.comment === TRANSPORT_NOTE).map((x) => x.runId), ["r2"]);
          assert.deepStrictEqual(b.writes.filter((x) => x.body.comment?.endsWith("Finished.")).map((x) => x.runId), ["w1"]);
        } },
      { name: "lost replacement after a resume: the one answer closes it under the third run", opts: { watchMs: 10 },
        replies: [blockedOn("T-2"), async (b) => {
          b.recover("t-1", "r2"); await until(() => b.wakes.length === 1);
          b.recover("t-1", "w1"); await until(() => b.wakes.length === 2);
          return "Finished.";
        }],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"]], ran: 2, status: "done",
        check: (b) => assert.deepStrictEqual(b.writes.filter((x) => x.body.comment?.endsWith("Finished.")).map((x) => x.runId), ["w2"]) },
      { name: "a resume that blocks on the same wait again resumes once more when it is done",
        replies: [blockedOn("T-2"), async (b) => { b.setStatus("t-2", "todo", PERSON); return blockedOn("T-2"); }, "Finished."],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"], ["done", "t-2"], ["wake", "r3"]], ran: 3, status: "done" },
      // Exposed again when the newer ask is deleted, it is the card's ask anew
      // (docs/board-decisions.md w6) — worked as new, never resumed from the
      // newer ask's wait: its own answer was final.
      { name: "an ask finished while its run was cancelled, posted with a newer ask's blocked answer: still finished",
        replies: [(b) => { b.runs.get("t-1").find((r) => r.id === "r1").status = "cancelled"; return "Did it."; }, blockedOn("T-2"), "Did it again."],
        steps: [["wake", "r1"], ["ask", "And this?"], ["wake", "r2"], ["unask"], ["done", "t-2"], ["wake", "r3"]], ran: 3, status: "done",
        check: (b, prompts) => assert.ok(!/waited on|Resuming/.test(prompts[2]), prompts[2]) },
      // The card changed after the snapshot the run would be built on: nothing
      // runs on it as it was and nothing is written; the next look works the
      // card as it is now (docs/board-decisions.md (d)).
      { name: "a person moves the card on between the bot's reads of it: nothing runs on the card as it was, the next look works it as it is",
        read: { of: "t-1", nth: 1, f: (b) => b.setStatus("t-1", "in_review", PERSON) },
        replies: ["Did it."], steps: [["wake", "r1"], ["retry"]], ran: 1, status: "done",
        check: (b, prompts) => {
          assert.deepStrictEqual(b.writes.map((x) => x.body), [{ status: "done", comment: "Did it." }]);
        } },
      { name: "a person changes what the card waits on as the bot looks its waits up: the answer is a comment, their waits stand",
        read: { of: "T-2", nth: 2, f: (b) => b.relink("t-1", PERSON, ["t-3"]) },
        replies: [blockedOn("T-2")], steps: [["wake", "r1"]], ran: 1, status: "in_progress", links: ["t-3"],
        check: (b) => assert.ok(b.writes.some((x) => x.body.comment === "Need T-2." && !x.body.status)) },
      { name: "a person changes what the card waits on as the bot closes it: their waits are put back",
        race: { before: (b) => b.relink("t-1", PERSON, ["t-3"]) },
        replies: [blockedOn("T-2")], steps: [["wake", "r1"]], ran: 1, status: "blocked", links: ["t-3"] },
      { name: "interrupted going on at once: run once more when allowed, and its verdict closes the card", opts: { resumeInterrupted: true },
        replies: [blockedOn("T-2"), () => new Promise(() => {}), "Finished."], steps: [["done", "t-2"], ["hang", "r1"], ["retry"]], ran: 3, status: "done",
        check: (b, prompts) => {
          assert.ok(prompts[2].includes(INTERRUPTED_NOTE) && prompts[2].includes("What it said so far"));
          assert.match(b.writes.at(-1).body.comment, /^Need T-2\.\n\nResuming: T-2[\s\S]*Finished\.$/);
        } },
      { name: "interrupted going on at once: the fallback, blocked, never the earlier answer",
        replies: [blockedOn("T-2"), () => new Promise(() => {})], steps: [["done", "t-2"], ["hang", "r1"], ["retry"]], ran: 2, status: "blocked",
        check: (b) => {
          const posted = b.writes.at(-1).body.comment;
          assert.ok(posted.startsWith("Need T-2.\n\nResuming: T-2") && posted.endsWith(FALLBACK_REPLY), posted);
        } },
      { name: "going on at once interrupted twice: run once more, then the fallback", opts: { resumeInterrupted: true },
        replies: [blockedOn("T-2"), () => new Promise(() => {})], steps: [["done", "t-2"], ["hang", "r1"], ["die", "r2"], ["retry"]], ran: 2, status: "blocked",
        check: (b) => assert.ok(b.writes.at(-1).body.comment.endsWith(FALLBACK_REPLY)) },
      { name: "a person moves the card on mid-answer, then unchanged wakes acknowledge it: their status stands, across restarts",
        replies: [(b) => { b.setStatus("t-1", "in_review", PERSON); return "Did it."; }], steps: [["wake", "r1"], ["wake", "r2"], ["wake", "r3"]], ran: 1, status: "in_review",
        check: (b) => assert.ok(!b.writes.some((x) => x.body.status === "done")) },
      { name: "an unchanged wake leaves the bot's waiting card blocked, and a wait done after it is cut from the card",
        replies: [`Need T-2 and T-3.\n${OUTCOME_MARK} blocked on T-2, T-3`], steps: [["wake", "r1"], ["wake", "r2"], ["done", "t-2"], ["retry"]],
        ran: 1, status: "blocked", links: ["t-3"],
        check: (b) => {
          assert.strictEqual(b.issues.get("t-1").status, "blocked");
          assert.match(b.issues.get("t-1").unblockDescriptor.action, /^Waits on T-3 \(T-2 done\)/);
        } },
      { name: "an unchanged wake leaves a blocked answer with no waits blocked",
        replies: [`Cannot yet.\n${OUTCOME_MARK} blocked`], steps: [["wake", "r1"], ["wake", "r2"]], ran: 1, status: "blocked",
        check: (b) => assert.strictEqual(b.issues.get("t-1").status, "blocked") },
      { name: "its last wait finishes as an unchanged wake acknowledges it: the ask resumes once, across restarts",
        replies: [blockedOn("T-2"), "Finished."], steps: [["wake", "r1"], ["onRead", (b) => b.setStatus("t-2", "done", PERSON)], ["wake", "r2"], ["retry"]],
        ran: 2, status: "done", check: (b) => assert.match(b.writes.at(-1).body.comment, /^Resuming: T-2/) },
      { name: "its last wait finishes as a wake the card was not checked out on acknowledges it: the ask resumes once",
        replies: [blockedOn("T-2"), "Finished."], steps: [["wake", "r1"], ["onRead", (b) => b.setStatus("t-2", "done", PERSON)], ["rewake", "r2"], ["retry"]],
        ran: 2, status: "done" },
      { name: "a person moves the blocked card on as an unchanged wake acknowledges it: the next wake resumes it, once",
        replies: [blockedOn("T-2"), "Finished."], steps: [["wake", "r1"], ["onRead", (b) => b.setStatus("t-1", "todo", PERSON)], ["wake", "r2"], ["wake", "r3"]],
        ran: 2, status: "done" },
      { name: "a person moves a blocked card with no waits on as an unchanged wake acknowledges it: the next wake resumes it, once",
        replies: [`Cannot yet.\n${OUTCOME_MARK} blocked`, "Done now."], steps: [["wake", "r1"], ["onRead", (b) => b.setStatus("t-1", "todo", PERSON)], ["wake", "r2"], ["wake", "r3"]],
        ran: 2, status: "done" },
      { name: "a wait reopens between an acknowledgement's looks at it: the card keeps the wait, and the ask resumes once it is done",
        replies: [blockedOn("T-2"), "Finished."],
        steps: [["wake", "r1"], ["onRead", (b) => {
          b.setStatus("t-2", "done", PERSON);
          b.state.afterRead = { of: "T-2", nth: 1, f: () => b.setStatus("t-2", "todo", PERSON) };
        }], ["wake", "r2"], ["retry"], ["done", "t-2"], ["wake", "r3"]], ran: 2, status: "done" },
      { name: "a wait reopens between an answer's looks at it: the card keeps the wait, and the ask resumes once it is done",
        replies: [(b) => {
          b.state.afterRead = { of: "T-2", nth: 1, f: () => {
            b.setStatus("t-2", "done", PERSON);
            b.state.afterRead = { of: "T-2", nth: 1, f: () => b.setStatus("t-2", "todo", PERSON) };
          } };
          return blockedOn("T-2");
        }, "Finished."],
        steps: [["wake", "r1"], ["done", "t-2"], ["wake", "r2"]], ran: 2, status: "done" },
      { name: "a person reopens the card a person blocked as the bot closed it, before the bot's note on their hold: the ask resumes once, across restarts",
        race: { before: (b, i) => { b.setStatus("t-1", "blocked", PERSON); i.unblockDescriptor = { owner: { userId: PERSON.actorId }, action: "Hold for T-3." }; i.blockedByIssueIds = ["t-3"]; },
          after: (b) => { b.state.afterRead = { of: "t-1", on: "comments", nth: 2, f: () => b.setStatus("t-1", "todo", PERSON) }; } },
        replies: [blockedOn("T-2"), "Finished."], steps: [["wake", "r1"], ["wake", "r2"], ["wake", "r3"]], ran: 2, status: "done",
        check: (b) => assert.ok(b.comments.get("t-1").some((c) => c.body.startsWith("Someone blocked this task as I closed it"))) },
      { name: "a person reopens a blocked card in the blocked answer's millisecond: the ask resumes once",
        replies: [`Cannot yet.\n${OUTCOME_MARK} blocked`, "Done now."], steps: [["wake", "r1"], ["move", "todo"], ["tie"], ["wake", "r2"], ["wake", "r3"]],
        ran: 2, status: "done" },
      { name: "a person moves the card on mid-answer in the same millisecond as the board's last entry: their status stands",
        replies: [`Cannot yet.\n${OUTCOME_MARK} blocked`, (b) => { b.setStatus("t-1", "in_review", PERSON); b.tie("t-1"); return "Done now."; }],
        steps: [["wake", "r1"], ["move", "todo"], ["wake", "r2"]], ran: 2, status: "in_review",
        check: (b) => assert.ok(b.writes.some((x) => x.body.comment === "Done now." && !x.body.status)) },
      { name: "a person changes what the card waits on mid-answer in the same millisecond as the board's last entry: their waits stand",
        replies: [`Cannot yet.\n${OUTCOME_MARK} blocked`, (b) => { b.relink("t-1", PERSON, ["t-3"]); b.tie("t-1"); return blockedOn("T-2"); }],
        steps: [["wake", "r1"], ["move", "todo"], ["wake", "r2"]], ran: 2, status: "in_progress", links: ["t-3"],
        check: (b) => assert.ok(b.writes.some((x) => x.body.comment === "Need T-2." && !x.body.status)) },
    ];
    for (const row of rows) {
      // What it waits on is held, being worked: an unchanged re-wake is not
      // a reason to escalate it (SLA-1775).
      const b = board([task("t-1", { runs: [], ...row.start }), ...["t-2", "t-3", "t-4"].map((t) => task(t, { assigneeAgentId: "agent-po", status: "todo" }))]);
      if (row.race?.before) b.state.beforeWrite = (i) => row.race.before(b, i);
      if (row.race?.after) b.state.afterWrite = (i) => row.race.after(b, i);
      if (row.read) b.state.afterRead = { ...row.read, f: (i) => row.read.f(b, i) };
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const prompts = [], revisited = [];
      // A re-wake on an ask answered as waiting is the model's to decide again
      // (SLA-1775): it is told so, and is not one of the row's asks. Here it
      // gives nothing, so the code's last resort — the mechanical note, still
      // in the same wait — is what each such wake posts.
      const answer = async (p) => {
        if (p.includes(REVISIT_LEAD)) { revisited.push(p); return ""; }
        const r = row.replies[prompts.length]; prompts.push(p); return typeof r === "function" ? r(b) : r ?? assert.fail("ran again");
      };
      const tick = () => poller(b, answer, { stateFile, ...row.opts }).tick();
      const wake = (r) => {
        b.runs.set("t-1", run(r));
        const t = b.issues.get("t-1");
        // The wake's checkout, unrecorded: Paperclip's own, of the statuses it takes.
        if (["todo", "backlog", "blocked"].includes(t.status)) t.status = "in_progress";
      };
      const t1 = b.issues.get("t-1");
      for (const [what, arg] of row.steps) {
        if (what === "wake") { wake(arg); await tick(); }
        // A wake Paperclip does not check the card out on: it waits on an open task.
        else if (what === "rewake") { b.runs.set("t-1", run(arg)); await tick(); }
        // Lands just after the next tick reads t-1, before anything it decides is written.
        else if (what === "onRead") b.state.afterRead = { of: "t-1", nth: 1, f: () => arg(b) };
        else if (what === "retry") await tick();
        else if (what === "tie") b.tie("t-1");
        else if (what === "hang") {
          wake(arg);
          poller(b, answer, { stateFile, ...row.opts, watchMs: 1e6 }).tick();
          await new Promise((r) => setTimeout(r, 20));
        }
        else if (what === "die") {
          wake(arg);
          poller(b, () => new Promise(() => {}), { stateFile, ...row.opts, watchMs: 1e6 }).tick();
          await new Promise((r) => setTimeout(r, 20));
        } else if (what === "done" || what === "open") b.setStatus(arg, what === "done" ? "done" : "todo", PERSON);
        else if (what === "unlink") t1.blockedByIssueIds = [];
        else if (what === "link") t1.blockedByIssueIds = [...(t1.blockedByIssueIds ?? []), arg];
        else if (what === "up") b.state.down = null;
        else if (what === "unask") {
          const theirs = b.comments.get("t-1").filter((c) => c.authorUserId).at(-1);
          b.comments.set("t-1", b.comments.get("t-1").filter((c) => c !== theirs));
        }
        else if (what === "move") b.setStatus("t-1", arg, PERSON);
        else if (what === "ask") {
          b.setStatus("t-1", "todo", PERSON);
          b.comments.get("t-1").push({ id: `p${b.comments.get("t-1").length}`, authorUserId: "user-1", createdAt: b.now(), body: arg });
        }
      }
      assert.strictEqual(prompts.length, row.ran, `${row.name}: ran ${prompts.length} times`);
      // The card as decided: a re-wake's checkout leaves no record of its own.
      const activity = JSON.parse(await (await b.fetch("https://board.example.com/api/issues/t-1/activity", {})).text());
      if (row.status) assert.strictEqual(decidedStatus(t1.status, activity, ME.id), row.status, `${row.name}: card`);
      if (row.links) assert.deepStrictEqual(t1.blockedByIssueIds, row.links, `${row.name}: links`);
      await row.check?.(b, prompts);
      for (const r of ["x1", "x2"]) { wake(r); await tick(); }
      assert.strictEqual(prompts.length, row.ran, `${row.name}: an unchanged wake ran it again`);
      const after = JSON.parse(await (await b.fetch("https://board.example.com/api/issues/t-1/activity", {})).text());
      if (row.status) assert.strictEqual(decidedStatus(t1.status, after, ME.id), row.status, `${row.name}: an unchanged wake changed the card`);
    }
  });

  await check("a state file whose keys carry the waits they came back from reads as the asks they name", async () => {
    const { writeFileSync } = require("fs");
    const legacy = (file, blocked) => {
      const s = JSON.parse(readFileSync(file, "utf8"));
      const old = (k) => `${k}~0123abcd`;
      s.answeredAsks = s.answeredAsks.map(old);
      s.blockedAsks = blocked ? s.answeredAsks : [];
      delete s.resumedFrom;
      writeFileSync(file, JSON.stringify(s));
    };
    // Answered done: never run again.
    let b = board([task("t-1", { runs: run("r1") })]);
    let stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    await poller(b, async () => "Finished.", { stateFile }).tick();
    legacy(stateFile, false);
    b.runs.set("t-1", run("r2")); b.issues.get("t-1").status = "in_progress";
    await poller(b, async () => assert.fail("an answered ask ran again"), { stateFile }).tick();
    // Answered blocked: resumed once when its wait is done, then final.
    b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    await poller(b, async () => `Need T-2.\n${OUTCOME_MARK} blocked on T-2`, { stateFile }).tick();
    legacy(stateFile, true);
    b.runs.set("t-1", run("r2")); b.issues.get("t-1").status = "in_progress";
    await poller(b, async () => assert.fail("ran on a re-wake"), { stateFile }).tick();
    b.setStatus("t-2", "done", PERSON);
    b.runs.set("t-1", run("r3")); b.issues.get("t-1").status = "in_progress";
    let n = 0;
    await poller(b, async () => { n++; return "Finished."; }, { stateFile }).tick();
    b.runs.set("t-1", run("r4")); b.issues.get("t-1").status = "in_progress";
    await poller(b, async () => { n++; return "again"; }, { stateFile }).tick();
    assert.strictEqual(n, 1);
    assert.strictEqual(b.issues.get("t-1").status, "done");
  });


  // An escalation: the Foreman's sync blocks a mirrored card, labels it and
  // hands it to the bot with a reason; the wake checks it out, unrecorded.
  const FOREMAN = { actorType: "user", actorId: "user-sync" };
  const mirror = /^source: \S+#\d+$/;
  const escalationBoard = (extra = {}) => {
    const b = board([task("t-1", { description: "source: acme/app#12\nstage review", labels: [{ name: "Needs EM ruling" }], runs: run("r1"), ...extra })]);
    b.setStatus("t-1", "blocked", FOREMAN, {}, { assigneeAgentId: { from: "agent-foreman", to: ME.id } });
    b.comments.get("t-1").push({ id: "f1", authorAgentId: null, authorUserId: "user-sync", createdAt: b.now(), body: "Two specs disagree on the retry window; needs a ruling." });
    b.issues.get("t-1").status = "in_progress";        // the wake's checkout, unrecorded
    return b;
  };
  const rewake = (b, id) => { b.runs.set("t-1", run(id)); b.issues.get("t-1").status = "in_progress"; };
  const escalating = (b, answer, opts = {}) => poller(b, answer, { externalWriter: mirror, escalationAuthority: "scope and mechanism", ...opts });

  await check("escalation: a blocked card with the label is worked, not refused, and stays blocked", async () => {
    const b = escalationBoard();
    const prompts = [];
    await escalating(b, async (p) => { prompts.push(p); return "Ruled on acme/app#12: 30 s retry window."; }).tick();
    assert.strictEqual(prompts.length, 1, "an escalation was refused");
    assert.match(prompts[0], /This card is an escalation/);
    assert.match(prompts[0], /Yours to decide: scope and mechanism/);
    assert.match(prompts[0], /source: owner\/repo#N/);
    assert.ok(!b.writes.some((w) => w.body.comment === HELD_NOTE), JSON.stringify(b.writes));
    assert.ok(b.writes.every((w) => !w.body.status || w.body.status === "blocked"), JSON.stringify(b.writes));
    // The checkout is undone before the note, which ends the run — naming
    // this bot as what unblocks it, as the board demands; resolved, the card goes back to whoever handed it up, still blocked.
    assert.deepStrictEqual(b.writes.map((w) => w.body), [KEEP_BLOCKED,
      { assigneeAgentId: "agent-foreman", comment: "Ruled on acme/app#12: 30 s retry window." }]);
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.strictEqual(b.issues.get("t-1").assigneeAgentId, "agent-foreman");
    // A person's own block, labelled and handed to the bot, is an escalation too.
    const c = board([task("t-1", { labels: [{ name: "needs em ruling" }], runs: run("r1") })]);
    c.setStatus("t-1", "blocked", PERSON);
    c.issues.get("t-1").status = "in_progress";
    let n = 0;
    await escalating(c, async () => { n++; return "Ruled."; }).tick();
    assert.strictEqual(n, 1, "a person's labelled block was refused");
    assert.strictEqual(c.issues.get("t-1").status, "blocked");
  });

  await check("escalation: a blocked card without the label is still refused; every re-wake's run ends on its own note, and none is deleted (SLA-1335)", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const b = board([task("t-1", { labels: [{ name: "Something else" }], runs: run("r1") })]);
    b.setStatus("t-1", "blocked", PERSON);
    b.issues.get("t-1").status = "in_progress";
    const never = async () => assert.fail("worked a held card");
    // r1 and r2 in one poller; r3 and r4 after a restart, from its state file.
    const first = escalating(b, never, { stateFile });
    await first.tick();
    rewake(b, "r2"); await first.tick();
    const restarted = escalating(b, never, { stateFile });
    rewake(b, "r3"); await restarted.tick();
    rewake(b, "r4"); await restarted.tick();
    assert.deepStrictEqual(b.writes.map((w) => [w.runId, w.body]), ["r1", "r2", "r3", "r4"].map((r) => [r, { comment: HELD_NOTE }]));
    // Every waiter ended (the fake ends a run on its comment), and no note is
    // taken down: the board shows a deleted comment as a blank one.
    assert.strictEqual(b.runs.get("t-1")[0].status, "succeeded", "the last re-wake's run was left open");
    assert.deepStrictEqual(b.comments.get("t-1").filter((c) => !c.deletedAt).map((c) => [c.createdByRunId, c.body]), ["r1", "r2", "r3", "r4"].map((r) => [r, HELD_NOTE]));
    const activity = JSON.parse(await (await b.fetch("https://board.example.com/api/issues/t-1/activity", {})).text());
    assert.strictEqual(decidedStatus(b.issues.get("t-1").status, activity, ME.id), "blocked", "the hold was lost");
    // No labels configured: nothing is an escalation.
    const c = escalationBoard();
    await escalating(c, async () => assert.fail("an empty label list still escalated"), { escalationLabels: [] }).tick();
  });

  await check("escalation: an unchanged card gets no second run and no second note; a new comment or hand-off runs again", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const b = escalationBoard();
    let n = 0;
    // Stuck each time, so the card stays with the bot to be woken again.
    const answer = async () => `Note ${++n}.\n${OUTCOME_MARK} blocked`;
    await escalating(b, answer, { stateFile }).tick();
    const after = b.writes.length;
    for (const id of ["r2", "r3"]) {
      rewake(b, id);
      await escalating(b, answer, { stateFile }).tick();
    }
    assert.strictEqual(n, 1, "an unchanged escalation ran again");
    // Each re-wake's run ends on a note of its own; none is taken down.
    assert.deepStrictEqual(b.writes.slice(after).filter((w) => w.body.comment).map((w) => [w.runId, w.body.comment]), [["r2", ESCALATION_KEPT], ["r3", ESCALATION_KEPT]]);
    assert.deepStrictEqual(b.comments.get("t-1").filter((c) => !c.deletedAt && c.body === ESCALATION_KEPT).map((c) => c.createdByRunId), ["r2", "r3"]);
    assert.strictEqual(b.issues.get("t-1").status, "blocked", "a re-wake's checkout was left in progress");
    // A person comments: a new ask.
    b.comments.get("t-1").push({ id: "h2", authorAgentId: null, authorUserId: "user-1", createdAt: b.now(), body: "Any update?" });
    rewake(b, "r4");
    await escalating(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 2, "a new comment was not worked");
    // Handed to the bot again, unchanged otherwise: a new escalation.
    b.setStatus("t-1", "blocked", FOREMAN, {}, { assigneeAgentId: { from: "agent-foreman", to: ME.id } });
    rewake(b, "r5");
    await escalating(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 3, "a new hand-off was not worked");
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
  });

  await check("escalation: an escalate answer hands the card to the next seat, by name, inside its run, still blocked", async () => {
    const b = escalationBoard();
    const pings = [];
    await escalating(b, async () => `Need a product call on the retry window.\nTried both specs; they conflict on customer-facing behaviour.\n${OUTCOME_MARK} escalate`,
      { escalateTo: parseEscalateTo("agent:product owner"), onEscalate: async (p) => pings.push(p) }).tick();
    const hand = b.writes.find((w) => "assigneeAgentId" in w.body);
    assert.ok(hand, JSON.stringify(b.writes));
    assert.strictEqual(hand.runId, "r1", "the hand-off was not made under the bot's run");
    // Only the fields it changes: the card had no user holder to clear.
    assert.deepStrictEqual(hand.body, { assigneeAgentId: "agent-po",
      comment: "Need a product call on the retry window.\nTried both specs; they conflict on customer-facing behaviour." });
    assert.strictEqual(b.issues.get("t-1").assigneeAgentId, "agent-po");
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.deepStrictEqual(pings, [], "an agent seat was pinged off the board");
  });

  await check("escalation: handed to a person, they are pinged once with the link and the ask, never again", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const b = escalationBoard();
    const pings = [];
    const opts = { stateFile, escalateTo: parseEscalateTo("user:user-avery|Avery"), onEscalate: async (p) => pings.push(p) };
    const answer = async () => `Need a call on committing to the 30 s window.\nIt changes what we promise the customer.\n${OUTCOME_MARK} escalate`;
    await escalating(b, answer, opts).tick();
    assert.deepStrictEqual(b.writes.find((w) => "assigneeUserId" in w.body).body.assigneeUserId, "user-avery");
    assert.strictEqual(b.issues.get("t-1").assigneeAgentId, null);
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.deepStrictEqual(pings, [{ task: "T-1", link: "https://board.example.com/T/issues/T-1", to: "Avery", ask: "Need a call on committing to the 30 s window." }]);
    const after = b.writes.length;
    for (const id of ["r2", "r3"]) {
      rewake(b, id);
      await escalating(b, answer, opts).tick();
    }
    assert.strictEqual(pings.length, 1, "a person was pinged again on an unchanged card");
    assert.strictEqual(b.writes.length, after, JSON.stringify(b.writes.slice(after)));
  });

  await check("escalation: with no one to hand it to, or a hand-off the board refuses, the card keeps its holder and says why", async () => {
    let b = escalationBoard();
    await escalating(b, async () => `Need a ruling.\n${OUTCOME_MARK} escalate`).tick();
    assert.deepStrictEqual(b.writes.map((w) => w.body), [KEEP_BLOCKED, { comment: "Need a ruling." }]);
    assert.strictEqual(b.issues.get("t-1").assigneeAgentId, ME.id);
    b = escalationBoard();
    await escalating(b, async () => `Need a ruling.\n${OUTCOME_MARK} escalate`, { escalateTo: parseEscalateTo("agent:Nobody") }).tick();
    assert.match(b.writes.at(-1).body.comment, /^Need a ruling\.\n\nI could not hand this card to Nobody: the board has no seat by that name\.$/);
    assert.strictEqual(b.issues.get("t-1").assigneeAgentId, ME.id);
    b = escalationBoard();
    b.state.refuseHandOff = true;
    const pings = [];
    await escalating(b, async () => `Need a ruling.\n${OUTCOME_MARK} escalate`, { escalateTo: parseEscalateTo("user:user-avery|Avery"), onEscalate: async (p) => pings.push(p) }).tick();
    assert.match(b.writes.at(-1).body.comment, /I could not hand this card to Avery: the board refused it \(403\)\.$/);
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.deepStrictEqual(pings, [], "a person was pinged for a hand-off that did not happen");
  });

  await check("escalation: settings — labels, next holder, return, authority, channel and mention per board", () => {
    assert.deepStrictEqual(ESCALATION_LABELS, ["Needs EM ruling"]);
    assert.deepStrictEqual(parseEscalateTo("agent:Product Owner"), { kind: "agent", ref: "Product Owner", name: "Product Owner" });
    assert.deepStrictEqual(parseEscalateTo("user:abc123 | Avery"), { kind: "user", ref: "abc123", name: "Avery" });
    assert.strictEqual(parseEscalateTo(""), null);
    assert.throws(() => parseEscalateTo("Product Owner"), /agent:<seat name or id>/);
    const { boards, problems, warnings } = paperclipBoards({
      PAPERCLIP_URL: "https://one.example.com", PAPERCLIP_API_KEY: "k1", PAPERCLIP_PROMPT_CHANNEL: "111",
      PAPERCLIP_ESCALATION_LABELS: "Needs EM ruling, Needs PO ruling", PAPERCLIP_ESCALATE_TO: "agent:Product Owner",
      PAPERCLIP_ESCALATION_RETURN_TO: "agent:Foreman", PAPERCLIP_ESCALATION_AUTHORITY: "scope and mechanism", PAPERCLIP_ESCALATION_MENTION: "<@42>",
      PAPERCLIP_EXTRA_BOARDS: JSON.stringify([
        { id: "two", url: "https://two.example.com", keyEnv: "TWO_KEY", escalateTo: "user:u-9|Avery", escalationChannel: "222", escalationReturnTo: "agent:Tech Lead" },
        { id: "three", url: "https://three.example.com", keyEnv: "TWO_KEY", escalationLabels: [], escalateTo: "nonsense", escalationReturnTo: "nonsense" },
      ]),
      TWO_KEY: "k2",
    });
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(warnings.length, 2, warnings.join("\n"));
    assert.ok(warnings.every((w) => /three/.test(w)), warnings.join("\n"));
    const [one, two, three] = boards.map((b) => b.escalation);
    assert.deepStrictEqual(one.labels, ["Needs EM ruling", "Needs PO ruling"]);
    assert.deepStrictEqual(one.escalateTo, { kind: "agent", ref: "Product Owner", name: "Product Owner" });
    assert.strictEqual(one.authority, "scope and mechanism");
    assert.strictEqual(one.mention, "<@42>");
    assert.deepStrictEqual(two.escalateTo, { kind: "user", ref: "u-9", name: "Avery" });
    assert.strictEqual(two.channel, "222");
    assert.strictEqual(two.authority, "scope and mechanism", "an extra board falls back to the env");
    assert.deepStrictEqual(three.labels, []);
    assert.strictEqual(three.escalateTo, null, "a broken or missing escalateTo is inherited from no one");
    assert.deepStrictEqual(one.returnTo, { kind: "agent", ref: "Foreman", name: "Foreman" });
    assert.deepStrictEqual(two.returnTo, { kind: "agent", ref: "Tech Lead", name: "Tech Lead" });
    assert.strictEqual(three.returnTo, null, "a broken return is not made, and not inherited");
    assert.deepStrictEqual(paperclipBoards({ PAPERCLIP_URL: "https://one.example.com", PAPERCLIP_API_KEY: "k" }).boards[0].escalation.labels, ["Needs EM ruling"]);
    assert.deepStrictEqual(paperclipBoards({ PAPERCLIP_URL: "https://one.example.com", PAPERCLIP_API_KEY: "k", PAPERCLIP_ESCALATION_LABELS: "" }).boards[0].escalation.labels, []);
  });

  // EM#626: a board attempt runs in a worker that outlives the bot (lib/attempts.js).
  const fakeAttempts = (phases = {}) => {
    const stopped = [];
    return { stopped, phases,
      state: (id) => phases[id] ?? { phase: "none" },
      current: (id) => phases[id] ?? { phase: "none" },
      alive: (id) => (phases[id]?.phase ?? "none") === "running",
      stop: (id) => { if (phases[id]?.phase !== "running") return false; stopped.push(id); phases[id] = { phase: "finished", exit: { code: null, cause: "stopped" } }; return true; } };
  };

  await check("EM#626: a restart follows the attempt under way — never run again, never told it was interrupted — and its answer carries the attempt's mark", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const seen = [];
    // The first bot dies mid-run; its worker does not.
    poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
    await new Promise((r) => setTimeout(r, 20));
    const id = seen[0].attemptId;
    assert.ok(id, "the attempt was named before it ran");
    assert.deepStrictEqual(Object.values(JSON.parse(readFileSync(stateFile, "utf8")).attemptIds), [id], "and saved with it");
    const after = [];
    await poller(b, async (p, i, o) => { after.push({ p, o }); return "sent"; }, { stateFile, resumeInterrupted: true, attempts: fakeAttempts({ [id]: { phase: "running" } }) }).tick();
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].o.attemptId, id, "the same attempt, followed");
    assert.strictEqual(after[0].o.runId, "r1", "under the same run");
    assert.ok(!after[0].p.includes(INTERRUPTED_NOTE), "not re-run as an interrupted attempt");
    const posted = b.writes.find((x) => x.body.comment?.startsWith("sent"));
    assert.ok(posted?.body.comment.includes(`<!-- slashbin-attempt:${id}:result -->`), "marked");
    assert.strictEqual(b.issues.get("t-1").status, "done");
    await poller(b, async () => assert.fail("ran again"), { stateFile, attempts: fakeAttempts() }).tick();
  });

  await check("EM#626: a worker that died after it started is answered blocked from its record — never run again", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
    await new Promise((r) => setTimeout(r, 20));
    const id = seen[0].attemptId;
    const att = fakeAttempts({ [id]: { phase: "died", started: { at: "2026-10-15T01:00:00Z" } } });
    await poller(b, async () => { throw new Error("worker died"); }, { stateFile, attempts: att }).tick();
    const posted = b.writes.find((x) => x.body.comment?.includes("was not run again"));
    assert.ok(posted, "the died note is posted");
    assert.strictEqual(posted.body.status, "blocked");
    assert.ok(!posted.body.comment.includes("PAPERCLIP-OUTCOME"), "the outcome line is read, not shown");
  });

  await check("EM#626: a worker whose task a person cancelled while the bot was away is stopped", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
    await new Promise((r) => setTimeout(r, 20));
    const id = seen[0].attemptId;
    b.setStatus("t-1", "cancelled", PERSON);
    const att = fakeAttempts({ [id]: { phase: "running" } });
    await poller(b, async () => assert.fail("ran"), { stateFile, attempts: att }).tick();
    assert.deepStrictEqual(att.stopped, [id]);
  });

  await check("EM#626: the model's own hand-off is not a reason to stop its worker; a person's is", async () => {
    for (const [actor, stops] of [[{ actorType: "agent", actorId: ME.id }, false], [PERSON, true]]) {
      const b = board([task("t-1", { runs: run("r1") })]);
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const seen = [];
      poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
      await new Promise((r) => setTimeout(r, 20));
      const id = seen[0].attemptId;
      b.issues.get("t-1").assigneeAgentId = "agent-po";
      const att = fakeAttempts({ [id]: { phase: "running" } });
      const realFetch = b.fetch;
      // The hand-off as Paperclip records it: an assignee change by its actor.
      const fetch = async (url, init) => {
        if (url.endsWith("/issues/t-1/activity")) return { ok: true, text: async () => JSON.stringify([{ action: "issue.updated", createdAt: new Date().toISOString(), ...actor, details: { changes: { assigneeAgentId: { from: ME.id, to: "agent-po" } } } }]) };
        return realFetch(url, init);
      };
      await poller({ ...b, fetch }, async () => assert.fail("ran"), { stateFile, attempts: att }).tick();
      assert.deepStrictEqual(att.stopped, stops ? [id] : [], JSON.stringify(actor));
    }
  });

  await check("EM#626: a run lost while the bot was away is reconciled from the attempt's record only once its worker stopped, then the bot wakes itself", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
    await new Promise((r) => setTimeout(r, 20));
    const id = seen[0].attemptId;
    b.runs.set("t-1", [{ id: "r1", agentId: ME.id, status: "failed" }]);
    b.issues.get("t-1").status = "blocked";
    const resolves = [];
    const realFetch = b.fetch;
    const fetch = async (url, init) => {
      if (url.endsWith("/issues/t-1/recovery-actions")) return { ok: true, text: async () => JSON.stringify({ active: { id: "ra-1", cause: "legacy_execution_requires_reconciliation", evidence: { runId: "r1" } } }) };
      if (url.endsWith("/issues/t-1/recovery-actions/resolve")) { resolves.push({ body: JSON.parse(init.body), run: init.headers["x-paperclip-run-id"] }); return { ok: true, text: async () => "{}" }; }
      return realFetch(url, init);
    };
    const att = fakeAttempts({ [id]: { phase: "running" } });
    await poller({ ...b, fetch }, async () => assert.fail("ran"), { stateFile, attempts: att }).tick();
    assert.strictEqual(resolves.length, 0, "nothing sent while the worker runs");
    assert.strictEqual(b.wakes.length, 0);
    att.phases[id] = { phase: "finished", exit: { code: 0, cause: null, at: "2026-10-15T02:00:00Z" } };
    await poller({ ...b, fetch }, async () => assert.fail("ran"), { stateFile, attempts: att }).tick();
    assert.strictEqual(resolves.length, 1);
    const { body, run: header } = resolves[0];
    assert.strictEqual(header, "r1");
    assert.strictEqual(body.actionId, "ra-1");
    assert.strictEqual(body.outcome, "restored");
    assert.strictEqual(body.sourceIssueStatus, "todo");
    assert.strictEqual(body.executionReconciliation.runId, "r1");
    assert.strictEqual(body.executionReconciliation.actionOutcome, "completed");
    assert.ok(body.executionReconciliation.outcomeEvidence.includes(id));
    assert.strictEqual(b.wakes.length, 1, "the bot wakes itself on the task");
    // The next run delivers the stored result, read from the same attempt.
    const after = [];
    await poller({ ...b, fetch }, async (p, i, o) => { after.push(o); return "sent"; }, { stateFile, attempts: att }).tick();
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].attemptId, id);
    assert.strictEqual(after[0].runId, "w1", "under the new run");
    assert.ok(b.writes.some((x) => x.runId === "w1" && x.body.comment?.startsWith("sent")));
  });

  await check("EM#626: a person's hold mid-run stops the worker; the model's own block, a recovery block, do not", async () => {
    for (const [actor, stops] of [[PERSON, true], [{ actorType: "agent", actorId: ME.id }, false], [{ actorType: "system" }, false]]) {
      const b = board([task("t-1", { runs: run("r1") })]);
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const att = fakeAttempts();
      const seen = [];
      poller(b, (p, i, o) => { seen.push(o); att.phases[o.attemptId] = { phase: "running" }; return new Promise(() => {}); }, { stateFile, watchMs: 10, attempts: att }).tick();
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(seen[0]?.attemptId);
      // The bot stays its assignee; only the status moves.
      b.setStatus("t-1", "blocked", actor);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepStrictEqual(att.stopped, stops ? [seen[0].attemptId] : [], JSON.stringify(actor));
    }
  });

  await check("EM#626: a board restart's recovery block on a card a person set up does not stop the worker", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    // A person made the card ready: the newest status write before the restart is theirs.
    b.setStatus("t-1", "todo", PERSON);
    b.issues.get("t-1").status = "in_progress";
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const att = fakeAttempts();
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); att.phases[o.attemptId] = { phase: "running" }; return new Promise(() => {}); }, { stateFile, watchMs: 10, attempts: att }).tick();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(seen[0]?.attemptId);
    b.recover("t-1", "r1");
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(att.stopped, [], "the board's own block is no one's hold");
  });

  await check("EM#626: the board loses a durable attempt's run mid-work — nothing said under it, its settlement is reconciled once the worker stops, the answer goes out once under the new run", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const att = fakeAttempts();
    let launches = 0;
    await poller(b, async (p, i, o) => {
      launches++;
      att.phases[o.attemptId] = { phase: "running" };
      b.recover("t-1", "r1", { hold: true });
      await new Promise((r) => setTimeout(r, 60));
      att.phases[o.attemptId] = { phase: "finished", exit: { code: 0, cause: null } };
      return "sent";
    }, { watchMs: 10, stateFile, attempts: att }).tick();
    assert.strictEqual(b.writes.filter((x) => x.body.comment).length, 0, "nothing posted under the lost run");
    assert.strictEqual(b.writes.length, 0, "no seat write under the lost run");
    const [resolved, ...more] = b.state.resolves ?? [];
    assert.strictEqual(more.length, 0, "reconciled once");
    assert.deepStrictEqual([resolved.runId, resolved.body.actionId, resolved.body.executionReconciliation.runId, resolved.body.executionReconciliation.actionOutcome], ["r1", "ra-r1", "r1", "completed"],
      "the settlement reconciled from the attempt's record, once the worker stopped");
    assert.deepStrictEqual(b.wakes, [{ issueId: "t-1" }]);
    assert.ok(b.runs.get("t-1").some((r) => r.id === "w1"), "the wake opened a run: the settlement no longer refuses it");
    await poller(b, async () => assert.fail("ran again"), { stateFile, attempts: att }).tick();
    const posted = b.writes.filter((x) => x.body.comment?.includes("sent"));
    assert.deepStrictEqual(posted.map((x) => x.runId), ["w1"], "once, under the run the wake opened");
    assert.ok(posted[0].body.comment.startsWith(LOST_NOTE_START), "says the first run was lost");
    assert.strictEqual(b.issues.get("t-1").status, "done");
    assert.strictEqual(launches, 1);
  });

  await check("EM#626: the model hands its card on itself, then the bot restarts — the answer is posted once as a comment, and the hand-off stands", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
    await new Promise((r) => setTimeout(r, 20));
    const id = seen[0].attemptId;
    // Its model's process.escalate: the card goes to the PO, blocked, by the seat.
    const i = b.issues.get("t-1");
    b.setStatus("t-1", "blocked", { actorType: "agent", actorId: ME.id }, { runId: "r1" }, { assigneeAgentId: { from: ME.id, to: "agent-po" } });
    i.assigneeAgentId = "agent-po";
    const att = fakeAttempts({ [id]: { phase: "finished", exit: { code: 0, cause: null } } });
    const reads = [];
    await poller(b, async (p, iss, o) => { reads.push(o); return "handed up to the PO"; }, { stateFile, attempts: att }).tick();
    assert.deepStrictEqual(reads.map((o) => o.attemptId), [id], "read from the same attempt's record");
    const posted = b.writes.filter((x) => x.body.comment?.includes(`<!-- slashbin-attempt:${id}:result -->`));
    assert.strictEqual(posted.length, 1, "posted once");
    assert.strictEqual(posted[0].runId, "r1", "under the attempt's run");
    assert.ok(posted[0].body.comment.startsWith("handed up to the PO"));
    assert.ok(!("status" in posted[0].body) && !("assigneeAgentId" in posted[0].body), "a comment only");
    assert.strictEqual(i.assigneeAgentId, "agent-po", "the hand-off stands");
    assert.strictEqual(i.status, "blocked");
    await poller(b, async () => assert.fail("ran again"), { stateFile, attempts: att }).tick();
    assert.strictEqual(b.writes.filter((x) => x.body.comment?.includes(id)).length, 1, "never twice");
  });

  await check("EM#626: the board loses the run and the worker ends before the watch looks — still reconciled, and answered once under the new run", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const att = fakeAttempts();
    await poller(b, async (p, i, o) => {
      att.phases[o.attemptId] = { phase: "running" };
      b.recover("t-1", "r1", { hold: true });
      att.phases[o.attemptId] = { phase: "finished", exit: { code: 0, cause: null } };
      return "sent";
    }, { watchMs: 1e6, stateFile, attempts: att }).tick();
    assert.strictEqual(b.writes.length, 0, "no seat write under the lost run");
    assert.strictEqual((b.state.resolves ?? []).length, 1, "the settlement reconciled once");
    await poller(b, async () => assert.fail("ran again"), { stateFile, attempts: att }).tick();
    const posted = b.writes.filter((x) => x.body.comment?.includes("sent"));
    assert.deepStrictEqual(posted.map((x) => x.runId), ["w1"], "once, under the run the wake opened");
    assert.ok(posted[0].body.comment.startsWith(LOST_NOTE_START));
  });

  await check("EM#626: a person holds the card while the bot is away and the board cancels its run — the restarted bot stops the worker", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
    await new Promise((r) => setTimeout(r, 20));
    const id = seen[0].attemptId;
    // The bot is down: a person blocks the card, the bot still its assignee, and the board cancels the run.
    b.setStatus("t-1", "blocked", PERSON);
    b.runs.get("t-1")[0].status = "cancelled";
    const att = fakeAttempts({ [id]: { phase: "running" } });
    await poller(b, async () => assert.fail("ran again"), { stateFile, attempts: att }).tick();
    assert.deepStrictEqual(att.stopped, [id], "the worker is stopped");
    assert.strictEqual(b.issues.get("t-1").status, "blocked", "the person's hold stands");
  });

  await check("EM#626: the board loses the run during a going-on after a wait already done — reconciled, and answered once under the new run", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "done" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const att = fakeAttempts();
    let launches = 0;
    await poller(b, async (p, i, o) => {
      launches++;
      att.phases[o.attemptId] = { phase: "running" };
      if (launches === 1) { att.phases[o.attemptId] = { phase: "finished", exit: { code: 0, cause: null } }; return `Need T-2.\n${OUTCOME_MARK} blocked on T-2`; }
      b.recover("t-1", "r1", { hold: true });
      att.phases[o.attemptId] = { phase: "finished", exit: { code: 0, cause: null } };
      return "DONE-CONTINUATION";
    }, { watchMs: 1e6, stateFile, attempts: att }).tick();
    assert.strictEqual(launches, 2);
    assert.strictEqual(b.writes.length, 0, "no seat write under the lost run");
    assert.strictEqual((b.state.resolves ?? []).length, 1, "the settlement reconciled once");
    assert.ok(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).pendingReplies).length, "the answer was dropped before delivery");
    await poller(b, async () => assert.fail("ran again"), { stateFile, attempts: att }).tick();
    const posted = b.writes.filter((x) => x.body.comment?.includes("DONE-CONTINUATION"));
    assert.deepStrictEqual(posted.map((x) => x.runId), ["w1"], "once, under the run the wake opened");
    assert.ok(posted[0].body.comment.startsWith(LOST_NOTE_START));
    assert.match(posted[0].body.comment, /Need T-2\.[\s\S]*Resuming: T-2/, "the first answer goes out with it");
  });

  // A person's status that let the attempt in is no withdrawal of it: only a change made after admission stops its worker.
  const admitted = [
    ["an escalation the Foreman's sync blocked and handed over in one write", () => escalationBoard(), { externalWriter: mirror, escalationAuthority: "scope and mechanism" }],
    ["a labelled escalation a person blocked, no hand-over in the write", () => {
      const b = board([task("t-1", { description: "source: acme/app#12\nstage review", labels: [{ name: "Needs EM ruling" }], runs: run("r1") })]);
      b.setStatus("t-1", "blocked", PERSON);
      b.issues.get("t-1").status = "in_progress";
      return b;
    }, { externalWriter: mirror, escalationAuthority: "scope and mechanism" }],
    ["a card a person put in review", () => {
      const b = board([task("t-1", { runs: run("r1") })]);
      b.setStatus("t-1", "in_review", PERSON);
      return b;
    }, {}],
  ];
  for (const [name, make, opts] of admitted) {
    await check(`EM#626: ${name} — its worker runs on, live and across a restart, and its own answer goes out once`, async () => {
      const b = make();
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const att = fakeAttempts();
      const seen = [];
      poller(b, (p, i, o) => { seen.push(o); att.phases[o.attemptId] = { phase: "running" }; return new Promise(() => {}); }, { stateFile, watchMs: 10, attempts: att, ...opts }).tick();
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(seen.length, 1, "admitted");
      const id = seen[0].attemptId;
      assert.deepStrictEqual(att.stopped, [], "stopped live by the status that let it in");
      const after = fakeAttempts({ [id]: { phase: "running" } });
      // The restarted bot follows the running worker; it never ends here, so the tick is not awaited.
      poller(b, () => new Promise(() => {}), { stateFile, watchMs: 10, attempts: after, ...opts }).tick();
      await new Promise((r) => setTimeout(r, 80));
      assert.deepStrictEqual(after.stopped, [], "stopped by the restarted bot");
      const done = fakeAttempts({ [id]: { phase: "finished", exit: { code: 0, cause: null } } });
      await poller(b, async (p, i, o) => { assert.strictEqual(o.attemptId, id, "ran again"); return "RULED-ONCE"; }, { stateFile, attempts: done, ...opts }).tick();
      const posted = b.writes.filter((x) => x.body.comment?.includes("RULED-ONCE"));
      assert.strictEqual(posted.length, 1, "its own answer, once");
      assert.ok(!b.writes.some((x) => x.body.comment?.includes(FALLBACK_REPLY)), "a fallback went out");
    });
  }

  await check("EM#626: the board loses the run, then a person cancels the card — the worker is still stopped", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const att = fakeAttempts();
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); att.phases[o.attemptId] = { phase: "running" }; return new Promise(() => {}); }, { stateFile, watchMs: 10, attempts: att }).tick();
    await new Promise((r) => setTimeout(r, 20));
    b.recover("t-1", "r1", { hold: true });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(att.stopped, [], "the board's own block stops nothing");
    b.setStatus("t-1", "cancelled", PERSON);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(att.stopped, [seen[0].attemptId], "the cancel stops the worker");
  });

  await check("EM#626: the model hands its card on, the bot restarts, the recipient checks it out — the answer is still posted once, and the recipient keeps it", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
    await new Promise((r) => setTimeout(r, 20));
    const id = seen[0].attemptId;
    const i = b.issues.get("t-1");
    b.setStatus("t-1", "blocked", { actorType: "agent", actorId: ME.id }, { runId: "r1" }, { assigneeAgentId: { from: ME.id, to: "agent-po" } });
    i.assigneeAgentId = "agent-po";
    // The original run has ended; the PO's own run checks the card out.
    b.runs.get("t-1")[0].status = "succeeded";
    b.runs.get("t-1").push({ id: "po-1", agentId: "agent-po", status: "running" });
    b.setStatus("t-1", "in_progress", { actorType: "agent", actorId: "agent-po" }, { runId: "po-1" });
    const att = fakeAttempts({ [id]: { phase: "finished", exit: { code: 0, cause: null } } });
    await poller(b, async () => "handed up to the PO", { stateFile, attempts: att }).tick();
    const posted = b.comments.get("t-1").filter((c) => c.body.includes(`<!-- slashbin-attempt:${id}:result -->`));
    assert.strictEqual(posted.length, 1, "posted once");
    assert.strictEqual(posted[0].createdByRunId, "r1", "under the attempt's own run");
    assert.ok(posted[0].body.startsWith("handed up to the PO"));
    assert.strictEqual(i.assigneeAgentId, "agent-po", "the hand-off stands");
    assert.strictEqual(i.status, "in_progress", "the recipient's checkout stands");
    await poller(b, async () => assert.fail("ran again"), { stateFile, attempts: att }).tick();
    assert.strictEqual(b.comments.get("t-1").filter((c) => c.body.includes(id)).length, 1, "never twice");
  });

  await check("EM#626: a provider killed outright is answered blocked, naming the kill — never the generic fallback", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const seen = [];
    poller(b, (p, i, o) => { seen.push(o); return new Promise(() => {}); }, { stateFile, watchMs: 1e6, attempts: fakeAttempts() }).tick();
    await new Promise((r) => setTimeout(r, 20));
    const id = seen[0].attemptId;
    const att = fakeAttempts({ [id]: { phase: "died", exit: { code: null, signal: "SIGKILL", cause: null }, started: { at: "2026-10-15T01:00:00Z" } } });
    await poller(b, async () => { throw new Error("worker died"); }, { stateFile, attempts: att }).tick();
    const posted = b.writes.find((x) => x.body.comment?.includes("killed by SIGKILL"));
    assert.ok(posted, "the died note names the kill");
    assert.strictEqual(posted.body.status, "blocked");
  });

  // ---- One transition model: what a wake does, and who may move a stop ----

  await check("wake model: every combination of the board and saved state comes to one step, and a held task is never worked", () => {
    const flags = ["live", "owes", "answered", "escalated", "resumes", "held"];
    for (let n = 0; n < 1 << flags.length; n++) {
      const f = Object.fromEntries(flags.map((k, i) => [k, Boolean(n & (1 << i))]));
      const step = wakeStep(f);
      const name = JSON.stringify(f);
      if (!f.live && !f.owes) assert.strictEqual(step, "post-older", name);
      else if (f.owes) assert.strictEqual(step, "retry", name);
      else if (f.escalated && f.answered && !f.resumes) assert.strictEqual(step, "settle", name);
      else if (f.answered && !f.resumes) assert.strictEqual(step, "acknowledge", name);
      else assert.strictEqual(step, f.held ? "hold" : "work", name);
      // Work runs only on a live run, on an ask not answered or resuming, on a task no one else holds.
      if (step === "work") assert.ok(f.live && !f.owes && !f.held && (!f.answered || f.resumes) && !(f.escalated && f.answered && !f.resumes), name);
    }
  });

  const AGENT = { actorType: "agent", actorId: "agent-po" };
  const STOP_ROWS = [
    { name: "an agent blocks it and hands it to the bot in one write (`return`)", works: true,
      setup: (b) => b.setStatus("t-1", "blocked", AGENT, { runId: "po-1" }, { assigneeAgentId: { from: "agent-po", to: ME.id } }) },
    { name: "an agent blocks it, then hands it to the bot, as two entries under its run", works: true,
      setup: (b) => { b.setStatus("t-1", "blocked", AGENT, { runId: "po-1" }); b.reassign("t-1", AGENT, { agentId: ME.id }, { runId: "po-1" }); } },
    { name: "an agent blocks it, and later hands it to the bot", works: true,
      setup: (b) => { b.setStatus("t-1", "blocked", AGENT, { runId: "po-1" }); b.reassign("t-1", AGENT, { agentId: ME.id }, { runId: "po-2" }); } },
    { name: "a person blocks it and hands it to the bot (SLA-1337)", works: false,
      setup: (b) => b.setStatus("t-1", "blocked", PERSON, {}, { assigneeAgentId: { from: "agent-po", to: ME.id } }) },
    { name: "a person hands it to the bot, then an agent blocks it", works: false,
      setup: (b) => { b.reassign("t-1", PERSON, { agentId: ME.id }); b.setStatus("t-1", "blocked", AGENT, { runId: "po-1" }); } },
    { name: "an agent hands it to the bot, then a different agent blocks it", works: false,
      setup: (b) => { b.reassign("t-1", AGENT, { agentId: ME.id }); b.setStatus("t-1", "blocked", { actorType: "agent", actorId: "agent-tl" }); } },
    { name: "an agent cancels it and hands it to the bot", works: false, status: "cancelled",
      setup: (b) => b.setStatus("t-1", "cancelled", PERSON, {}, { assigneeAgentId: { from: "agent-po", to: ME.id } }) },
  ];

  await check("stop model: a block an agent hands the bot is its work; a person's, or one an agent left on someone else's hand-off, stands", async () => {
    for (const row of STOP_ROWS) {
      const b = board([task("t-1", { assigneeAgentId: "agent-po", runs: run("r1") })]);
      row.setup(b);
      b.issues.get("t-1").assigneeAgentId = ME.id;
      const activity = JSON.parse(await (await b.fetch("https://board.example.com/api/issues/t-1/activity", {})).text());
      const setter = statusSetter(activity, row.status ?? "blocked", ME.id);
      assert.strictEqual(movable(setter, activity, ME.id), row.works && !row.status, `${row.name}: movable`);
      assert.strictEqual(handedBack(setter, activity, ME.id), row.works && !row.status, `${row.name}: handedBack`);
      // Through a poller: worked and closed (and left closed), or held with its note.
      if (row.status === "cancelled") continue;          // a cancelled task leaves the inbox
      b.comments.get("t-1").push({ id: "po-ask", authorAgentId: "agent-po", createdAt: b.now(), body: "Only you can fix the skill path. Please do." });
      b.issues.get("t-1").status = "in_progress";       // the wake's checkout, unrecorded
      let ran = 0;
      await poller(b, async () => { ran++; return "Fixed the skill path."; }).tick();
      assert.strictEqual(ran, row.works ? 1 : 0, `${row.name}: ran ${ran} times`);
      assert.strictEqual(b.issues.get("t-1").status, row.works ? "done" : "in_progress", `${row.name}: card`);
      assert.deepStrictEqual(b.writes.map((w) => w.body.comment), [row.works ? "Fixed the skill path." : HELD_NOTE], `${row.name}: comments`);
      assert.strictEqual(b.runs.get("t-1")[0].status, "succeeded", `${row.name}: the run was left open`);
    }
  });

  await check("escalation: unchanged re-wakes end every run, in one poller and after a restart, and nothing is worked or sent again", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const b = escalationBoard();
    let n = 0;
    const pings = [];
    const opts = { stateFile, escalateTo: parseEscalateTo("user:user-avery|Avery"), onEscalate: async (p) => pings.push(p) };
    const answer = async () => `Note ${++n}.\n${OUTCOME_MARK} blocked`;
    const first = escalating(b, answer, opts);
    await first.tick();
    const after = b.writes.length;
    rewake(b, "r2"); await first.tick();
    rewake(b, "r3"); await first.tick();
    const restarted = escalating(b, answer, opts);
    rewake(b, "r4"); await restarted.tick();
    rewake(b, "r5"); await restarted.tick();
    assert.strictEqual(n, 1, "an unchanged escalation was worked again");
    assert.deepStrictEqual(pings, [], "a re-wake sent a notification");
    assert.deepStrictEqual(b.writes.slice(after).filter((w) => w.body.comment).map((w) => w.runId), ["r2", "r3", "r4", "r5"], JSON.stringify(b.writes.slice(after)));
    assert.ok(b.writes.slice(after).every((w) => !("assigneeAgentId" in w.body) && (!w.body.status || w.body.status === "blocked")), JSON.stringify(b.writes.slice(after)));
    assert.strictEqual(b.runs.get("t-1")[0].status, "succeeded", "the last re-wake's run was left open");
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.strictEqual(b.issues.get("t-1").assigneeAgentId, ME.id);
    assert.deepStrictEqual(b.comments.get("t-1").filter((c) => !c.deletedAt).map((c) => c.body), ["Two specs disagree on the retry window; needs a ruling.", "Note 1.", ...Array(4).fill(ESCALATION_KEPT)]);
  });

  await check("escalation: an answer never overwrites a move or a hand-off made while it ran", async () => {
    const rows = [
      { name: "handed to another seat, still blocked", change: (b) => b.reassign("t-1", PERSON, { agentId: "agent-po" }), status: "blocked", holder: "agent-po" },
      { name: "handed to a person", change: (b) => b.reassign("t-1", PERSON, { userId: "user-avery" }), status: "blocked", holder: "user-avery" },
      { name: "moved to todo by a person", change: (b) => b.setStatus("t-1", "todo", PERSON), status: "todo", holder: ME.id },
      { name: "moved to todo and handed on", change: (b) => { b.setStatus("t-1", "todo", PERSON); b.reassign("t-1", PERSON, { agentId: "agent-po" }); }, status: "todo", holder: "agent-po" },
    ];
    for (const row of rows) for (const way of ["down", "up"]) {
      const b = escalationBoard();
      const pings = [];
      const answer = async () => { row.change(b); return way === "up" ? `Need a call.\n${OUTCOME_MARK} escalate` : "Ruled: 30 s."; };
      await escalating(b, answer, { escalateTo: parseEscalateTo("user:user-boss|Boss"), onEscalate: async (p) => pings.push(p) }).tick();
      const t = b.issues.get("t-1");
      const name = `${row.name}, answered ${way}`;
      assert.strictEqual(t.assigneeAgentId ?? t.assigneeUserId, row.holder, `${name}: holder overwritten`);
      assert.ok(b.writes.every((w) => !("assigneeAgentId" in w.body)), `${name}: ${JSON.stringify(b.writes)}`);
      const activity = JSON.parse(await (await b.fetch("https://board.example.com/api/issues/t-1/activity", {})).text());
      assert.strictEqual(decidedStatus(t.status, activity, ME.id), row.status, `${name}: status overwritten`);
      assert.deepStrictEqual(pings, [], `${name}: a person was told of a hand-off that did not happen`);
      const said = b.writes.filter((w) => w.body.comment);
      assert.strictEqual(said.length, 1, `${name}: ${JSON.stringify(b.writes)}`);
      assert.strictEqual(said[0].runId, "r1");
      assert.ok(said[0].body.comment.endsWith(CARD_CHANGED), `${name}: ${said[0].body.comment}`);
    }
  });

  await check("a task's answer never closes or hands back a task given to someone else while it ran", async () => {
    for (const [name, reply] of [["done", "Finished."], ["return", `Only you can do this.\n${OUTCOME_MARK} return`]]) {
      const b = board([task("t-1", { runs: run("r1"), createdByAgentId: "agent-po" })]);
      await poller(b, async () => { b.reassign("t-1", PERSON, { userId: "user-avery" }); return reply; }).tick();
      const t = b.issues.get("t-1");
      assert.strictEqual(t.assigneeUserId, "user-avery", `${name}: holder overwritten`);
      assert.strictEqual(t.status, "in_progress", `${name}: closed over the hand-off`);
      assert.deepStrictEqual(b.writes.map((w) => Object.keys(w.body)), [["comment"]], `${name}: ${JSON.stringify(b.writes)}`);
      assert.strictEqual(b.runs.get("t-1")[0].status, "succeeded", `${name}: the run was left open`);
    }
  });

  await check("escalation: a newer question from a person is worked under the same run before any hand-off; asked before the run, it is the one answered", async () => {
    const NEW_Q = "Also: does the 30 s window apply to refunds?";
    const ask = (b) => b.say("t-1", { actorType: "user", actorId: "user-avery" }, NEW_Q);
    for (const way of ["up", "down"]) {
      const opts = { escalateTo: parseEscalateTo("user:user-boss|Boss") };
      const reply = (n) => (way === "up" ? `Need a call ${n}.\n${OUTCOME_MARK} escalate` : `Ruled ${n}: 30 s.`);
      const holder = way === "up" ? "user-boss" : "agent-foreman";
      const holderOf = (t) => t.assigneeAgentId ?? t.assigneeUserId;

      // Asked before the run started: that is the ask the run answers, so the card is handed on.
      {
        const b = escalationBoard();
        ask(b);
        const prompts = [];
        await escalating(b, async (p) => { prompts.push(p); return reply(1); }, opts).tick();
        assert.strictEqual(prompts.length, 1, `${way}, asked before: worked ${prompts.length} times`);
        assert.match(prompts[0], /refunds/, `${way}, asked before: the run was not given the newer ask`);
        assert.strictEqual(holderOf(b.issues.get("t-1")), holder, `${way}, asked before: not handed on`);
        assert.ok(!b.writes.some((w) => String(w.body.comment ?? "").includes(NEWER_ASK)), `${way}, asked before: ${JSON.stringify(b.writes)}`);
      }

      // Asked while the run worked: the card is not handed on with the answer
      // to the older ask. It is worked again, under the same run, from the card
      // as it is now, and both answers go out in the one write that hands it on.
      {
        const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
        const b = escalationBoard();
        const prompts = [];
        const answer = async (p) => { prompts.push(p); if (prompts.length === 1) ask(b); return reply(prompts.length); };
        await escalating(b, answer, { ...opts, stateFile }).tick();
        const t = b.issues.get("t-1");
        const name = `${way}, asked during`;
        assert.strictEqual(prompts.length, 2, `${name}: the newer question was not worked before the hand-off`);
        assert.match(prompts[1], /refunds/, `${name}: the rework was not given the newer ask`);
        assert.match(prompts[1], /The card changed while you worked on it: a new comment came in/, name);
        assert.match(prompts[1], new RegExp(`Need a call 1|Ruled 1`), `${name}: the rework was not told what it said before`);
        assert.strictEqual(holderOf(t), holder, `${name}: the answer to the newer ask was not handed on`);
        const said = b.writes.filter((w) => w.body.comment);
        assert.deepStrictEqual(said.map((w) => w.runId), ["r1"], `${name}: ${JSON.stringify(said)}`);
        assert.ok("assigneeAgentId" in said[0].body, `${name}: the hand-off was not the answer's write`);
        assert.match(said[0].body.comment, /1[\s\S]*\n\n---\n\n[\s\S]*2/, `${name}: ${said[0].body.comment}`);
        assert.ok(!said[0].body.comment.includes(NEWER_ASK), name);
        assert.strictEqual(t.status, "blocked", `${name}: the card left blocked`);
        // Re-woken unchanged: nothing is worked again.
        rewake(b, "r2");
        await escalating(b, answer, { ...opts, stateFile }).tick();
        assert.strictEqual(prompts.length, 2, `${name}: worked again on an unchanged card`);
      }
    }
  });

  // ---- The escalation lifecycle, one owner: phases x revisions ----

  await check("escalation lifecycle: blocked through every run; a revision in any phase is reworked or left to whoever made it, never handed on stale", async () => {
    let n = 0;
    // Each revision is new each time it is made, so every one is a new ask.
    const REVISIONS = [
      { name: "title edited", kind: "rework", make: (b) => b.edit("t-1", PERSON, "title", `Retry window, rev ${++n}`), seen: /Retry window, rev \d+/ },
      { name: "description edited", kind: "rework", make: (b) => b.edit("t-1", PERSON, "description", `source: acme/app#12\nstage review\nRevision ${++n}: refunds too.`), seen: /Revision \d+: refunds too/ },
      { name: "a new comment", kind: "rework", make: (b) => b.say("t-1", PERSON, `Question ${++n}: refunds too?`), seen: /Question \d+: refunds too\?/ },
      { name: "handed away and back", kind: "rework", make: (b) => { b.reassign("t-1", PERSON, { agentId: "agent-po" }); b.reassign("t-1", PERSON, { agentId: ME.id }); } },
      { name: "handed to another seat", kind: "theirs", make: (b) => b.reassign("t-1", PERSON, { agentId: "agent-po" }) },
      { name: "moved out of blocked by a person", kind: "theirs", make: (b) => b.setStatus("t-1", "todo", PERSON) },
      { name: "its waits changed by a person", kind: "theirs", make: (b) => b.reassert("t-1", PERSON) },
    ];
    // When the revision lands: the bot's run number(s) it is made in (1 = the
    // first run, 2 = the first rework, ...), or before the first run starts.
    const PHASES = [
      { name: "after the card is put back to blocked, before the run", before: true, during: [] },
      { name: "during the run", during: [1] },
      { name: "during the rework", during: [2], warmUp: true },
      { name: "during every run", during: [1, 2, 3, 4] },
    ];
    for (const way of ["down", "up"]) for (const phase of PHASES) for (const rev of REVISIONS) {
      const name = `${rev.name}, ${phase.name}, answered ${way}`;
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const b = escalationBoard();
      const holder = way === "up" ? "user-boss" : "agent-foreman";
      const opts = { stateFile, escalateTo: parseEscalateTo("user:user-boss|Boss"), onEscalate: async (p) => pings.push(p) };
      const pings = [];
      // Lands just after the bot puts the card back to blocked, before anything runs.
      if (phase.before) b.state.afterWrite = () => { b.state.afterWrite = null; rev.make(b); };
      const prompts = [], statuses = [];
      const answer = async (p) => {
        prompts.push(p);
        statuses.push(b.issues.get("t-1").status);
        const k = prompts.length;
        // The rework phase: a comment first sends it round once, then the revision lands in the rework.
        if (phase.warmUp && k === 1) b.say("t-1", PERSON, "Warm-up question?");
        if (phase.during.includes(k)) rev.make(b);
        return way === "up" ? `Need a call ${k}.\n${OUTCOME_MARK} escalate` : `Ruled ${k}.`;
      };
      await escalating(b, answer, opts).tick();
      if (phase.before) {
        // Changed after the snapshot the run was built on: nothing runs on the
        // old card, nothing but the checkout's undo is written, and the card
        // is left for the next look (docs/board-decisions.md (d)).
        assert.strictEqual(prompts.length, 0, `${name}: worked on the card as it was`);
        assert.deepStrictEqual(b.writes.map((w) => w.body), [KEEP_BLOCKED], `${name}: wrote over the change`);
        await escalating(b, answer, opts).tick();
        if (rev.kind === "theirs") {
          // The next look decides from the card as it is now, their change
          // included, as any wake does: handed away, it is not the bot's to
          // work; otherwise it is worked once, on the card as it now reads.
          const away = rev.name === "handed to another seat";
          assert.strictEqual(prompts.length, away ? 0 : 1, `${name}: worked ${prompts.length} times`);
          if (away) assert.deepStrictEqual(b.writes.map((w) => w.body), [KEEP_BLOCKED], `${name}: wrote on a card handed away`);
          else assert.deepStrictEqual(b.writes.filter((w) => w.body.comment).map((w) => w.runId), ["r1"], name);
          continue;
        }
      }
      const t = b.issues.get("t-1");
      const holderNow = t.assigneeAgentId ?? t.assigneeUserId;
      const said = b.writes.filter((w) => w.body.comment);
      const handOffs = b.writes.filter((w) => "assigneeAgentId" in w.body || "assigneeUserId" in w.body);
      // Phase 1: the card is blocked before the model runs, and through every run.
      assert.ok(statuses.length >= 1 && statuses.every((s) => s === "blocked" || (rev.kind === "theirs" && s === "todo")), `${name}: the card was not blocked while worked: ${statuses}`);
      assert.deepStrictEqual(b.writes[0].body, KEEP_BLOCKED, `${name}: the checkout was not undone before the run`);
      // One comment, under the run, ends it.
      assert.deepStrictEqual(said.map((w) => w.runId), ["r1"], `${name}: ${JSON.stringify(said)}`);
      assert.strictEqual(b.runs.get("t-1")[0].status, "succeeded", `${name}: the run was left open`);
      const everyRun = phase.during.length > 1;
      if (rev.kind === "theirs") {
        // Someone else decided the card meanwhile: it is theirs, nothing is handed on.
        assert.deepStrictEqual(handOffs, [], `${name}: handed on over their change`);
        assert.ok(said[0].body.comment.endsWith(CARD_CHANGED), `${name}: ${said[0].body.comment}`);
        assert.deepStrictEqual(pings, [], `${name}: a person was told of a hand-off that did not happen`);
        continue;
      }
      if (everyRun) {
        // Revised on every run: worked the first time and twice more, then kept for the next wake.
        assert.strictEqual(prompts.length, 3, `${name}: worked ${prompts.length} times`);
        assert.deepStrictEqual(handOffs, [], `${name}: handed on with a stale answer`);
        assert.ok(said[0].body.comment.endsWith(NEWER_ASK), `${name}: ${said[0].body.comment}`);
        assert.strictEqual(holderNow, ME.id, `${name}: the card left the bot`);
        assert.strictEqual(t.status, "blocked", `${name}: the card left blocked`);
        // The next wake works the newest ask, and only then is the card handed on.
        rewake(b, "r2");
        await escalating(b, async (p) => { prompts.push(p); return way === "up" ? `Need a call last.\n${OUTCOME_MARK} escalate` : "Ruled last."; }, opts).tick();
        assert.strictEqual(prompts.length, 4, `${name}: the newest ask was not worked on the next wake`);
        if (rev.seen) assert.match(prompts[3], rev.seen, `${name}: the next wake was not given the revision`);
        const tt = b.issues.get("t-1");
        assert.strictEqual(tt.assigneeAgentId ?? tt.assigneeUserId, holder, `${name}: not handed on after the newest ask was worked`);
        assert.strictEqual(b.writes.filter((w) => "assigneeAgentId" in w.body || "assigneeUserId" in w.body).length, 1, name);
        continue;
      }
      // Revised once: worked again under the same run from the card as it is,
      // then handed on. Revised before the run: worked once, on the revision.
      const runs = phase.before ? 1 : 1 + 1 + (phase.warmUp ? 1 : 0);
      assert.strictEqual(prompts.length, runs, `${name}: worked ${prompts.length} times`);
      if (rev.seen) assert.match(prompts.at(-1), rev.seen, `${name}: the last run was not given the revision`);
      if (!phase.before) assert.match(prompts.at(-1), /The card changed while you worked on it/, name);
      assert.strictEqual(handOffs.length, 1, `${name}: ${JSON.stringify(b.writes)}`);
      assert.strictEqual(handOffs[0], said[0], `${name}: the hand-off was not the answer's write`);
      assert.match(said[0].body.comment, new RegExp(`${runs}\\.`), `${name}: the newest answer was not posted`);
      assert.strictEqual(holderNow, holder, `${name}: not handed on`);
      assert.strictEqual(t.status, "blocked", `${name}: the card left blocked`);
      assert.strictEqual(pings.length, way === "up" ? 1 : 0, `${name}: pings ${JSON.stringify(pings)}`);
      // The person is asked the latest attempt's question, not the first line of the post (round 4).
      if (way === "up") assert.strictEqual(pings[0].ask, `Need a call ${runs}.`, `${name}: ${JSON.stringify(pings)}`);
      // Re-woken unchanged: settled, never worked or handed again.
      rewake(b, "r2");
      await escalating(b, async () => assert.fail(`${name}: worked again`), opts).tick();
    }
  });

  // ---- docs/board-decisions.md: every row of its tables is a case here ----

  // The rows of one table of the model (`| a1 |`, `| p1 |`, `| r1 |`), each as its cells.
  const DOC = readFileSync(join(__dirname, "..", "docs", "board-decisions.md"), "utf8");
  const rowsOf = (prefix) => DOC.split("\n").filter((l) => new RegExp(`^\\| ${prefix}\\d+b? \\|`).test(l))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  // A table's builders and its rows must name the same cases: a row without a
  // builder, or a builder without a row, fails here.
  const sameIds = (prefix, builders) => assert.deepStrictEqual(Object.keys(builders).sort(), rowsOf(prefix).map((r) => r[0]).sort(), `docs/board-decisions.md table ${prefix} and its builders differ`);

  await check("table (a): every write's kind, whether it is the status decision, and whether it is a person's change — as the doc's rows say", () => {
    const BOT = { actorType: "agent", actorId: ME.id };
    const OTHER = { actorType: "user", actorId: "user-2" };
    const STEP = { owner: { agentId: ME.id }, action: SYNC_NOTE };
    // The Foreman's move: blocked, handed to the bot, its unblock step the note's text.
    const move = (b) => b.setStatus("t-1", "blocked", SYNC, {}, { assigneeAgentId: { from: "agent-foreman", to: ME.id }, unblockDescriptor: { from: null, to: STEP } });
    const bare = (b, actor) => b.record("t-1", actor, { status: "blocked", changes: { statusVersion: { from: 2, to: 3 } } });
    const AGENT = { actorType: "agent", actorId: "agent-tl" };
    // A move by `actor` whose unblock step is `action`.
    const moveAs = (b, actor, action) => b.setStatus("t-1", "blocked", actor, {}, { assigneeAgentId: { from: "agent-foreman", to: ME.id }, unblockDescriptor: { from: null, to: { owner: { agentId: ME.id }, action } } });
    // The update half of a commented restatement; its comment is posted separately.
    const noteUpdate = (b, actor) => b.record("t-1", actor, { status: "blocked", source: "comment", changes: { statusVersion: { from: 2, to: 3 } } });
    const SECRET_STEP = "Blocked: the push used api_key=notarealvalue1 and was refused.";
    const LONG_STEP = `Blocked at review: ${"the two specs disagree on the retry window, and ".repeat(6)}nobody has ruled.`;
    // Each builds the record and gives the index (newest first) of the write the row is about.
    const A = {
      a1: (b) => { b.setStatus("t-1", "blocked", PERSON); return 0; },
      a2: (b) => { move(b); return 0; },
      a3: (b) => { b.setStatus("t-1", "blocked", PERSON); bare(b, PERSON); return 0; },
      a4: (b) => { move(b); bare(b, PERSON); return 0; },
      a5: (b) => { move(b); restate(b, SYNC, SYNC_NOTE); return 1; },
      a5b: (b) => { move(b); restate(b, SYNC, SUMMARY); restate(b, SYNC, SYNC_NOTE); return 3; },
      a6: (b) => { move(b); restate(b, SYNC, SYNC_NOTE); restate(b, SYNC, "Holding this until Monday."); return 1; },
      a7: (b) => { move(b); bare(b, SYNC); restate(b, SYNC, SYNC_NOTE); return 2; },
      a8: (b) => { move(b); restate(b, PERSON, SYNC_NOTE); return 1; },
      a9: (b) => { move(b); b.record("t-1", SYNC, { status: "blocked", source: "comment", changes: { statusVersion: { from: 2, to: 3 } } }); return 0; },
      a10: (b) => { move(b); b.rehold("t-1", PERSON, ["t-2"], { owner: { userId: PERSON.actorId }, action: "Wait on T-2." }); return 0; },
      a11: (b) => { b.setStatus("t-1", "todo", SYNC); b.relink("t-1", PERSON, ["t-2"]); return 0; },
      a12: (b) => { move(b); b.reassign("t-1", PERSON, { agentId: "agent-po" }); return 0; },
      a13: (b) => { move(b); b.reassign("t-1", PERSON, { agentId: "agent-po" }); b.reassign("t-1", OTHER, { agentId: ME.id }); return 1; },
      a14: (b) => { b.setStatus("t-1", "blocked", PERSON); bare(b, BOT); return 0; },
      a15: (b) => { b.setStatus("t-1", "in_progress", BOT); b.recover("t-1", "r1"); return 0; },
      a16: (b) => { b.setStatus("t-1", "blocked", PERSON); b.recover("t-1", "r1"); return 0; },
      a17: (b) => { move(b); b.edit("t-1", PERSON, "title", "Retry window, revised"); return 0; },
      a18: (b) => { move(b); restate(b, SYNC, "Holding this until Monday."); restate(b, SYNC, SYNC_NOTE); return 3; },
      a19: (b) => { move(b); noteUpdate(b, SYNC); b.say("t-1", PERSON, "Any news?"); b.say("t-1", SYNC, SYNC_NOTE); return 2; },
      a20: (b) => { move(b); noteUpdate(b, SYNC); b.edit("t-1", PERSON, "title", "Retry window, revised"); b.say("t-1", SYNC, SYNC_NOTE); return 2; },
      a21: (b) => { move(b); noteUpdate(b, SYNC); b.recover("t-1", "r1"); b.say("t-1", SYNC, SYNC_NOTE); return 2; },
      a22: (b) => {
        move(b); noteUpdate(b, SYNC);
        b.activity.get("t-1").unshift({ action: "issue.comment_added", createdAt: b.now(), ...SYNC, runId: "run-x", details: { commentId: "cx", bodySnippet: SYNC_NOTE } });
        b.say("t-1", SYNC, "Holding this until Monday.");
        return 2;
      },
      a23: (b) => { moveAs(b, SYNC, SECRET_STEP); restate(b, SYNC, "Blocked: the push used api_key=[REDACTED] and was refused."); return 1; },
      a24: (b) => {
        moveAs(b, SYNC, LONG_STEP);
        const posted = `${LONG_STEP.slice(0, 200).trimEnd()}\n\n… (truncated)`;
        restate(b, SYNC, posted);
        b.activity.get("t-1")[0].details.body = posted;   // read whole from the thread (activityOf)
        return 1;
      },
      a25: (b) => { moveAs(b, SYNC, LONG_STEP); restate(b, SYNC, `${LONG_STEP.slice(0, 120)} — but hold this until Monday.`); return 1; },
      a26: (b) => { move(b); b.skew(10 * 60 * 1000); restate(b, SYNC, SYNC_NOTE); return 1; },
      a27: (b) => {
        move(b);
        b.record("t-1", SYNC, { status: "blocked", unblockDescriptor: null, changes: { statusVersion: { from: 2, to: 3 }, unblockDescriptor: { from: STEP, to: null } } });
        restate(b, SYNC, SYNC_NOTE);
        return 1;
      },
      a28: (b) => {
        move(b);
        b.record("t-1", SYNC, { status: "blocked", assigneeAgentId: ME.id, unblockDescriptor: STEP, changes: { statusVersion: { from: 2, to: 3 } } });
        restate(b, SYNC, SYNC_NOTE);
        return 1;
      },
      a29: (b) => {
        move(b);
        b.setStatus("t-1", "in_progress", BOT, { runId: "r1" });
        b.record("t-1", SYNC, { status: "blocked", source: "comment", changes: { status: { from: "in_progress", to: "blocked" }, statusVersion: { from: 3, to: 4 } } });
        b.say("t-1", SYNC, SYNC_NOTE);
        b.issues.get("t-1").status = "blocked";
        // The note's status is the move's: a hand-off to this bot, read as one.
        return { i: 1, also: (all) => assert.ok(lastDecision(all, ME.id)?.w === all[3] && lastDecision(all, ME.id).to === "blocked" && handedWith(all[3], all, ME.id)) };
      },
      a30: (b) => {
        b.setStatus("t-1", "blocked", SYNC, {}, { assigneeAgentId: { from: "agent-foreman", to: "agent-po" } });
        b.record("t-1", PERSON, { status: "blocked", assigneeAgentId: ME.id, changes: { statusVersion: { from: 2, to: 3 }, assigneeAgentId: { from: "agent-po", to: ME.id } } });
        return 0;
      },
      a31: (b) => { move(b); b.record("t-1", PERSON, { blockedByIssueIds: [], changes: { statusVersion: { from: 2, to: 3 } } }); return 0; },
      a32: (b) => { move(b); restate(b, SYNC, "Hold one."); restate(b, SYNC, "Hold two."); restate(b, SYNC, SYNC_NOTE); return 3; },
      a33: (b) => { moveAs(b, AGENT, SYNC_NOTE); restate(b, AGENT, SYNC_NOTE); restate(b, AGENT, "Hold on, the spec changed."); return 1; },
      a34: (b) => { move(b); restate(b, SYNC, SUMMARY); b.edit("t-1", SYNC, "title", "Retry window, revised"); restate(b, SYNC, SYNC_NOTE); return 1; },
      a35: (b) => { move(b); restate(b, SYNC, SYNC_NOTE); restate(b, SYNC, SYNC_NOTE); return 1; },
      a36: (b) => { move(b); b.reassert("t-1", AGENT); return 0; },
      a37: (b) => { move(b); bare(b, PERSON); b.tie("t-1"); return { i: 0, mark: b.activity.get("t-1")[1].createdAt }; },
      a38: (b) => { move(b); restate(b, SYNC, SUMMARY); return 1; },
    };
    sameIds("a", A);
    for (const [id, , writer, kind, decides, persons] of rowsOf("a")) {
      const b = board([task("t-1", { assigneeAgentId: "agent-foreman", runs: run("r1") }), task("t-2", { status: "todo" })]);
      const built = A[id](b);
      const { i, mark, also } = typeof built === "number" ? { i: built } : built;
      const all = b.activity.get("t-1");
      for (const a of all) a.id ??= `x${all.indexOf(a)}`;
      const name = `${id} (${writer})`;
      assert.strictEqual(decisionKind(all, i, ME.id), kind, `${name}: kind`);
      assert.strictEqual(lastDecision(all, ME.id)?.w === all[i] ? "yes" : "no", decides, `${name}: status decision`);
      // A write returned as the decision carries the status the card is in.
      if (decides === "yes") assert.strictEqual(lastDecision(all, ME.id).to, b.issues.get("t-1").status, `${name}: the status decided`);
      assert.strictEqual(personSince(all, mark ?? markAt(all, i + 1), ME.id) ? "yes" : "no", persons, `${name}: someone else's change since the mark`);
      also?.(all);
    }
  });

  await check("table (a) reads a long record in one pass: hundreds of notes, thousands of the bot's own restatements", () => {
    const at = (n) => new Date(Date.UTC(2026, 0, 1) + n).toISOString();
    const notes = [];
    for (let k = 0; k < 256; k++) {
      const step = { owner: { agentId: ME.id }, action: `Step ${k}.` };
      notes.unshift({ action: "issue.updated", createdAt: at(3 * k), ...SYNC, details: { status: "blocked", unblockDescriptor: step, changes: { statusVersion: { from: k, to: k + 1 } } } });
      notes.unshift({ action: "issue.updated", createdAt: at(3 * k + 1), ...SYNC, details: { status: "blocked", source: "comment", changes: { statusVersion: { from: k + 1, to: k + 2 } } } });
      notes.unshift({ action: "issue.comment_added", createdAt: at(3 * k + 2), ...SYNC, details: { commentId: `c${k}`, bodySnippet: `Step ${k}.` } });
    }
    assert.strictEqual(decisionKind(notes, 1, ME.id), "note");
    assert.strictEqual(lastDecision(notes, ME.id).w, notes[2]);
    const keeps = [{ action: "issue.updated", createdAt: at(0), ...PERSON, details: { changes: { status: { from: "todo", to: "blocked" } } } }];
    for (let k = 1; k <= 8000; k++) keeps.unshift({ action: "issue.updated", createdAt: at(k), actorType: "agent", actorId: ME.id, details: { status: "blocked", changes: { statusVersion: { from: k, to: k + 1 } } } });
    assert.strictEqual(lastDecision(keeps, ME.id).w, keeps.at(-1), "the bot's restatements took the person's block");
    assert.strictEqual(personSince(keeps, markAt(keeps, 8000), ME.id), undefined);
  });

  // An escalation worked through the lifecycle: `answers` are the model's
  // replies in turn (a function gets the prompt and the board), `opts` the poller's.
  const T2 = () => task("t-2", { status: "todo", assigneeAgentId: "agent-po" });
  const worked = async ({ answers, opts = {}, extra = [], fetch } = {}) => {
    const b = escalationBoard();
    for (const t of extra) { b.issues.set(t.id, { createdAt: "2026-01-01T00:00:00Z", title: t.id, description: "", ...t }); b.activity.set(t.id, []); b.comments.set(t.id, []); b.runs.set(t.id, []); }
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const prompts = [], pings = [];
    const answer = async (p) => { prompts.push(p); const a = answers[prompts.length - 1]; return typeof a === "function" ? a(b, p) : a; };
    const o = { stateFile, escalateTo: parseEscalateTo("user:user-boss|Boss"), onEscalate: async (p) => pings.push(p), ...opts };
    await escalating(fetch ? { ...b, fetch: fetch(b) } : b, answer, fetch ? { ...o, fetch: fetch(b) } : o).tick();
    const t = b.issues.get("t-1");
    const said = b.writes.filter((w) => w.body.comment);
    return { b, prompts, pings, stateFile, answer, o, t, said, holder: t.assigneeAgentId ?? t.assigneeUserId };
  };
  const up = (s) => `${s}\n${OUTCOME_MARK} escalate`;
  // A→B→A: the title edited while the first attempt runs, and edited back while the second does.
  const titleTo = (b, title) => b.edit("t-1", PERSON, "title", title);
  const aba = (first, second, third) => [(b) => { titleTo(b, "Retry window B"); return first; }, (b) => { titleTo(b, "t-1"); return second; }, third];

  await check("table r: the latest attempt's outcome decides the write, the holder after, and who is told — as the doc's rows say", async () => {
    const R = {
      r1: async () => {
        const w = await worked({ answers: ["Ruled: 30 s."] });
        assert.strictEqual(w.holder, "agent-foreman");
        assert.deepStrictEqual(w.pings, []);
      },
      r2: async () => {
        // The post carries the earlier attempt's answer first; the person is asked the latest's question.
        const w = await worked({ answers: [(b) => { b.say("t-1", PERSON, "Refunds too?"); return up("Old question 1."); }, up("Need a call on refunds.")] });
        assert.strictEqual(w.holder, "user-boss");
        assert.match(w.said[0].body.comment, /^Old question 1\./);
        assert.deepStrictEqual(w.pings.map((p) => p.ask), ["Need a call on refunds."]);
      },
      r3: async () => {
        const w = await worked({ answers: [up("Need a call.")], opts: { escalateTo: parseEscalateTo("agent:Product Owner") } });
        assert.strictEqual(w.holder, "agent-po");
        assert.deepStrictEqual(w.pings, []);
      },
      r4: async () => {
        const w = await worked({ answers: [up("Need a call.")], opts: { escalateTo: null } });
        assert.strictEqual(w.holder, ME.id);
        assert.deepStrictEqual(w.said.map((x) => Object.keys(x.body)), [["comment"]]);
      },
      r5: async () => {
        const w = await worked({ answers: [`Cannot rule.\n${OUTCOME_MARK} blocked`] });
        assert.strictEqual(w.holder, ME.id);
        assert.strictEqual(w.t.status, "blocked");
        assert.deepStrictEqual(w.said.map((x) => Object.keys(x.body)), [["comment"]]);
      },
      r6: async () => {
        const w = await worked({ answers: [`Need T-2 first.\n${OUTCOME_MARK} blocked on T-2`], extra: [T2()] });
        assert.deepStrictEqual(w.said.map((x) => x.body), [{ comment: "Need T-2 first.", blockedByIssueIds: ["t-2"] }], "linked in the one write, the unblock step untouched");
        assert.strictEqual(w.holder, ME.id);
        assert.strictEqual(w.t.status, "blocked");
        // An unchanged re-wake while T-2 is open settles; T-2 done, the next wake resumes it.
        rewake(w.b, "r2");
        await escalating(w.b, w.answer, w.o).tick();
        assert.strictEqual(w.prompts.length, 1, "worked again before T-2 was done");
        w.b.issues.get("t-2").status = "done";
        rewake(w.b, "r3");
        w.b.writes.length = 0;
        await escalating(w.b, async (p) => { w.prompts.push(p); return "Ruled: 30 s."; }, w.o).tick();
        assert.strictEqual(w.prompts.length, 2, "not resumed when T-2 was done");
        assert.match(w.prompts[1], /This card waited on T-2; it is now done/);
        assert.deepStrictEqual(w.b.issues.get("t-1").blockedByIssueIds, [], "the done link was not cleared");
        assert.strictEqual(w.b.issues.get("t-1").assigneeAgentId, "agent-foreman", "the resumed answer did not route");
        assert.match(w.b.writes.find((x) => x.body.comment).body.comment, /^Resuming: T-2, which this card waited on, is done\.\n\nRuled/);
        // Resumed once: a later wake settles.
        rewake(w.b, "r4");
        w.b.issues.get("t-1").assigneeAgentId = ME.id;
        await escalating(w.b, async () => assert.fail("resumed twice"), w.o).tick();
      },
      r7: async () => {
        // Done at posting: T-2 finishes while the answer that waits on it is made.
        const w = await worked({ extra: [T2()], answers: [(b) => { b.issues.get("t-2").status = "done"; return `Need T-2 first.\n${OUTCOME_MARK} blocked on T-2`; }, "Ruled now that T-2 is in: 30 s."] });
        assert.strictEqual(w.prompts.length, 2, "did not go on");
        assert.match(w.prompts[1], /already done/);
        assert.strictEqual(w.holder, "agent-foreman", "the go-on's outcome did not route");
        assert.deepStrictEqual(w.said.map((x) => x.runId), ["r1"]);
        assert.match(w.said[0].body.comment, /Need T-2 first\.\n\nResuming: T-2, which this card waited on, is already done\.\n\nRuled now/);
        // Once per attempt: a go-on that is blocked on done tasks again is posted, not run a third time.
        const v = await worked({ extra: [T2({})], answers: [(b) => { b.issues.get("t-2").status = "done"; return `Need T-2.\n${OUTCOME_MARK} blocked on T-2`; }, `Still need T-2.\n${OUTCOME_MARK} blocked on T-2`] });
        assert.strictEqual(v.prompts.length, 2);
        assert.strictEqual(v.holder, ME.id);
      },
      r8: async () => {
        const w = await worked({ answers: [`Need NOPE-1.\n${OUTCOME_MARK} blocked on NOPE-1`] });
        assert.deepStrictEqual(w.said.map((x) => x.body), [{ comment: "Need NOPE-1." }]);
        assert.strictEqual(w.holder, ME.id);
      },
    };
    sameIds("r", R);
    for (const [id] of rowsOf("r")) {
      try { await R[id](); } catch (e) { e.message = `${id}: ${e.message}`; throw e; }
    }
  });

  await check("table p: every phase of the lifecycle keeps its guarantee — as the doc's rows say", async () => {
    const P = {
      p1: async () => {
        const statuses = [];
        const w = await worked({ answers: [(b) => { statuses.push(b.issues.get("t-1").status); return "Ruled."; }] });
        assert.deepStrictEqual(w.b.writes[0].body, KEEP_BLOCKED);
        assert.deepStrictEqual(statuses, ["blocked"]);
      },
      p2: async () => {
        // work, then settle on an unchanged re-wake; retry posts an owed answer without running it again.
        const w = await worked({ answers: [`Cannot rule.\n${OUTCOME_MARK} blocked`] });
        rewake(w.b, "r2");
        await escalating(w.b, async () => assert.fail("worked a settled card"), w.o).tick();
        assert.strictEqual(w.b.writes.filter((x) => x.body.comment).at(-1).body.comment, ESCALATION_KEPT);
        let fails = 1;
        const flaky = (b) => async (u, init) => (init?.method === "PATCH" && JSON.parse(init.body).comment && fails-- > 0 ? { ok: false, status: 502, text: async () => "bad gateway" } : b.fetch(u, init));
        const v = await worked({ answers: ["Ruled once."], fetch: flaky });
        assert.strictEqual(v.holder, ME.id, "handed on though the write failed");
        await escalating(v.b, async () => assert.fail("ran again to retry a post"), v.o).tick();
        assert.strictEqual(v.b.issues.get("t-1").assigneeAgentId, "agent-foreman");
      },
      p3: async () => {
        // Each attempt is numbered above every earlier one, an ask asked again (A→B→A) included:
        // the saved sequence, read as each attempt runs.
        const b = escalationBoard();
        const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
        const ans = aba("Ruled 1.", "Ruled 2.", "Ruled 3."), seen = [];
        await escalating(b, async (p) => {
          const st = JSON.parse(readFileSync(stateFile, "utf8"));
          seen.push(Math.max(...Object.values(st.attemptSeq)));
          const a = ans[seen.length - 1];
          return typeof a === "function" ? a(b, p) : a;
        }, { stateFile }).tick();
        assert.deepStrictEqual(seen, [1, 2, 3]);
      },
      p4: async () => {
        // Decided anew by a person: theirs, the answer posted with CARD_CHANGED.
        const w = await worked({ answers: [(b) => { b.setStatus("t-1", "todo", PERSON); return "Ruled."; }] });
        assert.strictEqual(w.holder, ME.id);
        assert.ok(w.said[0].body.comment.endsWith(CARD_CHANGED));
        // Under the Foreman's own key (round 4): a bare restatement during the run is a hold too.
        const v = await worked({ answers: [(b) => { b.record("t-1", FOREMAN, { status: "blocked", changes: { statusVersion: { from: 3, to: 4 } } }); return "Ruled."; }] });
        assert.strictEqual(v.holder, ME.id, "a same-identity hold was handed over");
        assert.ok(v.said[0].body.comment.endsWith(CARD_CHANGED));
        // Asked something newer: a new attempt under the same run.
        const x = await worked({ answers: [(b) => { titleTo(b, "Retry window B"); return "Ruled 1."; }, "Ruled 2."] });
        assert.strictEqual(x.prompts.length, 2);
        assert.match(x.prompts[1], /The card changed while you worked on it/);
      },
      p5: async () => {
        // A→B→A, mixed outcomes: A first escalates, B rules, A asked again stays blocked.
        // The latest attempt (A's third) routes; A's first answer is replaced, B's goes above.
        const w = await worked({ answers: aba(up("Need a call 1."), "Ruled 2.", `Blocked 3.\n${OUTCOME_MARK} blocked`) });
        assert.strictEqual(w.prompts.length, 3);
        assert.doesNotMatch(w.prompts[2], /Need a call 1/, "the re-asked attempt was told its own replaced answer");
        assert.match(w.prompts[2], /Ruled 2/);
        assert.deepStrictEqual(w.said.map((x) => x.body), [{ comment: "Ruled 2.\n\n---\n\nBlocked 3." }]);
        assert.strictEqual(w.holder, ME.id, "a stale outcome routed");
        assert.deepStrictEqual(w.pings, []);
        // The other way round: B escalates, A asked again resolves — handed down, nobody pinged.
        const v = await worked({ answers: aba("Ruled 1.", up("Need a call 2."), "Ruled 3.") });
        assert.strictEqual(v.holder, "agent-foreman");
        assert.deepStrictEqual(v.pings, []);
        // And A asked again escalates: the person is asked A's latest question.
        const x = await worked({ answers: aba(up("Need a call 1."), "Ruled 2.", up("Need a call 3.")) });
        assert.strictEqual(x.holder, "user-boss");
        assert.deepStrictEqual(x.pings.map((p) => p.ask), ["Need a call 3."]);
      },
      p6: async () => {
        // Restart: A→B→A answered, its hand-off refused with a 5xx; a new poller
        // on the same state routes the same way, the latest attempt deciding.
        let fails = 1;
        const flaky = (b) => async (u, init) => (init?.method === "PATCH" && "assigneeUserId" in JSON.parse(init.body) && fails-- > 0 ? { ok: false, status: 503, text: async () => "unavailable" } : b.fetch(u, init));
        const w = await worked({ answers: aba(up("Need a call 1."), "Ruled 2.", up("Need a call 3.")), fetch: flaky });
        assert.strictEqual(w.holder, ME.id, "handed on though the write failed");
        const saved = JSON.parse(readFileSync(w.stateFile, "utf8"));
        assert.strictEqual(Object.keys(saved.pendingReplies).length, 2);
        await escalating(w.b, async () => assert.fail("ran again on restart"), { ...w.o }).tick();
        assert.strictEqual(w.b.issues.get("t-1").assigneeUserId, "user-boss", "the restart routed a stale outcome");
        assert.deepStrictEqual(w.pings.map((p) => p.ask), ["Need a call 3."]);
        assert.match(w.b.writes.filter((x) => x.body.comment).at(-1).body.comment, /^Ruled 2\.\n\n---\n\nNeed a call 3\.$/);
      },
      p7: async () => {
        // A dependency done later resumes the card once, and clears its done link (r6 runs it whole).
        const w = await worked({ answers: [`Need T-2 first.\n${OUTCOME_MARK} blocked on T-2`], extra: [T2()] });
        const saved = JSON.parse(readFileSync(w.stateFile, "utf8"));
        assert.deepStrictEqual(Object.values(saved.linked), [["t-2"]], "the link was not recorded for a restart");
        w.b.issues.get("t-2").status = "done";
        rewake(w.b, "r2");
        // A restart in between: the link is read back from the state file.
        await escalating(w.b, async (p) => { w.prompts.push(p); return "Ruled."; }, w.o).tick();
        assert.strictEqual(w.prompts.length, 2);
        assert.deepStrictEqual(w.b.issues.get("t-1").blockedByIssueIds, []);
      },
    };
    sameIds("p", P);
    for (const [id] of rowsOf("p")) {
      try { await P[id](); } catch (e) { e.message = `${id}: ${e.message}`; throw e; }
    }
  });

  await check("table (c): what the card says now wins over what the bot read before — as the doc's rows say", async () => {
    const SEATED = [...SEATS, { id: "agent-x", name: "agent-po" }];
    const ordinary = (extra = {}) => board([task("t-1", { runs: run("r1"), ...extra }), task("t-2", { status: "todo", assigneeAgentId: "agent-po" }), task("t-3", { status: "todo", assigneeAgentId: "agent-po" })]);
    const ask = async (b, answers, opts = {}) => {
      const prompts = [];
      const answer = async (p) => { prompts.push(p); const a = answers[prompts.length - 1]; return typeof a === "function" ? a(b, p) : a; };
      await poller(b, answer, opts).tick();
      return prompts;
    };
    const commentOnly = (b) => b.writes.filter((x) => x.id === "t-1").every((x) => Object.keys(x.body).join() === "comment");
    const AWAY = { "another agent": { agentId: "agent-po" }, "a person": { userId: "user-1" }, "nobody": {} };
    const W = {
      w1: async () => {
        for (const [who, to] of Object.entries(AWAY)) {
          const b = ordinary();
          // Handed away as the bot reads the task, after the inbox listed it.
          let done = false;
          const read = async (u, init) => { if (!done && /\/issues\/t-1$/.test(u) && init?.method !== "PATCH") { done = true; b.reassign("t-1", PERSON, to); } return b.fetch(u, init); };
          const prompts = await ask({ ...b, fetch: read }, ["Did it."], { fetch: read });
          assert.deepStrictEqual(prompts, [], `${who}: worked a card handed away`);
          assert.deepStrictEqual(b.writes.map((x) => x.body), [{ comment: HANDED_AWAY }], who);
          const t = b.issues.get("t-1");
          assert.deepStrictEqual([t.assigneeAgentId, t.assigneeUserId ?? null], [to.agentId ?? null, to.userId ?? null], who);
        }
      },
      w2: async () => {
        for (const [why, a] of [["done", "Did it."], ["return", `Fix the path.\n${OUTCOME_MARK} return`], ["blocked", `Cannot yet.\n${OUTCOME_MARK} blocked`], ["blocked on an unknown task", `Need NOPE-1.\n${OUTCOME_MARK} blocked on NOPE-1`]]) {
          const b = ordinary({ createdByAgentId: "agent-po" });
          await ask(b, [(x) => { x.reassign("t-1", PERSON, {}); return a; }]);
          assert.ok(commentOnly(b), `${why}: wrote more than the answer`);
          const t = b.issues.get("t-1");
          assert.deepStrictEqual([t.status, t.assigneeAgentId, t.assigneeUserId], ["in_progress", null, null], why);
        }
      },
      w3: async () => {
        for (const [who, actor] of [["a person", PERSON], ["another agent", { actorType: "agent", actorId: "agent-po" }]]) {
          for (const a of ["Did it.", `Fix the path.\n${OUTCOME_MARK} return`]) {
            const b = ordinary({ createdByAgentId: "agent-po" });
            await ask(b, [(x) => { x.reassign("t-1", actor, { agentId: "agent-tl" }); x.reassign("t-1", actor, { agentId: ME.id }); return a; }]);
            assert.ok(commentOnly(b), `${who}: closed or returned on a hand-off the card no longer shows`);
            assert.strictEqual(b.issues.get("t-1").status, "in_progress", who);
          }
        }
      },
      w4: async () => {
        // A non-mirrored escalation linked to T-2 and T-3; they finish one at a
        // time, a wake-less tick trimming the done one between; then a restart or not.
        for (const [first, second] of [["t-2", "t-3"], ["t-3", "t-2"]]) for (const restart of [false, true]) {
          const b = ordinary({ labels: [{ name: "Needs EM ruling" }] });
          b.setStatus("t-1", "blocked", PERSON);
          b.issues.get("t-1").status = "in_progress";
          const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
          const prompts = [];
          const answer = async (p) => { prompts.push(p); return prompts.length === 1 ? `Need both.\n${OUTCOME_MARK} blocked on T-2, T-3` : "Ruled."; };
          const o = { stateFile, externalWriter: /^source: \S+#\d+$/, escalationAuthority: "scope and mechanism" };
          let p = poller(b, answer, o);
          await p.tick();
          assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2", "t-3"]);
          b.setStatus(first, "done", PERSON);
          await p.tick();
          if (restart) p = poller(b, answer, o);
          b.setStatus(second, "done", PERSON);
          rewake(b, "r2");
          await p.tick();
          assert.strictEqual(prompts.length, 2, `${first} then ${second}${restart ? ", restarted" : ""}: not resumed`);
          assert.match(prompts[1], /waited on/);
          rewake(b, "r3");
          b.issues.get("t-1").assigneeAgentId = ME.id;
          await poller(b, async () => assert.fail("resumed twice"), o).tick();
        }
      },
      w5: async () => {
        // The link write lands; its response is lost (502). A restart reads the links back.
        let fails = 1;
        const lost = (b) => async (u, init) => {
          const r = await b.fetch(u, init);
          return init?.method === "PATCH" && JSON.parse(init.body).blockedByIssueIds && fails-- > 0 ? { ok: false, status: 502, text: async () => "bad gateway" } : r;
        };
        const w = await worked({ answers: [`Need T-2 first.\n${OUTCOME_MARK} blocked on T-2`], extra: [T2()], fetch: lost });
        assert.deepStrictEqual(w.t.blockedByIssueIds, ["t-2"]);
        await escalating(w.b, async () => assert.fail("ran again on restart"), w.o).tick();
        w.b.issues.get("t-2").status = "done";
        rewake(w.b, "r2");
        await escalating(w.b, async (p) => { w.prompts.push(p); return "Ruled."; }, w.o).tick();
        assert.strictEqual(w.prompts.length, 2, "the link written before the restart never resumed the card");
        assert.match(w.prompts[1], /This card waited on T-2; it is now done/);
      },
      w6: async () => {
        // An ordinary card's ask A→B→A across wakes: A, re-exposed, is worked as new.
        const b = ordinary();
        const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
        const prompts = [];
        const answer = async (p) => { prompts.push(p); return `Cannot yet ${prompts.length}.\n${OUTCOME_MARK} blocked`; };
        await poller(b, answer, { stateFile }).tick();
        for (const [title, r] of [["Retry window B", "r2"], ["t-1", "r3"]]) {
          titleTo(b, title);
          rewake(b, r);
          await poller(b, answer, { stateFile }).tick();
        }
        assert.strictEqual(prompts.length, 3, "the reverted ask was skipped as answered");
      },
      w7: async () => {
        for (const ref of ["agent:agent-po", "agent:Product Owner"]) {
          const w = await worked({ answers: [up("Need a call.")], opts: { escalateTo: parseEscalateTo(ref) }, fetch: (b) => { b.state.seats = [SEATED[2], ...SEATS]; return b.fetch; } });
          assert.strictEqual(w.holder, "agent-po", ref);
        }
      },
      w8: async () => {
        // Taken away mid-answer, or after the answer and before its go-on runs.
        for (const late of [false, true]) {
          let armed = false;
          const away = (b) => async (u, init) => {
            // The last read before a go-on is whether its run is still live.
            if (armed && init?.method !== "PATCH" && /\/issues\/t-1\/runs$/.test(u)) { armed = false; b.reassign("t-1", PERSON, { agentId: "agent-po" }); }
            return b.fetch(u, init);
          };
          const w = await worked({ extra: [T2()], fetch: away, answers: [(b) => {
            b.issues.get("t-2").status = "done";
            if (late) armed = true; else b.reassign("t-1", PERSON, { agentId: "agent-po" });
            return `Need T-2 first.\n${OUTCOME_MARK} blocked on T-2`;
          }, "Went on."] });
          assert.strictEqual(w.prompts.length, 1, `${late ? "after" : "mid"}-answer: went on with a card taken away`);
          assert.strictEqual(w.holder, "agent-po");
          assert.deepStrictEqual(w.said.map((x) => x.body), [{ comment: "Need T-2 first." }]);
        }
      },
      w9: async () => {
        const changes = {
          unassigned: (b) => b.reassign("t-1", PERSON, {}),
          cycled: (b) => { b.reassign("t-1", PERSON, { agentId: "agent-tl" }); b.reassign("t-1", PERSON, { agentId: ME.id }); },
          moved: (b) => b.setStatus("t-1", "todo", PERSON),
          "re-waited": (b) => b.relink("t-1", PERSON, ["t-2"]),
          retitled: (b) => titleTo(b, "Retry window B"),
          "asked anew": (b) => b.say("t-1", PERSON, "And refunds?"),
          unlabelled: (b) => { b.issues.get("t-1").labels = []; b.record("t-1", PERSON, { changes: { labelIds: { from: ["l1"], to: [] } } }); },
        };
        for (const [what, f] of Object.entries(changes)) {
          // The change lands as the seats are listed for the answer's hand-on.
          let armed = false;
          const listing = (b) => async (u, init) => { if (armed && /\/companies\/co-1\/agents$/.test(u)) { armed = false; f(b); } return b.fetch(u, init); };
          const w = await worked({ extra: [T2()], answers: [() => { armed = true; return up("Need a call."); }, "Ruled."], opts: { escalateTo: parseEscalateTo("agent:Product Owner") }, fetch: listing });
          assert.ok(!w.b.writes.some((x) => x.body.assigneeAgentId === "agent-po"), `${what}: handed on from reads made before the change`);
        }
      },
      w10: async () => {
        // The change lands just after the bot's last read before its write —
        // replayed from a clean run's requests, so it is the last read whatever
        // the order — on an ordinary card's return and an escalation's hand-on.
        const ways = {
          return: (fetch) => { const b = ordinary({ createdByAgentId: "agent-po" }); const f = fetch(b); return ask({ ...b, fetch: f }, [`Fix the path.\n${OUTCOME_MARK} return`], { fetch: f }).then(() => b); },
          "hand-on": (fetch) => worked({ answers: [up("Need a call."), "Ruled."], opts: { escalateTo: parseEscalateTo("agent:Product Owner") }, fetch }).then((w) => w.b),
        };
        const AWAY_NOW = { "taken away": (b) => b.reassign("t-1", PERSON, {}), cycled: (b) => { b.reassign("t-1", PERSON, { agentId: "agent-tl" }); b.reassign("t-1", PERSON, { agentId: ME.id }); } };
        for (const [way, go] of Object.entries(ways)) {
          const gets = [];
          let at = -1;
          await go((b) => async (u, init) => { if (init?.method !== "PATCH") gets.push(u); else if (at < 0 && "assigneeAgentId" in JSON.parse(init.body)) at = gets.length - 1; return b.fetch(u, init); });
          assert.ok(at > 0, `${way}: no hand-off to replay`);
          for (const [what, f] of Object.entries(AWAY_NOW)) {
            let n = 0;
            const b = await go((x) => async (u, init) => { const r = await x.fetch(u, init); if (init?.method !== "PATCH" && n++ === at) f(x); return r; });
            assert.ok(!b.writes.some((x) => x.body.assigneeAgentId === "agent-po"), `${way}, ${what}: handed over a change made after the last read (${gets[at]})`);
            assert.ok(!b.writes.some((x) => x.body.status && x.body.status !== "blocked"), `${way}, ${what}: status written`);
          }
        }
      },
      w11: async () => {
        // The Foreman's note longer than a snippet, word for word its step: read
        // whole from the thread it is the note, not a hold, so the work runs.
        const LONG = `Blocked at review: ${"the two specs disagree on the retry window, and ".repeat(4)}nobody has ruled.`;
        assert.ok(LONG.length > 120);
        const b = board([task("t-1", { description: "source: acme/app#12\nstage review", assigneeAgentId: "agent-foreman", runs: run("r1") })]);
        b.setStatus("t-1", "blocked", SYNC, {}, { assigneeAgentId: { from: "agent-foreman", to: ME.id }, unblockDescriptor: { from: null, to: { owner: { agentId: ME.id }, action: LONG } } });
        b.issues.get("t-1").assigneeAgentId = ME.id;
        restate(b, SYNC, LONG);
        b.issues.get("t-1").status = "in_progress";
        const prompts = await ask(b, ["Ruled."], { externalWriter: /^source: \S+#\d+$/ });
        assert.strictEqual(prompts.length, 1, "the Foreman's own long note was read as a hold");
      },
    };
    sameIds("w", W);
    for (const [id] of rowsOf("w")) {
      try { await W[id](); } catch (e) { e.message = `${id}: ${e.message}`; throw e; }
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
