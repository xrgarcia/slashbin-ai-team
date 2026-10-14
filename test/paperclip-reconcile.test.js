/**
 * Paperclip — a task's card stays true after the work moves on: a block the
 * bot set itself, or one Paperclip set when it lost a run, is brought up to
 * date; a decision someone else made is left alone.
 */
const assert = require("assert");
const { mkdtempSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller, statusSetter, reconcilable, outcomeOf, OUTCOME_MARK, TRANSPORT_NOTE, INTERRUPTED_NOTE, FALLBACK_REPLY, HELD_NOTE, decidedStatus } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const ME = { id: "agent-1", name: "Bot" };
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
  let last = 0;
  const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();
  const setStatus = (id, to, actor, extra = {}) => {
    const i = issues.get(id);
    activity.get(id).unshift({ action: "issue.updated", createdAt: now(), ...actor, ...extra, details: { changes: { status: { from: i.status, to } } } });
    i.status = to;
  };
  const blockedBy = (i) => (i.blockedByIssueIds ?? []).map((b) => ({ id: b, identifier: issues.get(b).identifier, status: issues.get(b).status }));
  const fetch = async (url, init) => {
    const path = url.replace(/^.*\/api/, "");
    const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
    if (path === "/agents/me") return ok(ME);
    if (path === `/agents/${ME.id}/wakeup` && init.method === "POST") {
      const { payload } = JSON.parse(init.body);
      wakes.push(payload);
      if (state.noWake) return ok({ status: "skipped", reason: "wakeup_skipped" });
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
    const m = path.match(/^\/issues\/([^/]+)(\/[a-z]+)?$/);
    if (m && state.down?.has(decodeURIComponent(m[1]))) return { ok: false, status: 503, text: async () => "unavailable" };
    const i = m && byName(decodeURIComponent(m[1]));
    if (!i) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      // Paperclip refuses an agent's write made outside any run.
      if (!init.headers["x-paperclip-run-id"]) return { ok: false, status: 403, text: async () => JSON.stringify({ error: "run needed", details: { code: "cross_issue_influence_run_context_required" } }) };
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
      // Whatever lands between the bot's last read and this write.
      if (state.beforeWrite && body.status) { const f = state.beforeWrite; delete state.beforeWrite; f(i); }
      if (body.comment && actorRun) actorRun.status = "succeeded";
      writes.push({ id: i.id, body, runId: init.headers["x-paperclip-run-id"] });
      const was = { blockedByIssueIds: i.blockedByIssueIds ?? [], unblockDescriptor: i.unblockDescriptor ?? null };
      if (body.blockedByIssueIds) i.blockedByIssueIds = body.blockedByIssueIds;
      if (body.unblockDescriptor) i.unblockDescriptor = body.unblockDescriptor;
      const runId = init.headers["x-paperclip-run-id"];
      if (body.status && body.status !== i.status) setStatus(i.id, body.status, { actorType: "agent", actorId: ME.id }, { runId });
      // Blocking a blocked task, or rewriting its waits, is recorded as a fresh
      // decision with no status change: a new statusVersion and what it replaced.
      else if (i.status === "blocked" && (body.status === "blocked" || body.blockedByIssueIds || body.unblockDescriptor)) {
        const changes = { statusVersion: { from: 1, to: 2 } };
        for (const k of Object.keys(was)) if (body[k] && JSON.stringify(body[k]) !== JSON.stringify(was[k])) changes[k] = { from: was[k], to: body[k] };
        activity.get(i.id).unshift({ action: "issue.updated", createdAt: now(), actorType: "agent", actorId: ME.id, runId, details: { ...(body.status ? { status: body.status } : {}), changes } });
      }
      if (body.comment) comments.get(i.id).push({ id: `c${writes.length}`, authorAgentId: ME.id, createdAt: now(), body: body.comment, createdByRunId: init.headers["x-paperclip-run-id"] });
      return ok({});
    }
    if (!m[2]) return ok({ ...i, blockedBy: blockedBy(i) });
    if (m[2] === "/activity") return ok(activity.get(i.id));
    if (m[2] === "/comments") return ok(comments.get(i.id));
    if (m[2] === "/runs") return ok(runs.get(i.id));
    return { ok: false, status: 404, text: async () => "" };
  };
  // Blocking a task that is already blocked changes no status string: Paperclip
  // records it as a new statusVersion and the wait's new owner, nothing more.
  const reassert = (id, actor) => {
    activity.get(id).unshift({ action: "issue.updated", ...actor, details: { status: "blocked",
      changes: { statusVersion: { from: 1, to: 2 }, unblockDescriptor: { from: null, to: { owner: { userId: actor.actorId } } } } } });
  };
  return { fetch, writes, tries, wakes, state, issues, runs, comments, setStatus, reassert, now,
    // Paperclip lost the run: it has ended, and the task is blocked.
    recover: (id, runId) => {
      activity.get(id).unshift({ action: "issue.execution_recovery_settled", actorType: "system", actorId: "execution-recovery", runId, details: { outcome: "blocked" } });
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

  await check("case 3, after a resume: Paperclip loses the run its wake checked out — noted, a new run opened, and the one answer closes it there", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    await poller(b, async () => `Need T-2.\n${OUTCOME_MARK} blocked on T-2`, { stateFile }).tick();
    b.setStatus("t-2", "done", PERSON);
    b.runs.set("t-1", run("r2"));
    b.issues.get("t-1").status = "in_progress";        // the wake's checkout, unrecorded
    let launches = 0;
    await poller(b, async () => {
      launches++;
      b.recover("t-1", "r2");
      await new Promise((r) => setTimeout(r, 60));
      return "Finished.";
    }, { watchMs: 10, stateFile }).tick();
    assert.strictEqual(launches, 1);
    assert.deepStrictEqual(b.writes.filter((x) => x.body.comment === TRANSPORT_NOTE).map((x) => x.runId), ["r2"], "no transport note under the lost run");
    assert.deepStrictEqual(b.wakes, [{ issueId: "t-1" }]);
    assert.deepStrictEqual(b.writes.filter((x) => x.body.comment?.endsWith("Finished.")).map((x) => x.runId), ["w1"]);
    assert.strictEqual(b.issues.get("t-1").status, "done");
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

  await check("waiting on the same task a second time resumes again; a repeat wake for one wait does not", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" }), task("t-3", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const replies = [`Need T-2.\n${OUTCOME_MARK} blocked on T-2`, `Need T-3.\n${OUTCOME_MARK} blocked on T-3`, `T-2 again.\n${OUTCOME_MARK} blocked on T-2`, "Finished."];
    let n = 0;
    const answer = async () => replies[n++];
    await poller(b, answer, { stateFile }).tick();
    b.setStatus("t-2", "done", PERSON); b.runs.set("t-1", run("r2"));
    await poller(b, answer, { stateFile }).tick();
    b.setStatus("t-3", "done", PERSON); b.runs.set("t-1", run("r3"));
    b.setStatus("t-2", "todo", PERSON);                 // T-2 reopened
    await poller(b, answer, { stateFile }).tick();
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-2"]);
    b.setStatus("t-2", "done", PERSON); b.runs.set("t-1", run("r4"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 4, "the second wait on T-2 was taken as already answered");
    assert.strictEqual(b.issues.get("t-1").status, "done");
    b.runs.set("t-1", run("r5"));
    await poller(b, async () => assert.fail("a repeat wake ran it again"), { stateFile }).tick();
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

  await check("case 1, a resumed task blocks on something new: the change of waits is no newer ask — it stays blocked and is not run again", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" }), task("t-3", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const answer = async () => (++n === 1 ? `Need T-2.\n${OUTCOME_MARK} blocked on T-2` : `Now T-3.\n${OUTCOME_MARK} blocked on T-3`);
    await poller(b, answer, { stateFile }).tick();
    b.setStatus("t-2", "done", PERSON);
    b.runs.set("t-1", run("r2"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, ["t-3"]);
    assert.ok(!b.writes.some((x) => x.body.status === "todo"), "reopened by its own close");
    b.runs.set("t-1", run("r3"));
    b.issues.get("t-1").status = "in_progress";        // a re-wake's checkout, unrecorded
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 2, "ran again");
    assert.ok(!b.writes.some((x) => x.runId === "r3" && x.body.status), "a status was written on the re-wake");
  });

  await check("a blocked answer is not finished: a person moving the card on asks it again; a re-wake alone does not", async () => {
    const b = board([task("t-1", { runs: run("r1") })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const answer = async () => (++n === 1 ? `Cannot yet.\n${OUTCOME_MARK} blocked` : "Done now.");
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
    b.runs.set("t-1", run("r2"));
    b.issues.get("t-1").status = "in_progress";        // a re-wake's checkout, unrecorded
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 1, "a re-wake ran it again");
    b.setStatus("t-1", "todo", PERSON);
    b.runs.set("t-1", run("r3"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 2, "the moved card was acknowledged, not asked again");
    assert.strictEqual(b.writes.at(-1).body.comment, "Done now.");
    assert.strictEqual(b.issues.get("t-1").status, "done");
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

  await check("a saved blocked answer whose waits finished before its post was retried goes on, once", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let refused = false;
    const fetch = async (url, init) => {
      if (init?.method === "PATCH" && !refused) { refused = true; return { ok: false, status: 503, text: async () => "unavailable" }; }
      return b.fetch(url, init);
    };
    const prompts = [];
    const answer = async (p) => { prompts.push(p); return prompts.length === 1 ? `Need T-2.\n${OUTCOME_MARK} blocked on T-2` : "Finished."; };
    await poller(b, answer, { stateFile, fetch }).tick();
    assert.strictEqual(prompts.length, 1);
    b.setStatus("t-2", "done", PERSON);
    await poller(b, answer, { stateFile, fetch }).tick();
    assert.strictEqual(prompts.length, 2, "the saved answer was posted blocked on nothing");
    assert.strictEqual(b.issues.get("t-1").status, "done");
    assert.match(b.writes.at(-1).body.comment, /^Need T-2\.\n\nResuming: T-2[\s\S]*Finished\.$/);
  });

  await check("a wait that finishes between an attempt and its retry is the same ask: a saved answer posts once, and an interrupted one is not run again", async () => {
    const linked = () => board([task("t-1", { blockedByIssueIds: ["t-2"], runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    // Its post fails; then the task it is linked to is done.
    let b = linked();
    let stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    await poller(b, async () => { n++; b.state.down = new Set(["t-1"]); return "Update sent."; }, { stateFile }).tick();
    b.state.down = null;
    b.setStatus("t-2", "done", PERSON);
    await poller(b, async () => { n++; return "Update sent."; }, { stateFile }).tick();
    assert.strictEqual(n, 1, "the work ran again");
    assert.strictEqual(b.writes.filter((x) => x.body.comment?.includes("Update sent.")).length, 1);
    // The bot dies mid-run; then the task it is linked to is done.
    for (const resumeInterrupted of [false, true]) {
      b = linked();
      stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      poller(b, () => new Promise(() => {}), { stateFile, resumeInterrupted, watchMs: 1e6 }).tick();
      await new Promise((r) => setTimeout(r, 20));
      b.setStatus("t-2", "done", PERSON);
      const prompts = [];
      await poller(b, async (p) => { prompts.push(p); return "sent"; }, { stateFile, resumeInterrupted }).tick();
      if (resumeInterrupted) assert.ok(prompts.length === 1 && prompts[0].includes(INTERRUPTED_NOTE), "not run once, told it was interrupted");
      else {
        assert.strictEqual(prompts.length, 0, "run again without resumeInterrupted");
        assert.ok(b.writes.some((x) => x.body.comment === FALLBACK_REPLY));
      }
    }
  });

  await check("an ask answered done after its resume is not run again when its waits change back", async () => {
    for (const change of ["unlink", "reopen"]) {
      const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
      const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
      let n = 0;
      const answer = async () => (++n === 1 ? `Need T-2.\n${OUTCOME_MARK} blocked on T-2` : "Finished.");
      await poller(b, answer, { stateFile }).tick();
      b.setStatus("t-2", "done", PERSON);
      b.runs.set("t-1", run("r2"));
      await poller(b, answer, { stateFile }).tick();
      assert.strictEqual(b.issues.get("t-1").status, "done");
      if (change === "unlink") b.issues.get("t-1").blockedByIssueIds = [];
      else b.issues.get("t-2").status = "todo";
      b.issues.get("t-1").status = "in_progress";      // requeued, unrecorded
      b.runs.set("t-1", run("r3"));
      await poller(b, answer, { stateFile }).tick();
      assert.strictEqual(n, 2, `${change}: the answered ask ran again`);
    }
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

  await check("a close that clears done links does not make an answered blocked ask look new", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    const replies = [`Need T-2.\n${OUTCOME_MARK} blocked on T-2`, "Done with it.", `Needs approval.\n${OUTCOME_MARK} blocked`, "ran again"];
    let n = 0;
    const answer = async () => replies[n++];
    await poller(b, answer, { stateFile }).tick();
    b.setStatus("t-2", "done", PERSON); b.runs.set("t-1", run("r2"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 2);
    b.setStatus("t-1", "todo", PERSON);
    b.comments.get("t-1").push({ id: "p1", authorUserId: "user-1", createdAt: new Date().toISOString(), body: "Ship it?" });
    b.runs.set("t-1", run("r3"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 3);
    assert.deepStrictEqual(b.issues.get("t-1").blockedByIssueIds, []);
    // Unchanged wakes, the second after a restart.
    b.runs.set("t-1", run("r4"));
    await poller(b, answer, { stateFile }).tick();
    b.runs.set("t-1", run("r5"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 3, "the answered ask was run again");
    assert.strictEqual(b.issues.get("t-1").status, "blocked");
  });

  await check("a wait that finishes while the bot answers a newer ask: the answer closes the card, and the ask is not run again", async () => {
    const b = board([task("t-1", { runs: run("r1") }), task("t-2", { assigneeAgentId: null, status: "todo" })]);
    const stateFile = join(mkdtempSync(join(tmpdir(), "pc-")), "s.json");
    let n = 0;
    const answer = async () => {
      n++;
      if (n === 1) return `Need T-2.\n${OUTCOME_MARK} blocked on T-2`;
      b.setStatus("t-2", "done", PERSON);              // finishes mid-answer
      return "Did it.";
    };
    await poller(b, answer, { stateFile }).tick();
    b.setStatus("t-1", "todo", PERSON);
    b.comments.get("t-1").push({ id: "p1", authorUserId: "user-1", createdAt: new Date().toISOString(), body: "And this?" });
    b.runs.set("t-1", run("r2"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 2);
    assert.strictEqual(b.issues.get("t-1").status, "done", "the answer was posted but the card left open");
    // An unchanged wake, after a restart.
    b.issues.get("t-1").status = "in_progress";
    b.runs.set("t-1", run("r3"));
    await poller(b, answer, { stateFile }).tick();
    assert.strictEqual(n, 2, "the answered ask was run again");
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
