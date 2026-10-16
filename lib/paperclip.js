/**
 * Paperclip — answer tasks assigned to this bot on a Paperclip board.
 *
 * Paperclip (paperclip.ing) is an agent task board. A task it hands to an agent
 * is checked out to the heartbeat run it opened, and only that run may write to
 * it, so a bot that
 * runs on its own host — beside its repo, its MCP servers and its permission
 * rules — has to be told a run is open. This module is that half:
 *
 *   1. Someone assigns the bot a task, or comments on one it holds. Paperclip
 *      opens a run, and the agent's server-side command holds the run open,
 *      waiting for a comment made under it.
 *   2. The poller here sees the open run, hands the task and its thread to the
 *      bot as a prompt, and posts the bot's answer as a comment under the run.
 *   3. The waiting run sees the comment and ends.
 *
 * The answer comes from the SAME run path as a Discord reply — the same
 * permissions, MCP config, settings and channel prompt — so a board cannot
 * reach a tool the bot's Discord channels cannot. That is the whole reason this
 * lives in the harness instead of in a script beside it.
 *
 * Pure decisions are exported for tests; the network and the Claude run are
 * injected, so nothing here logs a bot in.
 */

const { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } = require("fs");
const { basename, dirname } = require("path");
const { createHash, randomUUID } = require("crypto");
const { byteLength, truncateToBytes } = require("./argv-budget");
const { latestRecord, openHandUps } = require("./process-escalate");
const { parseContract, contractText } = require("./handoff-contract");

/**
 * How a run says the task did not simply finish. Without it every answer
 * closed the task as done, a "Blocked" reply included. `review` lands it in
 * in_review: Paperclip takes an agent's in_review only with a review path, so
 * the close names the reviewer in the same write (statusWrite).
 */
const OUTCOME_MARK = "PAPERCLIP-OUTCOME:";
const OUTCOME_LINE = /^[ \t>*_`]*PAPERCLIP-OUTCOME:[ \t]*([a-z_-]*)[^\n]*$/gim;

/** A task as the board names it, e.g. ACME-12. */
const IDENTIFIER = /\b[A-Z][A-Z0-9]*-\d+\b/g;

/**
 * The comment to post and the status to close with. Every outcome line is
 * taken out of the comment; any `blocked` one makes the task blocked. An
 * `escalate` line asks for an escalation to be handed on to the next holder
 * (`escalate`); it sets no status. A `return` line blocks the task and hands it
 * back to whoever gave it to the bot (`giveBack`): what is left is theirs to do. A blocked
 * line may name the tasks it waits on (`blocked on ACME-12, ACME-13`): the task
 * is then linked to them, and Paperclip wakes the bot when the last is done.
 * A blocked line may instead name the person it waits on (`blocked on Avery`):
 * the task is then handed to them, still blocked (`person`).
 * A `review` line puts finished work in review (in_review) instead of done;
 * any blocked or return line outranks it.
 *
 * @param {string} text the run's reply
 * @returns {{ comment: string, status: "done" | "blocked" | "in_review", waitsOn: string[], person: string | null, escalate: boolean, giveBack: boolean }}
 */
function outcomeOf(text) {
  let status = "done", escalate = false, giveBack = false, review = false, person = null;
  const waitsOn = [];
  const comment = String(text).replace(OUTCOME_LINE, (line, word) => {
    if (word.toLowerCase() === "blocked") {
      status = "blocked";
      const rest = line.slice(line.toUpperCase().indexOf(OUTCOME_MARK) + OUTCOME_MARK.length);
      for (const id of rest.match(IDENTIFIER) ?? []) if (!waitsOn.includes(id)) waitsOn.push(id);
      const after = rest.replace(/^\s*blocked\b/i, "");
      const who = /^\s*on\s/i.test(after) && after.replace(/^\s*on\s/i, "").replace(IDENTIFIER, " ").replace(/[,;.]|\band\b/gi, " ").replace(/\s+/g, " ").trim();
      if (who) person = who;
    }
    if (word.toLowerCase() === "escalate") escalate = true;
    if (word.toLowerCase() === "return") { status = "blocked"; giveBack = true; }
    if (word.toLowerCase() === "review") review = true;
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  if (review && status === "done") status = "in_review";
  return { comment, status, waitsOn, person, escalate, giveBack };
}

// ---- Status decisions: docs/board-decisions.md, table (a) ----

const sameActor = (a, b) => Boolean(a && b && a.actorType === b.actorType && a.actorId === b.actorId);
/** A write's changes to what the task waits on: its linked tasks or its unblock step. */
const changesWaits = (c) => Boolean(c?.blockedByIssueIds || c?.unblockDescriptor);
/** A write's change of holder. */
const handsOver = (c) => Boolean(c?.assigneeAgentId || c?.assigneeUserId);
/** A write to the task itself, as Paperclip records one (routes/issues.ts: one `issue.updated` per PATCH). */
const isUpdate = (a) => a?.action === "issue.updated";
/** Whether a write's request (its `details`, as Paperclip logs them) asked to set the holder or the waits. */
const asksHolder = (d) => Boolean(d && ("assigneeAgentId" in d || "assigneeUserId" in d));
const asksWaits = (d) => Boolean(d && ("blockedByIssueIds" in d || "unblockDescriptor" in d));
/** The run a record was written under; a person's writes have none. */
const runOf = (a) => a?.runId ?? null;
/** How much of a comment Paperclip logs with its posting (routes/issues.ts: `bodySnippet`). */
const SNIPPET = 120;
/** How the Foreman marks a comment it cut (comments.ts capComment). */
const CUT_MARK = "\n\n… (truncated)";
/**
 * Whether `body` is `step` as the Foreman posts it (comments.ts finishComment):
 * trimmed, each secret replaced by a redaction token, and cut with a mark when
 * long. A token stands for any text; a cut body for the start of the step.
 */
function postedAs(body, step) {
  let text = String(body).trim();
  const cut = text.endsWith(CUT_MARK.trim());
  if (cut) text = text.slice(0, -CUT_MARK.trim().length).trimEnd();
  const pattern = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\[REDACTED(?::[A-Za-z0-9_]+)?\\\]/g, "[\\s\\S]+?");
  return new RegExp(`^${pattern}${cut ? "" : "$"}`).test(String(step).trim());
}
/** A comment that leads with a bold header, as the Foreman's session summaries do (comments.ts sessionComment). */
const boldHeader = (text) => /^\*\*[^*\n]+\*\*/.test(String(text ?? "").trim());

/**
 * Each entry of a record (newest first) as a status decision, and the decision
 * in force from each entry back — one pass oldest first, then one fold, cached
 * on the record so every question asked of one read costs one pass.
 */
const passes = new WeakMap();
function decisionsOf(all, agentId) {
  let byAgent = passes.get(all);
  if (!byAgent) passes.set(all, byAgent = new Map());
  const hit = byAgent.get(agentId);
  if (hit && hit.len === all.length && hit.head === all[0] && hit.tail === all.at(-1)) return hit;
  const n = all.length;
  const kinds = new Array(n).fill("none"), noteOf = new Array(n).fill(-1);
  const isMe = (a) => a.actorType === "agent" && a.actorId === agentId;
  const isSystem = (a) => a.actorType === "system";
  const keyOf = (a) => `${a.actorType}:${a.actorId}`;
  // The comment each commented update posted: the first later posting by the
  // same writer under the same run not paired yet, before that writer's next
  // update under that run (routes/issues.ts logs the update, then the comment).
  const paired = new Set();
  const commentOf = (i) => {
    const w = all[i];
    for (let k = i - 1; k >= 0; k--) {
      const a = all[k];
      if (!sameActor(a, w) || runOf(a) !== runOf(w)) continue;
      if (isUpdate(a)) return null;
      if (a.action === "issue.comment_added" && !paired.has(k)) { paired.add(k); return a.details ?? {}; }
    }
    return null;
  };
  // The unblock step in force and the status, as the record has them.
  let desc, status;
  for (let i = n - 1; i >= 0 && (desc === undefined || status === undefined); i--) {
    const c = all[i].details?.changes;
    if (desc === undefined && c?.unblockDescriptor) desc = c.unblockDescriptor.from ?? null;
    if (status === undefined && c?.status) status = c.status.from;
  }
  desc ??= null;
  // Per writer, the note its latest move expects (rule 1), and the bold
  // summaries waiting on it (rule 4).
  const open = new Map();
  const close = (k) => { for (const b of open.get(k)?.bolds ?? []) kinds[b] = "decision"; open.delete(k); };
  for (let i = n - 1; i >= 0; i--) {
    const a = all[i];
    if (a.action === "issue.execution_recovery_settled") { kinds[i] = "settle"; continue; }
    if (!isUpdate(a)) continue;
    const d = a.details ?? {}, c = d.changes ?? {};
    if ("unblockDescriptor" in d) desc = d.unblockDescriptor ?? null;
    else if (c.unblockDescriptor) desc = c.unblockDescriptor.to ?? null;
    const was = status;
    if (c.status) status = c.status.to;
    else if (d.status) status = d.status;
    const commented = d.source === "comment";
    const comment = commented ? commentOf(i) : null;
    const k = keyOf(a), other = !isMe(a) && !isSystem(a);
    const moves = !commented && ("status" in d || asksHolder(d) || asksWaits(d) || c.status || handsOver(c) || changesWaits(c));
    if (other && moves) {
      close(k);
      open.set(k, { step: desc?.action ?? null, bolds: [], move: i });
    }
    const candidate = other && commented && !handsOver(c) && !changesWaits(c) && !asksHolder(d) && !asksWaits(d)
      && (c.status?.to === "blocked" || (c.statusVersion && !c.status));
    if (candidate && open.has(k)) {
      const o = open.get(k);
      const body = comment?.body ?? comment?.bodySnippet;
      const known = comment?.body != null || (typeof comment?.bodySnippet === "string" && comment.bodySnippet.length < SNIPPET);
      if (o.step && known && postedAs(body, o.step)) {
        for (const b of o.bolds) { kinds[b] = "note"; noteOf[b] = o.move; }
        kinds[i] = "note"; noteOf[i] = o.move;
        open.delete(k);
        continue;
      }
      if (boldHeader(body)) { o.bolds.push(i); continue; }
    } else if (other && !moves && !candidate && open.has(k)) close(k);
    // What the write decides, as table (a) reads it.
    if (c.status) kinds[i] = "decision";
    else if (!c.statusVersion) kinds[i] = changesWaits(c) ? "waits" : handsOver(c) ? "hand-off" : "none";
    else if (handsOver(c) && !("status" in d) && !changesWaits(c) && !asksWaits(d)) kinds[i] = "hand-off";
    else if (handsOver(c) && !("status" in d)) {
      // A hand-off that also rewrote the waits: a decision on a blocked card, its status kept.
      kinds[i] = was !== "blocked" ? "waits" : isMe(a) ? "keep" : "decision";
    } else kinds[i] = isMe(a) ? "keep" : "decision";
  }
  for (const k of [...open.keys()]) close(k);
  // The decision in force from each entry back (lastDecision), oldest first.
  const after = new Array(n + 1).fill(null);
  let cur = null;
  for (let i = n - 1; i >= 0; i--) {
    const a = all[i], d = a.details ?? {}, c = d.changes ?? {};
    const kind = kinds[i];
    if (kind === "settle") {
      // Paperclip settles a lost run as blocked whatever stop the task was in
      // already: a stop someone chose before it is still the decision, and
      // the settlement decides only a task it stopped (a15, a16).
      if (!(d.outcome === "blocked" && cur && STOPPED.has(cur.to) && !reconcilable(cur.w, agentId))) cur = { w: a, to: d.outcome };
    } else if (kind === "decision") cur = { w: a, to: c.status?.to ?? d.status ?? "blocked" };
    else if (kind === "keep") {
      // The bot reasserting a block keeps whoever decided it (a14).
      if (cur?.to !== "blocked") cur = { w: a, to: d.status ?? "blocked" };
    } else if (kind === "note" && c.status) cur = { w: all[noteOf[i]], to: c.status.to };
    after[i] = cur;
  }
  const result = { len: n, head: all[0], tail: all.at(-1), kinds, after };
  byAgent.set(agentId, result);
  return result;
}

/**
 * What one entry of a task's activity record (newest first) is, as a status
 * decision — table (a) of docs/board-decisions.md:
 *
 *   settle    Paperclip settling a run it lost
 *   decision  its writer's decision on the task's status (any status move, any
 *             restatement or waits rewrite on a blocked task — by anyone,
 *             the same writer as the last decision included)
 *   note      a writer's note on its own move, restating blocked (the expectation rule)
 *   keep      this bot restating its own block or trimming its waits
 *   hand-off  a change of holder alone
 *   waits     a waits change on a task that is not blocked
 *   none      anything else: a comment, an edit, a label
 */
function decisionKind(activity, i, agentId) {
  return decisionsOf(list(activity, "activity"), agentId).kinds[i] ?? "none";
}

/**
 * The last status decision in Paperclip's activity record (newest first) and
 * the status it set (decisionKind), from entry `from` on. Null when the record
 * does not say. `agentId` is the bot reading it (reconcilable).
 */
function lastDecision(activity, agentId, from = 0) {
  return decisionsOf(list(activity, "activity"), agentId).after[from] ?? null;
}
/** The board as of entry `i` of a read of a task's activity (newest first): its
 * time, on Paperclip's own clock, and it with every entry listed after it at
 * that time. Paperclip reports its clock to the millisecond but orders the
 * record on a finer one, so an entry listed before it in the same millisecond
 * was recorded after it.
 */
const markAt = (activity, i) => {
  const all = list(activity, "activity"), at = all[i]?.createdAt ?? "";
  return { at, seen: all.slice(i).filter((a) => a.createdAt === at).map((a) => a.id) };
};
/** The board as of a read of a task's activity: its newest entry (markAt). */
const markOf = (activity) => markAt(activity, 0);
/** The time a mark stands for. A mark saved as a time alone is one too: the time of a write, or one saved before marks kept what they saw. */
const atOf = (mark) => (mark && typeof mark === "object" ? mark.at : String(mark ?? ""));
/**
 * Whether an activity entry was recorded after `mark`: later, or at its time
 * and not seen in its read. A mark saved as a time alone did not say what it
 * saw, so its own millisecond counts as after it: a write the bot cannot place
 * is read as newer, never passed over.
 */
const after = (a, mark) => a.createdAt > atOf(mark) || (a.createdAt === atOf(mark) && atOf(mark) !== ""
  && (mark && typeof mark === "object" ? Boolean(mark.seen) && !mark.seen.includes(a.id) : true));
/**
 * The newest write by someone else — a person or another agent — to the
 * task's status or waits made after `mark` (markOf); undefined when none. A
 * decision or a waits change counts, whoever made the one before it; a
 * hand-off, a writer's note on its own move and an edit do not (decisionKind).
 */
const personSince = (activity, mark, agentId) => {
  const all = list(activity, "activity");
  const { kinds } = decisionsOf(all, agentId);
  return all.find((a, i) => a.actorType !== "system" && !(a.actorType === "agent" && a.actorId === agentId)
    && after(a, mark) && ["decision", "waits"].includes(kinds[i]));
};
/**
 * The newest change of holder by someone else after `mark`: the card handed
 * away, to nobody, or away and back. Whoever moved it made the newer decision,
 * even where it ends with the bot again (docs/board-decisions.md w3).
 */
const handedSince = (activity, mark, agentId) => list(activity, "activity").find((a) => a.actorType !== "system"
  && !(a.actorType === "agent" && a.actorId === agentId) && after(a, mark) && handsOver(a.details?.changes));

/**
 * The write that put the task in its present status (lastDecision). Null when
 * the record does not say — a task created in that status, or a last decision
 * that names another status.
 */
function statusSetter(activity, status, agentId) {
  const d = lastDecision(activity, agentId);
  return d?.to === status ? d.w : null;
}

/**
 * The status a task is in as decided. Paperclip's wake checks a stopped task
 * out to in_progress with no record of its own, so in_progress after a
 * recorded stop is still that stop: only a recorded move lifts it. A comment
 * never does — not even the bot's own, which can land after a person's stop
 * when its close was refused.
 */
function decidedStatus(status, activity, agentId) {
  if (!activity) return status;
  const d = lastDecision(activity, agentId);
  return status === "in_progress" && STOPPED.has(d?.to) ? d.to : status;
}

/**
 * Whether a stopped task may be moved on by this bot. A status is a decision
 * by who wrote it, not by its value: a task this bot blocked itself, or one
 * Paperclip blocked when it lost contact with a run, carries no one's choice
 * and is brought up to date. Anything else — a person, another agent, a sync,
 * or a status the record cannot account for — stands.
 */
function reconcilable(setter, agentId) {
  if (!setter) return false;
  if (setter.action === "issue.execution_recovery_settled") return setter.actorType === "system";
  // Of the bot's own writes only a block is its own stop. It also writes a
  // stop when it puts back one a person made as it closed (reopenIfMoved), and
  // that write is the person's decision: it always replaces the close's done.
  // A reasserted block (a trim of its waits) keeps the status it had.
  const { from, to } = setter.details.changes.status ?? { from: "blocked", to: "blocked" };
  return setter.actorType === "agent" && setter.actorId === agentId && to === "blocked" && from !== "done";
}

/**
 * Whether a stop is work another agent handed this bot: an agent's block that
 * also gave the task to it — in the same write, or in the newest hand-off to it,
 * made by that agent at or after the block (Paperclip may record the status
 * and the assignment as one entry or two). `return` hands a task back that way. It
 * is how one agent passes work on, not a hold on it, so its recipient works it.
 * A person's block stands even when it also hands the task over (SLA-1337), and
 * so does an agent's block of a task someone else gave this bot.
 */
function handedBack(setter, activity, agentId) {
  if (setter?.actorType !== "agent" || !setter.actorId || setter.actorId === agentId) return false;
  return handedWith(setter, activity, agentId);
}

/**
 * Whether the stop `setter` made came with a hand-off of the task to this bot
 * by the same writer: in the same write, or as the newest hand-off to it,
 * made at or after the stop. The Foreman's mirror blocks and hands a card on
 * in one write, then restates blocked with its note (mirror.ts move(), note());
 * Paperclip may record the status and the assignment as one entry or two.
 */
function handedWith(setter, activity, agentId) {
  if (!setter) return false;
  const toMe = (a) => a.details?.changes?.assigneeAgentId?.to === agentId || a.details?.assigneeAgentId === agentId;
  if (toMe(setter)) return true;
  const all = list(activity, "activity");
  const handed = all.find(toMe);
  const at = all.indexOf(setter);
  return Boolean(handed && sameActor(handed, setter) && at >= 0 && all.indexOf(handed) <= at);
}

/**
 * Whether this bot may move a task on from the stop `setter` put it in — the
 * one reading of a stop that every decision about one makes (holding a wake,
 * closing over it, putting it back after a close): a stop no one chose
 * (reconcilable), or work handed to this bot blocked (handedBack). Anything
 * else is someone's decision, and it stands.
 */
function movable(setter, activity, agentId) {
  return reconcilable(setter, agentId) || handedBack(setter, activity, agentId);
}

/**
 * What a wake on a task does, from what the board and the bot's saved state
 * say — the one transition every wake goes through:
 *
 *   post-older   the run is gone, and the ask it owes an answer to is not the
 *                task's newest: that answer is posted, the newer ask waits
 *   retry        an answer to this ask is owed: its post is retried (or an
 *                interrupted attempt rerun, unless the task is held)
 *   settle       an escalation already worked, unchanged since and not
 *                resuming from a wait it linked: the card is kept blocked and
 *                nothing is worked again
 *   acknowledge  this ask was answered and is not resuming: nothing is worked
 *                again, and the task is left as its answer left it
 *   hold         someone else stopped the task: it is not worked
 *   work         a new ask, or one resuming from its wait: the bot runs
 *
 * On a live run every one of them ends the run with a comment under it (the
 * board's waiter holds a run open until one lands): the answer, or a note.
 * A note is never repeated on the card (endRun).
 *
 * @param {{ live: boolean, owes: boolean, answered: boolean, escalated: boolean, resumes: boolean, held: boolean }} f
 * @returns {"post-older"|"retry"|"settle"|"acknowledge"|"hold"|"work"}
 */
function wakeStep({ live, owes, answered, escalated, resumes, held }) {
  if (!live && !owes) return "post-older";
  if (owes) return "retry";
  if (escalated && answered && !resumes) return "settle";
  if (answered && !resumes) return "acknowledge";
  if (held) return "hold";
  return "work";
}

/**
 * A failed request as an error that says why. Paperclip names a refused write
 * in the body (`{ "error", "details": { "code" } }`); the code is what tells a
 * wrong key from a write made outside the run it needs, so it leads the
 * message and is kept on the error. docs/paperclip-board-execution.md lists them.
 */
function refusal(method, path, status, text) {
  let code;
  try {
    const b = JSON.parse(text);
    code = [b?.details?.code, b?.code].find((c) => typeof c === "string" && /^[a-z0-9_]+$/.test(c));
  } catch { /* not JSON */ }
  const err = new Error(`${method} ${path} -> HTTP ${status}${code ? ` ${code}` : ""} ${text.slice(0, 300)}`.trimEnd());
  err.status = status;
  if (code) err.code = code;
  return err;
}

/** Paperclip wraps some lists and not others. */
const list = (v, key) => (Array.isArray(v) ? v : v?.[key] ?? []);
const runIdOf = (r) => r.id ?? r.runId;

/** The run this bot still owes an answer for on one task, or null. */
function pickOpenRun(runs, agentId, handled) {
  return list(runs, "runs").find(
    (r) => r.agentId === agentId && r.status === "running" && !handled.has(runIdOf(r))
  ) ?? null;
}

/**
 * The ask a run answers — exactly what the prompt tells the bot to answer: the
 * latest comment from a person that is still on the thread, else none (the task
 * itself). Not the comment that woke the run: a newer one may have arrived since,
 * and the saved answer must be filed under the ask it actually answers.
 */
function askOf(comments, agentId) {
  // Paperclip's own notices (authorType "system", such as a recovery escalation) ask nothing.
  return comments.filter((c) => !c.deletedAt && c.authorAgentId !== agentId && c.authorType !== "system").at(-1) ?? null;
}

/**
 * `<task>:<fingerprint>` of exactly what the bot is asked: the task's title and
 * description and the ask's id and text. An unchanged re-wake gets the same key;
 * an edited ask or a revised task is a new one and is answered. `handedAt`,
 * on an escalation, is the record of the card's hand-off to the bot: handed
 * to it again, it is a new ask.
 */
function askKey(taskId, issue, ask, handedAt) {
  const what = JSON.stringify([issue.title ?? "", issue.description ?? "", ask?.id ?? null, ask?.body ?? "", ...(handedAt ? [handedAt] : [])]);
  return `${taskId}:${createHash("sha256").update(what).digest("hex").slice(0, 24)}`;
}

// What one task's prompt may take. The prompt rides as a single argument, which
// the run path cuts from the tail at the OS limit (argv-budget.js), and the tail
// is where the latest ask is. Well under that limit, leaving room for the rest.
const PROMPT_MAX_BYTES = 96 * 1024;
const CUT_DESCRIPTION = "\n[The rest of the description is left out: it is longer than a board task can pass on.]";
const CUT_TITLE = " [title cut]";
const CUT_ASK = "\n[This ask was cut here: it is longer than a board task can pass on. Say so in your reply.]";

/**
 * The prompt for one task: the task, then its thread, oldest first. A prompt
 * too long for one run sheds, in order: the comments before the latest ask,
 * oldest first; the bot's own comments after it; the description; the title.
 * Only an ask too long on its own is cut, and the prompt says so.
 */
function buildTaskPrompt(issue, comments, me, boardUrl, { maxBytes = PROMPT_MAX_BYTES, note = "", returnable = true, contract = "" } = {}) {
  const live = comments.filter((c) => !c.deletedAt);
  const ask = askOf(live, me.id);
  const at = ask ? live.indexOf(ask) : live.length;
  const render = (c, body = c.body) => `--- ${c.authorAgentId === me.id ? `You (${me.name})` : "A board user"}, ${c.createdAt}\n${body}`;
  const parts = { before: 0, after: 0, title: issue.title, description: issue.description, askBody: ask?.body };
  const earlierNotice = (n) => `[${n} earlier comment${n === 1 ? " is" : "s are"} left out: the thread is longer than one run can take. The latest ask is in full below.]`;
  const laterNotice = (n) => `[${n} of your own later comment${n === 1 ? " is" : "s are"} left out: the thread is longer than one run can take.]`;
  const build = (thread) => {
    if (thread === undefined) {
      const earlier = live.slice(parts.before, at).map((c) => render(c));
      if (parts.before) earlier.unshift(earlierNotice(parts.before));
      const later = live.slice(at + 1 + parts.after).map((c) => render(c));
      if (parts.after) later.unshift(laterNotice(parts.after));
      thread = [...earlier, ...(ask ? [render(ask, parts.askBody)] : []), ...later].join("\n\n");
    }
    return [
      `This is a task assigned to you on a Paperclip board (${boardUrl}).`,
      "Everyone with access to the board reads it. Your reply is posted as your comment on the task — it is not a chat channel, and no one sees anything else you write.",
      "",
      `Task ${issue.identifier}: ${parts.title}`,
      parts.description ? `\n${parts.description}` : "",
      thread ? `\nThread so far:\n\n${thread}` : "",
      note ? `\n${note}` : "",
      contract ? `\n--- Handoff contract ---\n${contract}\n--- End handoff contract ---` : "",
      "",
      "You cannot book a follow-up or a scheduled job from a board task: nothing scheduled here can post back to it. If one is asked for, say so.",
      "You cannot attach a file to a board comment. If a file is asked for, say so; put short content in the reply itself.",
      "Your Discord conversations, their summaries and the files shared there are private to those channels and are not available here. Never quote, recall or summarize them on the board.",
      `If you could not do what was asked — a tool, access or decision you do not have — say what blocks it and who can clear it, and end your reply with the line ${OUTCOME_MARK} blocked. The task is then marked blocked instead of done.`,
      `If you were asked to clear a hold and it stays — nothing it waits on has changed — the task is blocked, not done: say once what clears it and when it resumes, and end with ${OUTCOME_MARK} blocked. Never answer an unchanged hold with a "still held" comment that leaves the task open; each one wakes the asker to ask again.`,
      `If it waits on other tasks on this board, name them on that line (${OUTCOME_MARK} blocked on ACME-12, ACME-13): the task is linked to them and comes back to you when the last one is done.`,
      `If it waits on a person instead — their decision, approval or action — name them on that line (${OUTCOME_MARK} blocked on Avery) and say in your reply's first line what they need to do: the task is handed to them, still blocked, so it waits with them and not with you.`,
      ...(returnable ? [`If the work is finished but needs whoever gave you this task to review it before it counts as done, end with the line ${OUTCOME_MARK} review: the task goes to review with them as the reviewer.`] : []),
      ...(returnable ? [`If what is left can only be done by whoever gave you this task, and they can do it, say exactly what they need to do and end with the line ${OUTCOME_MARK} return instead: the task is handed back to them, still blocked. Use blocked when it waits on something they cannot clear either.`] : []),
      "Answer the latest ask. Reply with the comment body only.",
    ].join("\n");
  };
  // The size of the prompt build() would return, without building it: each
  // comment is measured once, so shedding a long thread is linear, not a
  // rebuild per comment dropped (second pass on 52e8de4: 4,000 comments held
  // the bot's event loop for 52 seconds). The head and the ask are measured
  // again only when a cut changes them, which cut() flags: comparing the text
  // itself on every comment dropped was its own quadratic (second pass on
  // 0553e16: a 4 MB description held the loop for 7 seconds).
  const sizes = live.map((c) => byteLength(render(c)));
  const pre = [0];
  for (const n of sizes) pre.push(pre.at(-1) + n);
  const SEP = byteLength("\n\n"), THREAD_HEAD = byteLength("\nThread so far:\n\n");
  let headBytes, askBytes, headStale = true, askStale = true;
  const size = () => {
    if (headStale) { headStale = false; headBytes = byteLength(build("")); }
    if (ask && askStale) { askStale = false; askBytes = byteLength(render(ask, parts.askBody)); }
    const from = at + 1 + parts.after;
    const items = (at - parts.before) + (ask ? 1 : 0) + (live.length - from) + (parts.before ? 1 : 0) + (parts.after ? 1 : 0);
    const body = (pre[at] - pre[parts.before]) + (ask ? askBytes : 0) + (pre[live.length] - pre[Math.min(from, live.length)])
      + (parts.before ? byteLength(earlierNotice(parts.before)) : 0) + (parts.after ? byteLength(laterNotice(parts.after)) : 0);
    return items ? headBytes + THREAD_HEAD + body + SEP * (items - 1) : headBytes;
  };
  const over = () => size() - maxBytes;
  const cut = (field, notice) => {
    if (over() <= 0 || !parts[field]) return;
    parts[field] = truncateToBytes(parts[field], byteLength(parts[field]) - over() - byteLength(notice), { keep: "head" }) + notice;
    if (field === "askBody") askStale = true; else headStale = true;
  };
  while (over() > 0 && parts.before < at) parts.before++;
  while (over() > 0 && at + 1 + parts.after < live.length) parts.after++;
  cut("description", CUT_DESCRIPTION);
  cut("title", CUT_TITLE);
  cut("askBody", CUT_ASK);
  return build();
}

/**
 * Collects what a board run says. The run path hands files over as a
 * `{ files }` message for Discord to attach; a board comment cannot carry one,
 * so the reply names each file as not delivered rather than read as if it were.
 */
function replyCollector() {
  const parts = [], files = [];
  return {
    collect(m) {
      if (typeof m === "string") parts.push(m);
      else for (const f of m?.files ?? []) files.push(basename(String(f?.attachment ?? f?.name ?? f)));
    },
    text() {
      const note = files.length
        ? `Not delivered: ${files.join(", ")}. Files cannot be attached to a board task — ask for ${files.length === 1 ? "it" : "them"} in a channel that takes files.`
        : "";
      return [...parts, note].filter(Boolean).join("\n\n");
    },
  };
}

const FALLBACK_REPLY = "I could not answer this one just now. It has been logged and someone will follow up.";
/** What a blocked task waits for, as Paperclip's unblock descriptor names it. */
const UNBLOCK_ACTION = "Read the last comment for what was missing, then reply on this task; a reply reopens it and the assigned bot picks it up again.";
/** A blocked task that waits on others: what it waits on, and what else unblocks it. */
const waitAction = (waiting, done = []) => `Waits on ${waiting.join(", ")}${done.length ? ` (${done.join(", ")} done)` : ""}. `
  + "It comes back to the assigned bot on its own when the last of them is done. Anything else: read the last comment, then reply on this task.";
/** Statuses that stop a task. Who set one decides whether the bot may move it (reconcilable). */
const STOPPED = new Set(["blocked", "cancelled"]);
/** Posted under a run on a task someone else stopped: the bot does not work it. */
/** Appended to a `return` answer when the board names nobody to hand the task back to. */
/** Appended to a `review` answer when the board names nobody to review it. */
const NO_REVIEWER = "I could not send this for review: no one gave me this task and I report to no one, so it stays with me, blocked.";
const NO_GIVER = "I could not hand this task back: the board has no record of anyone but me giving it to me, so it stays with me, blocked.";
const HELD_NOTE = "This task is stopped by someone else, so I have not picked it up. Move it out of that status to have me work on it.";
/** On a task someone blocked as the bot closed it: their hold stands, and what its note said. */
const keptHold = (said) => `Someone blocked this task as I closed it, and the board let my close replace their hold's note. Their hold stands: I will not pick the task up until it is moved out of blocked.${said ? ` Their note said: ${said}` : ""}`;
/** Posted instead of a status or blocker write when a person changed the task after the bot read it (personSince). */
const PERSON_STANDS = "Someone changed this task's status or what it waits on after I last read it. Their change stands: I left the task as they set it.";
/** The re-wake note older versions posted; still read as a note on cards that carry it. */
const ALREADY_ANSWERED = "This was answered above. Add a comment with anything new and I will pick it up.";
const UNCHANGED_HEAD = "Nothing has changed since my last answer: ";
/** A comment's first line, to repeat it in a note: the reason a hold gives, or what an answer said. */
const firstLine = (body) => {
  const line = String(body ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
};
/**
 * Ends a re-wake's run on an ask already answered. It repeats the answer's
 * first line — a hold's reason — and who it waits on, so a card whose newest
 * comment it is still reads as the answer did. It never asks for anything:
 * a note that asked for "anything new" buried a hold on a person (SLA-1621).
 */
const unchangedNote = (answer, who) => `${UNCHANGED_HEAD}${firstLine(answer) || "see above."}${who ? ` Waiting on ${who}.` : ""}`;
/** Posted under a blocked answer that named a person the board does not have. */
const noPerson = (name) => `I could not hand this task to ${name}: the board has no person by that name, so it stays with me, blocked.`;
/** What a task handed to a person blocked waits for. */
const personAction = (name) => `Waits on ${name}, who holds it now: the last comment says what is needed. When it is done, hand the task back to the bot with a comment and it picks the work up again.`;
/** Ends a re-wake's run on an escalation already worked: the card is left blocked with this bot. */
const ESCALATION_KEPT = "This escalation was worked above and is still blocked with me. Add a comment with anything new, or hand it to me again, and I will pick it up.";
/** Added to an escalation's answer when the card changed while it was worked: the change stands. */
const CARD_CHANGED = "The card was changed while I worked on it, so I left it as it is now rather than hand it on.";
/** An escalation answered while a newer question came in: the card stays with the bot, and the next wake answers it. */
const NEWER_ASK = "The card was asked something newer while I worked on this (a comment, an edit, or a new hand-off to me), so I kept it to answer that next rather than hand it on.";
// How many times an escalation whose ask changed under it is worked again,
// under the same run, before its answer is posted and the card kept for the next wake.
const MAX_REWORK = 2;
/** What a run on an escalation reworked under the same run is told: what changed, and what it said to the card as it was. */
const reworkNote = (what, said) => `The card changed while you worked on it: ${what}. Your answer to the card as it was is posted together with this one, above it:\n\n${said}\n\nAnswer the card as it is now. Do not repeat anything that answer says was already done.`;
/** Posted when Paperclip blocks a task because it lost the run, while the bot is still working on it. */
const TRANSPORT_NOTE = "The board lost its connection to this run and marked the task blocked. The work is still running here — one attempt, not restarted — and its result will be posted on this task when it finishes.";
/** Opens an attempt's answer delivered under a new run because the board lost the one it started under (EM#626). */
const LOST_NOTE = "The board lost the run this work started under while it was still going. It went on here as one attempt, was not run again, and is delivered under this new run.";
/** The answer when an attempt's worker died after it started: never run again, as it may have acted (EM#626). */
const workerDiedNote = (id, at, signal) => `The worker running this ask stopped before it finished (attempt ${id}${at ? `, started ${at}` : ""}${signal ? `, killed by ${signal}` : ""}). It was not run again: it may have done part of the work. Check what it did before asking for it again.\n\nPAPERCLIP-OUTCOME: blocked`;
/** Carried in an attempt's posted answer, so a post whose response was lost is found again whatever was added to its text. */
const attemptMark = (id) => `<!-- slashbin-attempt:${id}:result -->`;
/** What the bot posts that is no answer: bookkeeping on a run or a task. */
/** Ends a run on a card handed to someone else before the bot picked it up: it is theirs, left as it is. */
const HANDED_AWAY = "This task was handed to someone else before I picked it up, so I left it as it is.";
const NOTES = new Set([HELD_NOTE, PERSON_STANDS, ALREADY_ANSWERED, TRANSPORT_NOTE, ESCALATION_KEPT, HANDED_AWAY]);
/** Whether a comment of the bot's is one of its notes on the card, not an answer. */
const isNote = (body) => NOTES.has(body) || body.startsWith(keptHold()) || body.startsWith(UNCHANGED_HEAD);
/** Prepended to a task whose last attempt the bot never finished (it restarted mid-run). */
/** reply() wrote nothing: every task the block named was done before it went out. */
const READY = Symbol("ready");
const INTERRUPTED_NOTE = "Your last attempt at this ask was interrupted before its answer was posted: the bot restarted mid-run. Whatever it started may have finished or may still be running. Find out what happened before doing anything again, and never repeat an action that may already have taken place. If you cannot tell, say so and mark the task blocked.";

/** The stage labels that mark a blocked card as an escalation for its holder to work (escalationLabels). */
const ESCALATION_LABELS = ["Needs EM ruling"];
/**
 * Who an escalation goes to next: `agent:<seat name or id>` or
 * `user:<board user id>`, a person, with `|<name>` to call them by. Null when
 * unset; throws on anything else, so a broken setting is reported, not guessed.
 */
function parseEscalateTo(text) {
  if (text === undefined || text === null || String(text).trim() === "") return null;
  const m = String(text).trim().match(/^(agent|user):([^|]+?)\s*(?:\|\s*(.+))?$/);
  if (!m) throw new Error(`escalateTo must be agent:<seat name or id> or user:<board user id>[|name], not ${JSON.stringify(text)}`);
  return { kind: m[1], ref: m[2].trim(), name: (m[3] ?? m[2]).trim() };
}
/**
 * What a run on an escalation is told: where it came from, what it may do, and
 * where the card goes after. `up` is who it may hand an unresolved card to,
 * `down` who a resolved one goes back to, `from` who handed it back down with
 * their resolution — each `{ name }`, or null.
 */
function escalationNote(authority, { up = null, down = null, from = null } = {}) {
  return [
    "This card is an escalation: the agent working it stopped and handed it up, and whoever held it before you (see the thread) could not resolve it. The card stays blocked the whole way: never change its status.",
    from ? `${from.name} handed it back down to you with their resolution, in the latest comments. Apply it at your level.` : "",
    "Read the card's reason in its latest comments. When the card mirrors a GitHub issue, the description's first line names it (source: owner/repo#N): act there — a comment or ruling on that issue is what releases the hold of the agent that stopped.",
    authority ? `Yours to decide: ${authority}` : "",
    `Resolve it: act on the GitHub issue, then reply with a short note saying what you did.${down ? ` The card then goes back to ${down.name}, still blocked.` : ""}`,
    up ? `Or, when the decision is outside your authority, escalate it to ${up.name}: start your reply with one line saying what you need from them, then what you tried and why you cannot resolve it, and end it with the line ${OUTCOME_MARK} escalate. The card is handed to them, still blocked. Escalating is correct when the decision is not yours; deciding it anyway is not.` : "",
    `If you can neither resolve it${up ? " nor escalate it" : ""}, say what you tried, why, and what you need, and end with the line ${OUTCOME_MARK} blocked: the card stays with you.`,
  ].filter(Boolean).join("\n");
}

/**
 * What survives a restart. `handled` — runs already closed, so a slow close is
 * never answered twice. `answered` — asks (`<task>:<ask>`) already answered, so a
 * re-wake under a new run is not answered again; it is a record, not a guess from
 * the thread, because a progress note the bot wrote mid-run looks like an answer.
 * `pending` — answers produced but not yet posted: running the task again to
 * recover one could repeat whatever the run did (mail, a record). Unposted
 * answers are never trimmed: one leaves only when its post lands. Nor are
 * answered asks — one dropped is a task that runs again; each is a short key.
 * `closing` — per task, a close whose follow-up look (see reopenIfMoved) has not
 * yet succeeded, so it is retried on every poll until it does. `since` — per
 * saved answer, when its attempt began, so a post of it that landed is found
 * on the board only among comments that came after. `decidedFrom` — per saved
 * or answered ask, the board as of the attempt that answered it last (markOf),
 * so its close, and every acknowledgement of it after, leaves a person's newer
 * status or waits as they set them (personSince). `attemptRuns` —
 * per saved answer, the run it was made under, so one whose run ended while the
 * bot was down (Paperclip gave up on it) is still posted on its task.
 * `resumed` — attempts whose interrupted run was already run once more, so a
 * second interruption posts the fallback instead of looping. `blockedAsks` —
 * per answered ask whose answer left it blocked, the run that wrote that
 * answer: the wait it is in, fixed when it is written. One is not finished: it
 * resumes once its waits are done or a recorded move takes it out of the stop.
 * The resume is an attempt like any other, saved before it runs, and its
 * answer ends that wait — final, or blocked in a new one — so each wait
 * resumes its ask once, and waiting a second time resumes it again.
 * `continued` — attempts whose answer, blocked on tasks already done, already
 * went on once, so a second such answer is posted rather than run again.
 * `continuing` — per saved answer, the going-on still under way: what was said
 * before it and what it was told, so one the bot died in is run once more,
 * told so, when allowed, or posted with the fallback — never posted as the
 * earlier answer, blocked on tasks already done.
 * `seq` and `attemptSeq` — the escalation lifecycle's monotonic attempt
 * sequence (docs/board-decisions.md (b)): every attempt takes the next number
 * as it begins, an ask asked again included, and the owed answers are read in
 * that order, never in the order their keys were first saved. `leads` — per
 * saved answer, the text a go-on or a resume put before the attempt's own
 * answer, so the person is told the attempt's own first line. `linked` — per
 * answered escalation, the tasks its blocked answer linked; it resumes when
 * every one is done (p7).
 *
 * Only a missing file is a fresh start. One that cannot be read throws: read as
 * empty, it would run every answered task again.
 */
function loadState(file) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch (err) {
    if (err.code === "ENOENT") return { handled: new Set(), answered: new Set(), pending: new Map(), closing: new Map(), since: new Map(), decidedFrom: new Map(), attemptRuns: new Map(), resumed: new Set(), blockedAsks: new Map(), reviewAsks: new Set(), continued: new Set(), continuing: new Map(), attemptIds: new Map(), seq: 0, attemptSeq: new Map(), leads: new Map(), linked: new Map(), linkDone: new Map(), lastAnswered: new Map() };
    throw err;
  }
  const s = JSON.parse(raw);
  // Keys saved before an ask's key stood alone carry the waits it came back
  // from (`~<hash>`); read back, each is the ask it names.
  const ask = (k) => k.replace(/~[0-9a-f]{8}$/, "");
  const asks = (ks) => (ks ?? []).map(ask);
  const byAsk = (o) => Object.entries(o ?? {}).map(([k, v]) => [ask(k), v]);
  // A saved answer is keyed `<task>:<ask>`; anything else predates that and can never be matched.
  const pending = new Map(byAsk(s.pendingReplies).filter(([k]) => k.includes(":")));
  // Saved before the wait was recorded with its ask: an unknown wait, resumed once.
  const blockedAsks = new Map(Array.isArray(s.blockedAsks) ? s.blockedAsks.map((k) => [ask(k), "earlier"]) : Object.entries(s.blockedAsks ?? {}));
  const attemptSeq = new Map(Object.entries(s.attemptSeq ?? {}).filter(([, v]) => Number.isInteger(v)));
  return { handled: new Set(s.handledRuns ?? []), answered: new Set(asks(s.answeredAsks)), pending,
    closing: new Map(Object.entries(s.closing ?? {}).map(([t, c]) => [t, { ...c, key: ask(c.key) }])), since: new Map(byAsk(s.pendingSince)), decidedFrom: new Map(Object.entries(s.decidedFrom ?? {})),
    attemptRuns: new Map(byAsk(s.attemptRuns)), resumed: new Set(asks(s.resumedAsks)), blockedAsks, reviewAsks: new Set(asks(s.reviewAsks)),
    continued: new Set(asks(s.continuedAsks)), continuing: new Map(Object.entries(s.continuing ?? {})), attemptIds: new Map(Object.entries(s.attemptIds ?? {})),
    attemptSeq, seq: Math.max(Number(s.seq) || 0, ...attemptSeq.values()), leads: new Map(Object.entries(s.leads ?? {})),
    linked: new Map(Object.entries(s.linked ?? {}).filter(([, v]) => Array.isArray(v))),
    linkDone: new Map(Object.entries(s.linkDone ?? {}).filter(([, v]) => Array.isArray(v))),
    lastAnswered: new Map(Object.entries(s.lastAnswered ?? {}).filter(([, v]) => typeof v === "string")) };
}
/** Written whole or not at all: a temp file, flushed, then renamed over the old one. */
function saveState(file, { handled, answered, pending, closing, since = new Map(), decidedFrom = new Map(), attemptRuns = new Map(), resumed = new Set(), blockedAsks = new Map(), reviewAsks = new Set(), continued = new Set(), continuing = new Map(), attemptIds = new Map(), seq = 0, attemptSeq = new Map(), leads = new Map(), linked = new Map(), linkDone = new Map(), lastAnswered = new Map() }) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify({
      handledRuns: [...handled].slice(-500),
      answeredAsks: [...answered],
      pendingReplies: Object.fromEntries(pending),
      closing: Object.fromEntries(closing),
      pendingSince: Object.fromEntries([...since].filter(([k]) => pending.has(k))),
      decidedFrom: Object.fromEntries([...decidedFrom].filter(([k]) => pending.has(k) || answered.has(k))),
      attemptRuns: Object.fromEntries([...attemptRuns].filter(([k]) => pending.has(k))),
      resumedAsks: [...resumed].slice(-500),
      blockedAsks: Object.fromEntries(blockedAsks),
      reviewAsks: [...reviewAsks].slice(-500),
      continuedAsks: [...continued].slice(-500),
      continuing: Object.fromEntries([...continuing].filter(([k]) => pending.has(k))),
      attemptIds: Object.fromEntries([...attemptIds].filter(([k]) => pending.has(k))),
      seq,
      attemptSeq: Object.fromEntries([...attemptSeq].filter(([k]) => pending.has(k))),
      leads: Object.fromEntries([...leads].filter(([k]) => pending.has(k))),
      linked: Object.fromEntries([...linked].filter(([k]) => answered.has(k) && blockedAsks.has(k))),
      linkDone: Object.fromEntries([...linkDone].filter(([k]) => linked.has(k))),
      lastAnswered: Object.fromEntries([...lastAnswered].slice(-500)),
    }, null, 2));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/**
 * @param {object} o
 * @param {string} o.url        board origin, e.g. https://board.example.com
 * @param {string} o.apiKey     the agent's API key
 * @param {string} o.stateFile  where handled run ids are kept
 * @param {(prompt: string, task: object) => Promise<string>} o.answer  runs the bot; resolves to its reply
 * @param {object} o.log        pino-style logger
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.requestTimeoutMs]  how long one request may take, body included
 * @param {boolean} [o.resumeInterrupted]  run an attempt the bot never finished once more, told so, instead of posting the fallback
 * @param {RegExp} [o.externalWriter]  first description line of a task another writer owns: the bot comments on it, never sets its status
 * @param {number} [o.watchMs]  how often a task being answered is checked for Paperclip losing its run
 * @param {Function} [o.onPoll]  called after each poll that reaches the board (its inbox read), so the bot can report the board ready
 * @param {string[]} [o.escalationLabels]  label names that make a blocked card assigned to the bot an escalation it works, the card left blocked
 * @param {{kind: "agent"|"user", ref: string, name: string}|null} [o.escalateTo]  who an escalation the bot cannot resolve is handed to (parseEscalateTo)
 * @param {{kind: "agent"|"user", ref: string, name: string}|null} [o.escalationReturnTo]  who a resolved escalation goes back to; unset, whoever handed it up to the bot
 * @param {string} [o.escalationAuthority]  what this bot decides itself, told to its escalation runs
 * @param {Function} [o.onEscalate]  called once when an escalation is handed to a person: ({ task, link, to, ask })
 * @param {object} [o.attempts]  the bot's board attempts (lib/attempts.js): each ask's work runs in a worker that outlives the bot, followed, never run twice
 */
function createPaperclipPoller({ url, apiKey, stateFile, answer, log, fetch: fetchImpl = fetch, requestTimeoutMs = 30000,
  resumeInterrupted = false, externalWriter = null, watchMs = 60000, onPoll = null,
  escalationLabels = ESCALATION_LABELS, escalateTo = null, escalationReturnTo = null, escalationAuthority = "", onEscalate = null,
  escalate: escalateClient = null, attempts = null, contract = null }) {
  const base = `${url.replace(/\/+$/, "")}/api`;
  let state;
  try { state = loadState(stateFile); } catch (err) {
    // Stay off rather than forget what was answered. Discord is unaffected.
    log.error({ err: err.message, stateFile }, "Paperclip state unreadable — board tasks are off until it is fixed");
    return { tick: async () => {}, whoami: null };
  }
  const { handled, answered, pending, closing } = state;
  state.since ??= new Map();
  state.decidedFrom ??= new Map();
  state.attemptRuns ??= new Map();
  state.resumed ??= new Set();
  state.blockedAsks ??= new Map();
  state.reviewAsks ??= new Set();
  state.continued ??= new Set();
  state.continuing ??= new Map();
  state.attemptIds ??= new Map();
  state.seq ??= 0;
  state.attemptSeq ??= new Map();
  state.leads ??= new Map();
  state.linked ??= new Map();
  state.linkDone ??= new Map();
  state.lastAnswered ??= new Map();
  const { since, decidedFrom, attemptRuns, resumed, blockedAsks, reviewAsks, continued, continuing, attemptIds, attemptSeq, leads, linked, linkDone, lastAnswered } = state;
  let me = null;
  let busy = false;
  let owed = null;      // why a tick was asked for while one ran
  let trigger = null;   // why the running tick runs: "poll", "connected" or an event type

  // Every request, body included, has a deadline: one response that stalls
  // mid-body would otherwise keep a tick busy forever, and every poll after it
  // skipped (second pass on 7fc887d). A timed-out write is reconciled like any
  // other failed one.
  async function api(method, path, body, runId) {
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    if (runId) headers["x-paperclip-run-id"] = runId;
    const abort = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${method} ${path} -> no full response in ${requestTimeoutMs} ms`));
        abort.abort();
      }, requestTimeoutMs);
    });
    // The loser of a race still settles later; aborted, it rejects, and that
    // rejection must be caught here, not left to crash the bot.
    const race = (p) => { p.catch(() => {}); return Promise.race([p, deadline]); };
    let r, text;
    try {
      r = await race(Promise.resolve(fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: abort.signal })));
      text = await race(Promise.resolve(r.text()));
    } finally { clearTimeout(timer); }
    if (!r.ok) throw refusal(method, path, r.status, text);
    return text ? JSON.parse(text) : null;
  }

  /**
   * A task another writer keeps in step with somewhere else (a mirror of an
   * issue tracker, say): two writers on one status fight, so the bot only
   * comments on it.
   */
  const external = (issue) => Boolean(externalWriter?.test(String(issue.description ?? "").split("\n")[0]));
  /**
   * A card handed to the bot to rule on while it stays blocked: blocked as
   * decided, held by this bot, and carrying an escalation label. It is worked,
   * whoever blocked it, and its status is never the bot's to change.
   */
  const wanted = new Set(escalationLabels.map((l) => String(l).trim().toLowerCase()));
  const escalation = (issue, decided) => decided === "blocked" && issue.assigneeAgentId === me.id
    && (issue.labels ?? []).some((l) => wanted.has(String(l?.name ?? l).trim().toLowerCase()));
  /**
   * Where the card's process.escalate record leaves this bot (SLA-1493), when
   * the bridge hands off through it (`escalate`): `escalated` when the latest
   * hop is a hand-up to it still open — worked as an escalation, with no label
   * needed — and `resumed` when the latest hop handed the card back down to it
   * and the block it is in is that hop's own: then the card is the bot's to
   * pick up again, not someone's hold. Null otherwise, and always without the
   * client: the record is the action's, read only where the bridge acts through it.
   */
  const hopOf = (issue, comments, decided, activity) => {
    if (!escalateClient || issue.assigneeAgentId !== me.id || decided !== "blocked") return null;
    const hops = latestRecord(comments, issue.id)?.hops ?? [];
    const last = hops.at(-1), open = openHandUps(hops);
    if (last?.to !== me.id) return null;
    if (open.at(-1)?.to === me.id) return { kind: "escalated", below: open.at(-1).from };
    return { kind: "resumed", from: last.from };
  };
  /** The block was set by the hop that handed the card back (hopOf `resumed`): no one's hold. */
  const hopBlocked = (hop, setter) => hop?.kind === "resumed" && setter?.actorType === "agent" && setter.actorId === hop.from;
  /** The record of the card's latest hand-off to this bot: a new one is a new escalation. */
  const handedAt = (activity) => list(activity, "activity").find((a) => a.details?.changes?.assigneeAgentId?.to === me.id)?.id ?? null;
  /** A holder as the board records one, `agent:<id>` or `user:<id>`, at one end of an assignment change. */
  const holderOf = (c, end) => (c.assigneeAgentId?.[end] ? `agent:${c.assigneeAgentId[end]}` : c.assigneeUserId?.[end] ? `user:${c.assigneeUserId[end]}` : null);
  /**
   * The escalation chain, bottom first, as the card's hand-offs built it since
   * it last went into blocked: a hand-off to a holder already on the chain
   * unwinds to them, any other climbs. Read from Paperclip's own record of
   * each assignment, never from what a comment says.
   */
  const chainOf = (activity) => {
    const record = [...list(activity, "activity")].reverse();
    let start = 0, was = null;
    record.forEach((a, n) => {
      const to = a.details?.changes?.status?.to;
      if (!to) return;
      if (to === "blocked" && was !== "blocked") start = n;
      was = to;
    });
    const chain = [];
    for (const a of record.slice(start)) {
      const c = a.details?.changes;
      if (!c?.assigneeAgentId && !c?.assigneeUserId) continue;
      const from = holderOf(c, "from"), to = holderOf(c, "to");
      if (!to) continue;
      if (chain.includes(to)) { chain.length = chain.indexOf(to) + 1; continue; }
      if (from && !chain.includes(from)) chain.push(from);
      else if (from) chain.length = chain.indexOf(from) + 1;
      chain.push(to);
    }
    return chain;
  };
  /** Where this bot sits on an escalation: who is below it, and who handed it back down, if anyone did. */
  const placeOn = (activity) => {
    const chain = chainOf(activity);
    const at = chain.indexOf(`agent:${me.id}`);
    const latest = list(activity, "activity").find((a) => a.details?.changes?.assigneeAgentId?.to === me.id);
    const from = latest ? holderOf(latest.details.changes, "from") : null;
    return { below: at > 0 ? chain[at - 1] : null, cameDown: from && !chain.includes(from) ? from : null };
  };
  /**
   * Who gave the bot this card, as a holder (`agent:<id>` / `user:<id>`): the
   * one it was last assigned from, read from Paperclip's own record of each
   * assignment, never from what a comment says; a card made already assigned
   * to the bot, its creator. Null when that is the bot itself, or nobody.
   */
  const giverOf = (activity, issue) => {
    const handed = list(activity, "activity").find((a) => a.details?.changes?.assigneeAgentId?.to === me.id);
    const from = handed ? holderOf(handed.details.changes, "from") : null;
    const giver = from ?? (issue.createdByAgentId ? `agent:${issue.createdByAgentId}` : issue.createdByUserId ? `user:${issue.createdByUserId}` : null);
    return giver === `agent:${me.id}` ? null : giver;
  };
  /** The card on the board, for a person to open. */
  const cardLink = (issue) => `${url.replace(/\/+$/, "")}/${String(issue.identifier).split("-")[0]}/issues/${issue.identifier}`;
  const nameOf = (b) => b.identifier ?? b.id;
  /** The tasks this one is linked as waiting on, when every one is done; else none. */
  const doneBlockers = (issue) => {
    const b = issue.blockedBy ?? [];
    return b.length && b.every((x) => x.status === "done") ? b : [];
  };
  /**
   * One attempt at an ask: its first answer, or its resume from the wait it
   * is in (blockedAsks). What the task waits on now never names it, so a wait
   * that changes while the ask is worked leaves the attempt as it was.
   */
  const attemptOf = (key) => (blockedAsks.has(key) ? `${key}@${blockedAsks.get(key)}` : key);
  /**
   * A task's record, each comment Paperclip logged cut to its first SNIPPET
   * characters filled in whole from the thread: a writer's note is told from a
   * hold by its whole text (decisionsOf, docs/board-decisions.md w11).
   */
  async function activityOf(taskId) {
    const record = list(await api("GET", `/issues/${taskId}/activity`), "activity");
    const cut = record.filter((a) => a.action === "issue.comment_added" && a.details?.body == null && String(a.details?.bodySnippet ?? "").length >= SNIPPET);
    if (!cut.length) return record;
    const whole = new Map(list(await api("GET", `/issues/${taskId}/comments`), "comments").map((c) => [c.id, c.body]));
    for (const a of cut) if (typeof whole.get(a.details.commentId) === "string") a.details = { ...a.details, body: whole.get(a.details.commentId) };
    return record;
  }
  /** Whether this bot may move a task out of the stop it is in now (see reconcilable). */
  async function mayMove(taskId, status) {
    const activity = await activityOf(taskId);
    return movable(statusSetter(activity, status, me.id), activity, me.id);
  }

  /**
   * A person's write to a task outranks every bot write decided before it. Each
   * status or blocker write the bot makes — a close, a hold put back, a
   * follow-up — is decided from the board as of `mark` (markOf), and the
   * record is read again just before it goes out: a person who changed the
   * task's status or waits since made the newer decision. Theirs stands, and
   * the bot comments instead (personStands). No write can be made conditional,
   * so one that lands between this read and the write is put back after it
   * (reopenIfMoved).
   */
  async function personDecided(taskId, mark) {
    return decidedSince(await activityOf(taskId), mark);
  }
  /** A status or waits decision, or a change of holder, by someone else since `mark` (w3). */
  const decidedSince = (record, mark) => Boolean(personSince(record, mark, me.id) || handedSince(record, mark, me.id));
  /** The comment a write a person's change stood over is replaced with, once per change. */
  async function personStands(taskId, mark, runId) {
    const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments");
    if (!comments.some((c) => c.authorAgentId === me.id && c.body === PERSON_STANDS && c.createdAt > atOf(mark))) {
      await api("PATCH", `/issues/${taskId}`, { comment: PERSON_STANDS }, runId);
    }
  }

  /** Whether the task is held by anyone but this bot now, or by nobody: whoever moved it there made the newer decision. */
  // Held by nobody is held elsewhere too: whoever unassigned it decided (w2).
  const heldElsewhere = (issue) => issue.assigneeAgentId !== me.id;

  /** The task's activity record — read only where it can change the status decided (decidedStatus). */
  async function recordFor(taskId, status) {
    return status === "in_progress" || STOPPED.has(status) ? activityOf(taskId) : null;
  }

  /** The ask on the task as the board shows it now, and the task's status as decided. */
  async function boardNow(taskId) {
    const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const issue = await api("GET", `/issues/${taskId}`);
    const status = decidedStatus(issue.status, await recordFor(taskId, issue.status), me.id);
    return { key: askKey(taskId, issue, askOf(comments, me.id)), status, external: external(issue), away: heldElsewhere(issue) };
  }

  /**
   * After closing a task, look once more: an update cannot be made conditional,
   * so anything that landed between the last read and the close was closed
   * over. A person who blocked or cancelled the task in that gap made a
   * decision that stands — Paperclip's own record of the close says which
   * status it replaced, and that status is put back. Otherwise a comment that
   * landed in the gap is a newer ask: the task goes back to todo, where
   * Paperclip itself moves a finished task a person comments on. The close is
   * recorded before it is sent and cleared only once this look succeeds; tick
   * retries any left over, across restarts. Only a task still done is touched:
   * a close that failed left it open anyway, and a change made after the close
   * is a person's own.
   */
  function closingNow(item, runId, key, as, mark, resumed = false) {
    closing.set(item.id, { runId, key, ...(as === "done" ? {} : { as }), mark, ...(resumed ? { resumed } : {}) });
    saveState(stateFile, state);
  }
  /**
   * The status this run's close (to `as`) replaced, and the write that had set
   * it, as Paperclip recorded them — with the waits the close replaced, and
   * whether a person changed the task's status or waits after `mark` and
   * before the close landed.
   */
  async function statusBeforeClose(taskId, runId, as, mark) {
    const activity = list(await activityOf(taskId), "activity");
    const at = activity.findIndex((a) => a.runId === runId && a.action === "issue.updated" && a.details?.changes?.status?.to === as);
    if (at < 0) return {};
    const { status: { from }, blockedByIssueIds: waits } = activity[at].details.changes;
    const setter = statusSetter(activity.slice(at + 1), from, me.id);
    return { from, setter, movable: movable(setter, activity.slice(at + 1), me.id), at: markAt(activity, at),
      waits: waits?.from, person: mark !== undefined && Boolean(personSince(activity.slice(at + 1), mark, me.id)) };
  }
  /** Paperclip's record of the newest status change this run made, from/to, and the board as of it (markAt). */
  async function lastStatusWrite(taskId, runId) {
    const activity = list(await activityOf(taskId), "activity");
    const at = activity.findIndex((a) => a.runId === runId && a.action === "issue.updated" && a.details?.changes?.status);
    return at >= 0 && { ...activity[at].details.changes.status, at: markAt(activity, at) };
  }
  /**
   * Put a status on a task that may have changed since it was read. No read
   * makes that safe, so the write is checked after it lands: Paperclip records
   * what each write replaced, under the row lock, and a write that replaced
   * anything but what was read stepped on a person's newer decision, which is
   * put back. The write is recorded before it is sent, so a response lost on
   * the way is settled from the board's record on the next tick.
   */
  // Paperclip refuses to block a task unless the write names who unblocks it,
  // and an agent may name only itself (live 2026-10-12: HTTP 422 on every
  // blocked close, retried each tick). The bot is that owner: a reply on the
  // task reopens it and the bot picks it up again.
  // A block that names the tasks it waits on links them, so Paperclip wakes the
  // bot when the last is done, and the descriptor says what is still open.
  // A close from an answer passes its waits, even none: the links are
  // replaced with exactly those, never left from an earlier block.
  // In review names its reviewer in the same write: Paperclip takes an agent's
  // in_review only with a review path, and a review stage is one an agent may
  // set — the reviewer becomes the holder, and the card returns to the bot.
  // A status put back for a person (reopenIfMoved) is theirs: no reviewer is named.
  // The bot is always the unblock owner: the board refuses an agent naming
  // anyone else (403 "Agents may only name themselves as an unblock owner"), so
  // a hold on a person reaches them as the task's assignee, with the action
  // naming them.
  const statusWrite = (status, waits, reviewer, person) => (status === "blocked"
    ? { status, unblockDescriptor: { owner: { agentId: me.id },
        action: person?.userId ? personAction(person.name) : waits?.names.length ? waitAction(waits.names) : UNBLOCK_ACTION },
      ...(waits ? { blockedByIssueIds: waits.ids } : {}) }
    : status === "in_review" && reviewer
      ? { status, executionPolicy: { stages: [{ type: "review", participants: [reviewer.agentId ? { type: "agent", agentId: reviewer.agentId } : { type: "user", userId: reviewer.userId }] }] } }
      : { status });
  /** A named task as the board has it; null when the board has no such task. Any other failure throws. */
  async function taskNamed(name) {
    try { return await api("GET", `/issues/${encodeURIComponent(name)}`); } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }
  /**
   * The named tasks still open, as ids to link. A name the board does not
   * know, a done task, or the task itself is left out. A lookup that fails
   * throws, so the post is retried rather than the wait dropped. `ready` —
   * every name is a task on this board other than this one, and done (see
   * allDone): told by the same lookups, so a task that reopens between two
   * looks can never leave a block that links nothing and was not ready.
   */
  async function resolveWaits(names, selfId) {
    const waits = { ids: [], names: [], done: [], ready: names.length > 0 };
    for (const n of names) {
      const t = await taskNamed(n);
      if (!(t?.id && t.id !== selfId && t.status === "done")) waits.ready = false;
      else if (!waits.done.includes(t.identifier ?? n)) waits.done.push(t.identifier ?? n);
      if (t?.id && t.id !== selfId && t.status !== "done" && !waits.ids.includes(t.id)) { waits.ids.push(t.id); waits.names.push(t.identifier ?? n); }
    }
    return waits;
  }
  /**
   * The named tasks, when every one is a task on this board other than this
   * one and all are done; else none. A failed lookup is none too: the answer
   * is in hand and must not be lost, and its post re-reads the waits.
   */
  async function allDone(names, selfId) {
    const done = [];
    for (const n of names) {
      let t;
      try { t = await taskNamed(n); } catch { return []; }
      if (!t?.id || t.id === selfId || t.status !== "done") return [];
      done.push(t.identifier ?? n);
    }
    return done;
  }
  // Decided from the board as of `mark`; a person's change since stands (personDecided).
  // `waits`, when given, are the task ids a person had it wait on, put back first.
  async function writeStatus(taskId, entry, status, expected, mark, waits) {
    if (await personDecided(taskId, mark)) {
      delete entry.wrote;
      await personStands(taskId, mark, entry.runId);
      return false;
    }
    if (waits) await api("PATCH", `/issues/${taskId}`, { blockedByIssueIds: waits }, entry.runId);
    entry.wrote = { status, expected };
    closing.set(taskId, entry);
    saveState(stateFile, state);
    try {
      await api("PATCH", `/issues/${taskId}`, statusWrite(status), entry.runId);
    } catch (err) {
      // Paperclip moves no task to in_progress while it waits on an open task
      // (HTTP 422): the waits put back stand, on the stop as it is.
      if (!(waits?.length && err.status === 422)) throw err;
      delete entry.wrote;
      saveState(stateFile, state);
    }
  }
  /** Settle a recorded write. False when it never landed, so nothing was set. */
  async function settleWrite(taskId, entry, tLog) {
    for (let landed = false; entry.wrote;) {
      const { status, expected } = entry.wrote;
      const last = await lastStatusWrite(taskId, entry.runId);
      if (last?.to !== status) { delete entry.wrote; return landed; }
      landed = true;
      if (last.from === expected) { delete entry.wrote; return true; }
      tLog.info({ issue: taskId, status: last.from }, "Paperclip task changed as the bot set it — the person's status put back");
      await writeStatus(taskId, entry, last.from, status, last.at);
    }
    return true;
  }
  /**
   * A blocked close that landed just after someone blocked the task replaced
   * their hold's waits and note with the bot's: Paperclip records it as the
   * same status reasserted. The hold is still theirs (lastDecision), and what
   * it said is put back — its waits, and its note as written when an agent
   * owns it; a person's note goes in a comment, since Paperclip lets an agent
   * name no one else as the one who unblocks. Resolves to whether there was
   * such a hold. Put back once: after that the close is no longer this run's
   * newest write, and the comment is already on the task.
   */
  async function restoreHold(taskId, runId, tLog) {
    const activity = list(await activityOf(taskId), "activity");
    const mine = (a) => a.runId === runId && a.action === "issue.updated" && a.actorType === "agent" && a.actorId === me.id;
    const at = activity.findIndex((a) => mine(a) && a.details?.status === "blocked" && !a.details.changes?.status && a.details.changes?.statusVersion);
    if (at < 0) return false;
    const held = statusSetter(activity.slice(at + 1), "blocked", me.id);
    if (!held || movable(held, activity.slice(at + 1), me.id)) return false;
    // Changed by a person since the close: their newer hold stands as they set it.
    const closed = markAt(activity, at);
    if (personSince(activity, closed, me.id)) {
      await personStands(taskId, closed, runId);
      tLog.info({ issue: taskId }, "Paperclip task was blocked by someone as the bot closed it, and changed by them since — their change stands");
      return true;
    }
    const { blockedByIssueIds: waits, unblockDescriptor: note } = activity[at].details.changes;
    const agentOwned = Boolean(note?.from?.owner?.agentId);
    if (activity.findIndex(mine) === at && (waits || agentOwned)) {
      await api("PATCH", `/issues/${taskId}`, { ...(waits ? { blockedByIssueIds: waits.from ?? [] } : {}), ...(agentOwned ? { unblockDescriptor: note.from } : {}) }, runId);
    }
    if (note?.from && !agentOwned) {
      const text = keptHold(note.from.action);
      const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments");
      if (!comments.some((c) => c.authorAgentId === me.id && c.body === text)) await api("PATCH", `/issues/${taskId}`, { comment: text }, runId);
    }
    tLog.info({ issue: taskId }, "Paperclip task was blocked by someone as the bot closed it — their hold stands, its waits and note put back");
    return true;
  }
  // `as` is the status the close set: done, or blocked when the run said it could not do the task.
  async function reopenIfMoved(taskId, { runId, key, as = "done" }, tLog) {
    const entry = closing.get(taskId)?.key === key ? closing.get(taskId) : { runId, key, as };
    if (!(entry.wrote && await settleWrite(taskId, entry, tLog))) {
      const now = await boardNow(taskId);
      if (now.status === as && !(as === "blocked" && await restoreHold(taskId, runId, tLog))) {
        const { from: before, movable: mine, at, waits, person } = await statusBeforeClose(taskId, runId, as, entry.mark);
        // A stop someone chose, or anything a person set — status or waits —
        // after the close was decided: their status goes back, and their waits.
        // The block a hop handed the card back in is no one's hold (hopOf).
        const theirs = person || (STOPPED.has(before) && !mine && !entry.resumed);
        if (before && before !== as && theirs) {
          await writeStatus(taskId, entry, before, as, at, person ? waits : undefined);
          tLog.info({ issue: taskId, status: before }, "Paperclip task was decided as it closed — put back");
        } else if (now.key !== key) {
          await writeStatus(taskId, entry, "todo", as, at ?? entry.mark ?? "");
          tLog.info({ issue: taskId }, "Paperclip task got a newer ask as it closed — reopened");
        }
        if (entry.wrote) await settleWrite(taskId, entry, tLog);
      }
    }
    if (closing.get(taskId)?.key === key) closing.delete(taskId);
    saveState(stateFile, state);
  }

  /**
   * End a run whose ask is already answered, without running it again. A run
   * is held open until a comment lands under it, so it gets a short note —
   * unless the board already shows one under this run (a post that landed
   * though its response was lost). A failed note throws, and the next tick
   * retries it: the run is handled only once the board has its comment.
   * The note closes the task as its answer left it, decided from the board as
   * that answer was (decidedFrom): a person's change since stands. An ask
   * answered blocked is still in its wait, so a wake's checkout of the bot's
   * own block is put back, on the tasks it still waits on; any other stop
   * stays as it is.
   *
   * Every run ends only on a comment of its own, and a hand-off can bring
   * three wakes (its own, a comment just after, Paperclip's review recovery).
   * Each note repeats the answer's first line and who the task waits on, so
   * the card still reads as the answer did. No earlier note is taken down:
   * the board shows a deleted comment as a blank one, which read as the bot
   * posting nothing (SLA-1621).
   */
  async function acknowledge(item, runId, comments, key, mark, issue) {
    const as = blockedAsks.has(key) ? "blocked" : "done";
    const waitsOn = as === "blocked" ? (issue.blockedBy ?? []).map(nameOf) : [];
    // A note that already landed was recorded as a close when it was sent.
    const noted = comments.some((c) => c.createdByRunId === runId);
    const answer = comments.filter((c) => !c.deletedAt && c.authorAgentId === me.id && c.body && !isNote(c.body)).at(-1);
    const note = unchangedNote(answer?.body, waitsOn.length ? waitsOn.join(", ") : as === "blocked" ? await ownerName(issue) : null);
    // An ask answered `review` is the reviewer's to move on: the note leaves
    // the card's status and review path as they are.
    if (!noted && reviewAsks.has(key)) {
      await api("PATCH", `/issues/${item.id}`, { comment: note }, runId);
      handled.add(runId);
      saveState(stateFile, state);
      return;
    }
    const closed = !noted
      && await reply(item, runId, key, note, as, { moveStopped: as === "blocked", waitsOn, unlessReady: as === "blocked", mark: decidedFrom.get(key) ?? mark });
    // The last of its waits finished since this tick read the task: nothing
    // was written, and the run is left for the next tick, which resumes the ask.
    if (closed === READY) return;
    handled.add(runId);
    saveState(stateFile, state);
    if (closed) await reopenIfMoved(item.id, { runId, key, as }, log);
  }

  /**
   * End a live run that does no work with a note under it. Paperclip holds a
   * run open until a comment lands under it (steps 2–3 above), so a wake that
   * is only left as it is still needs one, or its waiter never ends. Nothing is
   * posted when the board already shows a comment under this run. An earlier
   * note is never taken down: the board shows a deleted comment as a blank
   * one, which read as the bot posting nothing (SLA-1621).
   */
  async function endRun(item, runId, comments, body, { alone = false } = {}) {
    if (comments.some((c) => c.createdByRunId === runId)) return;
    // A card another seat has checked out refuses this seat's update (its
    // run lock), but not a comment on its own.
    if (alone) await api("POST", `/issues/${item.id}/comments`, { body }, runId);
    else await api("PATCH", `/issues/${item.id}`, { comment: body }, runId);
  }

  /**
   * Post a comment under the run, and close the task with it only if the board
   * still shows the ask it answers and nobody has decided the task's fate since:
   * a newer comment or a revised task is an ask this answer never saw, and a
   * task someone blocked or cancelled stays that way. A stop nobody chose — the
   * bot's own block, or Paperclip's when it lost the run — is no decision, and
   * a real answer moves the task on from it (`moveStopped`); a note that the
   * ask was already answered never does. A task another writer owns gets the
   * comment only. It closes as `as`: done, or blocked when the run said it
   * could not do the task, linked to the tasks it waits on. The close was
   * decided from the board as of `mark`: a person who changed the task's
   * status or waits since — up to the last read before the write, after its
   * waits are looked up — gets the comment only (personDecided). Resolves to
   * whether the task was closed.
   */
  async function reply(item, runId, key, comment, as = "done", { moveStopped = true, waitsOn = [], unlessReady = false, mark, giveTo = null,
    handOff = null, resumed = false, reviewer = null } = {}) {
    // A blank comment reads on the card as the bot saying nothing (SLA-1621).
    if (!String(comment ?? "").trim()) comment = FALLBACK_REPLY;
    const now = await boardNow(item.id);
    // Handed to someone else while it was answered: theirs now, so the comment only.
    // A card handed back down to the bot (hopOf `resumed`) is in the hop's
    // block, no one's hold: its answer moves it on like the bot's own.
    let close = now.key === key && !now.external && !now.away
      && (!STOPPED.has(now.status) || (moveStopped && (resumed || await mayMove(item.id, now.status))));
    const waits = close && as === "blocked" ? await resolveWaits(waitsOn, item.id) : undefined;
    // Every task the block names is done by now: it would wait for a wake that
    // never comes. Nothing is written, so the caller can go on with the work.
    if (unlessReady && waits?.ready) return READY;
    close &&= !await personDecided(item.id, mark);
    // Through process.escalate: the action's own write carries the hand-off,
    // the block and the record, so nothing here closes the card.
    if (close && handOff) {
      await handOff(comment);
      return false;
    }
    if (close) closingNow(item, runId, key, as, mark, resumed);
    // Handed back blocked (`return`): the task goes to whoever gave it, in the
    // same write, and the comment says what is left for them. The write still
    // carries the unblock note the board demands of every block (statusWrite):
    // without it the board refused every hand-back (live 2026-10-14, HTTP 422
    // "Entering blocked requires ... unblockDescriptor"). A hand-off the board
    // refuses closes the task blocked with the bot, and the comment says so.
    if (close && giveTo) {
      try {
        await api("PATCH", `/issues/${item.id}`, { ...statusWrite(as, waits, null, giveTo.person ? giveTo : null), assigneeAgentId: giveTo.agentId ?? null, assigneeUserId: giveTo.userId ?? null, comment }, runId);
        return close;
      } catch (err) {
        if (!(err.status >= 400 && err.status < 500)) throw err;
        log.error({ err: err.message, to: giveTo.name, issue: item.id }, "Paperclip hand-back refused by the board — the task stays with this bot");
        comment = `${comment}\n\nI could not hand this task ${giveTo.person ? "to" : "back to"} ${giveTo.name}: the board refused it (${err.status}).`;
      }
    }
    await api("PATCH", `/issues/${item.id}`, close ? { ...statusWrite(as, waits, reviewer), comment } : { comment }, runId);
    return close;
  }

  /**
   * A blocked task waiting on several others, some now done: the link and the
   * descriptor are cut down to the ones still open, so the card says what it
   * still waits on. Only a block of the bot's own; when the last is done
   * Paperclip wakes the bot, and the task resumes (handleTask). Paperclip takes
   * no agent write without a run (403 cross_issue_influence_run_context_required),
   * and none is open here, so it is made under the bot's latest run on this same
   * task: finished is fine, and on its own task it never counts against the
   * run's cross-task cap.
   */
  /**
   * The tasks an escalation's answer linked that are done, remembered in the
   * state file: the card's own waits forget a done link once it is trimmed
   * (reconcileWaiting), and the card resumes only when every one is done (w4).
   */
  function rememberDone(taskId, blockers) {
    let grew = false;
    for (const [k, ids] of linked) {
      if (!k.startsWith(`${taskId}:`)) continue;
      const have = linkDone.get(k) ?? [];
      const add = blockers.filter((b) => b.status === "done" && ids.includes(b.id) && !have.includes(b.id)).map((b) => b.id);
      if (add.length) { linkDone.set(k, [...have, ...add]); grew = true; }
    }
    if (grew) saveState(stateFile, state);
  }
  async function reconcileWaiting(item, runs) {
    if (item.status !== "blocked" || !item.unresolvedBlockerIssueIds?.length) return;
    const last = list(runs, "runs").find((r) => r.agentId === me.id && (r.contextIssueId ?? item.id) === item.id);
    if (!last) return;
    // Read before the task, so a person's change between the reads is after the mark (handleTask).
    const record = await activityOf(item.id);
    const issue = await api("GET", `/issues/${item.id}`);
    const blockers = issue.blockedBy ?? [];
    rememberDone(item.id, blockers);
    const done = blockers.filter((b) => b.status === "done"), open = blockers.filter((b) => b.status !== "done");
    if (!done.length || !open.length || external(issue) || heldElsewhere(issue)) return;
    // Its own block, unchanged by a person since: the next poll decides again from theirs.
    if (!reconcilable(statusSetter(record, "blocked", me.id), me.id) || await personDecided(item.id, markOf(record))) return;
    await api("PATCH", `/issues/${item.id}`, { blockedByIssueIds: open.map((b) => b.id),
      unblockDescriptor: { owner: { agentId: me.id }, action: waitAction(open.map(nameOf), done.map(nameOf)) } }, runIdOf(last));
    log.info({ issue: issue.identifier, waitsOn: open.map(nameOf), done: done.map(nameOf) }, "Paperclip task still waits — now only on what is open");
  }

  /**
   * While the bot answers, Paperclip may lose the run that holds the task (the
   * board's wait on it failed) and block the task, though the work goes on here
   * and its answer is still coming. The task gets a note saying so, under the
   * lost run, and the bot wakes itself on the task: Paperclip opens a new run
   * and checks the task out under it, and the answer closes it under that run
   * — an ended run may not write to an in-progress task. One attempt, never a
   * second launch. If no run opens, the task stays blocked with its note and
   * the answer closes it from there. `moved(runId)` hears of each new run.
   * A task cancelled, or handed on by a person, stops the attempt's worker
   * (unwanted, EM#626). A durable attempt's lost run takes no write at all:
   * `lost(runId)` hears of it, and the answer waits for a new run (deferLost).
   */
  /** Whether the board's own recovery settled this task blocked because it lost `runId` (its restart). */
  async function lostUnder(issue, runId) {
    if (issue.status !== "blocked" || external(issue)) return false;
    const setter = statusSetter(await activityOf(issue.id), "blocked", me.id);
    return setter?.action === "issue.execution_recovery_settled" && setter.runId === runId && reconcilable(setter, me.id);
  }

  function watchRun(item, runId, tLog, moved, attemptId, lost, mark) {
    let current = runId, noted = false, gone = false, looking = false;
    const timer = setInterval(async () => {
      // A lost run still watches for a person's cancel, hold or hand-on: the worker runs on.
      if ((noted && !gone) || looking) return;
      looking = true;
      try {
        const issue = await api("GET", `/issues/${item.id}`);
        if (attemptId && attempts && await unwanted(issue, mark)) {
          if (attempts.stop(attemptId)) tLog.warn({ attempt: attemptId, status: issue.status }, "Paperclip task cancelled or handed on — its worker is stopped");
          return;
        }
        if (gone || !await lostUnder(issue, current)) return;
        if (attemptId && attempts && lost) {
          // The board's block already says the run ended. Nothing is written
          // under it: its credentials are not the worker's any more (EM#626 D′).
          noted = gone = true;
          lost(current);
          tLog.warn({ attempt: attemptId }, "Paperclip lost this run while its worker still runs — nothing is written under it; the answer waits for a new run");
          return;
        }
        await api("PATCH", `/issues/${item.id}`, { comment: TRANSPORT_NOTE }, current);
        noted = true;
        let next = null;
        try {
          next = await api("POST", `/agents/${me.id}/wakeup`, { source: "automation", reason: "paperclip_transport_recovered", payload: { issueId: item.id } });
        } catch (err) {
          tLog.warn({ err: err.message }, "Paperclip would not open a new run — the answer closes the task from blocked");
        }
        if (next?.id) {
          current = next.id;
          noted = false;
          moved(current);
          tLog.warn({ newRunId: current }, "Paperclip lost this run and blocked the task — the answer is still coming, under a new run");
        } else tLog.warn("Paperclip lost this run and blocked the task — noted on the task, the answer is still coming");
      } catch (err) {
        tLog.warn({ err: err.message }, "Paperclip run watch failed — looking again");
      } finally { looking = false; }
    }, watchMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Hand a worked escalation on with its answer, in one write under the run,
   * the card left blocked (escalationOwner decides it may): up to `escalateTo`
   * when the answer escalates, back down when it resolves. A person handed one
   * going up is also told once, off the board (onEscalate). No seat by that
   * name, or a hand-off the board refuses, is said on the card instead.
   */
  async function handOn(item, runId, issue, { comment, escalate, latest }, target, tLog, seats) {
    const path = `/issues/${item.id}`;
    const to = await holderFor(target, seats);
    if (!to) {
      await api("PATCH", path, { comment: `${comment}\n\nI could not hand this card to ${target.name}: the board has no seat by that name.` }, runId);
      tLog.error({ to: target.ref }, "Paperclip escalation — no seat by that name; the card stays with this bot");
      return;
    }
    try {
      await api("PATCH", path, { assigneeAgentId: to.agentId ?? null, assigneeUserId: to.userId ?? null, comment }, runId);
    } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) throw err;
      await api("PATCH", path, { comment: `${comment}\n\nI could not hand this card to ${to.name}: the board refused it (${err.status}).` }, runId);
      tLog.error({ err: err.message, to: to.name }, "Paperclip escalation — the board refused the hand-off; the card stays with this bot");
      return;
    }
    tLog.info({ to: to.name, way: escalate ? "up" : "down" }, "Paperclip escalation handed on — the card left blocked");
    // Once per escalation: this write is made once per ask (a re-wake on an
    // unchanged card is never worked again), and the card is no longer this bot's.
    // The person is asked what the latest attempt asks (r2): the post may carry
    // earlier attempts' answers above it, whose first line is an older question.
    if (escalate && to.userId && onEscalate) {
      const ask = (latest ?? comment).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      try { await onEscalate({ task: issue.identifier, link: cardLink(issue), to: to.name, ask }); } catch (err) {
        tLog.warn({ err: err.message }, "Paperclip escalation — telling the person off the board failed; the card is with them");
      }
    }
  }
  /**
   * Hand the card on through process.escalate (SLA-1493): the action checks
   * the chain, moves the card and records the hop in one write, and a retry of
   * the same ask's hand-off is a replay that writes nothing. The answer rides
   * in that write (blocker or resolution), so nothing else is posted: a
   * comment would end the run. One the action refuses is tried once more as a
   * hand_up; refused again, the card stays blocked with this bot, and its
   * comment and unblock step carry each refusal's exact code and message.
   * Resolves to `{ handoff }`: the operation that landed, or "refused".
   */
  async function handOffVia(item, runId, key, comment, operation, tLog) {
    const call = async (op, extra = {}) => {
      let out;
      try {
        out = await escalateClient({ operation: op, issue: item.id, idempotencyKey: `${key}:${op}`,
          ...(op === "hand_up" ? { blocker: comment, ...extra } : { resolution: comment }) }, { runId });
      } catch (err) { out = { ok: false, code: "escalate_unreachable", message: err.message }; }
      return out?.ok === true ? out : { ok: false, code: out?.code ?? "escalate_unreadable", message: out?.message ?? "escalate gave no result" };
    };
    const first = await call(operation);
    if (first.ok) {
      tLog.info({ handoff: operation, to: first.holder?.id ?? null, replayed: Boolean(first.replayed) }, "Paperclip task handed on through process.escalate");
      return { handoff: operation };
    }
    // The fallback hand-up records the refusal on the card, in its hop's
    // "Attempted": whoever it reaches reads what the board said.
    const refused = (op, r) => `process.escalate ${op}: ${r.code}: ${r.message}`;
    // Before the fallback moves the card — which ends this run — the refusal
    // goes into the block's unblock step under the run still open. The card is
    // already blocked (keepBlocked), and the action keeps the step of a card
    // already blocked, so whoever the fallback reaches reads it there too.
    let second = null;
    if (operation !== "hand_up") {
      try {
        await api("PATCH", `/issues/${item.id}`, { unblockDescriptor: { owner: { agentId: me.id },
          action: `The hand-off asked for was refused (${refused(operation, first)}), so it was handed up instead. Read the latest comments, then resolve it or return it down the chain.` } }, runId);
      } catch (err) {
        if (!(err.status >= 400 && err.status < 500)) throw err;
        tLog.warn({ err: err.message }, "Paperclip hand-off refusal not written to the unblock step — it is in the hop's comment");
      }
      second = await call("hand_up", { attempted: `${refused(operation, first)} (the hand-off asked for was refused; handed up instead)` });
    }
    const refusals = [[operation, first], ...(second && !second.ok ? [["hand_up", second]] : [])].map(([op, r]) => ({ operation: op, code: r.code, message: r.message }));
    if (second?.ok) {
      tLog.error({ refusals, fallback: "hand_up", to: second.holder?.id ?? null, replayed: Boolean(second.replayed) },
        "Paperclip hand-off refused — handed up instead, with the refusal on the card");
      return { handoff: "refused", fallback: "hand_up" };
    }
    const action = `The hand-off was refused (${refusals.map((r) => refused(r.operation, r)).join("; ")}). Read the last comment, then hand this task on yourself or reply on it.`;
    const said = refusals.map((r) => `- ${r.operation}: ${r.code}: ${r.message}`).join("\n");
    await api("PATCH", `/issues/${item.id}`, { status: "blocked", unblockDescriptor: { owner: { agentId: me.id }, action },
      comment: `${comment}\n\nI could not hand this task on: the escalation action refused it.\n${said}` }, runId);
    tLog.error({ refusals }, "Paperclip hand-off refused — the task stays with this bot, blocked");
    return { handoff: "refused" };
  }
  /**
   * Put an escalation's card back to blocked after the wake's checkout, by
   * status alone (a comment would end the run). Only the unrecorded checkout is
   * undone: a recorded move since — a person taking the card out of blocked —
   * stands.
   */
  async function keepBlocked(item, runId, tLog) {
    const path = `/issues/${item.id}`;
    const now = await api("GET", path);
    if (now.status === "blocked" || decidedStatus(now.status, await recordFor(item.id, now.status), me.id) !== "blocked") return;
    // Entering blocked must name what unblocks it, and a bot may name only
    // itself (a bare status was refused 422 on the live board, 2026-10-14,
    // leaving every worked escalation in_progress). The card's own unblock
    // step is kept as the action.
    const action = now.unblockDescriptor?.action || UNBLOCK_ACTION;
    try { await api("PATCH", path, { status: "blocked", unblockDescriptor: { owner: { agentId: me.id }, action } }, runId); } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) throw err;
      tLog.warn({ err: err.message, status: now.status }, "Paperclip escalation — the board refused putting the card back to blocked; it is left as the board has it");
    }
  }
  /** The board's agent seats; none when the board will not list them. */
  async function seatsOf() {
    try { return list(await api("GET", `/companies/${me.companyId}/agents`), "agents"); } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) throw err;
      return [];
    }
  }
  /**
   * A holder as the board names it: an agent seat found by id, else by name,
   * or a board user. Null when no seat matches. An exact id wins over a name
   * that happens to equal it (w7). `seats`, when given, is a listing read
   * before the card was validated, so nothing is fetched between that read
   * and the write it guards (w9).
   */
  async function holderFor(target, seats) {
    if (target.kind === "user") return { userId: target.ref, name: target.name };
    // A holder read off the card's own record is a seat id the board gave.
    if (target.recorded) return { agentId: target.ref, name: target.name };
    const ref = target.ref.toLowerCase(), all = seats ?? await seatsOf();
    const seat = all.find((a) => a.id === target.ref) ?? all.find((a) => String(a.name ?? "").toLowerCase() === ref);
    return seat ? { agentId: seat.id, name: seat.name ?? target.name } : null;
  }
  /** The board's people: [{ id, name }]. Empty when the board will not list them. */
  async function peopleOf() {
    try {
      return list(await api("GET", `/companies/${me.companyId}/user-directory`), "users")
        .filter((u) => u.status !== "archived").map((u) => ({ id: u.principalId ?? u.user?.id, name: u.user?.name ?? "" })).filter((u) => u.id);
    } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) throw err;
      return [];
    }
  }
  /** A person a blocked answer names, as a holder: a configured escalation person, else a board user of that name. Null when none is. */
  async function personNamed(name) {
    const want = String(name).trim().toLowerCase();
    const known = [escalateTo, escalationReturnTo].find((t) => t?.kind === "user" && t.name.toLowerCase() === want);
    if (known) return { userId: known.ref, name: known.name, person: true };
    const hit = (await peopleOf()).find((u) => u.name.toLowerCase() === want);
    return hit ? { userId: hit.id, name: hit.name, person: true } : null;
  }
  /** Who a blocked task waits on, when that is someone other than this bot: the person holding it, else whoever its unblock note names. */
  async function ownerName(issue) {
    if (issue.assigneeUserId) return (await peopleOf()).find((u) => u.id === issue.assigneeUserId)?.name ?? null;
    const owner = issue.unblockDescriptor?.owner;
    if (owner?.userId) return (await peopleOf()).find((u) => u.id === owner.userId)?.name ?? null;
    if (owner?.agentId && owner.agentId !== me.id) return (await seatsOf()).find((a) => a.id === owner.agentId)?.name ?? null;
    return null;
  }
  /** A chain holder (`agent:<id>` / `user:<id>`) as a target with a name to call it by. */
  async function targetOf(holder, seats) {
    if (!holder) return null;
    const [kind, ref] = [holder.slice(0, holder.indexOf(":")), holder.slice(holder.indexOf(":") + 1)];
    const known = [escalateTo, escalationReturnTo].find((t) => t?.kind === kind && t.ref === ref);
    if (known) return known;
    if (kind === "user") return { kind, ref, name: "the person who handed it to you" };
    const seat = (seats ?? await seatsOf()).find((a) => a.id === ref);
    return { kind, ref, name: seat?.name ?? "the agent that handed it to you", recorded: true };
  }

  /**
   * Whether nobody wants an attempt's work any more: its task is cancelled, a
   * person put it on hold, or a person handed it to someone else. A hand-off the seat made itself (its
   * model's process.escalate) is not that: its answer still comes. Only a
   * person's change after `mark` — the board as the attempt was admitted from
   * it (decidedFrom) — counts: the status that let it in (an escalation's
   * block, a card in review, the Foreman's hand-over) is no withdrawal.
   */
  async function unwanted(issue, mark) {
    if (issue.status === "cancelled") return true;
    const activity = list(await api("GET", `/issues/${issue.id}/activity`), "activity");
    // A person's hold: they stopped the task where it stands (blocked, done,
    // in review) with the bot still on it. A recovery block (system) and the
    // model's own escalation (agent) are not a person's, and do not stop it.
    // Read from the write that decided the stop (lastDecision): the newest
    // status write alone skips a recovery settlement and lands on whoever
    // set the card up.
    const since = (a) => a?.actorType === "user" && (mark === undefined || after(a, mark));
    const decided = lastDecision(activity, me.id);
    if (decided && !["todo", "in_progress"].includes(decided.to) && since(decided.w)) return true;
    if (issue.assigneeAgentId === me.id) return false;
    return since(activity.find((a) => a.details?.changes?.assigneeAgentId || a.details?.changes?.assigneeUserId));
  }

  /** What became of a stopped attempt, from its own record, as the board's reconciliation evidence. */
  function stoppedAttempt(id, runId) {
    const s = attempts.current(id);
    const actionOutcome = s.phase === "finished" && s.exit?.code === 0 ? "completed" : s.phase === "unlaunched" || s.phase === "none" ? "not_performed" : "mixed";
    const ended = s.exit ? `exited ${s.exit.code ?? s.exit.signal}${s.exit.cause ? ` (${s.exit.cause})` : ""} at ${s.exit.at}` : s.phase;
    return { runId, providerStopped: true, actionOutcome,
      outcomeEvidence: `Bot attempt ${id}: its worker ${ended}. Its result is posted from the attempt's record; it is not run again.` };
  }

  /**
   * A run lost while the bot was away leaves its task in Paperclip's legacy
   * reconciliation hold, which refuses every later wake (EM#609). Once the
   * attempt's worker has stopped, the bot says what became of it, from the
   * attempt's own record, and wakes itself: the stored result is delivered
   * under the new run, never run again. While the worker holds its lock
   * nothing is sent — the work is still going. True when the task waits on it.
   */
  async function releaseLostRun(item, runId, key, tLog) {
    const id = attemptIds.get(key);
    if (!attempts || !id) return false;
    let held;
    try { held = (await api("GET", `/issues/${item.id}/recovery-actions`))?.active; } catch { return false; }
    if (held?.cause !== "legacy_execution_requires_reconciliation" || held.evidence?.runId !== runId) return false;
    const s = attempts.current(id);
    if (s.phase === "running" || s.phase === "launching") {
      tLog.info({ attempt: id }, "Paperclip lost this run while its worker still runs — the hold is cleared once it stops");
      return true;
    }
    const executionReconciliation = stoppedAttempt(id, runId);
    const { actionOutcome } = executionReconciliation;
    await api("POST", `/issues/${item.id}/recovery-actions/resolve`, { actionId: held.id, outcome: "restored", sourceIssueStatus: "todo", executionReconciliation }, runId);
    try {
      await api("POST", `/agents/${me.id}/wakeup`, { source: "automation", reason: "paperclip_attempt_reconciled", payload: { issueId: item.id } });
    } catch (err) {
      tLog.warn({ err: err.message }, "Paperclip would not open a new run — the next wake on the task posts the result");
    }
    tLog.warn({ attempt: id, actionOutcome }, "Paperclip lost this run while the bot was away — reconciled from the attempt's record; its result goes out under the next run");
    return true;
  }

  /**
   * The answer of an attempt whose task left this seat's inbox while the bot
   * was away, though nobody stopped it: its model handed the task on, or
   * closed it, itself (process.escalate). It is posted once, as a comment
   * only — the model's own write decided where the task stands, and this
   * never reverses it — under the attempt's run, found by its mark if a post
   * already landed. Read from the attempt's record, never run again.
   */
  async function deliverOutside(issue, k, id) {
    const s = attempts.current(id);
    if (s.phase !== "finished" && s.phase !== "died") return;
    const tLog = log.child({ paperclipTask: issue.identifier ?? issue.id, attempt: id });
    const mark = attemptMark(id);
    const comments = list(await api("GET", `/issues/${issue.id}/comments`), "comments");
    const landed = comments.find((c) => c.authorAgentId === me.id && c.body?.includes(mark));
    if (!landed) {
      let body = pending.get(k);
      if (!body) {
        try {
          body = s.phase === "died" ? workerDiedNote(id, s.started?.at, s.exit?.signal) : (await answer("", issue, { runId: attemptRuns.get(k), attemptId: id })).trim();
        } catch (err) {
          tLog.error({ err: err.message }, "Paperclip attempt's answer not read from its record");
        }
        body ||= FALLBACK_REPLY;
        if (continuing.has(k)) body = `${continuing.get(k).prefix}\n\n${body}`;
        pending.set(k, body);
        saveState(stateFile, state);
      }
      // A comment alone, through the comments route: the recipient may hold
      // the card checked out by now, and the board's assignee run lock
      // refuses another seat's update to it, never a comment.
      await api("POST", `/issues/${issue.id}/comments`, { body: `${outcomeOf(body).comment || FALLBACK_REPLY}\n\n${mark}` }, attemptRuns.get(k));
    }
    pending.delete(k); since.delete(k); attemptRuns.delete(k); continuing.delete(k); attemptIds.delete(k);
    answered.add(k);
    saveState(stateFile, state);
    tLog.info("Paperclip attempt ended after its task was handed on by its own model — its answer is posted as a comment, the hand-off stands");
  }

  /**
   * A durable attempt's run was lost while its worker ran (watchRun), and the
   * worker has stopped now. Its answer is stored, told the run was lost, and
   * goes out under a new run only (EM#626 D′). The board settled the lost run
   * as "blocked, never replayed", and that settlement refuses every wake on
   * the card until its outcome is reconciled: the bot files what became of the
   * attempt, from its own record, on that settlement (EM#609's evidence path;
   * the board moves the card back to todo), then wakes itself, and the next
   * tick posts it. A card someone moved since keeps their decision, and the
   * answer waits for its next run. True when the answer waits.
   */
  async function deferLost(item, k, gone, tLog) {
    const body = pending.get(k);
    if (body) pending.set(k, `${LOST_NOTE}\n\n${body}`);
    const id = attemptIds.get(k);
    attemptRuns.delete(k);
    handled.add(gone);
    saveState(stateFile, state);
    try {
      const setter = statusSetter(await api("GET", `/issues/${item.id}/activity`), "blocked", me.id);
      if (setter?.action === "issue.execution_recovery_settled" && setter.runId === gone && reconcilable(setter, me.id)) {
        await api("POST", `/issues/${item.id}/recovery-actions/resolve`, { actionId: setter.details?.recoveryActionId, outcome: "restored",
          sourceIssueStatus: "todo", executionReconciliation: stoppedAttempt(id, gone) }, gone);
        const next = await api("POST", `/agents/${me.id}/wakeup`, { source: "automation", reason: "paperclip_attempt_reconciled", payload: { issueId: item.id } });
        if (!next?.id) tLog.warn({ wake: next?.reason ?? next?.status }, "Paperclip took the reconciliation but opened no run — the answer waits for the task's next run");
      }
    } catch (err) {
      tLog.warn({ err: err.message }, "Paperclip would not take the reconciliation or open a run — the answer waits for the task's next run");
    }
    tLog.warn({ lostRunId: gone }, "Paperclip lost this run while the worker ran — its answer is stored and goes out under the next run");
    return true;
  }

  /** One task. Its failure is its own: it never holds up the rest of the inbox. */
  async function handleTask(item) {
    const runs = await api("GET", `/issues/${item.id}/runs`);
    let open = pickOpenRun(runs, me.id, handled);
    // Only a live run takes more work; a gone one only gets its answer posted.
    const live = Boolean(open);
    if (!open) {
      // An attempt still owed whose run is gone — Paperclip gave up on it while
      // the bot was down — is posted on its task under that run all the same.
      const owedRun = [...pending.keys()].filter((k) => k.startsWith(`${item.id}:`)).map((k) => attemptRuns.get(k)).find(Boolean);
      // A run Paperclip cancelled takes no write ever again (403
      // agent_run_cancelled): what it owes waits for the task's next run (SLA-1337).
      const cancelled = list(runs, "runs").some((r) => runIdOf(r) === owedRun && r.status === "cancelled");
      const owedKey = owedRun && [...attemptRuns].find(([k, r]) => r === owedRun && k.startsWith(`${item.id}:`))?.[0];
      if (owedKey && await releaseLostRun(item, owedRun, owedKey, log.child({ paperclipTask: item.identifier ?? item.id, runId: owedRun }))) return;
      if (!owedRun || handled.has(owedRun) || cancelled) return reconcileWaiting(item, runs);
      open = { id: owedRun };
    }
    const runId = runIdOf(open);
    // The run the answer goes out under: this one, or the one that replaced it when Paperclip lost it (watchRun).
    let postRun = runId;
    // The board as this tick decides from it: whatever it writes leaves a
    // person's later change to the task's status or waits standing
    // (personDecided). Read before the task itself, so a change made between
    // the reads is after the mark, never taken as seen.
    const activity = await activityOf(item.id);
    const decidedAt = markOf(activity);
    const issue = await api("GET", `/issues/${item.id}`);
    const comments = list(await api("GET", `/issues/${item.id}/comments`), "comments")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // A saved answer belongs to the task and the ask, not the run: Paperclip
    // re-wakes an open task under a new run id, and that run must find it too.
    const ask = askOf(comments, me.id);
    const mine = `${item.id}:`;
    // An escalation is asked again by a new comment or by a new hand-off to the bot.
    const hop = hopOf(issue, comments, decidedStatus(issue.status, activity, me.id), activity);
    const escalated = hop?.kind === "escalated" || escalation(issue, decidedStatus(issue.status, activity, me.id));
    const key = askKey(item.id, issue, ask, escalated ? handedAt(activity) : undefined);
    // An ask is answered only while it is the task's latest answered one: a
    // card revised A→B→A asks A again, as new (w6).
    if (answered.has(key) && lastAnswered.has(item.id) && lastAnswered.get(item.id) !== key && !pending.has(key)) {
      answered.delete(key); blockedAsks.delete(key); linked.delete(key); linkDone.delete(key);
      saveState(stateFile, state);
    }
    rememberDone(item.id, issue.blockedBy ?? []);
    // Where a resolved escalation goes, as the record read shows it: back down
    // the hop that brought it here, else the configured return, else whoever
    // handed it up to this bot.
    const downOn = async (record, seats) => hop?.kind === "escalated" ? await targetOf(`agent:${hop.below}`, seats)
      : escalationReturnTo ?? await targetOf(placeOn(record).below, seats);
    // Everything still owed on this task goes out in one comment, oldest ask
    // first, so an earlier ask whose answer never posted is not dropped by a
    // newer one. Built from saved state only, so a retry posts the same text.
    // The newest owed answer decides the status: blocked when it says it could
    // not do its ask — or when its run produced no answer (it failed, or the
    // bot died mid-run): the fallback says nothing was done. An older answer
    // still owed goes out as text only; a newer ask has moved past it.
    // The attempts owed on this task, oldest first by the attempt sequence
    // (docs/board-decisions.md (b)): an ask asked again is its newest attempt,
    // wherever its key was first saved. `except` leaves one out.
    const owedKeys = (except) => [...pending.keys()].filter((k) => k.startsWith(mine) && k !== except)
      .map((k, i) => [k, attemptSeq.get(k) ?? 0, i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([k]) => k);
    // An attempt begins: saved as owed before it runs, numbered after every
    // earlier one. Asked again, an ask's earlier answer is replaced.
    const begin = (k) => {
      pending.set(k, "");
      attemptSeq.set(k, ++state.seq);
      leads.delete(k);
      continuing.delete(k);
    };
    const owed = (except) => {
      const keys = owedKeys(except);
      const parts = keys.map((k) => ({ ...(pending.get(k) ? outcomeOf(pending.get(k))
        : { comment: continuing.has(k) ? `${continuing.get(k).prefix}\n\n${FALLBACK_REPLY}` : FALLBACK_REPLY, status: "blocked", waitsOn: [] }), mark: attemptIds.has(k) ? attemptMark(attemptIds.get(k)) : "" }));
      const last = parts.at(-1) ?? { status: "done", waitsOn: [] };
      // The latest attempt's own answer, without what a go-on or a resume put before it.
      const lead = keys.length ? leads.get(keys.at(-1)) : undefined;
      const own = last.comment && lead && last.comment.startsWith(lead) ? last.comment.slice(lead.length).trim() : last.comment;
      return { comment: parts.map((p) => [p.comment || FALLBACK_REPLY, p.mark].filter(Boolean).join("\n\n")).join("\n\n---\n\n"), status: last.status, waitsOn: last.waitsOn, person: last.person ?? null, escalate: Boolean(last.escalate), giveBack: Boolean(last.giveBack),
        latest: own || FALLBACK_REPLY };
    };
    // Each ask still owed is answered as its own answer says, in the post the
    // run `by` wrote: one posted with a newer ask's answer keeps its own. A
    // blocked answer is in a wait named by that run, fixed here and never
    // worked out again from what the task waits on; any other answer is final.
    const settle = (by) => {
      const latest = owedKeys().at(-1);
      if (latest) lastAnswered.set(item.id, latest);
      for (const k of [...pending.keys()]) {
        if (!k.startsWith(mine)) continue;
        const status = pending.get(k) ? outcomeOf(pending.get(k)).status : "blocked";
        pending.delete(k); since.delete(k); attemptRuns.delete(k); continuing.delete(k); attemptIds.delete(k); attemptSeq.delete(k); leads.delete(k);
        answered.add(k);
        if (status === "blocked") blockedAsks.set(k, by);
        else blockedAsks.delete(k);
        if (status === "in_review") reviewAsks.add(k);
        else reviewAsks.delete(k);
      }
    };
    const asked = ask?.createdAt ?? issue.createdAt;
    const saving = [...pending.keys()].filter((k) => k.startsWith(mine));
    if (saving.length) {
      // What is saved is delivered unless THAT text is already on the task (its
      // post landed but the response was lost), whichever ask it answered: a
      // newer ask must not carry an older answer out a second time (second pass
      // on a76d8c0). Any other comment of ours — a progress note written during
      // the run — is not the answer.
      const from = saving.map((k) => since.get(k) ?? issue.createdAt).sort()[0];
      const saved = owed().comment;
      // An attempt's answer carries its mark: found by it, whatever was added
      // to the text on the way out (a reviewer or giver note) — every mark
      // still owed, so an older answer posted alone does not stand for a newer one.
      const marks = saving.map((k) => attemptIds.get(k)).filter(Boolean).map(attemptMark);
      const landed = comments.find((c) => c.authorAgentId === me.id && c.createdAt > from && (c.body === saved || c.body === `${saved}\n\n${NO_GIVER}`
        || (marks.length === saving.length && marks.every((m) => c.body?.includes(m)))));
      if (landed) {
        const current = pending.has(key);
        // An escalation's blocked answer whose link write landed with it, its
        // response lost: the links are read back from the card (w5).
        const latest = owedKeys().at(-1), { status: as, waitsOn } = owed();
        if (escalated && as === "blocked" && waitsOn.length) {
          const names = waitsOn.map((n) => n.toUpperCase());
          const ids = (issue.blockedBy ?? []).filter((b) => names.includes(String(b.identifier ?? "").toUpperCase())).map((b) => b.id);
          if (ids.length) linked.set(latest, ids);
        }
        settle(landed.createdByRunId ?? runId);
        saveState(stateFile, state);
        if (current && !escalated && !heldElsewhere(issue)) return acknowledge(item, runId, comments, key, decidedAt, issue);
      }
    }
    // Handed to someone else, or to nobody, after the inbox listed it and
    // before this read: theirs. Nothing runs; an answer still owed is posted
    // as a comment only (reply), and a live run ends on a note (w1).
    if (heldElsewhere(issue)) {
      const older = owedKeys().at(-1);
      if (older) {
        const { comment, status } = owed();
        await reply(item, runId, older, comment, status, { mark: decidedFrom.get(older) ?? decidedAt });
        settle(runId);
      } else if (live) await endRun(item, runId, comments, HANDED_AWAY, { alone: true });
      handled.add(runId);
      saveState(stateFile, state);
      log.child({ paperclipTask: issue.identifier, runId }).info("Paperclip task handed to someone else before it was picked up — left as it is");
      return;
    }
    // A gone run takes no new work. When a newer ask came in after the attempt
    // it still owes, that attempt is posted under it as a comment only — the
    // newer ask has moved past it — and the newer ask waits for a live run.
    if (wakeStep({ live, owes: pending.has(key) }) === "post-older") {
      const older = owedKeys().at(-1);
      if (older) {
        const { comment, status } = owed();
        await reply(item, runId, older, comment, status, { mark: decidedFrom.get(older) ?? decidedAt });
        settle(runId);
      }
      handled.add(runId);
      saveState(stateFile, state);
      log.child({ paperclipTask: issue.identifier, runId }).info("Paperclip run gone with a newer ask on the task — the owed answer is posted, the ask waits for a live run");
      return;
    }
    // A task someone else stopped is not worked — not on a wake for its waits,
    // nor on a comment, nor to rerun an interrupted attempt — until a recorded
    // move takes it out of the stop. Paperclip's wake checks it out first with
    // no record of its own, so the stop is read as decided (decidedStatus), not
    // as the board shows. An answer already made is still posted: on a stopped
    // task it is a comment only (reply).
    // A person's stop, unless it was the hand-off of the task to the bot:
    // recognised from the record of the hand-off, wherever it sits, not from
    // the newest status record alone — the mirror's note restates blocked
    // after it (handedWith). A person's own stop since still holds.
    const personStop = (s, record = activity) => s?.actorType === "user" && !handedWith(s, record, me.id);
    const heldBy = (status, activity) => {
      const decided = decidedStatus(status, activity, me.id);
      // A task another writer owns is that writer's to stop as well — its sync
      // blocks a card for the bot to clear — so there only a person's stop holds.
      // The Foreman's sync writes with a board user's key, so a stop that also
      // hands the task to the bot is that hand-off, not a person's hold (SLA-1335).
      const setter = () => statusSetter(activity, decided, me.id);
      // An escalation is worked whoever blocked it, and left blocked. A card a
      // hop handed back down is worked while it is still in that hop's block.
      // One a recorded hand-up brought here is picked up with no label, but a
      // person's block since is still theirs (SLA-1493 row 2).
      if (hop?.kind === "escalated") return { decided, held: STOPPED.has(decided) && personStop(setter(), activity) };
      return { decided, held: !escalated && STOPPED.has(decided) && !hopBlocked(hop, setter())
        && (external(issue) ? personStop(setter(), activity) : !movable(setter(), activity, me.id)) };
    };
    const { decided, held } = heldBy(issue.status, activity);
    // Someone may stop the task, take it, or decide it while the bot works
    // it: then it is not worked again (w8). The record is read before the
    // card, so a change between the reads is seen on the card.
    const takenSince = async (mark) => {
      const record = await activityOf(item.id);
      const card = await api("GET", `/issues/${item.id}`);
      return heldElsewhere(card) || decidedSince(record, mark) || heldBy(card.status, record).held;
    };
    // An ask answered blocked is not finished: it resumes from the wait it is
    // in once that wait's tasks are done, or a status move recorded after the
    // answer takes its task on — once per wait, across restarts. Any other
    // answer is final, whatever its waits do after. An answer that was a
    // comment only — a mirrored card, whose links are its writer's, or one a
    // person changed as it was made — stopped nothing, so the card being open
    // is no sign anyone reopened it; nor is the bot's own write under the
    // answering run putting back what a person set (reopenIfMoved).
    const movedSinceAnswer = async () => {
      // The blocked answer itself, posted under the run that wrote it — never
      // a note since (an acknowledgement, a hold, even one posted under that
      // run), which would hide a move made before it. An answer saved before
      // its run was recorded is the last of ours that is not such a note.
      const ours = comments.filter((c) => c.authorAgentId === me.id && !isNote(c.body));
      const answer = ours.filter((c) => c.createdByRunId === blockedAsks.get(key)).at(-1) ?? ours.at(-1);
      const activity = list(await activityOf(item.id), "activity");
      const moved = lastDecision(activity, me.id)?.w;
      if (!answer || !moved || moved.runId === blockedAsks.get(key)) return false;
      // Paperclip records the answer's posting in the same order as the move,
      // which tells them apart within a millisecond; without that record a
      // move in the answer's millisecond counts — the answer was decided
      // before it was posted.
      const posted = activity.findIndex((a) => a.action === "issue.comment_added" && a.details?.commentId === answer.id);
      return posted >= 0 ? activity.indexOf(moved) < posted : moved.createdAt >= answer.createdAt;
    };
    // An escalation resumes only from the tasks its own answer linked (r6, p7),
    // every one done: it is blocked throughout, whoever blocked it.
    // Done is what the state file remembers (rememberDone) or the card shows now.
    const linkedDone = (k) => {
      const ids = linked.get(k) ?? [], b = issue.blockedBy ?? [], was = linkDone.get(k) ?? [];
      return ids.length > 0 && ids.every((id) => was.includes(id) || b.some((x) => x.id === id && x.status === "done"));
    };
    const resumes = answered.has(key) && blockedAsks.has(key) && (escalated ? linkedDone(key)
      : (!external(issue) && doneBlockers(issue).length > 0) || (!STOPPED.has(decided) && await movedSinceAnswer()));
    const step = wakeStep({ live, owes: pending.has(key), answered: answered.has(key), escalated, resumes, held });
    if (step === "acknowledge") return acknowledge(item, runId, comments, key, decidedAt, issue);

    const tLog = log.child({ paperclipTask: issue.identifier, runId });
    // What a hand-off through process.escalate made of this run, for its log line.
    let handoff = null, fallback = null;
    const handOff = (operation) => async (text) => { ({ handoff, fallback = null } = await handOffVia(item, postRun, key, text, operation, tLog)); };
    // Paperclip re-wakes an unchanged stopped card: each run still ends on a
    // note of its own (endRun, SLA-1335).
    const hold = async () => {
      // An answer an older ask still owes — its post failed, and a newer ask
      // came with the stop — is still posted, a comment only on the stopped
      // task (reply); it ends the run in place of the note.
      const older = pending.has(key) ? undefined : owedKeys().at(-1);
      if (older) {
        const { comment, status } = owed();
        await reply(item, runId, older, comment, status, { mark: decidedFrom.get(older) ?? decidedAt });
        settle(runId);
      } else await endRun(item, runId, comments, HELD_NOTE);
      handled.add(runId);
      saveState(stateFile, state);
      tLog.info({ status: decided }, "Paperclip task is stopped by someone else — not picked up");
    };
    let lostRun = null;
    // One run of the bot on the card as read (`card`: this wake's read, or a
    // fresher one an escalation is reworked from), under the run it goes out
    // under; `attemptId` names a durable attempt's worker (EM#626).
    const run = async (note, card = { issue, comments, activity }, as = key, attemptId = undefined) => {
      const unwatch = watchRun(item, postRun, tLog, (next) => {
        postRun = next;
        if (attemptRuns.has(as)) attemptRuns.set(as, next);
        saveState(stateFile, state);
      }, attemptId, (gone) => { lostRun = gone; }, decidedFrom.get(as) ?? decidedAt);
      if (escalated) {
        const up = escalateClient ? (me.reportsTo ? await targetOf(`agent:${me.reportsTo}`) : hop?.kind === "escalated" ? null : escalateTo) : escalateTo;
        note = [escalationNote(escalationAuthority, { up: up || null, down: await downOn(card.activity), from: await targetOf(placeOn(card.activity).cameDown) }), note].filter(Boolean).join("\n\n");
      }
      try {
        // Read per task: a copy the reader serves can expire between tasks.
        const contractNote = await contractText(contract);
        return (await answer(buildTaskPrompt(card.issue, card.comments, me, url, { note, returnable: !escalated && !external(card.issue), contract: contractNote }), card.issue, { runId: postRun, attemptId })).trim();
      } catch (err) {
        tLog.error({ err: err.message, attempt: attemptId }, "Paperclip task failed");
        // A worker that died after it started is never run again: it may have acted.
        const s = attemptId && attempts?.current(attemptId);
        if (s?.phase === "died") return workerDiedNote(attemptId, s.started?.at, s.exit?.signal);
      } finally {
        unwatch();
        // A worker that ended before the watch's next look: the board may
        // have lost its run all the same. Looked at once more, so delivery
        // never rests on the watch's timing.
        if (attemptId && attempts && !lostRun) {
          try {
            if (await lostUnder(await api("GET", `/issues/${item.id}`), postRun)) lostRun = postRun;
          } catch (err) {
            tLog.warn({ err: err.message }, "Paperclip task not read after its worker ended — delivering as things stand");
          }
        }
      }
    };
    // Each attempt is named before it starts, and saved with it: a restarted
    // bot follows that attempt's worker rather than starting the work again.
    const nameAttempt = (k) => { if (attempts) attemptIds.set(k, randomUUID()); return attemptIds.get(k); };
    // A person's block on a card a recorded hand-up brought here holds it (heldBy).
    if (escalated) return step === "hold" ? hold() : ownEscalation(step);
    let body;
    if (step === "retry") {
      // Attempted already; only the post failed, or the bot died mid-run.
      // Retry the post, never the run — unless the operator lets an attempt the
      // bot never finished run once more, told it was interrupted, for work
      // that can find out what its last attempt did (resumeInterrupted).
      // An interrupted going-on (goOn) is run once more as itself: told what
      // was said before it, and that it was interrupted.
      body = pending.get(key);
      const cont = continuing.get(key);
      const attemptId = attemptIds.get(key);
      if (body) tLog.info("Paperclip answer not yet posted — retrying the post only");
      else if (attempts && attemptId) {
        // The attempt's worker outlived the bot: followed to its end, its
        // answer read from what it wrote, and never started a second time. A
        // task stopped meanwhile stops the worker; its record still answers.
        if (held && attempts.stop(attemptId)) { tLog.warn({ attempt: attemptId }, "Paperclip task stopped by someone else — its worker is stopped"); return hold(); }
        tLog.info({ attempt: attemptId, phase: attempts.current(attemptId).phase }, "Paperclip attempt under way before the restart — following it, not running it again");
        body = await run("", undefined, key, attemptId);
        if (body && cont) { body = `${cont.prefix}\n\n${body}`; continuing.delete(key); }
        pending.set(key, body || "");
        saveState(stateFile, state);
      } else if (resumeInterrupted && (cont ? !cont.resumed : !resumed.has(attemptOf(key)))) {
        if (held) return hold();
        tLog.warn("Paperclip attempt never finished — running it once more, told it was interrupted");
        if (cont) cont.resumed = true;
        else resumed.add(attemptOf(key));
        decidedFrom.set(key, decidedAt);
        attemptRuns.set(key, runId);
        saveState(stateFile, state);
        body = await run(cont ? `${INTERRUPTED_NOTE}\n\n${cont.note}` : INTERRUPTED_NOTE);
        if (body && cont) { body = `${cont.prefix}\n\n${body}`; continuing.delete(key); }
        pending.set(key, body || "");
        saveState(stateFile, state);
      } else tLog.warn("Paperclip attempt never finished — posting the fallback, not running it again");
    } else {
      if (step === "hold") return hold();
      // Back from waiting: every task it was blocked on is done. The card goes
      // back in progress now and its answer opens by saying why. Not a comment
      // of its own: a comment under the run ends the run (the board's waiter),
      // and Paperclip refuses the close from an ended run on an in-progress card.
      const back = decided === "blocked" && !external(issue) ? doneBlockers(issue) : [];
      let note = "", resuming = "";
      if (back.length) {
        const names = back.map(nameOf).join(", ");
        if (issue.status === "blocked") {
          // A person changed it since this tick read it: the next tick decides from theirs.
          if (await personDecided(item.id, decidedAt)) return;
          await api("PATCH", `/issues/${item.id}`, { status: "in_progress" }, runId);
        }
        resuming = `Resuming: ${names}, which this task waited on, ${back.length === 1 ? "is" : "are"} done.`;
        note = `This task was blocked waiting on ${names}; ${back.length === 1 ? "it is" : "they are"} now done. Pick the task up where it stopped.`;
        tLog.info({ resumedFrom: back.map(nameOf) }, "Paperclip task's waits are done — resuming it");
      }
      tLog.info({ trigger }, "Paperclip task waiting — running the bot");
      // Mark the attempt before it starts. A bot that dies mid-run may already
      // have sent mail or written a record, so a restart posts the fallback
      // for this ask rather than running it a second time. Its post can only
      // be a comment made after it starts: after the ask, and after anything
      // of ours already there — the answer that left the ask in the wait it
      // resumes from may say the same words.
      begin(key);
      since.set(key, [asked, ...comments.filter((c) => c.authorAgentId === me.id).map((c) => c.createdAt)].sort().at(-1));
      decidedFrom.set(key, decidedAt);
      attemptRuns.set(key, runId);
      const attemptId = nameAttempt(key);
      saveState(stateFile, state);
      body = await run(note, undefined, key, attemptId);
      if (body && resuming) body = `${resuming}\n\n${body}`;
      pending.set(key, body || "");
      saveState(stateFile, state);
    }
    if (lostRun && await deferLost(item, key, lostRun, tLog)) return;
    // A blocked answer whose waits are all done gets no wake from them — done
    // before it was made, or since: the last finished before its post went
    // out, or before a saved answer's post was retried. The work goes on now,
    // once per ask, under a live run, told what the answer said so nothing it
    // did is done again. Never on a task someone stopped, nor one another
    // writer owns.
    const newest = () => owedKeys().at(-1);
    const mayGoOn = () => live && !held && !external(issue) && Boolean(newest()) && !continued.has(attemptOf(newest()));
    const goOn = async () => {
      if (!mayGoOn()) return;
      const k = newest();
      const first = pending.get(k) ? outcomeOf(pending.get(k)) : null;
      if (first?.status !== "blocked" || !first.waitsOn.length) return;
      const ready = await allDone(first.waitsOn, item.id);
      if (!ready.length || await takenSince(decidedFrom.get(k) ?? decidedAt).catch(() => true)) return;
      const names = ready.join(", ");
      const note = `This task said it was blocked waiting on ${names}; ${ready.length === 1 ? "it is" : "they are"} already done. What it said so far:\n\n${first.comment}\n\nPick the task up where it stopped, and do not repeat anything it says was already done.`;
      const prefix = `${first.comment}\n\nResuming: ${names}, which this task waited on, ${ready.length === 1 ? "is" : "are"} already done.`;
      // An attempt like any other, marked before it starts: a bot that dies in
      // it finds it under way (continuing), not the earlier answer to post.
      const was = pending.get(k);
      continued.add(attemptOf(k));
      continuing.set(k, { prefix, note });
      pending.set(k, "");
      const attemptId = nameAttempt(k);
      saveState(stateFile, state);
      tLog.info({ waitsOn: ready }, "Paperclip task said it waits on tasks already done — going on with it");
      const again = await run(note, undefined, key, attemptId);
      pending.set(k, again ? `${prefix}\n\n${again}` : was);
      continuing.delete(k);
      saveState(stateFile, state);
      // Lost to a board restart like any attempt: nothing under that run, the answer waits for a new one.
      return Boolean(lostRun) && deferLost(item, k, lostRun, tLog);
    };
    // Comment and close in one write. Paperclip re-wakes an agent whose run
    // ends with the task still open, and refuses in_review without a named
    // reviewer — so an answered ask is done. A reply on the task reopens it.
    const post = async (unlessReady) => {
      let { comment, status: as, waitsOn, person, escalate, giveBack } = owed();
      // `review`: in review with whoever gave the bot the task as the
      // reviewer, else its manager; with neither the work waits, blocked.
      let text = comment, giveTo = null, reviewer = null, via = null;
      if (as === "in_review") {
        const who = await targetOf(giverOf(activity, issue)) ?? (me.reportsTo ? await targetOf(`agent:${me.reportsTo}`) : null);
        reviewer = who && await holderFor(who);
        if (!reviewer) { as = "blocked"; text = `${comment}\n\n${NO_REVIEWER}`; }
        tLog.info({ reviewer: reviewer?.name ?? null }, reviewer ? "Paperclip task finished — sent to review" : "Paperclip task finished for review, but no one can review it — it stays with this bot");
      }
      // `return` through process.escalate: up the reporting line (hand_up), or
      // back down a recorded hand-up this bot holds (return). A seat with no
      // manager hands back to its giver, as before.
      if (giveBack && as === "blocked" && !external(issue) && escalateClient && (me.reportsTo || hop)) {
        const hops = latestRecord(comments, item.id)?.hops ?? [];
        via = handOff(openHandUps(hops).at(-1)?.to === me.id ? "return" : "hand_up");
      } else if (giveBack && as === "blocked" && !external(issue)) {
        const giver = await targetOf(giverOf(activity, issue));
        giveTo = giver && await holderFor(giver);
        if (!giveTo) text = `${comment}\n\n${NO_GIVER}`;
        tLog.info({ to: giveTo?.name ?? null }, giveTo ? "Paperclip task handed back to whoever gave it" : "Paperclip task asked to be handed back, but no one gave it — it stays with this bot");
      } else if (person && as === "blocked" && !external(issue)) {
        // Blocked on a person: the task waits with them, so no wake of this
        // bot's lands on it while it waits (SLA-1621).
        giveTo = await personNamed(person);
        if (!giveTo) text = `${comment}\n\n${noPerson(person)}`;
        tLog.info({ to: giveTo?.name ?? null, named: person }, giveTo ? "Paperclip task waits on a person — handed to them, blocked" : "Paperclip task waits on a person the board does not have — it stays with this bot");
      }
      return { status: as, closed: await reply(item, postRun, key, text, as, { waitsOn, unlessReady, mark: decidedFrom.get(key) ?? decidedAt, giveTo,
        handOff: via, resumed: hopBlocked(hop, statusSetter(activity, "blocked", me.id)), reviewer }) };
    };
    if (await goOn()) return;
    let { status, closed } = await post(mayGoOn());
    if (closed === READY) {
      if (await goOn()) return;
      ({ status, closed } = await post(false));
    }
    settle(postRun);
    handled.add(runId);
    handled.add(postRun);
    saveState(stateFile, state);
    tLog.info({ answered: Boolean(body) && handoff !== "refused", outcome: status, leftOpen: !closed, ...(handoff ? { handoff } : {}), ...(fallback ? { fallback } : {}),
      ...(postRun !== runId ? { postRun } : {}) }, "Paperclip task answered");
    if (closed) await reopenIfMoved(item.id, { runId: postRun, key, as: status }, tLog);

    /**
     * An escalation's whole lifecycle on this wake, owned here alone — the
     * phases of docs/board-decisions.md (b), in order:
     *
     *   p1 restore   the wake's checkout put the card in progress with no
     *                record; it goes back to blocked before anything runs, and
     *                is blocked throughout the work (keepBlocked)
     *   p2 choose    settle (worked already, nothing new, not resuming), resume
     *                (every task its answer linked is done), retry (an answer
     *                owed), else work (wakeStep)
     *   p3 attempt   begin(): saved as owed and numbered before it runs
     *   p4 validate  just before the write, the card read afresh — its
     *                status, holder, title, description, comments and hand-off
     *                record — must still be the ask the answer answers:
     *                - decided anew (a person moved it or its waits, it was
     *                  handed elsewhere, it is no longer an escalation): it is
     *                  theirs; the answer is posted and nothing handed on
     *                  (CARD_CHANGED)
     *                - asked something newer (an edit, a comment, a new hand-off
     *                  to the bot): a new attempt under the same run, from the
     *                  fresh read, and validated again (MAX_REWORK times); past
     *                  that, or with the run gone, the answer is posted and the
     *                  card kept for the next wake (NEWER_ASK)
     *   p5 route     the latest attempt's outcome picks the write (r1-r8)
     *   p6 settle    each owed attempt answered; a linked wait recorded
     *   p7 resume    when every linked task is done (p2)
     *
     * A stale answer is never handed on: every write is decided from the read
     * that validated it, and from the latest attempt by the sequence.
     */
    async function ownEscalation(step) {
      await keepBlocked(item, runId, tLog);
      // An escalation already worked, with nothing new since, is left as it is:
      // Paperclip re-wakes the holder of a blocked card it sees unchanged. The
      // run ends on a note of its own (endRun).
      if (step === "settle") {
        await endRun(item, runId, comments, ESCALATION_KEPT);
        handled.add(runId);
        saveState(stateFile, state);
        tLog.info("Paperclip escalation already worked — nothing new on the card, left blocked");
        return;
      }
      // Links an earlier answer of this card made (r6), which this wake's
      // write may clear once done (p7); read before the attempts settle.
      const wasLinked = [...new Set([key, ...owedKeys()].flatMap((k) => linked.get(k) ?? []))];
      if (step === "retry") {
        const cont = continuing.get(key);
        const attemptId = attemptIds.get(key);
        if (pending.get(key)) tLog.info("Paperclip escalation answer not yet posted — retrying the post only");
        else if (attempts && attemptId) {
          // The attempt's worker outlived the bot: followed to its end, never
          // started a second time (EM#626), as on any task.
          if (held && attempts.stop(attemptId)) { tLog.warn({ attempt: attemptId }, "Paperclip escalation stopped by someone else — its worker is stopped"); return hold(); }
          tLog.info({ attempt: attemptId, phase: attempts.current(attemptId).phase }, "Paperclip escalation attempt under way before the restart — following it, not running it again");
          let body = await run("", undefined, key, attemptId);
          if (body && cont) { body = `${cont.prefix}\n\n${body}`; leads.set(key, cont.prefix); continuing.delete(key); }
          pending.set(key, body || "");
          saveState(stateFile, state);
        } else if (resumeInterrupted && (cont ? !cont.resumed : !resumed.has(attemptOf(key)))) {
          tLog.warn("Paperclip escalation attempt never finished — running it once more, told it was interrupted");
          if (cont) cont.resumed = true;
          else resumed.add(attemptOf(key));
          decidedFrom.set(key, decidedAt);
          attemptRuns.set(key, runId);
          saveState(stateFile, state);
          let body = await run(cont ? `${INTERRUPTED_NOTE}\n\n${cont.note}` : INTERRUPTED_NOTE);
          if (body && cont) { body = `${cont.prefix}\n\n${body}`; leads.set(key, cont.prefix); continuing.delete(key); }
          pending.set(key, body || "");
          saveState(stateFile, state);
        } else tLog.warn("Paperclip escalation attempt never finished — posting the fallback, not running it again");
      } else {
        // Back from the wait its answer linked (p7): every linked task is done.
        let note = "", lead = "";
        if (resumes) {
          const back = (issue.blockedBy ?? []).filter((b) => linked.get(key).includes(b.id));
          const names = back.map(nameOf).join(", ");
          lead = `Resuming: ${names}, which this card waited on, ${back.length === 1 ? "is" : "are"} done.`;
          note = `This card waited on ${names}; ${back.length === 1 ? "it is" : "they are"} now done. Pick it up where it stopped.`;
          tLog.info({ resumedFrom: back.map(nameOf) }, "Paperclip escalation's linked waits are done — resuming it");
        }
        tLog.info({ trigger }, "Paperclip escalation waiting — running the bot, the card kept blocked");
        // Marked before it starts, as every attempt is (see the work step).
        begin(key);
        since.set(key, [asked, ...comments.filter((c) => c.authorAgentId === me.id).map((c) => c.createdAt)].sort().at(-1));
        decidedFrom.set(key, decidedAt);
        attemptRuns.set(key, runId);
        const attemptId = nameAttempt(key);
        saveState(stateFile, state);
        const body = await run(note, undefined, key, attemptId);
        if (body && lead) leads.set(key, lead);
        pending.set(key, body ? (lead ? `${lead}\n\n${body}` : body) : "");
        saveState(stateFile, state);
      }
      if (lostRun && await deferLost(item, key, lostRun, tLog)) return;
      // The ask the answer answers is the latest attempt owed (the sequence).
      let answering = owedKeys().at(-1) ?? key;
      let mark = decidedFrom.get(answering) ?? decidedAt;
      let was = { issue, comments, activity };
      // The tasks this wake's answer links, when it is blocked on open ones (r6).
      let linkedNow = null;
      const settledKeys = owedKeys();
      for (let rounds = 0; ; rounds++) {
        // A wake since may have checked the card out again.
        await keepBlocked(item, postRun, tLog);
        // The seats before the card: a hand-on decided from this round's reads
        // fetches nothing between them and its write (w9).
        const seats = await seatsOf();
        // The record before the task, so a change between the reads is after the mark.
        const record = await activityOf(item.id);
        const card = await api("GET", `/issues/${item.id}`);
        const thread = list(await api("GET", `/issues/${item.id}/comments`), "comments").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const outcome = owed();
        const target = outcome.escalate ? escalateTo : outcome.status === "blocked" ? null : await downOn(record, seats);
        const path = `/issues/${item.id}`;
        const finish = async (comment, why) => {
          await api("PATCH", path, { comment }, postRun);
          tLog.info({ escalate: outcome.escalate, outcome: outcome.status }, why);
        };
        const runLive = async () => live && list(await api("GET", `/issues/${item.id}/runs`), "runs").some((r) => runIdOf(r) === postRun && r.status === "running");
        // A card a recorded hand-up brought here is an escalation with no label
        // while that hop stands (hopOf, SLA-1493).
        const cardHop = hopOf(card, thread, decidedStatus(card.status, record, me.id), record);
        // A person's block since pickup on a card a recorded hand-up brought
        // here is theirs: the answer is said, with nothing to explain.
        const personHeld = cardHop?.kind === "escalated" && escalateClient && personStop(statusSetter(record, "blocked", me.id), record);
        if (personSince(record, mark, me.id) || heldElsewhere(card)
          || !(cardHop?.kind === "escalated" || escalation(card, decidedStatus(card.status, record, me.id)))) {
          await finish(target && !personHeld ? `${outcome.comment}\n\n${CARD_CHANGED}` : outcome.comment,
            "Paperclip escalation worked — the card was decided anew meanwhile, so it was left as it is");
          break;
        }
        const now = askKey(item.id, card, askOf(thread, me.id), handedAt(record));
        // Through the shared action (SLA-1493): every hand-up up the reporting
        // line, label or record alike; and, on a card a recorded hand-up brought
        // here, the answer back down that chain, resolved or handed back undone.
        // Down a chain only a label made, the action has no record to walk.
        const recorded = cardHop?.kind === "escalated";
        const op = !escalateClient ? null : outcome.escalate ? (me.reportsTo ? "hand_up" : null)
          : !recorded ? null : outcome.giveBack ? "return" : outcome.status !== "blocked" ? "resolve" : null;
        if (now === answering) {
          // The links this card's answer made earlier, done now, are cleared by
          // this write's attempt (p7); a link anyone else made stays.
          const links = card.blockedBy ?? [];
          const done = new Set(links.filter((b) => b.status === "done" && wasLinked.includes(b.id)).map((b) => b.id));
          const kept = links.map((b) => b.id).filter((id) => !done.has(id));
          const unlink = async () => {
            if (!done.size) return;
            try { await api("PATCH", path, { blockedByIssueIds: kept }, postRun); } catch (err) {
              if (!(err.status >= 400 && err.status < 500)) throw err;
              tLog.warn({ err: err.message }, "Paperclip escalation — the board refused clearing the done links; they are left");
            }
          };
          const waits = !target && outcome.status === "blocked" && outcome.waitsOn.length ? await resolveWaits(outcome.waitsOn, item.id) : null;
          const goneOn = `${answering}#${attemptSeq.get(answering) ?? 0}`;
          // The record is read last, just before a write that hands the card on
          // or links it: a change since this round's reads is decided by the
          // next round, from fresh reads; past the rounds, the answer is only
          // posted (w10).
          if ((op || target || waits?.ids.length) && (await activityOf(item.id)).some((a) => after(a, markOf(record)))) {
            if (rounds < MAX_REWORK) continue;
            await finish(outcome.comment, "Paperclip escalation worked — the card kept changing under the write, so the answer is posted and the card left as it is");
            break;
          }
          if (op && recorded && personStop(statusSetter(record, "blocked", me.id), record)) {
            // A card a recorded hand-up brought here that a person has blocked
            // since pickup is theirs: the answer is said, and nothing is handed on.
            await finish(outcome.comment, "Paperclip escalation worked, but a person holds the card — a note posted, nothing handed on");
          } else if (op) {
            // The action moves the card and records the hop in one write; the answer rides in it.
            await unlink();
            ({ handoff, fallback = null } = await handOffVia(item, postRun, answering, outcome.comment, op, tLog));
          } else if (target) {
            // r1-r3: handed down, or up, the person told the latest attempt's ask.
            await unlink();
            await handOn(item, postRun, card, outcome, target, tLog, seats);
          } else if (waits?.ids.length) {
            // r6: linked to the tasks still open, in the one write that posts it;
            // the unblock step is left as it is (the Foreman reads it back).
            const ids = [...new Set([...kept, ...waits.ids])];
            try {
              await api("PATCH", path, { comment: outcome.comment, blockedByIssueIds: ids }, postRun);
              linkedNow = waits.ids;
              tLog.info({ waitsOn: waits.names }, "Paperclip escalation worked — blocked on open tasks, linked so it resumes when they are done");
            } catch (err) {
              if (!(err.status >= 400 && err.status < 500)) throw err;
              await finish(`${outcome.comment}\n\nI could not link this card to ${waits.names.join(", ")}: the board refused it (${err.status}).`,
                "Paperclip escalation worked — the board refused the link; a note posted, the card left blocked with this bot");
            }
          } else if (waits?.ready && !continued.has(goneOn) && rounds < MAX_REWORK && await runLive()) {
            // r7: blocked on tasks already done — no wake will come from them.
            // It goes on now, under the same run, once per attempt, as a round;
            // the go-on's own outcome routes on the next pass. The card is read
            // again first: changed since this round's reads (taken away, decided,
            // asked anew), the next round decides from it before anything runs (w8).
            const recheck = await activityOf(item.id);
            if (recheck.some((a) => after(a, markOf(record))) || heldElsewhere(await api("GET", path))) continue;
            const names = waits.done.join(", ");
            const said = outcomeOf(pending.get(answering)).comment;
            const note = `This card said it was blocked waiting on ${names}; ${waits.done.length === 1 ? "it is" : "they are"} already done. What it said so far:\n\n${said}\n\nPick it up where it stopped, and do not repeat anything it says was already done.`;
            const prefix = `${said}\n\nResuming: ${names}, which this card waited on, ${waits.done.length === 1 ? "is" : "are"} already done.`;
            const before = pending.get(answering);
            continued.add(goneOn);
            continuing.set(answering, { prefix, note });
            pending.set(answering, "");
            decidedFrom.set(answering, markOf(record));
            saveState(stateFile, state);
            tLog.info({ waitsOn: waits.done }, "Paperclip escalation said it waits on tasks already done — going on with it");
            const again = await run(note, { issue: card, comments: thread, activity: record }, answering);
            if (again) { pending.set(answering, `${prefix}\n\n${again}`); leads.set(answering, prefix); } else pending.set(answering, before);
            continuing.delete(answering);
            saveState(stateFile, state);
            mark = markOf(record);
            was = { issue: card, comments: thread, activity: record };
            continue;
          } else {
            // r4, r5, r8 (and r7 past its go-on): a comment only, the card left blocked with this bot.
            await unlink();
            await finish(outcome.comment, "Paperclip escalation worked — a note posted, the card left blocked with this bot");
          }
          break;
        }
        if (rounds >= MAX_REWORK || !await runLive()) {
          await finish(target ? `${outcome.comment}\n\n${NEWER_ASK}` : outcome.comment,
            "Paperclip escalation worked — asked something newer meanwhile, so the card stays with this bot for it");
          break;
        }
        // Asked something newer: a new attempt now, under the same run, from
        // the card as it is. Told the answers that will be posted above it —
        // not the re-asked key's own, which this attempt replaces (A→B→A).
        const what = [card.title !== was.issue.title && "its title was edited", card.description !== was.issue.description && "its description was edited",
          askOf(thread, me.id)?.id !== askOf(was.comments, me.id)?.id && "a new comment came in", handedAt(record) !== handedAt(was.activity) && "it was handed to you again"].filter(Boolean);
        tLog.info({ changed: what }, "Paperclip escalation asked something newer while it was worked — working it again before any hand-off");
        const above = owed(now).comment;
        const from = since.get(answering) ?? asked;
        begin(now);
        if (!settledKeys.includes(now)) settledKeys.push(now);
        since.set(now, from);
        decidedFrom.set(now, markOf(record));
        attemptRuns.set(now, postRun);
        saveState(stateFile, state);
        pending.set(now, await run(reworkNote(what.join(", ") || "its ask was revised", above), { issue: card, comments: thread, activity: record }, now) || "");
        saveState(stateFile, state);
        answering = now;
        mark = markOf(record);
        was = { issue: card, comments: thread, activity: record };
      }
      settle(postRun);
      // p6: a linked wait is recorded on the attempt that made it; any earlier
      // link of these asks is ended by this answer (resumed once per wait).
      for (const k of [key, ...settledKeys]) { linked.delete(k); linkDone.delete(k); }
      if (linkedNow) linked.set(answering, linkedNow);
      handled.add(runId);
      handled.add(postRun);
      saveState(stateFile, state);
    }
  }

  // A tick asked for while one runs is not dropped: it is owed, and the running
  // tick goes round once more when it finishes, so an event that lands
  // mid-answer is seen then rather than on the next poll.
  async function tick(reason = "poll") {
    if (busy) { owed = owed ?? reason; return; }
    busy = true;
    try {
      for (let why = reason; why; why = owed, owed = null) {
        trigger = why;
        await pass();
      }
    } finally {
      busy = false;
      trigger = null;
    }
  }

  async function pass() {
    try {
      me ??= await api("GET", "/agents/me");
      for (const [taskId, c] of [...closing]) {
        try {
          await reopenIfMoved(taskId, c, log);
        } catch (err) {
          log.warn({ err: err.message, issue: taskId }, "Paperclip close not yet checked — retrying it next tick");
        }
      }
      const inbox = list(await api("GET", "/agents/me/inbox-lite"), "issues");
      // The board answered: a successful poll, whatever the tasks then do.
      try { onPoll?.(); } catch { /* a readiness report never stops a poll */ }
      // The inbox holds only todo, in_progress and blocked tasks, but a card is
      // handed to this seat in review too (the Foreman's dev-verified and merged
      // cards), and Paperclip opens a run on it all the same. Without this the
      // run stays open with no one in it. Each is worked only while a
      // run of this seat's is open on it (handleTask).
      if (me.companyId) {
        try {
          const seen = new Set(inbox.map((i) => i.id));
          const inReview = list(await api("GET", `/companies/${me.companyId}/issues?assigneeAgentId=${me.id}&status=in_review`), "issues");
          inbox.push(...inReview.filter((i) => i.assigneeAgentId === me.id && !seen.has(i.id)));
        } catch (err) {
          log.warn({ err: err.message, status: err.status }, "Paperclip in-review tasks not read — retrying next tick");
        }
      }
      // A worker whose task left the inbox — cancelled, or handed on by a
      // person while the bot was away — is stopped (unwanted). One whose task
      // left it otherwise (the model handed it on, or closed it, itself) has
      // its answer delivered once it ends (deliverOutside).
      if (attempts) {
        const seen = new Set(inbox.map((i) => i.id));
        for (const [k, id] of [...attemptIds]) {
          const taskId = k.slice(0, k.indexOf(":"));
          // A live worker is checked even while its card is in the inbox: a
          // person's hold made while the bot was away, under a run the board
          // has since cancelled, reaches no handleTask watch.
          const alive = attempts.alive(id);
          if (!pending.has(k) || (seen.has(taskId) && !alive)) continue;
          try {
            const issue = await api("GET", `/issues/${taskId}`);
            if (!alive) {
              if (!await unwanted(issue, decidedFrom.get(k))) await deliverOutside(issue, k, id);
              continue;
            }
            if (await unwanted(issue, decidedFrom.get(k)) && attempts.stop(id)) {
              log.warn({ issue: taskId, attempt: id, status: issue.status }, "Paperclip task cancelled or handed on — its worker is stopped");
            }
          } catch (err) {
            log.warn({ err: err.message, issue: taskId }, "Paperclip task of a running worker not read — checking again next tick");
          }
        }
      }
      for (const item of inbox) {
        try {
          await handleTask(item);
        } catch (err) {
          log.warn({ err: err.message, status: err.status, code: err.code, issue: item.id }, "Paperclip task failed — retrying it next tick");
        }
      }
    } catch (err) {
      log.warn({ err: err.message, status: err.status, code: err.code }, "Paperclip poll failed — retrying next tick");
    }
  }

  // Who this seat is, for the live-event socket: its agent id and company.
  const whoami = async () => (me ??= await api("GET", "/agents/me"));

  return { tick, whoami };
}

/**
 * The boards this bot answers on. The first is PAPERCLIP_URL with
 * PAPERCLIP_API_KEY; PAPERCLIP_EXTRA_BOARDS adds more, as a JSON array of
 * `{ "id", "url", "keyEnv", "promptChannel", "events", "escalationLabels",
 * "escalateTo", "escalationReturnTo", "escalationAuthority", "escalationChannel",
 * "escalationMention" }`
 * (`events: false` keeps that board on polling alone; unset, it follows
 * PAPERCLIP_EVENTS). Each board's escalation settings (`escalation`) come from
 * the PAPERCLIP_ESCALATION_* variables unless the entry sets its own — except
 * `escalateTo` and `escalationReturnTo`, which name a seat or person on one
 * board and are never carried to another. An extra board names the
 * variable that holds its key rather than carrying the key, so the setting can
 * be logged and the key stays in the environment, where the bot scrubs it.
 * Each board gets its own poller, state file and sessions, since one agent is a
 * separate seat on every board it sits on. A broken entry is reported and
 * skipped; the rest still come on.
 */
function paperclipBoards(env = process.env) {
  // A broken escalation setting leaves the board on: it is a warning, not a problem.
  const boards = [], problems = [], warnings = [];
  const labelsOf = (v) => String(v).split(",").map((l) => l.trim()).filter(Boolean);
  const target = (v, label) => {
    try { return parseEscalateTo(v); } catch (err) { warnings.push(`${label}: ${err.message}; that hand-off is not made`); return null; }
  };
  const base = {
    labels: env.PAPERCLIP_ESCALATION_LABELS === undefined ? ESCALATION_LABELS : labelsOf(env.PAPERCLIP_ESCALATION_LABELS),
    authority: env.PAPERCLIP_ESCALATION_AUTHORITY || "",
    channel: env.PAPERCLIP_ESCALATION_CHANNEL || undefined,
    mention: env.PAPERCLIP_ESCALATION_MENTION || "",
  };
  // A board's handoff contract: its own setting, else the bot-wide one.
  const contractOf = (v, label) => parseContract(v === undefined || v === "" ? env.HANDOFF_CONTRACT : v, label);
  if (env.PAPERCLIP_URL && env.PAPERCLIP_API_KEY) {
    const { setting: contract, problem } = contractOf(env.PAPERCLIP_CONTRACT, "PAPERCLIP_CONTRACT");
    if (problem) problems.push(problem);
    else boards.push({ id: null, url: env.PAPERCLIP_URL, apiKey: env.PAPERCLIP_API_KEY, keyEnv: "PAPERCLIP_API_KEY", promptChannel: env.PAPERCLIP_PROMPT_CHANNEL || undefined, contract,
      escalation: { ...base, escalateTo: target(env.PAPERCLIP_ESCALATE_TO, "PAPERCLIP_ESCALATE_TO"), returnTo: target(env.PAPERCLIP_ESCALATION_RETURN_TO, "PAPERCLIP_ESCALATION_RETURN_TO") } });
  } else if (env.PAPERCLIP_URL || env.PAPERCLIP_API_KEY) {
    problems.push("PAPERCLIP_URL and PAPERCLIP_API_KEY must both be set");
  }
  let extra = [];
  if (env.PAPERCLIP_EXTRA_BOARDS) {
    try { extra = JSON.parse(env.PAPERCLIP_EXTRA_BOARDS); } catch (err) { problems.push(`PAPERCLIP_EXTRA_BOARDS is not JSON (${err.message})`); }
    if (!Array.isArray(extra)) { problems.push("PAPERCLIP_EXTRA_BOARDS must be a JSON array"); extra = []; }
  }
  const origin = (u) => String(u).replace(/\/+$/, "").toLowerCase();
  for (const b of extra) {
    const id = b?.id;
    const label = `extra board ${JSON.stringify(id ?? null)}`;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) { problems.push(`${label}: id must be lowercase letters, digits and dashes`); continue; }
    if (boards.some((x) => x.id === id)) { problems.push(`${label}: id used twice`); continue; }
    if (typeof b.url !== "string" || !/^https?:\/\//.test(b.url)) { problems.push(`${label}: url must be an http(s) origin`); continue; }
    if (typeof b.keyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(b.keyEnv)) { problems.push(`${label}: keyEnv must name an environment variable`); continue; }
    if (!env[b.keyEnv]) { problems.push(`${label}: ${b.keyEnv} is not set`); continue; }
    if (b.events !== undefined && typeof b.events !== "boolean") { problems.push(`${label}: events must be true or false`); continue; }
    if (b.escalationLabels !== undefined && !(Array.isArray(b.escalationLabels) && b.escalationLabels.every((l) => typeof l === "string"))) { problems.push(`${label}: escalationLabels must be an array of label names`); continue; }
    for (const k of ["escalateTo", "escalationReturnTo", "escalationAuthority", "escalationChannel", "escalationMention"]) {
      if (b[k] !== undefined && typeof b[k] !== "string") warnings.push(`${label}: ${k} must be a string; it is ignored`);
    }
    const text = (k) => (typeof b[k] === "string" ? b[k] : undefined);
    const { setting: contract, problem: contractProblem } = contractOf(b.contract, `${label} contract`);
    if (contractProblem) { problems.push(contractProblem); continue; }
    // Two pollers on one board would race each other for the same runs.
    if (boards.some((x) => origin(x.url) === origin(b.url))) { problems.push(`${label}: ${b.url} is already answered by another entry`); continue; }
    const escalation = {
      labels: b.escalationLabels ? labelsOf(b.escalationLabels.join(",")) : base.labels,
      authority: text("escalationAuthority") ?? base.authority,
      channel: text("escalationChannel") ?? base.channel,
      mention: text("escalationMention") ?? base.mention,
      escalateTo: target(text("escalateTo"), `${label} escalateTo`),
      returnTo: target(text("escalationReturnTo"), `${label} escalationReturnTo`),
    };
    boards.push({ id, url: b.url, apiKey: env[b.keyEnv], keyEnv: b.keyEnv, promptChannel: b.promptChannel ? String(b.promptChannel) : undefined, contract, ...(b.events === undefined ? {} : { events: b.events }), escalation });
  }
  return { boards, problems, warnings };
}

/**
 * Every variable a board's key is configured in: PAPERCLIP_API_KEY and each
 * keyEnv PAPERCLIP_EXTRA_BOARDS names — read from the configuration, never
 * from the boards that came on. A board that is off (BOT_SURFACES=discord, a
 * broken entry) still has its key in the environment, and no run may see it.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
function boardKeyEnvs(env = process.env) {
  let extra = [];
  try { extra = JSON.parse(env.PAPERCLIP_EXTRA_BOARDS || "[]"); } catch { /* reported by paperclipBoards */ }
  const named = (Array.isArray(extra) ? extra : []).map((b) => b?.keyEnv)
    .filter((k) => typeof k === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  return [...new Set(["PAPERCLIP_API_KEY", ...named])];
}

module.exports = { ESCALATION_LABELS, handedWith, decisionKind, lastDecision, personSince, markAt, boardKeyEnvs, parseEscalateTo, escalationNote, statusSetter, decidedStatus, reconcilable, handedBack, movable, wakeStep, HELD_NOTE, ESCALATION_KEPT, CARD_CHANGED, NEWER_ASK, PERSON_STANDS, TRANSPORT_NOTE, INTERRUPTED_NOTE, HANDED_AWAY, handedSince, waitAction, paperclipBoards, pickOpenRun, askOf, askKey, buildTaskPrompt, replyCollector, createPaperclipPoller, FALLBACK_REPLY, ALREADY_ANSWERED, unchangedNote, UNBLOCK_ACTION, OUTCOME_MARK, outcomeOf, refusal };
