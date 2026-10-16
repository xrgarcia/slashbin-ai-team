/**
 * Paperclip — a task's card stays true after the work moves on: a block the
 * bot set itself, or one Paperclip set when it lost a run, is brought up to
 * date; a decision someone else made is left alone.
 */
const assert = require("assert");
const { mkdtempSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, statusSetter, reconcilable, outcomeOf, OUTCOME_MARK, TRANSPORT_NOTE, INTERRUPTED_NOTE, FALLBACK_REPLY, HELD_NOTE, PERSON_STANDS, decidedStatus, ESCALATION_LABELS, parseEscalateTo, paperclipBoards, UNBLOCK_ACTION } = require("../lib/paperclip");
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
        activity.get(i.id).unshift({ action: "issue.comment_added", createdAt: c.createdAt, actorType: "agent", actorId: ME.id, runId, details: { commentId: c.id } });
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
  // The newest entry recorded in the same millisecond as the one before it.
  const tie = (id) => { const [a, b] = activity.get(id); a.createdAt = b.createdAt; };
  return { fetch, writes, tries, wakes, state, issues, runs, comments, setStatus, reassert, rehold, relink, tie, now,
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

  await check("case 6: a task another writer owns gets the comment, never a status", async () => {
    const mirror = /^source: \S+#\d+$/;
    const b = board([task("t-1", { description: "source: acme/app#12\nstage review", runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    await poller(b, async () => { b.recover("t-1", "r1"); await new Promise((r) => setTimeout(r, 30)); return `x\n${OUTCOME_MARK} blocked on T-2`; },
      { externalWriter: mirror, watchMs: 5 }).tick();
    assert.ok(b.writes.length >= 1);
    assert.ok(b.writes.every((x) => !x.body.status && !x.body.blockedByIssueIds && !x.body.unblockDescriptor), JSON.stringify(b.writes));
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

  await check("a mirrored task answered blocked is not run again on an unchanged wake, until a status move recorded after the answer", async () => {
    const mirror = /^source: \S+#\d+$/;
    const b = board([task("t-1", { description: "source: acme/app#12\nstage review", runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const answer = async () => { n++; return `Need the spec.\n${OUTCOME_MARK} blocked`; };
    await poller(b, answer, { stateFile, externalWriter: mirror }).tick();
    assert.strictEqual(n, 1);
    for (const r of ["r2", "r3"]) {
      b.runs.set("t-1", run(r));
      await poller(b, answer, { stateFile, externalWriter: mirror }).tick();
    }
    assert.strictEqual(n, 1, "an unchanged mirrored ask was run again");
    assert.strictEqual(b.writes.filter((x) => x.body.comment?.startsWith("Need the spec.")).length, 1, "its answer was posted again");
    // Its writer moves the card back after the answer: that is a reopening.
    b.setStatus("t-1", "todo", PERSON);
    b.setStatus("t-1", "in_progress", PERSON);
    b.runs.set("t-1", run("r4"));
    await poller(b, answer, { stateFile, externalWriter: mirror }).tick();
    assert.strictEqual(n, 2, "a recorded reopening did not bring the ask back");
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
      { name: "an ask finished while its run was cancelled, posted with a newer ask's blocked answer: still finished",
        replies: [(b) => { b.runs.get("t-1").find((r) => r.id === "r1").status = "cancelled"; return "Did it."; }, blockedOn("T-2")],
        steps: [["wake", "r1"], ["ask", "And this?"], ["wake", "r2"], ["unask"], ["done", "t-2"], ["wake", "r3"]], ran: 2 },
      { name: "a person moves the card on between the bot's reads of it: the answer is a comment, their status stands",
        read: { of: "t-1", nth: 1, f: (b) => b.setStatus("t-1", "in_review", PERSON) },
        replies: ["Did it."], steps: [["wake", "r1"]], ran: 1, status: "in_review",
        check: (b) => assert.ok(b.writes.some((x) => x.body.comment === "Did it." && !x.body.status)) },
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
      const b = board([task("t-1", { runs: [], ...row.start }), ...["t-2", "t-3", "t-4"].map((t) => task(t, { assigneeAgentId: null, status: "todo" }))]);
      if (row.race?.before) b.state.beforeWrite = (i) => row.race.before(b, i);
      if (row.race?.after) b.state.afterWrite = (i) => row.race.after(b, i);
      if (row.read) b.state.afterRead = { ...row.read, f: (i) => row.read.f(b, i) };
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      const prompts = [];
      const answer = async (p) => { const r = row.replies[prompts.length]; prompts.push(p); return typeof r === "function" ? r(b) : r ?? assert.fail("ran again"); };
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
      { assigneeAgentId: "agent-foreman", assigneeUserId: null, comment: "Ruled on acme/app#12: 30 s retry window." }]);
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

  await check("escalation: a blocked card without the label is still refused, and its note is not repeated on a re-wake (SLA-1335)", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const b = board([task("t-1", { labels: [{ name: "Something else" }], runs: run("r1") })]);
    b.setStatus("t-1", "blocked", PERSON);
    b.issues.get("t-1").status = "in_progress";
    await escalating(b, async () => assert.fail("worked a blocked card with no escalation label"), { stateFile }).tick();
    assert.deepStrictEqual(b.writes.map((w) => w.body), [{ comment: HELD_NOTE }]);
    for (const id of ["r2", "r3"]) {
      rewake(b, id);
      await escalating(b, async () => assert.fail("worked a held card on a re-wake"), { stateFile }).tick();
    }
    assert.strictEqual(b.writes.filter((w) => w.body.comment === HELD_NOTE).length, 1, JSON.stringify(b.writes));
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
    assert.ok(b.writes.slice(after).every((w) => !w.body.comment), JSON.stringify(b.writes.slice(after)));
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
    assert.deepStrictEqual(hand.body, { assigneeAgentId: "agent-po", assigneeUserId: null,
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
        if (url.endsWith("/issues/t-1/activity")) return { ok: true, text: async () => JSON.stringify([{ action: "issue.updated", ...actor, details: { changes: { assigneeAgentId: { from: ME.id, to: "agent-po" } } } }]) };
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
