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

  // ---- Round 7: the snapshot is the whole card, whoever changed it ----

  // The card a run is built on, as compared just before the run: its status,
  // holder, labels, title, description and newest comment. A change by
  // Paperclip itself, or by this bot's own seat outside the run, is a change.
  const BOT_SEAT = { actorType: "agent", actorId: ME.id };
  const systemNotice = (b) => {
    const c = { id: "s1", authorType: "system", authorAgentId: null, authorUserId: null, createdAt: b.now(), body: "Run recovered by the board." };
    b.comments.get("t-1").push(c);
    b.activity.get("t-1").unshift({ action: "issue.comment_added", createdAt: c.createdAt, actorType: "system", actorId: "execution-recovery", details: { commentId: c.id } });
  };
  const neverRan = (b, prompts, row) => {
    assert.strictEqual(prompts.length, 0, `${row}: ran on the card as it was`);
    assert.ok(!b.writes.some((w) => w.body.status === "done" || w.body.comment), `${row}: answered over the change: ${JSON.stringify(b.writes)}`);
    assert.deepStrictEqual(handOffs(b), [], `${row}: handed on over the change`);
  };
  for (const [row, kind, at, change, what] of [
    // Paperclip's recovery blocks the card and fails its run after the first comments read.
    ["R1", "ordinary", GET("/issues/t-1/comments"), (b) => b.recover("t-1", "r1"), "recovered after the first comments read"],
    // The same recovery inside the re-read itself: after its read of the task, before its read of the record.
    ["R55", "ordinary", GET("/issues/t-1"), (b) => b.recover("t-1", "r1"), "recovered during the re-read before the run"],
    // On an escalation, after the prompt's seat lookup, the last read before the run.
    ["R6", "escalation", GET(`/companies/${ME.companyId}/agents`), (b) => b.recover("t-1", "r1"), "recovered after the prompt's seat lookup"],
    ["R2", "ordinary", GET("/issues/t-1/comments"), (b) => b.say("t-1", BOT_SEAT, "A note from this bot's seat."), "commented on by this bot's own seat after the first comments read"],
    ["R7", "escalation", GET(`/companies/${ME.companyId}/agents`), (b) => b.say("t-1", BOT_SEAT, "A note from this bot's seat."), "commented on by this bot's own seat before the run"],
    ["R7", "escalation", GET(`/companies/${ME.companyId}/agents`), systemNotice, "given a notice by the board before the run"],
  ]) {
    await check(`${row}: ${kind}, ${what}: nothing runs and nothing is answered`, async () => {
      const b = kind === "ordinary" ? ordinary() : escalation();
      const fetch = after(b, at, change, row === "R55" ? 2 : 1);
      const { prompts, answer } = model(b, ["Done.", "Done."]);
      await poller(b, answer, { stateFile: stateFileOf(), fetch, ...(kind === "escalation" ? ESC : {}) }).tick();
      neverRan(b, prompts, row);
      if (change !== systemNotice && !what.includes("own seat")) assert.strictEqual(b.issues.get("t-1").status, "blocked", `${row}: the recovery's block was not left`);
    });
  }

  // R3, R9: a wait-less look trims a done wait off a card that waits on T-2 and
  // T-3. A title (R3) or description (R9) edit after the look reads the card
  // stops the trim: the links and the unblock step stay as they were.
  const waitingOnBoth = async () => {
    const b = ordinary();
    const stateFile = stateFileOf();
    await poller(b, model(b, [`Need both.\n${OUTCOME_MARK} blocked on T-2, T-3`]).answer, { stateFile }).tick();
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2", "t-3"]);
    b.setStatus("t-2", "done", PERSON);
    return { b, stateFile, step: b.issues.get("t-1").unblockDescriptor };
  };
  await check("R3, R9 control: unchanged, the wait-less look trims the done wait", async () => {
    const { b, stateFile } = await waitingOnBoth();
    await poller(b, model(b, []).answer, { stateFile }).tick();
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-3"]);
  });
  for (const [row, field] of [["R3", "title"], ["R9", "description"]]) {
    await check(`${row}: the ${field} edited after a wait-less look reads the card: its waits are not trimmed`, async () => {
      const { b, stateFile, step } = await waitingOnBoth();
      const before = b.writes.length;
      const fetch = after(b, GET("/issues/t-1"), (x) => x.edit("t-1", PERSON, field, `${field}, revised`));
      await poller(b, model(b, []).answer, { stateFile, fetch }).tick();
      const t = b.issues.get("t-1");
      assert.deepStrictEqual(t.blockedByIssueIds, ["t-2", "t-3"], `${row}: unlinked over the edit`);
      assert.deepStrictEqual(t.unblockDescriptor, step, `${row}: the unblock step was rewritten over the edit`);
      assert.ok(!b.writes.slice(before).some((w) => "blockedByIssueIds" in w.body || "unblockDescriptor" in w.body), `${row}: ${JSON.stringify(b.writes.slice(before))}`);
    });
  }

  // R4: an escalation waits on T-2 and on T-404, a task the board does not
  // have. T-2 finishing is not every wait done. R5: it waits on open T-2 and
  // on T-3, done when it answered; T-3 reopens, then T-2 finishes. Each with
  // and without a restart before the wake.
  for (const [row, waits, before, restart] of [
    ["R4", "T-2, T-404", () => {}, false], ["R4", "T-2, T-404", () => {}, true],
    ["R5", "T-2, T-3", (b) => b.setStatus("t-3", "done", PERSON), false], ["R5", "T-2, T-3", (b) => b.setStatus("t-3", "done", PERSON), true],
  ]) for (const mirrored of [false, true]) {
    await check(`${row}: a${mirrored ? " mirrored" : "n unmirrored"} escalation blocked on ${waits}${restart ? ", restart before the wake" : ""}: no resume or hand-on until every one reads done`, async () => {
      const b = escalation({ mirrored });
      before(b);
      const stateFile = stateFileOf();
      const { prompts, answer } = model(b, [`Need ${waits}.\n${OUTCOME_MARK} blocked on ${waits}`, "Ruled."]);
      let p = poller(b, answer, { stateFile, ...ESC });
      await p.tick();
      if (row === "R5") b.setStatus("t-3", "todo", PERSON);
      b.setStatus("t-2", "done", PERSON);
      if (restart) p = poller(b, answer, { stateFile, ...ESC });
      wake(b, "r2");
      await p.tick();
      assert.strictEqual(prompts.length, 1, `${row}: resumed with a wait not done`);
      assert.deepStrictEqual(handOffs(b), [], `${row}: handed on with a wait not done`);
      if (row === "R5") {
        // Control: once both read done, it resumes.
        b.setStatus("t-3", "done", PERSON);
        wake(b, "r3");
        await p.tick();
        assert.strictEqual(prompts.length, 2, `${row}: not resumed once both were done`);
      }
    });
  }

  // R8: a person adds a label to an escalation while it is worked, keeping
  // the escalation label. The answer was built on the labels before it: it
  // is not handed on unless a run on the card as it is now came after.
  await check("R8: a label added while an escalation is worked: the answer built before it is not handed on", async () => {
    const b = escalation();
    const addLabel = (x) => {
      const i = x.issues.get("t-1");
      const to = [...i.labels, { name: "Customer waiting" }];
      x.record("t-1", PERSON, { changes: { labels: { from: i.labels, to } } });
      i.labels = to;
    };
    const { prompts, answer } = model(b, [(x) => { addLabel(x); return "Ruled: 30 s."; }, "Ruled again: 30 s."]);
    await poller(b, answer, { stateFile: stateFileOf(), ...ESC }).tick();
    const on = handOffs(b).filter((w) => w.body.assigneeAgentId === "agent-foreman");
    assert.ok(on.length === 0 || (prompts.length === 2 && on.every((w) => /Ruled again/.test(w.body.comment ?? ""))),
      `handed on with the answer from before the label: ${prompts.length} runs, ${JSON.stringify(on)}`);
  });

  // ---- Round 8: only this attempt's own runs speak for it; the record is read last ----

  // Each request the poller makes, in order, up to its first answer() call.
  const requestsBeforeAnswer = async (make, answers, opts = {}) => {
    const b = make();
    const seen = [];
    let answered = false;
    const fetch = async (url, init = {}) => { if (!answered) seen.push(`${init.method ?? "GET"} ${url.replace(/^.*\/api/, "")}`); return b.fetch(url, init); };
    const { answer } = model(b, answers.map((a) => (x, p) => { answered = true; return typeof a === "function" ? a(x, p) : a; }));
    await poller(b, answer, { stateFile: stateFileOf(), fetch, ...opts }).tick();
    return seen;
  };
  // How many times `req` was made before answer() in a clean run: the last one is the preflight's.
  const countOf = (seen, req) => seen.filter((r) => r === req).length;
  const savedState = (file) => JSON.parse(require("fs").readFileSync(file, "utf8"));
  const unexecuted = (stateFile, row) => {
    const s = savedState(stateFile);
    assert.deepStrictEqual(s.pendingReplies, {}, `${row}: the attempt was not rolled back: ${JSON.stringify(s.pendingReplies)}`);
    assert.deepStrictEqual(s.answeredAsks, [], `${row}: the ask was recorded answered`);
  };
  // Another run of this same seat (not the attempt's): r0.
  const OTHER_RUN = { runId: "r0" };

  // R1, R2, R19: after the first comments read, another run of this bot's own
  // seat moves T-1 out of in_progress. A write by the seat is not the
  // attempt's own: only one under the attempt's runs is. Nothing runs, the
  // checkpoint is put back, and the status that run wrote stands.
  for (const [row, to] of [["R1", "blocked"], ["R2", "todo"], ["R19", "blocked"]]) {
    await check(`${row}: another run of this seat moves T-1 to ${to} after the first comments read: nothing runs, the checkpoint is restored, ${to} stands`, async () => {
      if (row === "R19") {
        // A board and no DISCORD_TOKEN or BOT_SURFACES: Paperclip-only, the board its one surface.
        const { botSurfaces } = require("../lib/surfaces");
        const s = botSurfaces({}, 1);
        assert.ok(s.paperclip && !s.discord, `${row}: not Paperclip-only: ${JSON.stringify(s)}`);
      }
      const b = ordinary();
      const stateFile = stateFileOf();
      const fetch = after(b, GET("/issues/t-1/comments"), (x) => x.setStatus("t-1", to, BOT_SEAT, OTHER_RUN));
      const { prompts, answer } = model(b, ["Done.", "Done."]);
      await poller(b, answer, { stateFile, fetch }).tick();
      neverRan(b, prompts, row);
      unexecuted(stateFile, row);
      assert.strictEqual(b.issues.get("t-1").status, to, `${row}: ${to} was written over`);
    });
  }
  await check("R1 control: the attempt's own status write (under its run) is not a change", async () => {
    const b = escalation();
    const { prompts, answer } = model(b, ["Ruled: 30 s."]);
    await poller(b, answer, { stateFile: stateFileOf(), ...ESC }).tick();
    assert.strictEqual(prompts.length, 1, "the escalation's own keep-blocked write stopped its run");
    assert.ok(b.activity.get("t-1").some((a) => a.runId === "r1" && a.details?.changes?.status?.to === "blocked"), "the case never wrote its own block");
  });

  // R4, R5: a comment lands after the preflight reads the comments and
  // before it reads the record: the record, read last, shows it, whoever
  // posted it — this bot's seat under another run, or the board.
  for (const [row, what, make] of [
    ["R4", "a comment from another run of this seat", (x) => { const c = x.say("t-1", BOT_SEAT, "A note from another run."); c.createdByRunId = "r0"; x.activity.get("t-1")[0].runId = "r0"; }],
    ["R5", "a system notice", systemNotice],
  ]) for (const kind of ["ordinary", "escalation"]) {
    await check(`${row}: ${kind}, ${what} between the preflight's comments read and its record read: nothing runs or completes`, async () => {
      const make0 = () => (kind === "ordinary" ? ordinary() : escalation());
      const opts = kind === "escalation" ? ESC : {};
      const n = countOf(await requestsBeforeAnswer(make0, ["Done."], opts), "GET /issues/t-1/comments");
      const b = make0();
      const stateFile = stateFileOf();
      const fetch = after(b, GET("/issues/t-1/comments"), make, n);
      const { prompts, answer } = model(b, ["Done.", "Done."]);
      await poller(b, answer, { stateFile, fetch, ...opts }).tick();
      neverRan(b, prompts, row);
      unexecuted(stateFile, row);
      assert.notStrictEqual(b.issues.get("t-1").status, "done", `${row}: completed over the comment`);
    });
  }

  // R3: an escalation's answer is saved, the bot stops before routing it,
  // and a label is added (the escalation label kept). The restarted bot
  // checks the saved answer against the card that produced it, not against
  // the card it first reads: the old ruling is not handed on.
  await check("R3: a saved escalation answer, a restart before routing, a label added: the old ruling is not handed on", async () => {
    const b = escalation();
    const stateFile = stateFileOf();
    let dead = false;
    const dying = async (url, init) => { if (dead) throw new Error("the bot stopped"); return b.fetch(url, init); };
    const { prompts, answer } = model(b, [() => { dead = true; return "Ruled: 30 s."; }, "Ruled again: 30 s."]);
    await poller(b, answer, { stateFile, fetch: dying, ...ESC }).tick();
    assert.strictEqual(prompts.length, 1);
    assert.ok(Object.values(savedState(stateFile).pendingReplies).includes("Ruled: 30 s."), "the answer was not saved before the stop");
    assert.ok(Object.keys(savedState(stateFile).builtOn ?? {}).length, "the card the answer was made from was not saved with it");
    const i = b.issues.get("t-1");
    const to = [...i.labels, { name: "Customer waiting" }];
    b.record("t-1", PERSON, { changes: { labels: { from: i.labels, to } } });
    i.labels = to;
    wake(b, "r2");
    await poller(b, answer, { stateFile, ...ESC }).tick();
    const on = handOffs(b).filter((w) => w.body.assigneeAgentId === "agent-foreman");
    assert.ok(on.every((w) => !/Ruled: 30 s\./.test(w.body.comment ?? "")), `the old ruling was handed on: ${JSON.stringify(on)}`);
    assert.ok(on.length === 0 || (prompts.length === 2 && on.every((w) => /Ruled again/.test(w.body.comment ?? ""))), `${prompts.length} runs, ${JSON.stringify(on)}`);
  });
  await check("R3 control: a saved escalation answer, a restart, nothing changed: it is handed on without another run", async () => {
    const b = escalation();
    const stateFile = stateFileOf();
    let dead = false;
    const dying = async (url, init) => { if (dead) throw new Error("the bot stopped"); return b.fetch(url, init); };
    const { prompts, answer } = model(b, [() => { dead = true; return "Ruled: 30 s."; }]);
    await poller(b, answer, { stateFile, fetch: dying, ...ESC }).tick();
    wake(b, "r2");
    await poller(b, answer, { stateFile, ...ESC }).tick();
    assert.strictEqual(prompts.length, 1);
    assert.ok(handOffs(b).some((w) => w.body.assigneeAgentId === "agent-foreman" && /Ruled: 30 s\./.test(w.body.comment ?? "")), JSON.stringify(b.writes));
  });

  // R6: an ordinary card already links T-2; its answer blocks on T-3. A
  // person edits the title during the T-3 lookup, the last call before the
  // write: the card is read again after it, and the T-2 link stands.
  const linkedToT2 = () => {
    const b = ordinary();
    b.issues.get("t-1").blockedByIssueIds = ["t-2"];
    return b;
  };
  const ON_T3 = `Needs T-3.\n${OUTCOME_MARK} blocked on T-3`;
  await check("R6 control: unchanged, the blocked answer links T-3", async () => {
    const b = linkedToT2();
    await poller(b, model(b, [ON_T3]).answer, { stateFile: stateFileOf() }).tick();
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-3"]);
  });
  await check("R6: the title edited during the dependency lookup before the write: the rewrite stops, the T-2 link stands", async () => {
    const b0 = linkedToT2();
    const reads = [];
    const spy = async (url, init = {}) => { const p = url.replace(/^.*\/api/, ""); if ((init.method ?? "GET") === "GET" && p === "/issues/T-3") reads.push(p); return b0.fetch(url, init); };
    await poller(b0, model(b0, [ON_T3]).answer, { stateFile: stateFileOf(), fetch: spy }).tick();
    assert.ok(reads.length > 0, "the case never looked T-3 up");
    const b = linkedToT2();
    const fetch = after(b, GET("/issues/T-3"), (x) => x.edit("t-1", PERSON, "title", "Make publishing reliable, revised"), reads.length);
    await poller(b, model(b, [ON_T3, ON_T3]).answer, { stateFile: stateFileOf(), fetch }).tick();
    const t = b.issues.get("t-1");
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-2"], `the T-2 link was replaced: ${JSON.stringify(b.writes)}`);
    assert.ok(!b.writes.some((w) => "blockedByIssueIds" in w.body), JSON.stringify(b.writes));
  });

  // ---- Round 9: routing is checked against the card the answer was made from ----

  // An ordinary card waits on T-2, its unblock step written; its answer blocks
  // on T-3. Whatever lands while answer() runs is a change to the card the
  // answer was made from (builtOn): no read taken after the answer came back
  // stands in for it. The answer is said as a comment only; status, links and
  // unblock step stay as the change left them.
  const STEP_T2 = { owner: { agentId: ME.id }, action: "Waits on T-2." };
  const onT2 = () => {
    const b = ordinary();
    Object.assign(b.issues.get("t-1"), { blockedByIssueIds: ["t-2"], unblockDescriptor: STEP_T2 });
    return b;
  };
  const addLabel = (name) => (x) => {
    const i = x.issues.get("t-1");
    const to = [...(i.labels ?? []), { name }];
    x.record("t-1", PERSON, { changes: { labels: { from: i.labels ?? [], to } } });
    i.labels = to;
  };
  const seatComment = (x) => { const c = x.say("t-1", BOT_SEAT, "A note from another run."); c.createdByRunId = "r0"; x.activity.get("t-1")[0].runId = "r0"; };
  const ROUTES = (w) => ["status", "blockedByIssueIds", "unblockDescriptor", "assigneeAgentId", "assigneeUserId", "reviewers", "executionPolicy"].some((k) => k in w.body);
  // Nothing routed: the answer said as a comment, the card as `status`, still on T-2 with its step.
  const keptOnT2 = (b, row, status) => {
    const t = b.issues.get("t-1");
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-2"], `${row}: the T-2 wait was replaced: ${JSON.stringify(b.writes)}`);
    assert.deepStrictEqual(t.unblockDescriptor, STEP_T2, `${row}: the unblock step was rewritten`);
    if (status) assert.strictEqual(t.status, status, `${row}: the status was written over`);
    assert.ok(!b.writes.some(ROUTES), `${row}: a stale routing write: ${JSON.stringify(b.writes)}`);
    assert.ok(b.writes.some((w) => /Needs T-3\./.test(w.body.comment ?? "")), `${row}: the answer was not said: ${JSON.stringify(b.writes)}`);
  };
  await check("R5 control: an unchanged card still routes the blocked answer to T-3", async () => {
    const b = onT2();
    await poller(b, model(b, [ON_T3]).answer, { stateFile: stateFileOf() }).tick();
    const t = b.issues.get("t-1");
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-3"], JSON.stringify(b.writes));
    assert.strictEqual(t.status, "blocked");
  });
  for (const [row, what, change, status] of [
    ["R1", "another run of this seat moves it to todo", (x) => x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN), "todo"],
    ["R2", "another run of this seat blocks it", (x) => x.setStatus("t-1", "blocked", BOT_SEAT, OTHER_RUN), "blocked"],
    ["R3", "a label is added", addLabel("Customer waiting"), "in_progress"],
    ["R4", "another run of this seat comments", seatComment, "in_progress"],
    ["R5", "the board posts a notice", systemNotice, "in_progress"],
    ["R6", "another label is added", addLabel("Priority"), "in_progress"],
    ["R7", "another run of this seat comments, the step written", seatComment, "in_progress"],
    ["R8", "a board notice changes the newest comment", systemNotice, "in_progress"],
    ["R9", "another run of this seat moves it from in_progress to todo", (x) => x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN), "todo"],
    ["R10", "another run of this seat moves it from in_progress to blocked", (x) => x.setStatus("t-1", "blocked", BOT_SEAT, OTHER_RUN), "blocked"],
  ]) {
    await check(`${row}: ${what} while the blocked-on-T-3 answer is made: nothing routed, T-2 and its step stand`, async () => {
      const b = onT2();
      const { prompts, answer } = model(b, [(x) => { change(x); return ON_T3; }, ON_T3]);
      await poller(b, answer, { stateFile: stateFileOf() }).tick();
      assert.strictEqual(prompts.length, 1, `${row}: ran ${prompts.length} times`);
      keptOnT2(b, row, status);
    });
  }
  // R30: the walkthrough itself — one answer, no routing PATCH at all.
  await check("R30: walkthrough, another run of this seat moves T-1 to todo during answer(): one answer, no routing PATCH, todo on T-2", async () => {
    const b = onT2();
    const patches = [];
    const fetch = async (url, init = {}) => { if (init.method === "PATCH") patches.push(JSON.parse(init.body)); return b.fetch(url, init); };
    const { prompts, answer } = model(b, [(x) => { x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN); return ON_T3; }]);
    await poller(b, answer, { stateFile: stateFileOf(), fetch }).tick();
    assert.strictEqual(prompts.length, 1);
    assert.ok(patches.every((p) => !ROUTES({ body: p })), `a routing PATCH went out: ${JSON.stringify(patches)}`);
    keptOnT2(b, "R30", "todo");
  });
  // R16: a label added while an answer ending `review` is made: no review routing.
  await check("R16: a label added while a review answer is made: no in_review write, no reviewer named", async () => {
    const b = ordinary();
    const { answer } = model(b, [(x) => { addLabel("Customer waiting")(x); return `Done, please check.\n${OUTCOME_MARK} review`; }]);
    await poller(b, answer, { stateFile: stateFileOf() }).tick();
    assert.notStrictEqual(b.issues.get("t-1").status, "in_review", JSON.stringify(b.writes));
    assert.ok(!b.writes.some(ROUTES), `review routed over the label: ${JSON.stringify(b.writes)}`);
    assert.ok(b.writes.some((w) => /Done, please check\./.test(w.body.comment ?? "")), "the answer was not said");
  });
  await check("R16 control: unchanged, the review answer goes to review", async () => {
    const b = ordinary();
    await poller(b, model(b, [`Done, please check.\n${OUTCOME_MARK} review`]).answer, { stateFile: stateFileOf() }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "in_review", JSON.stringify(b.writes));
  });

  // R11-R14: the answer is saved, the bot stops before routing it, the card
  // changes, and a restarted bot replays the saved answer: it is checked
  // against the card it was made from (builtOn, with that read's record
  // mark), so a change before the restarted run's own checkout is still seen.
  const savedThenStopped = async (b, first) => {
    const stateFile = stateFileOf();
    let dead = false;
    const dying = async (url, init) => { if (dead) throw new Error("the bot stopped"); return b.fetch(url, init); };
    const { prompts, answer } = model(b, [() => { dead = true; return first; }, first]);
    await poller(b, answer, { stateFile, fetch: dying }).tick();
    assert.strictEqual(prompts.length, 1);
    assert.ok(Object.values(savedState(stateFile).pendingReplies).includes(first), "the answer was not saved before the stop");
    assert.ok(Object.values(savedState(stateFile).builtOn ?? {}).every((v) => v.mark), "the card's record mark was not saved with the answer");
    return { stateFile, prompts, answer };
  };
  for (const [row, what, change] of [
    ["R11", "a label added", addLabel("Customer waiting")],
    ["R12", "another run of this seat comments", seatComment],
    ["R13", "another run of this seat moves it to todo, and the restart's checkout shows in_progress", (x) => x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN)],
  ]) {
    await check(`${row}: a saved blocked-on-T-3 answer, ${what} before a restart: the replay routes nothing, T-2 stands`, async () => {
      const b = onT2();
      const { stateFile, answer } = await savedThenStopped(b, ON_T3);
      change(b);
      wake(b, "r2");
      await poller(b, answer, { stateFile }).tick();
      keptOnT2(b, row);
    });
  }
  await check("R11 control: a saved blocked-on-T-3 answer, nothing changed, a restart: it routes to T-3 without another run", async () => {
    const b = onT2();
    const { stateFile, prompts, answer } = await savedThenStopped(b, ON_T3);
    wake(b, "r2");
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(prompts.length, 1);
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-3"], JSON.stringify(b.writes));
  });
  await check("R14: a saved return, another run of this seat moves the card to todo, a restart under r2: nothing is handed back", async () => {
    const b = ordinary();
    const { stateFile, answer } = await savedThenStopped(b, RETURNED);
    b.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN);
    wake(b, "r2");
    await poller(b, answer, { stateFile }).tick();
    assert.deepStrictEqual(handOffs(b), [], `returned over the later decision: ${JSON.stringify(b.writes)}`);
    assert.strictEqual(holderOf(b.issues.get("t-1")), ME.id);
    assert.ok(!b.writes.some((w) => w.body.status === "blocked"), JSON.stringify(b.writes));
  });

  // R15: a saved escalation answer with no builtOn (saved before it was kept),
  // a label added, a restart: no record of its card, so it is not handed on
  // unless it is made again from the card as it is.
  await check("R15: a legacy saved escalation answer without builtOn, a label added, a restart: the old ruling is not handed on", async () => {
    const b = escalation();
    const stateFile = stateFileOf();
    let dead = false;
    const dying = async (url, init) => { if (dead) throw new Error("the bot stopped"); return b.fetch(url, init); };
    const { prompts, answer } = model(b, [() => { dead = true; return "Ruled: 30 s."; }, "Ruled again: 30 s."]);
    await poller(b, answer, { stateFile, fetch: dying, ...ESC }).tick();
    const s = savedState(stateFile);
    delete s.builtOn;
    require("fs").writeFileSync(stateFile, JSON.stringify(s));
    addLabel("Customer waiting")(b);
    wake(b, "r2");
    await poller(b, answer, { stateFile, ...ESC }).tick();
    const on = handOffs(b).filter((w) => w.body.assigneeAgentId === "agent-foreman");
    assert.ok(on.every((w) => !/Ruled: 30 s\./.test(w.body.comment ?? "")), `the old ruling was handed on: ${JSON.stringify(on)}`);
    assert.ok(on.length === 0 || (prompts.length === 2 && on.every((w) => /Ruled again/.test(w.body.comment ?? ""))), `${prompts.length} runs, ${JSON.stringify(on)}`);
  });

  // ---- Round 10: every routing write takes the snapshot that produced it ----

  // A quiet re-wake's acknowledgement routes from the card as the wake read it
  // at its start (handleTask), with that read's record mark and the wake's own
  // runs, never from a read taken inside reply(). Anything recorded since by
  // anyone else stops the routing: the note goes as a comment only, and the
  // run completes on it without another model run.
  const ON_T2 = `Needs T-2.\n${OUTCOME_MARK} blocked on T-2`;
  // T-1 answered blocked on T-2, then woken again under r2 (the checkout unrecorded).
  const answeredOnT2 = async () => {
    const b = ordinary();
    const stateFile = stateFileOf();
    const m = model(b, [ON_T2]);
    await poller(b, m.answer, { stateFile }).tick();
    const t = b.issues.get("t-1");
    assert.strictEqual(t.status, "blocked", `the first answer did not block: ${JSON.stringify(b.writes)}`);
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-2"]);
    const step = structuredClone(t.unblockDescriptor);
    wake(b, "r2");
    return { b, stateFile, m, step, since: b.writes.length };
  };
  // The acknowledgement under r2 is a comment only: no routing write, the card as the change left it.
  const quietKept = (r, row, { status, waits = ["t-2"] }) => {
    const t = r.b.issues.get("t-1"), mine = r.b.writes.slice(r.since);
    assert.strictEqual(r.m.prompts.length, 1, `${row}: the model ran again`);
    assert.ok(!mine.some(ROUTES), `${row}: a stale routing write: ${JSON.stringify(mine)}`);
    assert.strictEqual(t.status, status, `${row}: the status was written over: ${JSON.stringify(mine)}`);
    assert.deepStrictEqual(t.blockedByIssueIds, waits, `${row}: the waits were rewritten`);
    assert.deepStrictEqual(t.unblockDescriptor, r.step, `${row}: the unblock step was rewritten`);
    assert.ok(mine.some((w) => w.runId === "r2" && w.body.comment), `${row}: r2 did not complete on a comment of its own: ${JSON.stringify(mine)}`);
  };
  // The second read of T-1 on the quiet wake is reply()'s boardNow; the first, the wake's own.
  const afterBoardNow = (b, f) => after(b, GET("/issues/t-1"), f, 2);
  await check("R1 control: a quiet re-wake on an unchanged card puts the T-2 block back, with no model run", async () => {
    const r = await answeredOnT2();
    await poller(r.b, r.m.answer, { stateFile: r.stateFile }).tick();
    const t = r.b.issues.get("t-1");
    assert.strictEqual(r.m.prompts.length, 1);
    assert.strictEqual(t.status, "blocked", JSON.stringify(r.b.writes.slice(r.since)));
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-2"]);
    assert.ok(r.b.writes.slice(r.since).some((w) => w.runId === "r2" && w.body.comment));
  });
  for (const [row, what, make, status, waits] of [
    ["R1", "another run of this seat moves T-1 to todo just after boardNow's card response", afterBoardNow, (x) => x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN), "todo"],
    ["R32", "the walkthrough: another run's todo lands after reply() reads the card", afterBoardNow, (x) => x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN), "todo"],
    ["R4", "a label is added just after boardNow's card response", afterBoardNow, addLabel("Customer waiting"), "in_progress"],
    ["R5", "another run of this seat comments just after boardNow's card response", afterBoardNow, seatComment, "in_progress"],
    ["R8", "another run of this seat relinks T-1 to T-3 after the wake's comments read", (b, f) => after(b, GET("/issues/t-1/comments"), f, 1),
      (x) => x.relink("t-1", { ...BOT_SEAT, ...OTHER_RUN }, ["t-3"]), "in_progress", ["t-3"]],
  ].map(([row, what, at, change, status, waits]) => [row, what, (b) => at(b, change), status, waits])) {
    await check(`${row}: quiet re-wake, ${what}: the acknowledgement is a comment only, the change stands`, async () => {
      const r = await answeredOnT2();
      await poller(r.b, r.m.answer, { stateFile: r.stateFile, fetch: make(r.b) }).tick();
      quietKept(r, row, { status, waits });
    });
  }
  // R9: an answer that finished the ask; the quiet wake's checkout, then another run's todo.
  const answeredDone = async () => {
    const b = ordinary();
    const stateFile = stateFileOf();
    const m = model(b, ["Done."]);
    await poller(b, m.answer, { stateFile }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "done", JSON.stringify(b.writes));
    b.runs.set("t-1", run("r2"));
    b.issues.get("t-1").status = "in_progress";   // the wake's checkout, unrecorded
    return { b, stateFile, m, since: b.writes.length };
  };
  await check("R9 control: a quiet re-wake on an unchanged finished card closes it done again, with no model run", async () => {
    const r = await answeredDone();
    await poller(r.b, r.m.answer, { stateFile: r.stateFile }).tick();
    assert.strictEqual(r.m.prompts.length, 1);
    assert.strictEqual(r.b.issues.get("t-1").status, "done", JSON.stringify(r.b.writes.slice(r.since)));
  });
  await check("R9: quiet re-wake on a finished card, another run of this seat moves it to todo after the wake's comments read: done is not written over todo", async () => {
    const r = await answeredDone();
    const fetch = after(r.b, GET("/issues/t-1/comments"), (x) => x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN), 1);
    await poller(r.b, r.m.answer, { stateFile: r.stateFile, fetch }).tick();
    const mine = r.b.writes.slice(r.since);
    assert.strictEqual(r.m.prompts.length, 1, "the model ran again");
    assert.strictEqual(r.b.issues.get("t-1").status, "todo", `done was written over todo: ${JSON.stringify(mine)}`);
    assert.ok(!mine.some(ROUTES), `a stale routing write: ${JSON.stringify(mine)}`);
    assert.ok(mine.some((w) => w.runId === "r2" && w.body.comment), `r2 did not complete on a comment: ${JSON.stringify(mine)}`);
  });

  // R2, R3, R6, R7: a saved answer whose builtOn has no record mark (or no
  // runs) has nothing to place another run's write against: it never routes.
  // Another run of this seat moves T-1 to todo, the restart's checkout shows
  // in_progress again, and the saved answer goes out as a comment only.
  const stripBuilt = (stateFile, keep) => {
    const s = savedState(stateFile);
    for (const k of Object.keys(s.builtOn ?? {})) s.builtOn[k] = Object.fromEntries(Object.entries(s.builtOn[k]).filter(([f]) => keep.includes(f)));
    require("fs").writeFileSync(stateFile, JSON.stringify(s));
  };
  for (const [row, keep] of [["R2", ["snap", "own"]], ["R6", ["snap"]]]) {
    await check(`${row}: a saved blocked-on-T-3 answer whose builtOn keeps only ${keep.join("+")}, another run's todo, a restart: nothing routed, T-2 stands`, async () => {
      const b = onT2();
      const { stateFile, prompts, answer } = await savedThenStopped(b, ON_T3);
      stripBuilt(stateFile, keep);
      b.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN);
      wake(b, "r2");
      await poller(b, answer, { stateFile }).tick();
      assert.strictEqual(prompts.length, 1, `${row}: the model ran again`);
      keptOnT2(b, row);
    });
  }
  for (const [row, keep] of [["R3", ["snap", "own"]], ["R7", ["snap"]]]) {
    await check(`${row}: a saved return whose builtOn keeps only ${keep.join("+")}, another run's todo, a restart: nothing handed back`, async () => {
      const b = ordinary();
      const { stateFile, prompts, answer } = await savedThenStopped(b, RETURNED);
      stripBuilt(stateFile, keep);
      b.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN);
      wake(b, "r2");
      const since = b.writes.length;
      await poller(b, answer, { stateFile }).tick();
      assert.strictEqual(prompts.length, 1, `${row}: the model ran again`);
      assert.deepStrictEqual(handOffs(b), [], `${row}: handed back without provenance: ${JSON.stringify(b.writes)}`);
      assert.ok(!b.writes.slice(since).some(ROUTES), `${row}: a routing write: ${JSON.stringify(b.writes.slice(since))}`);
      assert.ok(b.writes.slice(since).some((w) => /Only the Product Owner/.test(w.body.comment ?? "")), `${row}: the answer was not said`);
    });
  }

  // ---- Round 11: one gate for every routing write, fallbacks and restorations included ----

  // Every write that sets a status, holder, waits or unblock step goes through
  // routeGate: the card read again just before it and compared with the
  // snapshot that produced the write. Anything recorded since by anyone but
  // this attempt's own runs — a newer ask included, never a reason to skip
  // the comparison — turns the write into a comment only.

  // R1, R5, R21: T-1 answered blocked on T-2; a person asks again just after
  // quiet wake r2's first comments response. The ask is newer than the
  // answer, so the note cannot close (close=false), and the block it would
  // put back is decided from no card the wake read: a comment only.
  for (const [row, ask, spy] of [["R1", "Any news on this?", false], ["R5", "And can it cover refunds too?", false], ["R21", "Is this still waiting on T-2?", true]]) {
    await check(`${row}: quiet re-wake, a person asks again after r2's first comments read: the note is a comment only, nothing routed`, async () => {
      const r = await answeredOnT2();
      const patches = [];
      const asked = after(r.b, GET("/issues/t-1/comments"), (x) => x.say("t-1", PERSON, ask), 1);
      const fetch = async (url, init = {}) => { if (init.method === "PATCH") patches.push(JSON.parse(init.body)); return asked(url, init); };
      await poller(r.b, r.m.answer, { stateFile: r.stateFile, fetch }).tick();
      quietKept(r, row, { status: "in_progress" });
      assert.deepStrictEqual([r.b.issues.get("t-1").assigneeAgentId, r.b.issues.get("t-1").assigneeUserId ?? null], [ME.id, null], `${row}: the holder changed`);
      if (spy) assert.ok(patches.every((p) => !ROUTES({ body: p })), `${row}: a routing PATCH went out: ${JSON.stringify(patches)}`);
    });
  }

  // R2: an ordinary `return`, the hand-back refused (403), and another run of
  // this seat records todo before the refusal comes back. The fallback block
  // is a routing write of its own: re-read, the todo seen, a comment only.
  await check("R2: an ordinary return's hand-back refused, another run's todo lands first: todo stands, the refusal said as a comment", async () => {
    const b = ordinary();
    b.state.refuseHandOff = true;
    const fetch = after(b, PATCHES("assigneeAgentId"), (x) => x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN));
    const { prompts, answer } = model(b, [RETURNED]);
    await poller(b, answer, { stateFile: stateFileOf(), fetch }).tick();
    const t = b.issues.get("t-1");
    assert.strictEqual(prompts.length, 1, "the model ran again");
    assert.strictEqual(t.status, "todo", `todo was written over: ${JSON.stringify(b.writes)}`);
    assert.ok(!b.writes.some(ROUTES), `a routing write after the refusal: ${JSON.stringify(b.writes)}`);
    assert.strictEqual(holderOf(t), ME.id);
    assert.ok(b.writes.some((w) => /Only the Product Owner/.test(w.body.comment ?? "") && /could not hand this task back/.test(w.body.comment)), `the refusal was not said: ${JSON.stringify(b.writes)}`);
  });

  // R3: an ordinary `return` through process.escalate (the seat reports to
  // the Product Owner). The hand_up records another run's todo, then refuses:
  // the terminal refusal block is gated like any other, so todo stands and
  // the refusal, with its code, is said as a comment.
  await check("R3: an ordinary return through process.escalate, the hand_up records another run's todo and refuses: todo stands, the refusal said", async () => {
    const b = ordinary();
    const calls = [];
    const escalate = async (args) => {
      calls.push(args.operation);
      b.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN);
      return { ok: false, code: "not_holder", message: "the card is not with you" };
    };
    const reports = async (url, init = {}) => (url.endsWith("/api/agents/me") ? { ok: true, text: async () => JSON.stringify({ ...ME, reportsTo: "agent-po" }) } : b.fetch(url, init));
    const { prompts, answer } = model(b, [RETURNED]);
    await poller(b, answer, { stateFile: stateFileOf(), fetch: reports, escalate }).tick();
    const t = b.issues.get("t-1");
    assert.deepStrictEqual(calls, ["hand_up"], `the action was not asked: ${JSON.stringify(calls)}`);
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(t.status, "todo", `todo was written over: ${JSON.stringify(b.writes)}`);
    assert.ok(!b.writes.some(ROUTES), `a routing write after the refusal: ${JSON.stringify(b.writes)}`);
    assert.ok(b.writes.some((w) => /not_holder: the card is not with you/.test(w.body.comment ?? "")), `the refusal was not said: ${JSON.stringify(b.writes)}`);
  });

  // R4: an answered escalation waits on T-2. On quiet wake r2, another run of
  // this seat records todo just after keepBlocked's card response: the
  // checkout restoration is gated against the wake's snapshot, so todo
  // stands, and r2 completes on a comment of its own with no model run.
  await check("R4: an answered escalation on T-2, another run's todo after keepBlocked's card read on quiet wake r2: todo stands, r2 ends on a comment", async () => {
    const b = escalation();
    const stateFile = stateFileOf();
    const { prompts, answer } = model(b, [ON_T2]);
    await poller(b, answer, { stateFile, ...ESC }).tick();
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2"], `the wait was not linked: ${JSON.stringify(b.writes)}`);
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    wake(b, "r2");
    const since = b.writes.length;
    // The wake reads the card once; the next read of it is keepBlocked's.
    const fetch = after(b, GET("/issues/t-1"), (x) => x.setStatus("t-1", "todo", BOT_SEAT, OTHER_RUN), 2);
    await poller(b, answer, { stateFile, fetch, ...ESC }).tick();
    const mine = b.writes.slice(since), t = b.issues.get("t-1");
    assert.strictEqual(prompts.length, 1, "the model ran again");
    assert.strictEqual(t.status, "todo", `todo was written over: ${JSON.stringify(mine)}`);
    assert.ok(!mine.some(ROUTES), `a routing write: ${JSON.stringify(mine)}`);
    assert.deepStrictEqual(t.blockedByIssueIds, ["t-2"]);
    assert.ok(mine.some((w) => w.runId === "r2" && w.body.comment), `r2 did not end on a comment: ${JSON.stringify(mine)}`);
  });

  // The guard: every write that can change routing goes through routeGate.
  // The only PATCH calls in the poller are the gate's and say()'s, which
  // sends a comment and nothing else; process.escalate is called only from
  // the gate; and every POST is a comment, a wake or a reconciliation.
  await check("every routing write goes through routeGate: no other PATCH, no other process.escalate call", async () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../lib/paperclip.js"), "utf8");
    const body = (name) => {
      const at = src.indexOf(`function ${name}(`);
      assert.ok(at >= 0, `no ${name}()`);
      let depth = 0, i = src.indexOf("{", src.indexOf(")", at));
      const start = i;
      for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
      return [start, i];
    };
    const gate = body("routeGate");
    const sayAt = src.match(/const say = \(([^)]*)\) => api\("PATCH", [^,]+, \{ comment(: [a-z]+)? \}, [a-zA-Z]+\);/);
    assert.ok(sayAt, "say() is not a comment-only PATCH");
    const inGate = (i) => i > gate[0] && i < gate[1];
    const patches = [...src.matchAll(/api\("PATCH"/g)].map((m) => m.index);
    const stray = patches.filter((i) => !inGate(i) && i !== sayAt.index + sayAt[0].indexOf('api("PATCH"'));
    assert.deepStrictEqual(stray.map((i) => src.slice(i, i + 80)), [], "a PATCH outside routeGate and say()");
    assert.strictEqual(patches.filter(inGate).length, 1, "routeGate makes more than one kind of PATCH");
    const escalates = [...src.matchAll(/\bescalateClient\(/g)].map((m) => m.index);
    assert.ok(escalates.length >= 1 && escalates.every(inGate), "process.escalate called outside routeGate");
    const posts = [...src.matchAll(/api\("POST", `([^`]+)`/g)].map((m) => m[1]);
    assert.ok(posts.every((p) => /\/comments$|\/wakeup$|\/recovery-actions\/resolve$/.test(p)), `a POST that is not a comment, a wake or a reconciliation: ${posts}`);
  });

  // The validator itself: only a snapshot with its fields, its record mark and its runs authorizes routing.
  await check("routableSnapshot: no mark, no runs, legacy or nothing never authorizes routing", async () => {
    const { routableSnapshot } = require("../lib/paperclip");
    assert.strictEqual(typeof routableSnapshot, "function", "routableSnapshot is not exported");
    const snap = { status: "in_progress", assignees: [ME.id, null], labels: [], title: "", description: "", newest: null, ask: "" };
    const mark = { at: "2026-01-01T00:00:00.000Z", seen: ["a1"] };
    for (const [why, s] of [["nothing", undefined], ["null", null], ["empty", {}], ["legacy", { legacy: true }],
      ["no mark", { snap, own: ["r1"] }], ["no runs", { snap, mark }], ["runs not a list", { snap, mark, own: "r1" }],
      ["a bare time for a mark", { snap, mark: mark.at, own: ["r1"] }], ["no fields", { mark, own: ["r1"] }],
      ["legacy with the rest", { legacy: true, snap, mark, own: ["r1"] }]]) {
      assert.strictEqual(routableSnapshot(s), false, `${why} authorized routing`);
    }
    assert.strictEqual(routableSnapshot({ snap, mark, own: ["r1"] }), true, "a whole snapshot did not authorize routing");
  });
  // The guard: reply() takes the producing snapshot as its fourth argument at every call site.
  await check("every reply() call site passes a producing snapshot", async () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../lib/paperclip.js"), "utf8");
    const calls = [...src.matchAll(/\breply\(item,\s*[^,]+,\s*[^,]+,\s*([^,]+),/g)].map((m) => m[1].trim());
    assert.ok(calls.length >= 6, `found ${calls.length} reply() calls`);
    const bare = [...src.matchAll(/\breply\(/g)].length - [...src.matchAll(/async function reply\(/g)].length;
    assert.strictEqual(calls.length, bare, `a reply() call not in the (item, run, key, snapshot, ...) form: ${calls}`);
    assert.ok(calls.every((a) => /^(wakeSnap\(\)|producing\(.+\)|snapshot)$/.test(a)), `a call site passes no snapshot: ${calls}`);
  });
  // The same for the other routing helpers: acknowledge (7th), handOn (3rd), handOffVia (7th).
  await check("every acknowledge(), handOn() and handOffVia() call site passes a producing snapshot", async () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../lib/paperclip.js"), "utf8");
    const argsOf = (name) => [...src.matchAll(new RegExp(`(?<!function )\\b${name}\\(item,`, "g"))].map((m) => {
      let depth = 0, i = m.index + name.length, arg = "", out = [];
      for (; i < src.length; i++) {
        const c = src[i];
        if ("([{".includes(c)) { depth++; if (depth === 1) continue; }
        if (")]}".includes(c)) { depth--; if (depth === 0) { out.push(arg.trim()); break; } }
        if (c === "," && depth === 1) { out.push(arg.trim()); arg = ""; continue; }
        arg += c;
      }
      return out;
    });
    const want = [["acknowledge", 6, /^wakeSnap\(\)$/], ["handOn", 2, /^withOwn\(was\)$/], ["handOffVia", 6, /^(from|withOwn\(was\))$/]];
    // withOwn only merges this attempt's runs into the producing snapshot's own.
    assert.match(src, /const withOwn = \(w\) => Array\.isArray\(w\.own\) \? \{ \.\.\.w, own: \[\.\.\.new Set\(\[\.\.\.w\.own, \.\.\.ownRuns\(\)\]\)\] \} : w;/);
    for (const [name, at, form] of want) {
      const calls = argsOf(name);
      assert.ok(calls.length >= 1, `no ${name}() call found`);
      assert.ok(calls.every((a) => form.test(a[at] ?? "")), `${name}() called without a producing snapshot: ${JSON.stringify(calls.map((a) => a[at]))}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
