/**
 * Paperclip — the poller re-reads the card before it acts on it
 * (docs/board-decisions.md (d)). Before the model runs, and before every
 * routing write (a return, a transfer, an unlink), the card is read again;
 * a change to it since the snapshot the work was built on stops the act. A
 * wait resumes only when every task it waits on reads done on a fresh read,
 * and an ask is deduplicated only against that task's own latest answered
 * ask. Each case names the review row it closes (R<n>) and injects the change
 * between the snapshot and the effect through the fake board's HTTP client.
 *
 * The fake board is the one in paperclip-reconcile.test.js.
 */
const assert = require("assert");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, OUTCOME_MARK, UNBLOCK_ACTION, revisitNote } = require("../lib/paperclip");

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

// ---- What the cases share ----

/**
 * A fetch that runs `f` once, just after the `nth` request `match` accepts
 * has been answered: the response is read whole first, so it shows the board
 * as it was before `f`.
 */
const frozen = async (r) => { const body = await r.text(); return { ok: r.ok, status: r.status, text: async () => body }; };
const after = (b, match, f, nth = 1) => async (url, init = {}) => {
  const r = await frozen(await b.fetch(url, init));
  if (nth > 0 && match(url.replace(/^.*\/api/, ""), init) && --nth === 0) f(b);
  return r;
};
const GET = (path) => (p, init) => p === path && (init.method ?? "GET") === "GET";
const PATCHES = (field) => (p, init) => init.method === "PATCH" && field in JSON.parse(init.body);
// How a re-wake on an ask answered as waiting opens its prompt (revisitNote).
const REWOKEN = new RegExp(`^${revisitNote().slice(0, 24)}`);
const AGENT_PO = { actorType: "agent", actorId: "agent-po" };
const FOREMAN = { actorType: "user", actorId: "user-sync" };
const mirror = /^source: \S+#\d+$/;
const stateFileOf = () => join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
const holderOf = (t) => t.assigneeAgentId ?? t.assigneeUserId ?? null;
const handOffs = (b) => b.writes.filter((w) => "assigneeAgentId" in w.body || "assigneeUserId" in w.body);
const unlabel = (b) => { const i = b.issues.get("t-1"); b.record("t-1", PERSON, { changes: { labels: { from: i.labels, to: [] } } }); i.labels = []; };
const humanWait = (b) => b.rehold("t-1", PERSON, ["t-3"], { owner: { userId: PERSON.actorId }, action: "Waits on legal." });
const extra = (b, ...ts) => { for (const t of ts) { b.issues.set(t.id, { createdAt: "2026-01-01T00:00:00Z", title: t.id, description: "", ...t }); b.activity.set(t.id, []); b.comments.set(t.id, []); b.runs.set(t.id, t.runs ?? []); } };
const other = (id) => task(id, { status: "todo", assigneeAgentId: "agent-po" });

/** The model: `answers` in turn (a function gets the board), every prompt kept. */
const model = (b, answers) => {
  const prompts = [];
  const answer = async (p) => { prompts.push(p); const a = answers[prompts.length - 1]; if (a === undefined) assert.fail(`ran ${prompts.length} times`); return typeof a === "function" ? a(b, p) : a; };
  return { prompts, answer };
};

/** An ordinary card: handed to the bot by the Product Owner, a person's ask on it. */
const ordinary = (more = {}) => {
  const b = board([task("t-1", { title: "Make publishing reliable", runs: run("r1"), ...more, assigneeAgentId: "agent-po" }), other("t-2"), other("t-3")]);
  b.reassign("t-1", AGENT_PO, { agentId: ME.id });
  b.say("t-1", PERSON, "Please make the publish reliable.");
  return b;
};
/** An escalation: the Foreman's sync blocks a card, labels it, hands it to the bot; the wake checks it out. */
const escalation = ({ mirrored = true } = {}) => {
  const b = board([task("t-1", { title: "Retry window", description: mirrored ? "source: acme/app#12\nstage review" : "stage review", labels: [{ name: "Needs EM ruling" }], runs: run("r1") }), other("t-2"), other("t-3")]);
  b.setStatus("t-1", "blocked", FOREMAN, {}, { assigneeAgentId: { from: "agent-foreman", to: ME.id } });
  b.comments.get("t-1").push({ id: "f1", authorAgentId: null, authorUserId: "user-sync", createdAt: b.now(), body: "Two specs disagree on the retry window; needs a ruling." });
  b.issues.get("t-1").status = "in_progress";
  return b;
};
const ESC = { externalWriter: mirror, escalationAuthority: "scope and mechanism" };
/** A new wake: a new run, and Paperclip's checkout of the statuses it takes, unrecorded. */
const wake = (b, id) => {
  b.runs.set("t-1", run(id));
  const t = b.issues.get("t-1");
  if (["todo", "backlog", "blocked"].includes(t.status)) t.status = "in_progress";
};

(async () => {
  // ---- Required 1: the card is re-read just before the model runs ----

  // Each change lands after the snapshot the run is built on and before the
  // model would run. A change that ends the bot's part (taken away,
  // cancelled) never runs; a revision is worked on the next look, from the
  // card as it reads then.
  const ENDS = {
    unassigned: (b) => b.reassign("t-1", PERSON, {}),
    "handed to another seat": (b) => b.reassign("t-1", PERSON, { agentId: "agent-po" }),
    cancelled: (b) => b.setStatus("t-1", "cancelled", PERSON),
  };
  const REVISES = {
    "a new question": { make: (b) => b.say("t-1", PERSON, "And refunds too?"), seen: /And refunds too\?/ },
    "the title changed": { make: (b) => b.edit("t-1", PERSON, "title", "Retry window, revised"), seen: /Retry window, revised/ },
  };
  const ROWS_1 = [
    // During the first comments read, after the task's own read.
    ["R75", "ordinary", "comments", "unassigned"], ["R76", "ordinary", "comments", "cancelled"],
    ["R77", "ordinary", "comments", "a new question"], ["R78", "ordinary", "comments", "the title changed"],
    ["R79", "escalation", "comments", "unassigned"], ["R80", "escalation", "comments", "cancelled"],
    ["R81", "escalation", "comments", "a new question"], ["R82", "escalation", "comments", "the title changed"],
    // During the seat lookup an escalation's prompt makes.
    ["R4", "escalation", "seats", "unassigned"], ["R15", "escalation", "seats", "handed to another seat"],
    ["R17", "escalation", "seats", "cancelled"], ["R19", "escalation", "seats", "the title changed"],
    ["R20", "escalation", "seats", "a new question"],
  ];
  for (const [row, kind, when, change] of ROWS_1) {
    await check(`${row}: ${kind}, ${change} during the ${when === "seats" ? "prompt's seat lookup" : "first comments read"}: never run on the card as it was`, async () => {
      const b = kind === "ordinary" ? ordinary() : escalation();
      const make = ENDS[change] ?? REVISES[change].make;
      const match = when === "seats" ? GET(`/companies/${ME.companyId}/agents`) : GET("/issues/t-1/comments");
      const fetch = after(b, match, make);
      const { prompts, answer } = model(b, ["Done.", "Done."]);
      const opts = { stateFile: stateFileOf(), fetch, ...(kind === "escalation" ? ESC : {}) };
      await poller(b, answer, opts).tick();
      assert.strictEqual(prompts.length, 0, `${row}: ran on the card as it was`);
      // Nothing the bot decided is written over the change (an escalation's
      // checkout undo, which comes before the run, is the only write).
      assert.ok(b.writes.every((w) => !("assigneeAgentId" in w.body) && !("assigneeUserId" in w.body) && !w.body.comment), `${row}: ${JSON.stringify(b.writes)}`);
      await poller(b, answer, opts).tick();
      const t = b.issues.get("t-1");
      if (ENDS[change]) {
        assert.strictEqual(prompts.length, 0, `${row}: ran after ${change}`);
        if (change === "cancelled") assert.strictEqual(t.status, "cancelled", row);
        else assert.strictEqual(holderOf(t), change === "unassigned" ? null : "agent-po", row);
      } else {
        // The next look works the revision: the first run there is already sees it.
        assert.strictEqual(prompts.length, 1, `${row}: ran ${prompts.length} times`);
        assert.match(prompts[0], REVISES[change].seen, `${row}: the run did not see the revision`);
      }
    });
  }

  // R16, R18, R21: a person re-decides an escalation during the prompt's seat
  // lookup — moved to todo, the label taken off, a wait of their own added.
  // Nothing runs on the escalation as it was; their decision stands.
  for (const [row, what, make, stands] of [
    ["R16", "moved to todo", (b) => b.setStatus("t-1", "todo", PERSON), (t) => t.status === "todo"],
    ["R18", "its label removed", unlabel, (t) => (t.labels ?? []).length === 0],
    ["R21", "a person's wait added", humanWait, (t) => t.status === "blocked" && t.unblockDescriptor?.owner?.userId === PERSON.actorId && t.blockedByIssueIds.join() === "t-3"],
  ]) {
    await check(`${row}: an escalation ${what} during the prompt's seat lookup: not run as the escalation it was`, async () => {
      const b = escalation();
      const fetch = after(b, GET(`/companies/${ME.companyId}/agents`), make);
      const { prompts, answer } = model(b, ["Ruled."]);
      await poller(b, answer, { stateFile: stateFileOf(), fetch, ...ESC }).tick();
      assert.strictEqual(prompts.length, 0, `${row}: ran on the card as it was`);
      assert.deepStrictEqual(handOffs(b), [], row);
      assert.ok(stands(b.issues.get("t-1")), `${row}: ${JSON.stringify(b.issues.get("t-1"))}`);
    });
  }

  // R2, R14: after the run list is read, another agent cancels the card and
  // assigns it to the bot (R14: the run is cancelled with it). Cancellation
  // never authorizes work.
  for (const [row, runToo] of [["R2", false], ["R14", true]]) {
    await check(`${row}: cancelled and assigned to the bot after the run list was read${runToo ? ", its run cancelled too" : ""}: nothing runs, the card stays cancelled`, async () => {
      const b = board([task("t-1", { title: "Make publishing reliable", assigneeAgentId: "agent-po", runs: run("r1") })]);
      b.issues.get("t-1").assigneeAgentId = ME.id;
      b.say("t-1", PERSON, "Please make the publish reliable.");
      // One write, as Paperclip records a status and a holder set together.
      const fetch = after(b, GET("/issues/t-1/runs"), () => {
        if (runToo) b.runs.get("t-1")[0].status = "cancelled";
        b.setStatus("t-1", "cancelled", AGENT_PO, {}, { assigneeAgentId: { from: "agent-po", to: ME.id } });
      });
      const { prompts, answer } = model(b, ["Done."]);
      const p = poller(b, answer, { stateFile: stateFileOf(), fetch });
      await p.tick(); await p.tick();
      assert.strictEqual(prompts.length, 0, `${row}: ran a cancelled card`);
      assert.strictEqual(b.issues.get("t-1").status, "cancelled", row);
      assert.ok(b.writes.every((w) => !w.body.status), `${row}: ${JSON.stringify(b.writes)}`);
    });
  }

  // ---- Required 2: the card is re-read just before every routing write ----

  // A resumed escalation: answered `blocked on T-2`, T-2 done, re-woken and
  // answered "Ruled." — the bot unlinks the done wait, then hands the card
  // down to the Foreman. Each change lands just after the unlink is written.
  const resumed = async (change) => {
    const b = escalation();
    const stateFile = stateFileOf();
    const { prompts, answer } = model(b, [`Need T-2 first.\n${OUTCOME_MARK} blocked on T-2`, "Ruled: 30 s.", "Ruled again: 30 s."]);
    await poller(b, answer, { stateFile, ...ESC }).tick();
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2"], "the wait was not linked");
    b.setStatus("t-2", "done", PERSON);
    wake(b, "r2");
    const before = b.writes.length;
    // How many runs there had been when the change landed: a hand-on with no
    // run after it carries the answer from before the change.
    let ranBefore = null;
    const fetch = after(b, (p, init) => p === "/issues/t-1" && PATCHES("blockedByIssueIds")(p, init) && !JSON.parse(init.body).comment, (x) => { ranBefore = prompts.length; change(x); });
    await poller(b, answer, { stateFile, fetch, ...ESC }).tick();
    assert.ok(b.writes.slice(before).some((w) => w.body.blockedByIssueIds && !w.body.comment), "the case never reached its unlink");
    const handedOn = handOffs(b).filter((w) => w.body.assigneeAgentId === "agent-foreman");
    return { b, prompts, ranBefore, t: b.issues.get("t-1"), stale: prompts.length === ranBefore ? handedOn : [] };
  };
  // Kept by the bot, or handed on only after a run that was given the revision.
  const revised = ({ t, prompts, ranBefore }, seen) => assert.ok(holderOf(t) === ME.id
    || (prompts.length > ranBefore && seen.test(prompts.at(-1))), `not worked on the revision before it went on: ${prompts.length} runs`);
  const UNLINK_ROWS = [
    ["R7", "unassigned", (b) => b.reassign("t-1", PERSON, {}), ({ t }) => assert.strictEqual(holderOf(t), null)],
    ["R22", "handed to another seat", (b) => b.reassign("t-1", PERSON, { agentId: "agent-po" }), ({ t }) => assert.strictEqual(holderOf(t), "agent-po")],
    ["R23", "cancelled", (b) => b.setStatus("t-1", "cancelled", PERSON), ({ t }) => { assert.strictEqual(t.status, "cancelled"); assert.strictEqual(holderOf(t), ME.id); }],
    ["R9", "moved to todo", (b) => b.setStatus("t-1", "todo", PERSON), ({ t }) => { assert.strictEqual(t.status, "todo"); assert.strictEqual(holderOf(t), ME.id); }],
    ["R10", "its label removed", unlabel, ({ t }) => assert.strictEqual(holderOf(t), ME.id)],
    ["R12", "a person's wait on open T-3", humanWait, ({ t }) => {
      assert.strictEqual(holderOf(t), ME.id);
      assert.deepStrictEqual(t.blockedByIssueIds, ["t-3"]);
      assert.deepStrictEqual(t.unblockDescriptor?.owner, { userId: PERSON.actorId });
    }],
    // A new hand-in: the old one's answer is not handed on under it.
    ["R25", "handed away and back", (b) => { b.reassign("t-1", PERSON, { agentId: "agent-po" }); b.reassign("t-1", PERSON, { agentId: ME.id }); }, ({ t, prompts, ranBefore }) => assert.ok(holderOf(t) === ME.id || prompts.length > ranBefore)],
    // A revision: worked before the card goes on, or the card kept for it.
    ["R8", "a new question", (b) => b.say("t-1", PERSON, "And refunds too?"), (r) => revised(r, /And refunds too\?/)],
    ["R11", "the title revised", (b) => b.edit("t-1", PERSON, "title", "Retry window, revised"), (r) => revised(r, /Retry window, revised/)],
    ["R24", "the description revised", (b) => b.edit("t-1", PERSON, "description", "source: acme/app#12\nstage review\nRefunds too."), (r) => revised(r, /Refunds too\./)],
  ];
  for (const [row, what, change, stands] of UNLINK_ROWS) {
    await check(`${row}: a resumed escalation ${what} as its done wait is unlinked: the stale answer is not handed on`, async () => {
      const r = await resumed(change);
      assert.deepStrictEqual(r.stale, [], `${row}: handed on with the answer from before the change: ${JSON.stringify(r.b.writes)}`);
      stands(r);
    });
  }

  // R72, R73: an ordinary `return`. The change lands after each read the bot
  // makes before its return write but the last: every one is seen, and the
  // person's decision stands. (A change inside the last read's round trip is
  // the residual: Paperclip has no compare-and-set.)
  const RETURNED = `Only the Product Owner can change its own routine.\n${OUTCOME_MARK} return`;
  const returnReads = async () => {
    const b = ordinary();
    const reads = [];
    const fetch = async (url, init = {}) => {
      const p = url.replace(/^.*\/api/, "");
      if ((init.method ?? "GET") === "GET" && p.startsWith("/issues/t-1")) reads.push(p);
      if (init.method === "PATCH" && PATCHES("assigneeAgentId")(p, init)) reads.push("PATCH");
      return b.fetch(url, init);
    };
    await poller(b, model(b, [RETURNED]).answer, { stateFile: stateFileOf(), fetch }).tick();
    assert.strictEqual(holderOf(b.issues.get("t-1")), "agent-po", "the clean return did not hand back");
    return reads.slice(0, reads.indexOf("PATCH"));
  };
  for (const [row, what, change, stands] of [
    ["R72", "unassigned", (b) => b.reassign("t-1", PERSON, {}), (t) => holderOf(t) === null],
    ["R73", "handed away and back", (b) => { b.reassign("t-1", PERSON, { agentId: "agent-po" }); b.reassign("t-1", PERSON, { agentId: ME.id }); }, (t) => holderOf(t) === ME.id],
  ]) {
    await check(`${row}: an ordinary card ${what} after any read before its return but the last: the return is not written over it`, async () => {
      const reads = await returnReads();
      // From the card's own read on: a change before it is in the snapshot.
      const first = reads.indexOf("/issues/t-1") + 1;
      assert.ok(first > 0 && reads.length > first, JSON.stringify(reads));
      for (let k = first; k < reads.length; k++) {
        const b = ordinary();
        let n = 0;
        const fetch = async (url, init = {}) => {
          const r = await frozen(await b.fetch(url, init));
          const p = url.replace(/^.*\/api/, "");
          if ((init.method ?? "GET") === "GET" && p.startsWith("/issues/t-1") && ++n === k) change(b);
          return r;
        };
        await poller(b, model(b, [RETURNED, RETURNED]).answer, { stateFile: stateFileOf(), fetch }).tick();
        const t = b.issues.get("t-1");
        assert.ok(stands(t), `${row}: after read ${k} (${reads[k - 1]}): ${JSON.stringify(b.writes)}`);
        assert.ok(!handOffs(b).some((w) => w.body.assigneeAgentId === "agent-po"), `${row}: returned over the change after read ${k} (${reads[k - 1]})`);
      }
    });
  }

  await check("a routing write sends only the fields it changes: no clearing of a holder the card does not have", async () => {
    const b = ordinary();
    await poller(b, model(b, [RETURNED]).answer, { stateFile: stateFileOf() }).tick();
    const [w] = handOffs(b);
    assert.ok(w && !("assigneeUserId" in w.body), JSON.stringify(b.writes));
  });

  // ---- Required 3: a wait resumes only when every task it waits on is done, read fresh ----

  // An ordinary card waits on T-2 and T-3. T-2 finishes and a wake-less look
  // trims it from the card; T-2 reopens; T-3 finishes. R83 without a restart,
  // R85 with one before the last wake.
  for (const [row, restart] of [["R83", false], ["R85", true]]) {
    await check(`${row}: an ordinary card's trimmed wait reopens${restart ? ", restart before the last wake" : ""}: no resume while it is open`, async () => {
      const b = ordinary();
      const stateFile = stateFileOf();
      const { prompts, answer } = model(b, [`Need both.\n${OUTCOME_MARK} blocked on T-2, T-3`, "Finished."]);
      let p = poller(b, answer, { stateFile });
      await p.tick();
      assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2", "t-3"]);
      b.setStatus("t-2", "done", PERSON);
      await p.tick();
      b.setStatus("t-2", "todo", PERSON);
      b.setStatus("t-3", "done", PERSON);
      if (restart) p = poller(b, answer, { stateFile });
      wake(b, "r2");
      await p.tick();
      assert.strictEqual(prompts.length, 1, `${row}: resumed with T-2 open`);
      b.setStatus("t-2", "done", PERSON);
      wake(b, "r3");
      await p.tick();
      assert.strictEqual(prompts.length, 2, `${row}: not resumed once both were done`);
    });
  }

  // An escalation waits on T-2 and T-3 (R5, R26: mirrored, its waits kept by
  // the bot; R84, R86: not mirrored, linked on the card and trimmed). T-2
  // finishes, then reopens; T-3 finishes.
  for (const [row, mirrored, restart] of [["R5", true, false], ["R26", true, true], ["R84", false, false], ["R86", false, true]]) {
    await check(`${row}: a${mirrored ? " mirrored" : "n unmirrored"} escalation's wait reopens${restart ? ", restart before the last wake" : ""}: it keeps waiting`, async () => {
      const b = escalation({ mirrored });
      const stateFile = stateFileOf();
      const { prompts, answer } = model(b, [`Need both.\n${OUTCOME_MARK} blocked on T-2, T-3`, "Ruled."]);
      let p = poller(b, answer, { stateFile, ...ESC });
      await p.tick();
      b.setStatus("t-2", "done", PERSON);
      await p.tick();
      b.setStatus("t-2", "todo", PERSON);
      b.setStatus("t-3", "done", PERSON);
      if (restart) p = poller(b, answer, { stateFile, ...ESC });
      wake(b, "r2");
      await p.tick();
      assert.strictEqual(prompts.length, 1, `${row}: resumed with T-2 open`);
      assert.deepStrictEqual(handOffs(b), [], `${row}: handed on with T-2 open`);
      b.setStatus("t-2", "done", PERSON);
      wake(b, "r3");
      await p.tick();
      assert.strictEqual(prompts.length, 2, `${row}: not resumed once both were done`);
    });
  }

  // ---- Required 4: an ask is deduplicated only against the task's own latest answered ask ----

  // R1, R13: an ordinary card goes back to the Product Owner — returned by
  // the bot, or answered and then handed over — and is handed back to the
  // bot unchanged. A new hand-off is a new ask: it is run again, as the new
  // ask it is (R13 across a restart). A wake with nothing new is not.
  const BACK = {
    "returned": { answers: [RETURNED, "Done this time."], away: () => {} },
    "answered and handed over": { answers: ["Did it.", "Done this time."], away: (b) => b.reassign("t-1", PERSON, { agentId: "agent-po" }) },
  };
  for (const [row, restart] of [["R1", false], ["R13", true]]) for (const [how, { answers, away }] of Object.entries(BACK)) {
    await check(`${row}: an ordinary card ${how}, handed back unchanged${restart ? " across a restart" : ""}: run again`, async () => {
      const b = ordinary();
      const stateFile = stateFileOf();
      const { prompts, answer } = model(b, answers);
      let p = poller(b, answer, { stateFile });
      await p.tick();
      away(b);
      assert.strictEqual(holderOf(b.issues.get("t-1")), "agent-po");
      if (restart) p = poller(b, answer, { stateFile });
      b.reassign("t-1", AGENT_PO, { agentId: ME.id });
      b.setStatus("t-1", "todo", AGENT_PO);
      wake(b, "r2");
      await p.tick();
      assert.strictEqual(prompts.length, 2, `${row}: the hand-back was taken for the ask already answered: ${JSON.stringify(b.writes.map((w) => w.body.comment))}`);
      // Run as the new ask it is, not as a re-wake on the ask it returned.
      assert.doesNotMatch(prompts[1], REWOKEN, `${row}: the hand-back was run as a re-wake on the returned ask`);
      // Re-woken with nothing new: not run a third time.
      wake(b, "r3");
      await p.tick();
      assert.strictEqual(prompts.length, 2, `${row}: an unchanged wake ran it again`);
    });
  }

  // R6, R29: asked A, then B; 500 (R6) or 501 (R29) other tasks answered;
  // restart; the ask reverted to A. A is not this task's latest answered ask,
  // so it is run again — however many asks other tasks had meanwhile.
  for (const [row, others] of [["R6", 500], ["R29", 501]]) {
    await check(`${row}: A, then B, ${others} other tasks, a restart, back to A: A is run again`, async () => {
      const b = ordinary({ title: "A" });
      const stateFile = stateFileOf();
      const prompts = [];
      const answer = async (p) => { prompts.push(p); return "Done."; };
      const own = () => prompts.filter((x) => /\bT-1\b/.test(x)).length;
      let p = poller(b, answer, { stateFile });
      await p.tick();
      b.edit("t-1", PERSON, "title", "B");
      b.setStatus("t-1", "todo", PERSON);
      wake(b, "r2");
      await p.tick();
      assert.strictEqual(own(), 2, `${row}: B was not run`);
      const ids = Array.from({ length: others }, (_, n) => `o-${n}`);
      extra(b, ...ids.map((id) => task(id, { runs: run(`ro-${id}`), title: `Other ${id}` })));
      for (let n = 0; n < 50 && ids.some((id) => b.issues.get(id).status !== "done"); n++) await p.tick();
      assert.ok(ids.every((id) => b.issues.get(id).status === "done"), `${row}: the other tasks were not all answered`);
      p = poller(b, answer, { stateFile });
      b.edit("t-1", PERSON, "title", "A");
      b.setStatus("t-1", "todo", PERSON);
      wake(b, "r3");
      await p.tick();
      assert.strictEqual(own(), 3, `${row}: reverted to A, not run`);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
