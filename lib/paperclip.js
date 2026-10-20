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
 * any blocked or return line outranks it. A `follow-up` line, from the
 * reviewer of a task in review, sends it back to whoever did the work with the
 * comment (Paperclip's changes-requested: the card returns to them and wakes
 * them); `followUp`.
 *
 * @param {string} text the run's reply
 * @returns {{ comment: string, status: "done" | "blocked" | "in_review", waitsOn: string[], person: string | null, escalate: boolean, giveBack: boolean, followUp: boolean }}
 */
function outcomeOf(text) {
  let status = "done", escalate = false, giveBack = false, review = false, followUp = false, person = null;
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
    if (/^follow[-_]?up$/i.test(word)) followUp = true;
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  if (review && status === "done") status = "in_review";
  return { comment, status, waitsOn, person, escalate, giveBack, followUp: followUp && status === "done" };
}

/**
 * Who asked for a task and so accepts it (SLA-C1 task-completion): its creator,
 * as the task record has it — never a comment's say. `agent:<id>` /
 * `user:<id>`; null when the seat made it itself, or nobody did.
 */
function requesterOf(issue, selfId) {
  const r = issue?.createdByAgentId ? `agent:${issue.createdByAgentId}` : issue?.createdByUserId ? `user:${issue.createdByUserId}` : null;
  return r === `agent:${selfId}` ? null : r;
}

/** A policy document setting, `<caseId>/<documentKey>`; null when unset. Throws on a malformed one. */
function parsePolicy(value, label = "policy") {
  if (value === undefined || value === null || value === "") return null;
  const m = /^([0-9a-f-]{36})\/([a-z0-9][a-z0-9-]*)$/i.exec(String(value).trim());
  if (!m) throw new Error(`${label} must be <caseId>/<documentKey>`);
  return { caseId: m[1], key: m[2] };
}

/** Said in place of the policy when it cannot be read: a run never guesses it. */
const POLICY_UNAVAILABLE = (p, why) => `POLICY UNAVAILABLE: the company policy ${p.key} could not be read (${why}). Say so in your reply; do not act on a remembered version.`;

// ---- Status decisions: docs/board-decisions.md, table (a) ----

/** A write's changes to what the task waits on: its linked tasks or its unblock step. */
const changesWaits = (c) => Boolean(c?.blockedByIssueIds || c?.unblockDescriptor);
/** A write's change of holder. */
const handsOver = (c) => Boolean(c?.assigneeAgentId || c?.assigneeUserId);

/**
 * Who wrote an entry of a task's record, as `{ type, id }`. A write made with
 * a person's key names the writer it was made for when Paperclip credits it
 * (`details.creditedActor`, which it sets on a person's writes only, from the
 * key's own credit: the Foreman's sync credits every write to its own agent
 * since 2026-10-18). Every other entry is its actor's — so a sync write from
 * before then reads as the person whose key it used, a hold like any of theirs.
 */
function writerOf(a) {
  const c = a?.details?.creditedActor;
  if (a?.actorType === "user" && c?.id && (c.type === "agent" || c.type === "user")) return { type: c.type, id: c.id };
  return { type: a?.actorType ?? null, id: a?.actorId ?? null };
}
/** Whether an entry is this bot's own write. */
const byBot = (a, agentId) => { const w = writerOf(a); return w.type === "agent" && w.id === agentId; };
/** Whether an entry is someone else's: a person's or another agent's, never this bot's or Paperclip's. */
const byOther = (a, agentId) => writerOf(a).type !== "system" && !byBot(a, agentId);
/** Whether an entry gives the task to this bot. */
const toBot = (a, agentId) => a?.details?.changes?.assigneeAgentId?.to === agentId || a?.details?.assigneeAgentId === agentId;

/**
 * Each entry of a record (newest first) as a decision, and the decision in
 * force from each entry back: one pass, oldest first, over the record given.
 * Nothing is kept between calls, so every answer is the record's own.
 *
 * A decision is a write that changes the task's status, its holder or what it
 * waits on (kinds `status`, `holder`, `waits`), or Paperclip settling a run it
 * lost (`settle`); anything else — a comment, an edit, a write that restates
 * the status in force — decides nothing (`none`). No comment text is read.
 * A status is changed only by a write that moves it off the status recorded
 * before it: Paperclip's wake checks a stopped task out with no record of its
 * own, so a write that puts the recorded status back after a checkout is a
 * restatement, not a move. A decision carries the status in force after it,
 * or null when the record never says.
 *
 * The newest decision wins, with one exception: this bot's own write never
 * takes over a decision someone else made (board-decisions rule 3) — a person
 * moving the card to todo is still the decision after the bot blocks it, and
 * putting the card back after a checkout, closing over a hold, or trimming its
 * waits leaves their stop the decision. Over a choice that is not a stop the
 * bot's own newest write is kept beside it (`own`): the stop it put on the
 * card is its own, never theirs. Paperclip's settlement of a lost run is read
 * the same way as the bot's writes over a stop (a14, a15).
 */
function decisionsOf(all, agentId) {
  const n = all.length;
  const kinds = new Array(n).fill("none"), after = new Array(n + 1).fill(null);
  let status = null, cur = null;
  const stands = () => Boolean(cur && STOPPED.has(cur.to) && !movable(cur.w, all, agentId));
  for (let i = n - 1; i >= 0; i--) {
    const a = all[i], d = a.details ?? {}, c = d.changes ?? {};
    if (a.action === "issue.execution_recovery_settled") {
      kinds[i] = "settle";
      if (!(d.outcome === "blocked" && stands())) cur = { w: a, to: d.outcome ?? null };
      status = d.outcome ?? status;
    } else if (a.action === "issue.created") {
      status = d.status ?? status;
      kinds[i] = "status";
      cur = { w: a, to: status };
    } else if (a.action === "issue.updated") {
      // A recorded change with nothing recorded before it is a move: Paperclip
      // says it changed the status, and the record holds no status to compare.
      if (!c.status) status ??= d.status ?? null;
      const moves = Boolean(c.status) && (status === null || c.status.to !== status);
      if (c.status) status = c.status.to;
      kinds[i] = moves ? "status" : changesWaits(c) ? "waits" : handsOver(c) ? "holder" : "none";
      if (kinds[i] === "none") { after[i] = cur; continue; }
      if (!byBot(a, agentId) || !cur || (!stands() && !byOther(cur.w, agentId))) cur = { w: a, to: status };
      // Someone else's decision is in force: the bot's write never takes it
      // over. A stop the bot puts on the card after a choice that is not one
      // is its own, kept beside the decision (statusSetter, decidedStatus).
      else if (!stands()) cur = { w: cur.w, to: cur.to, own: { w: a, to: status } };
    }
    after[i] = cur;
  }
  return { kinds, after };
}

/**
 * What one entry of a task's activity record (newest first) decides — table
 * (a) of docs/board-decisions.md:
 *
 *   status  a move of the task's status (a task created in one, too)
 *   waits   a change to what it waits on: its linked tasks or its unblock step
 *   holder  a change of holder alone
 *   settle  Paperclip settling a run it lost
 *   none    anything else: a comment, an edit, a label, a restated status
 */
function decisionKind(activity, i, agentId) {
  return decisionsOf(list(activity, "activity"), agentId).kinds[i] ?? "none";
}

/**
 * The last decision in Paperclip's activity record (newest first) and the
 * status in force after it (decisionKind), read over entry `from` and all
 * older ones. Null when the record holds none. `agentId` is the bot reading
 * it: its own writes never take over someone else's stop.
 */
function lastDecision(activity, agentId, from = 0) {
  const all = list(activity, "activity");
  return decisionsOf(from ? all.slice(from) : all, agentId).after[0] ?? null;
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
/**
 * Whether `s` is a snapshot a routing write may be decided from: the card an
 * answer was produced from (`snap`), the record as that card was read
 * (`mark`), and the runs that answer was made under (`own`). A legacy one, or
 * one missing any of the three, authorizes nothing: the answer is said as a
 * comment only and the card left as it is (board-decisions (d)).
 */
const routableSnapshot = (s) => Boolean(s) && typeof s === "object" && !s.legacy
  && Boolean(s.snap) && typeof s.snap === "object"
  && Boolean(s.mark) && typeof s.mark === "object" && typeof s.mark.at === "string" && Array.isArray(s.mark.seen)
  && Array.isArray(s.own);
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
 * The newest decision by someone else — a person or another agent — on the
 * task's status or waits made after `mark` (markOf); undefined when none. A
 * change of holder is read by handedSince; a comment, an edit or a restated
 * status decides nothing (decisionKind).
 */
const personSince = (activity, mark, agentId) => {
  const all = list(activity, "activity");
  const { kinds } = decisionsOf(all, agentId);
  return all.find((a, i) => (kinds[i] === "status" || kinds[i] === "waits") && byOther(a, agentId) && after(a, mark));
};
/**
 * The newest change of holder by someone else after `mark`: the card handed
 * away, to nobody, or away and back. Whoever moved it made the newer decision,
 * even where it ends with the bot again (docs/board-decisions.md w3).
 */
const handedSince = (activity, mark, agentId) => list(activity, "activity").find((a) => byOther(a, agentId)
  && after(a, mark) && handsOver(a.details?.changes));

/**
 * The write that put the task in its present status (lastDecision). Null when
 * the last decision names another status. A last decision whose status the
 * record never says is taken as the one that set it: the bot never reads a
 * write it cannot place as no one's.
 */
function statusSetter(activity, status, agentId) {
  const d = lastDecision(activity, agentId);
  if (d?.own?.to === status) return d.own.w;
  return d && (d.to === status || d.to === null) ? d.w : null;
}

/**
 * The status a task is in as decided. Paperclip's wake checks a stopped task
 * out to in_progress with no record of its own, so in_progress after a
 * recorded stop is still that stop: only a recorded move lifts it. A stop
 * someone chose is still theirs when a write that decides nothing put the
 * card in another stop: a cancelled card Paperclip settled blocked, or that
 * the bot put back to blocked, is still cancelled.
 */
function decidedStatus(status, activity, agentId) {
  if (!activity) return status;
  const d = lastDecision(activity, agentId);
  const to = STOPPED.has(d?.to) ? d.to : d?.own?.to;
  return STOPPED.has(to) && (status === "in_progress" || STOPPED.has(status)) ? to : status;
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
  // Of the bot's own writes only a block is its own stop. A write that puts
  // back a stop someone else made (reopenIfMoved) is theirs, not a decision
  // (decisionsOf); read alone, a move out of done is never the bot's own stop.
  const { from, to } = setter.details?.changes?.status ?? { from: "blocked", to: "blocked" };
  return byBot(setter, agentId) && to === "blocked" && from !== "done";
}

/**
 * Whether a stop is work another agent handed this bot: an agent's decision
 * that also gave the task to it. `return` hands a task back that way. It is
 * how one agent passes work on, not a hold on it, so its recipient works it.
 * A person's block stands even when it also hands the task over (SLA-1337),
 * and so does an agent's block of a task someone else gave this bot.
 */
function handedBack(setter, activity, agentId) {
  const w = writerOf(setter);
  if (w.type !== "agent" || !w.id || w.id === agentId) return false;
  return handedWith(setter, activity, agentId);
}

/**
 * Whether the decision `setter` made gave the task to this bot. A hand-off
 * made by a later write is a decision of its own, and newer, so the write
 * that decided is the one to read (the Foreman's mirror blocks and hands a
 * card on in one write: mirror.ts move()).
 */
function handedWith(setter, activity, agentId) {
  return Boolean(setter) && toBot(setter, agentId);
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
 * The card's own state, as the bridge read it just before the run: a board run
 * has no way to read the board, so this is what it answers "what is this
 * card's status and reviewer?" from. `names` maps a seat or person id to a
 * name; an id with no name is shown as the id. Empty when the card has no
 * status (nothing was read).
 */
function cardBlock(issue, me, names, runId = "") {
  if (!issue?.status) return "";
  const nameOf = (id) => (id === me.id ? `${me.name} (you)` : names?.(id) ?? id);
  const holder = issue.assigneeAgentId ? nameOf(issue.assigneeAgentId) : issue.assigneeUserId ? nameOf(issue.assigneeUserId) : "no one";
  const creator = issue.createdByAgentId ? nameOf(issue.createdByAgentId) : issue.createdByUserId ? nameOf(issue.createdByUserId) : "unknown";
  const reviewers = (issue.executionPolicy?.stages ?? []).filter((st) => st?.type === "review")
    .flatMap((st) => (st.participants ?? []).map((pt) => nameOf(pt.agentId ?? pt.userId))).filter(Boolean);
  const owner = issue.unblockDescriptor?.owner;
  const ownerId = owner && typeof owner === "object" ? owner.agentId ?? owner.userId : owner;
  const blockers = (issue.blockedBy ?? []).map((b) => `${b.identifier ?? b.id}${b.status ? ` (${b.status})` : ""}`);
  return [
    "--- Card now (read from the board just before this run; it is current, and a run has no other way to read the board) ---",
    ...(runId ? [`This run: ${runId} (this is your Paperclip heartbeat run ID; give it when asked for it)`] : []),
    `Status: ${issue.status}`,
    `Assigned to: ${holder}`,
    `Created by: ${creator}`,
    `Reviewer: ${reviewers.length ? reviewers.join(", ") : "none recorded"}`,
    ...(issue.unblockDescriptor ? [`Unblock owner: ${ownerId ? nameOf(ownerId) : String(owner ?? "unknown")}`, `Unblock action: ${issue.unblockDescriptor.action ?? "none recorded"}`] : []),
    ...(blockers.length ? [`Blocked by: ${blockers.join(", ")}`] : []),
    "--- End card now ---",
  ].join("\n");
}

/**
 * The prompt for one task: the task, then its thread, oldest first. A prompt
 * too long for one run sheds, in order: the comments before the latest ask,
 * oldest first; the bot's own comments after it; the description; the title.
 * Only an ask too long on its own is cut, and the prompt says so.
 */
function buildTaskPrompt(issue, comments, me, boardUrl, { maxBytes = PROMPT_MAX_BYTES, note = "", returnable = true, contract = "", policy = "", names = null, runId = "", mirrored = false } = {}) {
  const reviewing = issue.status === "in_review" && issue.assigneeAgentId === me.id;
  const requester = requesterOf(issue, me.id);
  const live = comments.filter((c) => !c.deletedAt);
  const ask = askOf(live, me.id);
  const at = ask ? live.indexOf(ask) : live.length;
  // Paperclip's own notices (a disposition repair, a recovery) are named as the
  // board's: a re-wake is decided from them (SLA-1775).
  const render = (c, body = c.body) => `--- ${c.authorAgentId === me.id ? `You (${me.name})` : c.authorType === "system" ? "Paperclip (the board itself)" : "A board user"}, ${c.createdAt}\n${body}`;
  const parts = { before: 0, after: 0, title: issue.title, description: issue.description, askBody: ask?.body };
  const cardNow = cardBlock(issue, me, names, runId);
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
      cardNow ? `\n${cardNow}` : "",
      thread ? `\nThread so far:\n\n${thread}` : "",
      note ? `\n${note}` : "",
      contract ? `\n--- Handoff contract ---\n${contract}\n--- End handoff contract ---` : "",
      policy ? `\n--- Task completion policy ---\n${policy}\n--- End task completion policy ---` : "",
      "",
      "You cannot book a follow-up or a scheduled job from a board task: nothing scheduled here can post back to it. If one is asked for, say so.",
      "You cannot attach a file to a board comment. If a file is asked for, say so; put short content in the reply itself.",
      "Your Discord conversations, their summaries and the files shared there are private to those channels and are not available here. Never quote, recall or summarize them on the board.",
      `If you could not do what was asked — a tool, access or decision you do not have — say what blocks it and who can clear it, and end your reply with the line ${OUTCOME_MARK} blocked. The task is then marked blocked instead of done.`,
      `If you were asked to clear a hold and it stays — nothing it waits on has changed — the task is blocked, not done: say once what clears it and when it resumes, and end with ${OUTCOME_MARK} blocked. Never answer an unchanged hold with a "still held" comment that leaves the task open; each one wakes the asker to ask again.`,
      // A mirrored card's hold is its source's: a run that read the hold's
      // condition as met called it cleared and changed nothing.
      ...(mirrored ? [`This task mirrors another system, named on its description's first line. That system sets its status, so a hold here is the source's: only what the source documents as releasing it does — never a comment here, and never the condition it named now looking met. Until the source releases it, the hold stands: never call it cleared. Release it in the source if that is yours to do and say what you did; otherwise say what releases it and end with ${OUTCOME_MARK} blocked.`] : []),
      `If it waits on other tasks on this board, name them on that line (${OUTCOME_MARK} blocked on ACME-12, ACME-13): the task is linked to them and comes back to you when the last one is done.`,
      `If it waits on a person instead — their decision, approval or action — name them on that line (${OUTCOME_MARK} blocked on Avery) and say in your reply's first line what they need to do: the task is handed to them, still blocked, so it waits with them and not with you.`,
      ...(reviewing ? [`You are reviewing this task's result. If it is accepted, say so: the task is then done. If it needs more, say exactly what and end with the line ${OUTCOME_MARK} follow-up: the task goes back to whoever did the work, on this same task, and they reply again.`]
        : returnable && requester && policy ? ["You did not create this task, so you do not close it: a finished answer goes to whoever created it for review, and they accept it or ask a follow-up on this same task."]
          : returnable ? [`If the work is finished but needs whoever gave you this task to review it before it counts as done, end with the line ${OUTCOME_MARK} review: the task goes to review with them as the reviewer.`] : []),
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
/**
 * Agent follow-ups on one review before Paperclip hands it to a person
 * (its default is 3): a normal request → reply → follow-up → reply never
 * reaches a person by accident.
 */
const REVIEW_ROUNDS = 10;
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
// A quoted line never carries a head of its own: each re-wake used to quote the
// last, and the card filled with "Nothing has changed since my last comment:
// Nothing has changed since..." (SLA-1775).
const UNCHANGED_LEAD = /^(?:\s*Nothing has changed since my last (?:answer|comment)\b[:.,]?\s*)+/i;
// An answer whose first line says the run could not read the card is a claim about that run, not about the card: re-quoted, it read as the card's state.
const UNREADABLE = /\b(?:can(?:'|’)?t|cannot|can not|could not|unable to|do not|don't)\b[^.\n]{0,40}\b(?:read|see|access|view)\b/i;
const unchangedNote = (answer, who, state = "") => {
  const line = firstLine(answer).replace(UNCHANGED_LEAD, "");
  const quote = state && UNREADABLE.test(line) ? state : line || "see above.";
  return `${UNCHANGED_HEAD}${quote}${who ? ` Waiting on ${who}.` : ""}`;
};
/**
 * The wakes Paperclip holds to a comment (server heartbeat.ts
 * shouldRequireIssueCommentForWake): a run on one of them is answered only by
 * a comment, so a re-wake there still gets the note. The EM repo's board
 * waiter (scripts/paperclip/bridge-waiter.mjs) carries the same list; its
 * test pins the two together.
 */
const COMMENT_WAKES = ["issue_assigned", "execution_review_requested", "execution_approval_requested", "execution_changes_requested"];
/**
 * Whether a run on this wake may end with nothing said (SLA-2088). Every
 * wake Paperclip does not hold to a comment — someone else's comment the
 * answer already covers, an unblock, Paperclip's review-path recovery. A
 * wake the run does not record is not one: it still gets the note.
 */
const quietWake = ({ reason = null, skip = false } = {}) => typeof reason === "string" && reason !== "" && (skip || !COMMENT_WAKES.includes(reason));
/**
 * The field a comment-less close sends back unchanged, so the card's activity
 * shows the close under the run and the board waiter ends it. Nothing else the
 * bot writes carries it; a status write alone also happens mid-run.
 */
const QUIET_MARK = "requestDepth";
/**
 * Said in place of a comment by a run that ends with nothing new (SLA-2088):
 * every write that would have carried the note carries the quiet mark instead
 * — the card's own request depth, unchanged — and no comment.
 */
class Quiet {
  constructor(depth) { this[QUIET_MARK] = depth; }
}
const isQuiet = (c) => c instanceof Quiet;
/** A write's body with what it says: a comment, the quiet mark, or nothing. */
const withSaid = (body, text, issue) => isQuiet(text) ? { ...body, [QUIET_MARK]: Number.isInteger(issue?.[QUIET_MARK]) ? issue[QUIET_MARK] : text[QUIET_MARK] }
  : text !== undefined && text !== null ? { ...body, comment: text } : body;
// ---- Model-work triggers: what lets a wake start the model (docs/model-work-triggers.md) ----

/** Every status a Paperclip card can have (Paperclip's ISSUE_STATUSES). */
const CARD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
/** Where a new ask starts the model when PAPERCLIP_INTAKE is unset: everywhere but backlog, where a card is captured, not asked. */
const DEFAULT_INTAKE = CARD_STATUSES.filter((s) => s !== "backlog");
/** PAPERCLIP_INTAKE: `all`, or a comma list of card statuses; unset, DEFAULT_INTAKE. Throws on an unknown status or an empty list. */
function parseIntake(value, label = "PAPERCLIP_INTAKE") {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_INTAKE;
  if (String(value).trim().toLowerCase() === "all") return CARD_STATUSES;
  const named = String(value).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = named.filter((s) => !CARD_STATUSES.includes(s));
  if (unknown.length) throw new Error(`${label} names ${unknown.join(", ")}, which is not a card status (${CARD_STATUSES.join(", ")}, or all)`);
  if (!named.length) throw new Error(`${label} names no status; unset it for the default, or say all`);
  return [...new Set(named)];
}
/**
 * PAPERCLIP_REWAKE: how many times the model looks again at one ask it
 * answered as waiting when the card wakes with nothing new asked. `off` (or
 * unset) is 0: each such wake gets the mechanical note. The last look allowed
 * is told to escalate, and a wake past it gets the note.
 */
function parseRewake(value, label = "PAPERCLIP_REWAKE") {
  if (value === undefined || value === null || String(value).trim() === "" || String(value).trim().toLowerCase() === "off") return 0;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be off or a whole number of looks (1 or more), not ${value}`);
  return n;
}
/**
 * The status a card was in before this wake. Paperclip's wake checks a card
 * out to in_progress with no record of its own, so a card the board shows in
 * progress is in the status its last recorded change, or its creation, set.
 */
function intakeStatus(status, activity) {
  if (status !== "in_progress") return status;
  for (const a of list(activity, "activity")) {
    const to = a?.action === "issue.updated" ? a.details?.changes?.status?.to : a?.action === "issue.created" ? a.details?.status : undefined;
    if (typeof to === "string") return to;
  }
  return status;
}
const STATUS_NAMES = { backlog: "Backlog", todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", blocked: "Blocked", cancelled: "Cancelled" };
const INTAKE_HEAD = "Not started: this card is in ";
/** Posted under a run on a card whose status this bot does not start work in (PAPERCLIP_INTAKE). */
const intakeNote = (status, intake) => `${INTAKE_HEAD}${STATUS_NAMES[status] ?? status}, and I start work only on cards in `
  + `${intake.map((s) => STATUS_NAMES[s] ?? s).join(", ")}. Move it to one of those when it is ready for me.`;
/** Wake reasons as the model is told them. */
const WAKE_REASONS = {
  issue_disposition_repair: "Paperclip's disposition repair: your last run left the card open with no durable wait, so the board woke you to settle it",
  issue_commented: "a comment on the card",
  issue_unblock_requested: "a request to clear the card's block",
  issue_blockers_resolved: "the cards it waits on being done",
  issue_reopened_via_comment: "a comment that reopened the card",
};
/**
 * What a re-wake on an ask already answered tells the model (SLA-1775): it
 * woke again with nothing new asked, what it said last, why it woke, and what
 * the board shows now of each card it waits on — so it decides the next step
 * from the card's state, not from habit, and never repeats itself. One comment
 * comes of it: progress on a blocker being worked, an escalation when the
 * blocker is not being worked and nothing changed, or the work itself.
 *
 * @param {{ reason?: string|null, repair?: {attempt?: number, maxAttempts?: number}|null, previous?: string,
 *   blockers?: {name: string, title?: string, status?: string, holder?: string|null, updatedAt?: string, comments?: string[]}[],
 *   mustEscalate?: string|null, escalateName?: string|null, next?: number }} o
 */
function revisitNote({ reason = null, repair = null, previous = "", blockers = [], mustEscalate = null, escalateName = null, next = 1 } = {}) {
  const said = firstLine(previous).replace(UNCHANGED_LEAD, "");
  const why = WAKE_REASONS[reason] ?? (reason ? `the board (${reason})` : "the board");
  const to = escalateName ? ` It goes to ${escalateName}.` : "";
  const facts = blockers.map((b) => [
    `- ${b.name}${b.title ? ` "${b.title}"` : ""}: ${b.status ?? "status unknown"}, ${b.holder ? `held by ${b.holder}` : "held by nobody"}${b.updatedAt ? `, last changed ${b.updatedAt}` : ""}.`,
    ...(b.comments ?? []).map((c) => `  Recent comment: ${c}`),
  ].join("\n"));
  return [
    `This card woke you again (wake ${next} on this ask), from ${why}. Nobody has asked anything new since your last answer, which is in the thread above${said ? `; its first line was: "${said}"` : ""}.`,
    "Do not post that answer again, and never quote or restate a \"Nothing has changed\" comment. Read the thread for what your job on this card is, decide the next step, and post exactly one comment:",
    `- It waits on another card that is being worked: say (a) that it is being addressed and by whom; (b) what changed since you last looked, from what you check now — that card's status and holder below, and its pull request, CI and review state and any merge to develop, which you check yourself with your tools; never restate your last comment; and (c) that this card stays blocked on it, and the next step once it lands. End with ${OUTCOME_MARK} blocked on <that card's id>.`,
    `- It waits on a person or an event: say who or what, and what they need to do. End with ${OUTCOME_MARK} blocked (or ${OUTCOME_MARK} blocked on <Name>).`,
    `- What it waits on is not being worked — no holder, no change in a long time, or stuck — and nothing changed since you last looked: escalate. Say who decides, what they must decide and why. End with ${OUTCOME_MARK} escalate.${to}`,
    "- There is work you can do now: do it and answer as usual.",
    ...(reason === "issue_disposition_repair" ? [`Paperclip woke you because the card was left open with no durable wait${repair?.attempt ? ` (repair attempt ${repair.attempt} of ${repair.maxAttempts ?? "?"})` : ""}: block it on what it waits on, or escalate. Another "nothing has changed" reply only brings the next repair.`] : []),
    ...(mustEscalate ? [`Escalate this card now: ${mustEscalate} End with ${OUTCOME_MARK} escalate.${to}`] : []),
    ...(facts.length ? ["", "What the board shows now of the cards this one waits on:", ...facts] : []),
  ].join("\n");
}
/** Posted under a blocked answer that named a person the board does not have. */
const noPerson = (name) => `I could not hand this task to ${name}: the board has no person by that name, so it stays with me, blocked.`;
/** What a task handed to a person blocked waits for. */
const personAction = (name) => `Waits on ${name}, who holds it now: the last comment says what is needed. When it is done, hand the task back to the bot with a comment and it picks the work up again.`;
/** Ends a re-wake's run on an escalation already worked: the card is left blocked with this bot. */
const ESCALATION_KEPT = "This escalation was worked above and is still blocked with me. Add a comment with anything new, or hand it to me again, and I will pick it up.";
/** Added to an escalation's answer when the card changed while it was worked: the change stands. */
const CARD_CHANGED = "The card was changed while I worked on it, so I left it as it is now rather than hand it on.";
/** Added to an answer whose write was refused because a dependency it was built on reads open again: the card keeps waiting on it. */
const depsReopened = (names) => {
  const n = names.join(", "), one = names.length === 1;
  return `${n} ${one ? "is" : "are"} not done any more, so I put this card back to wait for ${one ? "it" : "them"} rather than move it on. It picks up again when ${one ? "it is" : "they are"} done.`;
};
/** An escalation answered while a newer question came in: the card stays with the bot, and the next wake answers it. */
const NEWER_ASK = "The card was asked something newer while I worked on this (a comment, an edit, or a new hand-off to me), so I kept it to answer that next rather than hand it on.";
// How many times an escalation whose ask changed under it is worked again,
// under the same run, before its answer is posted and the card kept for the next wake.
const MAX_REWORK = 2;
/** What a run on an escalation reworked under the same run is told: what changed, and what it said to the card as it was. */
const reworkNote = (what, said) => `The card changed while you worked on it: ${what}. Your answer to the card as it was is posted together with this one, above it:\n\n${said}\n\nAnswer the card as it is now. Do not repeat anything that answer says was already done.`;
/** Posted when Paperclip blocks a task because it lost the run, while the bot is still working on it. */
const TRANSPORT_NOTE = "The board lost its connection to this run and marked the task blocked. The work is still running here — one attempt, not restarted — and its result will be posted on this task when it finishes.";
/** Opens an attempt's answer delivered under a new run because the board lost the one it started under. */
const LOST_NOTE = "The board lost the run this work started under while it was still going. It went on here as one attempt, was not run again, and is delivered under this new run.";
/** The answer when an attempt's worker died after it started: never run again, as it may have acted. */
const workerDiedNote = (id, at, signal) => `The worker running this ask stopped before it finished (attempt ${id}${at ? `, started ${at}` : ""}${signal ? `, killed by ${signal}` : ""}). It was not run again: it may have done part of the work. Check what it did before asking for it again.\n\nPAPERCLIP-OUTCOME: blocked`;
/** Carried in an attempt's posted answer, so a post whose response was lost is found again whatever was added to its text. */
const attemptMark = (id) => `<!-- slashbin-attempt:${id}:result -->`;
/** What the bot posts that is no answer: bookkeeping on a run or a task. */
/** Ends a run on a card handed to someone else before the bot picked it up: it is theirs, left as it is. */
const HANDED_AWAY = "This task was handed to someone else before I picked it up, so I left it as it is.";
const NOTES = new Set([HELD_NOTE, PERSON_STANDS, ALREADY_ANSWERED, TRANSPORT_NOTE, ESCALATION_KEPT, HANDED_AWAY]);
/** Whether a comment of the bot's is one of its notes on the card, not an answer. */
/**
 * A re-wake's answer as it is posted (SLA-1775). A model that failed gives
 * null: the caller falls back to the mechanical note, the card as it was.
 * A card that must be escalated (the code's loop guard) or an answer that only
 * repeats the last one is escalated, so a loop always ends with someone who
 * decides and the thread never carries the same answer twice.
 */
function revisitAnswer(body, { said = "", unchanged = false, mustEscalate = null, waits = [] } = {}) {
  if (!String(body ?? "").trim()) {
    if (!mustEscalate) return null;
    body = unchangedNote(said, waits.join(", ") || null);
  }
  const o = outcomeOf(body);
  if (o.escalate) return body;
  const same = (t) => firstLine(t).replace(UNCHANGED_LEAD, "").trim().toLowerCase();
  // A repeat is never posted as news: whatever the board shows, an answer
  // with nothing new to say goes to whoever decides.
  const repeat = Boolean(same(said)) && same(o.comment) === same(said);
  const why = mustEscalate ?? (repeat ? `I would only repeat my last answer${unchanged ? ", and nothing this card waits on has changed" : ""}.` : null);
  return why ? `${body}\n\nEscalating: ${why}\n${OUTCOME_MARK} escalate` : body;
}
// A model-written "nothing has changed since my last comment" is a note too: quoted as an answer, it nested (SLA-1775).
const isNote = (body) => NOTES.has(body) || body.startsWith(keptHold()) || body.startsWith(UNCHANGED_HEAD) || body.startsWith(INTAKE_HEAD) || UNCHANGED_LEAD.test(String(body ?? ""));
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
 * every one is done (p7). `lastAnswered` — per task, its latest answered
 * ask: an ask is deduplicated only against that one, never against a window
 * of recent asks across tasks, so it is kept for every task, never trimmed
 * (w6). `handedTo` — per task, the record of its hand-off to the bot that its
 * latest answered ask was answered under: handed to the bot again, the task
 * is asked anew (docs/board-decisions.md (d)). `revisits` — per task's
 * latest answered ask, what its answer waits on, read again before it
 * resumes (w4). `gates` — per saved resume, the dependencies it resumed
 * from, saved before it ran: a restart that would run it again reads them
 * done first (preflight), or leaves it waiting. `refused` — per task, a
 * routing write refused because a dependency its answer was built on reads
 * open again (routeGate, waitKept): the dependencies, the asks still owed and
 * the outcome refused, saved BEFORE the write that keeps the wait goes out,
 * so a restart that finds that answer landed (its mark) settles it as the
 * kept wait, never as the outcome refused. Cleared once settled, or before a
 * write those dependencies read done let through.
 *
 * Only a missing file is a fresh start. One that cannot be read throws: read as
 * empty, it would run every answered task again.
 */
function loadState(file) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch (err) {
    if (err.code === "ENOENT") return { handled: new Set(), answered: new Set(), pending: new Map(), closing: new Map(), since: new Map(), decidedFrom: new Map(), attemptRuns: new Map(), resumed: new Set(), blockedAsks: new Map(), reviewAsks: new Set(), continued: new Set(), continuing: new Map(), attemptIds: new Map(), seq: 0, attemptSeq: new Map(), leads: new Map(), linked: new Map(), linkDone: new Map(), lastAnswered: new Map(), revisits: new Map(), handedTo: new Map(), builtOn: new Map(), gates: new Map(), refused: new Map() };
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
    lastAnswered: new Map(Object.entries(s.lastAnswered ?? {}).filter(([, v]) => typeof v === "string")),
    revisits: new Map(Object.entries(s.revisits ?? {}).filter(([, v]) => v && typeof v === "object")),
    handedTo: new Map(Object.entries(s.handedTo ?? {}).filter(([, v]) => typeof v === "string")),
    builtOn: new Map(byAsk(s.builtOn).filter(([, v]) => v && typeof v === "object" && v.snap && typeof v.snap === "object")),
    gates: new Map(Object.entries(s.gates ?? {}).filter(([, v]) => v && Array.isArray(v.refs))),
    refused: new Map(Object.entries(s.refused ?? {}).filter(([, v]) => v && Array.isArray(v.tasks) && Array.isArray(v.open))) };
}
/** Written whole or not at all: a temp file, flushed, then renamed over the old one. */
function saveState(file, { handled, answered, pending, closing, since = new Map(), decidedFrom = new Map(), attemptRuns = new Map(), resumed = new Set(), blockedAsks = new Map(), reviewAsks = new Set(), continued = new Set(), continuing = new Map(), attemptIds = new Map(), seq = 0, attemptSeq = new Map(), leads = new Map(), linked = new Map(), linkDone = new Map(), lastAnswered = new Map(), revisits = new Map(), handedTo = new Map(), builtOn = new Map(), gates = new Map(), refused = new Map() }) {
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
      lastAnswered: Object.fromEntries(lastAnswered),
      revisits: Object.fromEntries([...revisits].filter(([k]) => answered.has(k) && (lastAnswered.get(k.slice(0, k.indexOf(":"))) ?? k) === k)),
      handedTo: Object.fromEntries(handedTo),
      builtOn: Object.fromEntries([...builtOn].filter(([k]) => pending.has(k))),
      gates: Object.fromEntries([...gates].filter(([k]) => pending.has(k))),
      refused: Object.fromEntries([...refused].filter(([t]) => [...pending.keys()].some((k) => k.startsWith(`${t}:`)))),
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
 * @param {string[]} [o.intake]  card statuses a new ask starts the model in (parseIntake); any other gets a note, the model not started
 * @param {number} [o.rewake]  times the model looks again at an ask answered as waiting (parseRewake); 0, the mechanical note
 */
function createPaperclipPoller({ url, apiKey, stateFile, answer, log, fetch: fetchImpl = fetch, requestTimeoutMs = 30000,
  resumeInterrupted = false, externalWriter = null, watchMs = 60000, onPoll = null,
  escalationLabels = ESCALATION_LABELS, escalateTo = null, escalationReturnTo = null, escalationAuthority = "", onEscalate = null,
  escalate: escalateClient = null, attempts = null, contract = null, policy = null, intake = DEFAULT_INTAKE, rewake = 0 }) {
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
  state.revisits ??= new Map();
  state.handedTo ??= new Map();
  // The card each owed answer was made from (snapOf, as its preflight read
  // it) and the runs it was made under: routed after a restart, the answer is
  // checked against that card, not the one the restarted bot first read (d).
  state.builtOn ??= new Map();
  // What each owed resume was admitted on: the dependencies it resumes from,
  // saved before its preflight, so every recovery that would run it again is
  // gated on them as the first run was (preflight, savedDeps).
  state.gates ??= new Map();
  // Per task: a write refused because a dependency the answer was built on
  // reads open again (routeGate, waitKept), saved before the write that keeps
  // the wait. settle keeps the wait from it, so the ask resumes when they are
  // done — after a restart too (loadState's `refused`).
  state.refused ??= new Map();
  const { since, decidedFrom, attemptRuns, resumed, blockedAsks, reviewAsks, continued, continuing, attemptIds, attemptSeq, leads, linked, linkDone, lastAnswered, revisits, handedTo, builtOn, gates } = state;
  const depsRefused = state.refused;
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
   * The company's task-completion policy, read live for each run (SLA-C1,
   * epic 651): its text and the revision it is, which the run logs. Unreadable
   * is said in the prompt, never left silent; unset is no policy block.
   */
  const policyText = async (tLog) => {
    if (!policy) return "";
    try {
      const doc = await api("GET", `/cases/${policy.caseId}/documents/${encodeURIComponent(policy.key)}`);
      const body = String(doc.latestBody ?? doc.body ?? "").trim();
      if (!body) throw new Error("the document is empty");
      tLog.info({ policy: policy.key, revisionId: doc.latestRevisionId, revision: doc.latestRevisionNumber }, "Paperclip policy read for this run");
      return `${body}\n\n(${policy.key}, revision ${doc.latestRevisionNumber}, ${doc.latestRevisionId})`;
    } catch (err) {
      tLog.warn({ policy: policy.key, err: err.message, status: err.status }, "Paperclip policy unreadable — the run is told so");
      return POLICY_UNAVAILABLE(policy, err.status ? `HTTP ${err.status}` : err.message);
    }
  };
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
  const hopBlocked = (hop, setter) => hop?.kind === "resumed" && Boolean(setter) && writerOf(setter).type === "agent" && writerOf(setter).id === hop.from;
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
  /** A task's activity record, newest first. No comment text is read from it (decisionsOf). */
  async function activityOf(taskId) {
    return list(await api("GET", `/issues/${taskId}/activity`), "activity");
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
  /**
   * The card a run was built on, read again just before the run's answer and
   * before every routing write — a return, a transfer, an unlink, a rewrite of
   * what it waits on (docs/board-decisions.md (d)). It is the same card only
   * when its snapshot (snapOf) reads as it did, field by field, and nothing
   * was recorded on it since by anyone but this bot — a decision or a
   * settlement by Paperclip itself counts, as do an edit and a comment — and
   * it was not cancelled since: cancellation never lets work go on. The record is
   * read last, so a change between these reads is seen in it. Paperclip has
   * no compare-and-set: a change inside the one round trip between this read
   * and the write is not seen (the residual, docs/board-decisions.md "Known
   * limits"). Resolves to the fresh card, with `moved` when it is not the
   * same card.
   *
   * The status the snapshot expects is the one it read, or the one this
   * attempt itself wrote since (an escalation put back to blocked after the
   * checkout, a resume taken in progress): a status anyone else recorded, or
   * one no record accounts for, is a change. "This attempt" is its own runs
   * (`own`), told by the run id Paperclip records with each write, never by
   * the seat: another run of this same seat is someone else, and whatever it
   * writes or posts is a change. Comments the attempt's own runs posted are
   * its output, not a change to the card it was built on. A system comment
   * (a notice from the board) is a change too.
   *
   * `was.snap`, when given, is the snapshot saved with an answer when it was
   * made (builtOn), and `was.own` the runs it was made under: an answer
   * routed after a restart is checked against the card that produced it, not
   * the card the restarted bot first read.
   */
  const labelsOf = (issue) => (issue.labels ?? []).map((l) => String(l?.id ?? l?.name ?? l).trim().toLowerCase()).sort();
  const snapOf = (issue, comments, own = []) => {
    const ask = askOf(comments, me.id);
    return { status: issue.status ?? null, assignees: [issue.assigneeAgentId ?? null, issue.assigneeUserId ?? null], labels: labelsOf(issue),
      title: issue.title ?? "", description: issue.description ?? "", newest: comments.filter((c) => !own.includes(c.createdByRunId)).at(-1)?.id ?? null,
      ask: ask?.body ?? "" };
  };
  const sameSnap = (a, b) => Object.keys(a).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
  // A record entry by anyone but this bot: a person or another agent, or
  // Paperclip deciding or settling (decisionKind). A bare restatement of the
  // status changes nothing on the card (board-decisions rule 2).
  const restates = (a) => a.action === "issue.updated" && Object.keys(a.details?.changes ?? {}).every((k) => k === "statusVersion");
  // A write of this attempt's own: this seat, under one of the attempt's runs (`own`).
  const ownWrite = (a, own) => byBot(a, me.id) && Boolean(a.runId) && own.includes(a.runId);
  // Paperclip settling one of the attempt's own runs as lost (watchRun): the
  // attempt's own life, not a decision about the card. Counted only for a
  // routing write after the answer (`settled`); before the run, a lost run
  // still stops it (deferLost).
  const ownLoss = (a, own) => a.action === "issue.execution_recovery_settled" && Boolean(a.runId) && own.includes(a.runId);
  const foreignSince = (record, mark, own = [], settled = false) => {
    const all = list(record, "activity"), { kinds } = decisionsOf(all, me.id);
    return all.some((a, i) => after(a, mark) && !ownWrite(a, own) && !(settled && ownLoss(a, own))
      && (kinds[i] !== "none" || a.action === "issue.comment_added" || (writerOf(a).type !== "system" && !restates(a))));
  };
  // The status this attempt itself recorded since `mark`, when the newest status recorded since is its own.
  const ownStatusSince = (record, mark, own = []) => {
    const a = list(record, "activity").find((x) => after(x, mark) && (x.details?.changes?.status || x.action === "issue.execution_recovery_settled"));
    return a && ownWrite(a, own) && a.details?.changes?.status ? a.details.changes.status.to : undefined;
  };
  // The snapshot of a card as read whole ({ issue, comments, activity }),
  // under runs `own`: the "was" side of a later comparison (changedFrom).
  const snapshotOf = (card, own) => {
    if (!card?.issue || !Array.isArray(card.comments) || !card.activity) throw new TypeError("snapshotOf needs a card read whole");
    return { snap: snapOf(card.issue, card.comments, own), own: [...own], mark: markOf(card.activity) };
  };
  // Whether card `now` ({ issue, comments, activity }) is not the snapshot `was` (cardNow).
  const changedFrom = (was, now, own = [], { settled = false } = {}) => {
    // A snapshot with no snap, mark or runs of its own — a legacy answer, or
    // one saved before the three were kept — has nothing to be checked
    // against: changed, and nothing is routed (routableSnapshot).
    if (!routableSnapshot(was)) return true;
    const runs = [...new Set([...own, ...was.own])].filter(Boolean);
    const mark = was.mark;
    const expected = { ...was.snap };
    // A run of its own lost since leaves the status to Paperclip's block and
    // the checkout of the run that replaced it, neither recorded as anyone's
    // decision: a status anyone recorded since is still a change (foreignSince).
    const lost = settled && list(now.activity, "activity").some((a) => after(a, mark) && ownLoss(a, runs));
    const ownStatus = ownStatusSince(now.activity, mark, runs);
    expected.status = lost ? now.issue.status : ownStatus ?? expected.status;
    // Cancelled since the snapshot is a change, whoever wrote it. A snapshot
    // read cancelled — the put-back of a person's cancel (writeStatus), which
    // a person's newer decision is put back over in turn — decided knowing it.
    return (now.issue.status === "cancelled" && expected.status !== "cancelled") || foreignSince(now.activity, mark, runs, settled) || !sameSnap(expected, snapOf(now.issue, now.comments, runs));
  };
  // The card read whole, its record last: a change between these reads is seen in the record.
  async function readCard(taskId) {
    const issue = await api("GET", `/issues/${taskId}`);
    const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const activity = await activityOf(taskId);
    return { issue, comments, activity };
  }
  async function cardNow(taskId, was, own = was?.own ?? [], opts = {}) {
    const now = await readCard(taskId);
    return { ...now, moved: changedFrom(was, now, own, opts) };
  }
  /** A comment and nothing else: the only write besides routeGate's, and it routes nothing. */
  const say = (taskId, comment, runId) => api("PATCH", `/issues/${taskId}`, withSaid({}, comment), runId);
  /** Whether a routing write moves the card out of the wait it is in: a hand-off, a new holder, any status but blocked, or a link to a dependency cut. */
  const leavesWait = (body, deps) => Boolean(body.escalate) || "assigneeAgentId" in body || "assigneeUserId" in body
    || (body.status !== undefined && body.status !== "blocked") || (Array.isArray(body.blockedByIssueIds) && deps.some((d) => !body.blockedByIssueIds.includes(d)));
  /**
   * The one gate every routing write passes (docs/board-decisions.md (d)):
   * a status, a holder, what the card waits on, its unblock step, a hand-off
   * through process.escalate — a close, a return, a fallback block after a
   * refusal, a checkout put back, a link or an unlink alike. `from` is the
   * snapshot that produced the write (builtOn for an answer, the wake's read
   * for a note, the read a compensation is decided on). The card is read
   * again here, immediately before the write, and compared with it
   * (changedFrom): anything recorded since by anyone but this attempt's own
   * runs (`own`, default `from.own`) — a status, holder, waits, unblock step,
   * label, edit, comment or any other activity after its mark — or a
   * snapshot that proves nothing (routableSnapshot), and nothing is routed:
   * `unrouted` goes as a comment only (none when null — a comment would end
   * the run), and the card stays as it is now. A newer ask is a change like
   * any other, never a reason to skip the comparison.
   *
   * `write` is the routing body, or a function of the fresh card that makes
   * it (null: nothing to route); `{ escalate: args }` hands the card on
   * through process.escalate instead of a PATCH. `comment` rides in the
   * routed PATCH. An HTTP refusal of the routed PATCH is thrown: a fallback
   * that routes calls the gate again, from a fresh read. Resolves to
   * `{ routed, fresh, result }`. Paperclip has no compare-and-set: a change
   * inside the one round trip between this read and the write is the residual.
   *
   * A write that may move a resumed card out of its wait (leavesWait) reads
   * the card's dependencies first (depsGate) and the card after them, so the
   * card compare is the last read before the write and a change during a
   * dependency read is seen. One read open again, and nothing leaves the
   * wait: the same single PATCH puts the wait back instead (waitKept, its
   * comment `said` with the reopened tasks named), and resolves
   * `{ routed: false, why: "deps", open }`; settle then keeps the wait and the
   * ask owed (depsRefused), for the wake that reads them done. The refusal is
   * saved before that write goes out (waitKept): a restart after the board
   * took it settles the wait, not the outcome refused. A write that leaves the
   * wait, let through on its dependencies read done, clears any earlier
   * refusal of the task — saved, before it goes out.
   */
  async function routeGate(taskId, from, runId, write, { comment, unrouted = comment, settled = false, own, said = comment } = {}) {
    if (!routableSnapshot(from)) {
      if (unrouted !== null && unrouted !== undefined) await say(taskId, unrouted, runId);
      return { routed: false, fresh: null, why: "unproven" };
    }
    // A write from an answer a dependency resume produced (`from.deps`)
    // that may leave the wait (a body made from the fresh card may): every
    // dependency is read first (depsGate), and the card after it, last
    // before the write — a change made during the dependency reads is seen.
    const mayLeave = from.deps?.length && (typeof write === "function" || (write && leavesWait(write, from.deps)));
    const deps = mayLeave ? await depsGate(from.deps, taskId) : null;
    const fresh = await cardNow(taskId, from, own ?? from.own, { settled });
    const body = !fresh.moved ? (typeof write === "function" ? await write(fresh) : write) : null;
    if (!body) {
      if (unrouted !== null && unrouted !== undefined) await say(taskId, unrouted, runId);
      return { routed: false, fresh, why: fresh.moved ? "changed" : "nothing" };
    }
    // A dependency read open, and nothing leaves the wait: the wait is kept
    // instead, in this same one write (waitKept) — the answer said with it.
    const keep = deps && !deps.done && leavesWait(body, from.deps) ? waitKept(taskId, fresh.issue, deps, said ?? null, body) : null;
    // Its dependencies read done: an earlier refusal of this task no longer stands.
    if (deps?.done && depsRefused.delete(taskId)) saveState(stateFile, state);
    const kept = { routed: false, fresh, why: "deps", open: deps?.open };
    if (keep && !Object.keys(keep.body).length) {
      if (keep.text !== null) await say(taskId, keep.text, runId);
      return kept;
    }
    if (!keep && body.escalate) {
      let out;
      try { out = await escalateClient(body.escalate, { runId }); } catch (err) { out = { ok: false, code: "escalate_unreachable", message: err.message }; }
      return { routed: true, fresh, result: out?.ok === true ? out : { ok: false, code: out?.code ?? "escalate_unreadable", message: out?.message ?? "escalate gave no result" } };
    }
    const [send, text] = keep ? [keep.body, keep.text] : [body, comment];
    let result;
    try { result = await api("PATCH", `/issues/${taskId}`, withSaid(send, text, fresh.issue), runId); } catch (err) {
      if (!keep || !(err.status >= 400 && err.status < 500)) throw err;
      log.warn({ err: err.message, issue: taskId }, "Paperclip refused keeping the wait with the answer — the answer goes as a comment");
      if (keep.text !== null) await say(taskId, keep.text, runId);
      return kept;
    }
    return keep ? kept : { routed: true, fresh, result };
  }
  /**
   * The write that keeps a card's wait when a write from an answer was
   * refused because a dependency that answer was built on reads open again
   * (routeGate): blocked with the bot, linked to every dependency still
   * open, its unblock step naming them — only what differs from the card
   * just read (a card already in that wait gets the comment alone) — and
   * the answer said in it (`said`; null: nothing said, a comment would end
   * the run). A mirrored card's status and links are its writer's: the
   * comment only. The refusal is noted for the task (depsRefused) and saved
   * before the write is returned for sending — write-ahead: the dependencies,
   * the asks still owed and the outcome refused. Its settle, on this wake or
   * on a restart that finds the answer landed, keeps the ask waiting on them,
   * so the wake that reads them done resumes it.
   */
  function waitKept(taskId, issue, deps, said, refusedBody = {}) {
    depsRefused.set(taskId, { tasks: deps.tasks, open: deps.open, done: false,
      owed: [...pending.keys()].filter((k) => k.startsWith(`${taskId}:`)),
      refused: refusedBody.escalate ? `escalate:${refusedBody.escalate.operation ?? ""}` : refusedBody.status ?? ("assigneeAgentId" in refusedBody || "assigneeUserId" in refusedBody ? "hand-off" : "unlink") });
    saveState(stateFile, state);
    const on = (issue.blockedBy ?? []).map((b) => b.id);
    const names = deps.open.map(nameOf);
    const missing = deps.open.filter((t) => t.status !== "unknown").map((t) => t.id).filter((id) => !on.includes(id));
    const body = external(issue) ? {} : {
      ...(issue.status !== "blocked" ? { status: "blocked", unblockDescriptor: { owner: { agentId: me.id }, action: waitAction(names) } } : {}),
      ...(missing.length ? { blockedByIssueIds: [...on, ...missing] } : {}) };
    // Nothing new said (Quiet), a dependency reopened is: it goes alone.
    return { body, text: said === null ? null : isQuiet(said) ? depsReopened(names) : `${said}\n\n${depsReopened(names)}` };
  }
  /**
   * The record of the card's latest hand-in to this bot from another holder
   * (a write naming the bot that already held it hands nothing over): the
   * hand-off an answer is answered under. "" when the record shows none.
   */
  const handIn = (activity) => list(activity, "activity").find((a) => a.details?.changes?.assigneeAgentId?.to === me.id
    && a.details.changes.assigneeAgentId.from !== me.id)?.id ?? "";
  /**
   * A hand-off's holder fields, only those it changes (d): the new holder,
   * and the other kind of holder cleared only when the card read last has one.
   * With no read to go by, both, as before.
   */
  const holderWrite = (to, issue) => {
    const [mine, other] = to.userId ? ["assigneeUserId", "assigneeAgentId"] : ["assigneeAgentId", "assigneeUserId"];
    return { [mine]: (to.userId ?? to.agentId) ?? null, ...(!issue || issue[other] ? { [other]: null } : {}) };
  };
  /**
   * The state file as it was before an attempt began, put back whole when the
   * card moved before the attempt ran (cardNow): nothing of it was done, and
   * the next wake decides from the card as it is then.
   */
  const checkpoint = () => structuredClone(state);
  function restore(was) {
    for (const [k, v] of Object.entries(was)) {
      const live = state[k];
      if (live instanceof Map) { live.clear(); for (const [a, b] of v) live.set(a, b); } else if (live instanceof Set) { live.clear(); for (const a of v) live.add(a); } else state[k] = v;
    }
    saveState(stateFile, state);
  }
  /** The card moved before an attempt ran: the attempt ends unrun, nothing posted, and the card is left for the next wake. */
  class CardMoved extends Error {}
  /** A dependency read not done just before a resume's model run (depsGate): nothing runs, and the wait stands. `now` is that read. */
  class DepsOpen extends Error { constructor(now) { super("a dependency is not done"); this.now = now; } }
  // What a resume or a going-on tells the model and says on the card, built
  // only from the names depsGate read done immediately before the run (run's
  // `deps`): never from an earlier lookup. `what` is "task" or "card".
  const resumeText = (what, names) => {
    const n = names.join(", "), one = names.length === 1;
    return { lead: `Resuming: ${n}, which this ${what} waited on, ${one ? "is" : "are"} done.`,
      note: what === "task" ? `This task was blocked waiting on ${n}; ${one ? "it is" : "they are"} now done. Pick the task up where it stopped.`
        : `This card waited on ${n}; ${one ? "it is" : "they are"} now done. Pick it up where it stopped.` };
  };
  const goOnText = (what, names, said) => {
    const n = names.join(", "), one = names.length === 1;
    return { lead: `${said}\n\nResuming: ${n}, which this ${what} waited on, ${one ? "is" : "are"} already done.`,
      note: `This ${what} said it was blocked waiting on ${n}; ${one ? "it is" : "they are"} already done. What it said so far:\n\n${said}\n\n${what === "task" ? "Pick the task up" : "Pick it up"} where it stopped, and do not repeat anything it says was already done.` };
  };
  // The `deps` of a going-on (goOn, r7) and of an interrupted one run again:
  // its prompt and lead are made when depsGate reads its waits done, and only
  // then is it under way (`continuing` gets its prefix, the answer it went on
  // from is set aside). A new going-on is recorded unstarted before its
  // preflight (preContinue): a restart inside the preflight finds it so and
  // puts it back (unstarted), and the next wake goes on again. `k` names a
  // new going-on; without it the interrupted `cont` is brought up to the
  // fresh read.
  const contDeps = (cont, what, k) => ({ refs: cont.deps, say(names) {
    const t = goOnText(what, names, cont.said);
    if (k === undefined) Object.assign(cont, { prefix: t.lead, note: t.note });
    else { continuing.set(k, { ...(continuing.get(k) ?? {}), prefix: t.lead, note: t.note, deps: cont.deps, said: cont.said, was: cont.was }); pending.set(k, ""); }
    return t;
  } });
  // A going-on recorded before its preflight, unstarted (no prefix): what
  // undoes it after a restart (unstarted) — its go-on mark, the attempt id
  // and the mark it was decided from as they were before it.
  const preContinue = (k, mark, cont) => {
    continuing.set(k, { deps: cont.deps, said: cont.said, was: cont.was, mark, id: attemptIds.get(k) ?? null, from: decidedFrom.get(k) ?? null });
  };
  // Every going-on of the task recorded but never started — the bot stopped
  // inside its preflight — is put back as it was before it: its answer still
  // owed, its go-on not used, so the next look goes on with it again. One
  // that started (its prefix made) is never run a second time.
  const unstarted = (taskId) => {
    let any = false;
    for (const [k, c] of [...continuing]) {
      if (!k.startsWith(`${taskId}:`) || c.prefix !== undefined) continue;
      continuing.delete(k);
      if (c.mark) continued.delete(c.mark);
      if (c.id) attemptIds.set(k, c.id); else if (c.id === null) attemptIds.delete(k);
      if (c.from) decidedFrom.set(k, c.from); else if (c.from === null) decidedFrom.delete(k);
      any = true;
    }
    if (any) saveState(stateFile, state);
  };
  /** The comment a write a person's change stood over is replaced with, once per change. */
  async function personStands(taskId, mark, runId) {
    const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments");
    if (!comments.some((c) => c.authorAgentId === me.id && c.body === PERSON_STANDS && c.createdAt > atOf(mark))) {
      await say(taskId, PERSON_STANDS, runId);
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
    return { key: askKey(taskId, issue, askOf(comments, me.id)), status, external: external(issue), away: heldElsewhere(issue),
      shown: issue.status, unblock: issue.unblockDescriptor ?? null, reviewStage: issue.executionState?.currentStageId ?? null };
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
  // A later round reuses the stage the card's review state points at: a stage
  // sent without an id gets a new one, which orphans that state, and the board
  // then finds no reviewer and refuses the write (live 2026-10-18, SLA-1871:
  // HTTP 422 invalid_issue_disposition on every second answer, retried each tick).
  const statusWrite = (status, waits, reviewer, person, stageId = null) => (status === "blocked"
    ? { status, unblockDescriptor: { owner: { agentId: me.id },
        action: person?.userId ? personAction(person.name) : waits?.names.length ? waitAction(waits.names) : UNBLOCK_ACTION },
      ...(waits ? { blockedByIssueIds: waits.ids } : {}) }
    : status === "in_review" && reviewer
      ? { status, executionPolicy: { maxReviewRounds: REVIEW_ROUNDS, stages: [{ ...(stageId ? { id: stageId } : {}), type: "review", participants: [reviewer.agentId ? { type: "agent", agentId: reviewer.agentId } : { type: "user", userId: reviewer.userId }] }] } }
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
    const waits = { ids: [], names: [], done: [], all: [], ready: names.length > 0 };
    for (const n of names) {
      const t = await taskNamed(n);
      // Every task named, done or not, known or not: what a resume waits on (depsGate).
      const ref = t?.id ? t.id : n;
      if (t?.id !== selfId && !waits.all.includes(ref)) waits.all.push(ref);
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
  // Each write is gated (routeGate) against the card this decision is read
  // from: anything recorded on it since, by anyone but this run, stands too.
  async function writeStatus(taskId, entry, status, expected, mark, waits) {
    const card = await readCard(taskId);
    const stands = async () => {
      delete entry.wrote;
      saveState(stateFile, state);
      await personStands(taskId, mark, entry.runId);
      return false;
    };
    if (decidedSince(card.activity, mark)) return stands();
    const from = snapshotOf(card, [entry.runId]);
    if (waits && !(await routeGate(taskId, from, entry.runId, { blockedByIssueIds: waits }, { unrouted: null })).routed) return stands();
    entry.wrote = { status, expected };
    closing.set(taskId, entry);
    saveState(stateFile, state);
    try {
      if (!(await routeGate(taskId, from, entry.runId, statusWrite(status), { unrouted: null })).routed) return stands();
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
    const card = await readCard(taskId);
    const activity = list(card.activity, "activity");
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
      const put = await routeGate(taskId, snapshotOf(card, [runId]), runId,
        { ...(waits ? { blockedByIssueIds: waits.from ?? [] } : {}), ...(agentOwned ? { unblockDescriptor: note.from } : {}) }, { unrouted: null });
      if (!put.routed) {
        await personStands(taskId, closed, runId);
        tLog.info({ issue: taskId }, "Paperclip task was blocked by someone as the bot closed it, and changed since — left as it is");
        return true;
      }
    }
    if (note?.from && !agentOwned) {
      const text = keptHold(note.from.action);
      const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments");
      if (!comments.some((c) => c.authorAgentId === me.id && c.body === text)) await say(taskId, text, runId);
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
        } else if (now.key !== key && !now.external) { // a mirrored card's status is its writer's; the newer ask's own wake answers it
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
   * A hand-off can bring three wakes (its own, a comment just after,
   * Paperclip's review recovery). Only a wake Paperclip holds to a comment
   * (COMMENT_WAKES) gets a note; every other ends with nothing said, its
   * close carrying the quiet mark instead (SLA-2088). A note repeats the
   * answer's first line and who the task waits on, so the card still reads
   * as the answer did. No earlier note is taken down:
   * the board shows a deleted comment as a blank one, which read as the bot
   * posting nothing (SLA-1621).
   *
   * `waits`, when given, are what a blocked answer still waits on though the
   * card's own links all read done — one trimmed and reopened since: the note
   * links them again, so the wait stands on the card (w4).
   */
  async function acknowledge(item, runId, comments, key, mark, issue, snapshot, waits, { handToRequester = false } = {}) {
    if (!snapshot || typeof snapshot !== "object") throw new TypeError("acknowledge needs the wake's snapshot");
    const as = blockedAsks.has(key) ? "blocked" : "done";
    const waitsOn = as === "blocked" ? waits ?? (issue.blockedBy ?? []).map(nameOf) : [];
    // A note that already landed was recorded as a close when it was sent.
    const noted = comments.some((c) => c.createdByRunId === runId);
    const answer = comments.filter((c) => !c.deletedAt && c.authorAgentId === me.id && c.body && !isNote(c.body)).at(-1);
    const owner = waitsOn.length ? waitsOn.join(", ") : as === "blocked" ? await ownerName(issue) : null;
    let note = unchangedNote(answer?.body, owner, as === "blocked" ? `the card is blocked${owner ? ` on ${owner}` : ""}.` : "");
    // A card the bot holds blocked with nothing it can clear, and a creator
    // other than itself: every 4h wake of the holder lands back here, re-blocks
    // the card and starts the clock again. It is handed to whoever created it,
    // so the wake goes to the party who can act. The board takes an agent
    // naming only itself as unblock owner, so the assignee is what moves.
    let giveTo = null;
    if (!noted && as === "blocked" && handToRequester && !owner && !reviewAsks.has(key)) {
      const req = requesterOf(issue, me.id);
      const who = req && await targetOf(req);
      giveTo = who && await holderFor(who);
      if (giveTo) note = `${note} Nothing here is mine to clear, so this card goes back to ${giveTo.name}, who created it.`;
    }
    // Nothing new, on a wake Paperclip does not hold to a comment: the run
    // ends with nothing said (SLA-2088). The note was the only way to end a
    // run once, and a hand-off brought three in a minute — the answer, then
    // one for the comments it already covered and one for Paperclip's review
    // recovery. The close is the same write without it, carrying the quiet
    // mark the board waiter ends the run on. A card handed back to its
    // creator says so: that is news.
    if (!noted && !giveTo && Number.isInteger(issue[QUIET_MARK]) && quietWake(await wakeOf(runId))) {
      log.info({ paperclipTask: issue.identifier, runId }, "Paperclip task woke again with nothing new — the run is closed without a comment");
      note = new Quiet(issue[QUIET_MARK]);
    }
    // An ask answered `review` is the reviewer's to move on: the note leaves
    // the card's status and review path as they are.
    if (!noted && reviewAsks.has(key)) {
      await say(item.id, note, runId);
      handled.add(runId);
      saveState(stateFile, state);
      return;
    }
    const closed = !noted
      && await reply(item, runId, key, snapshot, note, as, { moveStopped: as === "blocked", waitsOn, unlessReady: as === "blocked", mark: decidedFrom.get(key) ?? mark, giveTo });
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
    else await say(item.id, body, runId);
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
  async function reply(item, runId, key, snapshot, comment, as = "done", { moveStopped = true, waitsOn = [], unlessReady = false, mark, giveTo = null,
    handOff = null, resumed = false, reviewer = null } = {}) {
    // The card the answer was produced from is required: a routing write is
    // never decided from a card read here (board-decisions (d)).
    if (!snapshot || typeof snapshot !== "object") throw new TypeError("reply needs the snapshot the answer was produced from");
    const routable = routableSnapshot(snapshot);
    // A blank comment reads on the card as the bot saying nothing (SLA-1621).
    if (!isQuiet(comment) && !String(comment ?? "").trim()) comment = FALLBACK_REPLY;
    const now = await boardNow(item.id);
    // Handed to someone else while it was answered: theirs now, so the comment only.
    // A card handed back down to the bot (hopOf `resumed`) is in the hop's
    // block, no one's hold: its answer moves it on like the bot's own.
    // A task another writer owns takes the bot's block and nothing else: the
    // writer keeps its status, but a mirrored card the bot leaves open after a
    // waiting answer has no durable wait, and Paperclip's disposition repair
    // re-woke the bot on it until it gave up (SLA-1775). A block links what it
    // waits on, and the writer cannot move the card on while that is open.
    let close = now.key === key && !now.away
      && (now.external ? as === "blocked"
        : !STOPPED.has(now.status) || (moveStopped && (resumed || await mayMove(item.id, now.status))));
    const waits = close && as === "blocked" ? await resolveWaits(waitsOn, item.id) : undefined;
    // Every task the block names is done by now: it would wait for a wake that
    // never comes. Nothing is written, so the caller can go on with the work.
    if (unlessReady && waits?.ready) return READY;
    close &&= !await personDecided(item.id, mark);
    // Every routing write an answer makes — a block and what it waits on, a
    // return, a transfer, a review, a done close — is decided from the
    // snapshot the answer was produced from (`snapshot`: the wake's read for a
    // note, the builtOn card for an answer), never from a card read here, and
    // goes through the one gate (routeGate): the card read again just before
    // the write, as the "now" side only (d). Changed since, or a snapshot that
    // authorizes nothing (routableSnapshot), and nothing is routed — the
    // answer is said as a comment only, the card's status, links and unblock
    // step as they are. A close recorded before it goes out is dropped again
    // when the gate does not route it: nothing was written to put back.
    // A close with nothing said stays so when the card changed under it.
    const changedNote = (text) => isQuiet(text) ? text : `${text}\n\n${CARD_CHANGED}`;
    const unclose = () => {
      if (closing.get(item.id)?.key === key && closing.get(item.id)?.runId === runId) { closing.delete(item.id); saveState(stateFile, state); }
    };
    // Through process.escalate: the action's own write carries the hand-off,
    // the block and the record, so nothing here closes the card. The hand-off
    // passes the same gate (handOffVia).
    if (close && handOff) {
      await handOff(comment, snapshot);
      return false;
    }
    // Handed back blocked (`return`): the task goes to whoever gave it, in the
    // same write, and the comment says what is left for them. The write still
    // carries the unblock note the board demands of every block (statusWrite):
    // without it the board refused every hand-back (live 2026-10-14, HTTP 422
    // "Entering blocked requires ... unblockDescriptor"). A hand-off the board
    // refuses closes the task blocked with the bot — through the gate again,
    // from a fresh read — and the comment says so.
    if (close && giveTo) {
      try {
        const out = await routeGate(item.id, snapshot, runId, (fresh) => {
          closingNow(item, runId, key, as, mark, resumed);
          return { ...statusWrite(as, waits, null, giveTo.person ? giveTo : null), ...holderWrite(giveTo, fresh.issue) };
        }, { comment, unrouted: changedNote(comment), settled: true });
        if (!out.routed) { unclose(); return false; }
        return close;
      } catch (err) {
        if (!(err.status >= 400 && err.status < 500)) throw err;
        log.error({ err: err.message, to: giveTo.name, issue: item.id }, "Paperclip hand-back refused by the board — the task stays with this bot");
        comment = `${comment}\n\nI could not hand this task ${giveTo.person ? "to" : "back to"} ${giveTo.name}: the board refused it (${err.status}).`;
      }
    }
    // A mirrored card's links are its writer's unless the answer names a
    // wait of its own: a block on a person or an event leaves them as they are.
    if (close) {
      try {
        const out = await routeGate(item.id, snapshot, runId, () => {
          closingNow(item, runId, key, as, mark, resumed);
          return statusWrite(as, now.external && !waits?.ids.length ? null : waits, reviewer, null, now.reviewStage);
        }, { comment, unrouted: changedNote(comment), settled: true });
        if (!out.routed) { unclose(); return false; }
      } catch (err) {
        // A card in a review stage takes the reviewer's non-approving write as
        // changes requested and moves it on itself, then refuses the block's
        // unblock note: the same write failed on every tick, forever. The
        // board's review decides the status; the answer goes as a comment.
        if (!(err.status === 422 && /unblockDescriptor requires blocked status/.test(err.message))) throw err;
        log.warn({ err: err.message, issue: item.id }, "Paperclip review stage took the card's status — the answer goes as a comment only");
        await say(item.id, comment, runId);
        return false;
      }
      return close;
    }
    // A blocked answer that cannot close (a newer ask came in while it was
    // made) still leaves the card in a block of the bot's own: never someone
    // else's stop, which a write would make the bot's, nor a person's change.
    // A comment-only write on a card decided blocked that the wake's
    // unrecorded checkout shows in progress puts the block back in the same
    // write: after the comment the run is over, and a card left in progress
    // with no durable wait is what Paperclip's disposition repair re-wakes
    // (SLA-1775). The card's own unblock step is kept; the bot may name only
    // itself as its owner. The block passes the gate like any routing write:
    // a newer ask is a change like any other, so the comment goes alone.
    const restore = routable && as === "blocked" && now.status === "blocked" && now.shown === "in_progress" && !now.away
      && (now.external || await mayMove(item.id, "blocked")) && !await personDecided(item.id, mark);
    if (!restore) { await say(item.id, comment, runId); return close; }
    try {
      await routeGate(item.id, snapshot, runId,
        { status: "blocked", unblockDescriptor: { owner: { agentId: me.id }, action: now.unblock?.action || UNBLOCK_ACTION } },
        { comment, unrouted: comment, settled: true });
    } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) throw err;
      log.warn({ err: err.message, issue: item.id }, "Paperclip refused putting the block back with the comment — the comment goes alone");
      await say(item.id, comment, runId);
    }
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
   * The dependency gate (docs/board-decisions.md, (d)): what a
   * resume or a going-on waits on (`refs`, task ids or names), each read
   * afresh now (w4). Done only when every one reads done now. The card's own
   * waits forget a done link once it is trimmed (reconcileWaiting), and a
   * task done once may reopen, so nothing remembered stands for it — not
   * even the eligibility lookup that started the resume. One the board does
   * not know, or that cannot be read, is not done: the wait stands.
   *
   * Every run that resumes or goes on because its dependencies finished
   * passes it immediately before the model is invoked (run's `deps`), and
   * the prompt's "done" is built from that read alone. Every write from the
   * answer such a run made that leaves the wait — a done close, a review, a
   * hand-off — passes it again inside routeGate (the snapshot's `deps`).
   */
  async function depsGate(refs, selfId) {
    const tasks = [];
    for (const ref of refs) {
      let t = null;
      try { t = await taskNamed(ref); } catch { /* unread: not done */ }
      tasks.push(t?.id && t.id !== selfId ? t : { id: ref, status: "unknown" });
    }
    return { tasks, done: tasks.length > 0 && tasks.every((t) => t.status === "done"), open: tasks.filter((t) => t.status !== "done") };
  }
  async function reconcileWaiting(item, runs) {
    if (item.status !== "blocked" || !item.unresolvedBlockerIssueIds?.length) return;
    const last = list(runs, "runs").find((r) => r.agentId === me.id && (r.contextIssueId ?? item.id) === item.id);
    if (!last) return;
    // Read before the task, so a person's change between the reads is after the mark (handleTask).
    const record = await activityOf(item.id);
    const issue = await api("GET", `/issues/${item.id}`);
    const comments = list(await api("GET", `/issues/${item.id}/comments`), "comments").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const blockers = issue.blockedBy ?? [];
    const done = blockers.filter((b) => b.status === "done"), open = blockers.filter((b) => b.status !== "done");
    if (!done.length || !open.length || external(issue) || heldElsewhere(issue)) return;
    // Its own block, unchanged by a person since: the next poll decides again from theirs.
    if (!reconcilable(statusSetter(record, "blocked", me.id), me.id) || await personDecided(item.id, markOf(record))) return;
    // The card read again just before the unlink (d): anything changed on it
    // since — an edit, a comment, a decision — and the next look decides.
    const cut = await routeGate(item.id, snapshotOf({ issue, comments, activity: record }, []), runIdOf(last), { blockedByIssueIds: open.map((b) => b.id),
      unblockDescriptor: { owner: { agentId: me.id }, action: waitAction(open.map(nameOf), done.map(nameOf)) } }, { unrouted: null });
    if (!cut.routed) return;
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
   * (unwanted). A durable attempt's lost run takes no write at all:
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
          // under it: its credentials are not the worker's any more.
          noted = gone = true;
          lost(current);
          tLog.warn({ attempt: attemptId }, "Paperclip lost this run while its worker still runs — nothing is written under it; the answer waits for a new run");
          return;
        }
        await say(item.id, TRANSPORT_NOTE, current);
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
  async function handOn(item, runId, from, issue, { comment, escalate, latest }, target, tLog, seats) {
    const path = `/issues/${item.id}`;
    // Decided from the snapshot the answer was produced from, or not at all (d).
    if (!routableSnapshot(from)) {
      await say(item.id, `${comment}\n\n${CARD_CHANGED}`, runId);
      tLog.warn("Paperclip escalation — no snapshot the answer was produced from; the answer posted, nothing handed on");
      return;
    }
    const to = await holderFor(target, seats);
    if (!to) {
      await say(item.id, `${comment}\n\nI could not hand this card to ${target.name}: the board has no seat by that name.`, runId);
      tLog.error({ to: target.ref }, "Paperclip escalation — no seat by that name; the card stays with this bot");
      return;
    }
    try {
      // The hand-on passes the one gate (routeGate): changed since the
      // snapshot, and the answer is said as a comment, the card left as it is.
      const out = await routeGate(item.id, from, runId, (fresh) => holderWrite(to, fresh.issue ?? issue), { comment, unrouted: `${comment}\n\n${CARD_CHANGED}` });
      if (!out.routed) {
        tLog.info({ to: to.name }, "Paperclip escalation — the card changed since the answer was made; the answer posted, nothing handed on");
        return;
      }
    } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) throw err;
      await say(item.id, `${comment}\n\nI could not hand this card to ${to.name}: the board refused it (${err.status}).`, runId);
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
  async function handOffVia(item, runId, key, comment, operation, tLog, from) {
    // Every write that moves the card is checked against the snapshot the
    // answer was produced from, read again just before it (d); with none that
    // authorizes routing, the answer is said as a comment only.
    if (!routableSnapshot(from)) {
      await say(item.id, `${comment}\n\n${CARD_CHANGED}`, runId);
      tLog.warn({ refused: operation }, "Paperclip hand-off — no snapshot the answer was produced from; the answer posted, nothing handed on");
      return { handoff: "changed" };
    }
    // Every hand-off, step and fallback goes through the one gate
    // (routeGate), each from a fresh read: changed since the snapshot, and the
    // answer is said as a comment only, the card left as it is now.
    const unrouted = `${comment}\n\n${CARD_CHANGED}`;
    const changed = () => {
      tLog.info({ refused: operation }, "Paperclip hand-off — the card changed since the answer was made; the answer posted, nothing handed on");
      return { handoff: "changed" };
    };
    const call = async (op, extra = {}, settled = false) => routeGate(item.id, from, runId, { escalate: { operation: op, issue: item.id, idempotencyKey: `${key}:${op}`,
      ...(op === "hand_up" ? { blocker: comment, ...extra } : { resolution: comment }) } }, { unrouted, settled, said: comment });
    // A dependency the answer was built on open again: the gate kept the
    // wait, the answer said with it (keepWait), and nothing is handed on.
    const waits = () => {
      tLog.info({ refused: operation }, "Paperclip hand-off — a dependency the answer was built on is open again; the wait kept, nothing handed on");
      return { handoff: "waits" };
    };
    const firstGo = await call(operation, {}, true);
    if (firstGo.why === "deps") return waits();
    if (!firstGo.routed) return changed();
    const first = firstGo.result;
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
    // The fallback moves the card: the card is read again before the unblock
    // step is written, and again after it, immediately before the hand-up (d),
    // so no other call comes between that last read and the hand-up. A change
    // since leaves the card as it is now, the answer said as a comment.
    if (operation !== "hand_up") {
      try {
        const step = await routeGate(item.id, from, runId, { unblockDescriptor: { owner: { agentId: me.id },
          action: `The hand-off asked for was refused (${refused(operation, first)}), so it was handed up instead. Read the latest comments, then resolve it or return it down the chain.` } }, { unrouted });
        if (!step.routed) return changed();
      } catch (err) {
        if (!(err.status >= 400 && err.status < 500)) throw err;
        tLog.warn({ err: err.message }, "Paperclip hand-off refusal not written to the unblock step — it is in the hop's comment");
      }
      const go = await call("hand_up", { attempted: `${refused(operation, first)} (the hand-off asked for was refused; handed up instead)` });
      if (go.why === "deps") return waits();
      if (!go.routed) return changed();
      second = go.result;
    }
    const refusals = [[operation, first], ...(second && !second.ok ? [["hand_up", second]] : [])].map(([op, r]) => ({ operation: op, code: r.code, message: r.message }));
    if (second?.ok) {
      tLog.error({ refusals, fallback: "hand_up", to: second.holder?.id ?? null, replayed: Boolean(second.replayed) },
        "Paperclip hand-off refused — handed up instead, with the refusal on the card");
      return { handoff: "refused", fallback: "hand_up" };
    }
    const action = `The hand-off was refused (${refusals.map((r) => refused(r.operation, r)).join("; ")}). Read the last comment, then hand this task on yourself or reply on it.`;
    const said = refusals.map((r) => `- ${r.operation}: ${r.code}: ${r.message}`).join("\n");
    const refusal = `${comment}\n\nI could not hand this task on: the escalation action refused it.\n${said}`;
    const kept = await routeGate(item.id, from, runId, { status: "blocked", unblockDescriptor: { owner: { agentId: me.id }, action } },
      { comment: refusal, unrouted: `${refusal}\n\n${CARD_CHANGED}` });
    if (!kept.routed) return changed();
    tLog.error({ refusals }, "Paperclip hand-off refused — the task stays with this bot, blocked");
    return { handoff: "refused" };
  }
  /**
   * Put an escalation's card back to blocked after the wake's checkout, by
   * status alone (a comment would end the run). Only the unrecorded checkout is
   * undone: a recorded move since — a person taking the card out of blocked —
   * stands.
   */
  async function keepBlocked(item, runId, tLog, from, { settled = false } = {}) {
    const path = `/issues/${item.id}`;
    const now = await api("GET", path);
    if (now.status === "blocked" || decidedStatus(now.status, await recordFor(item.id, now.status), me.id) !== "blocked") return;
    // Entering blocked must name what unblocks it, and a bot may name only
    // itself (a bare status was refused 422 on the live board, 2026-10-14,
    // leaving every worked escalation in_progress). The card's own unblock
    // step is kept as the action.
    const action = now.unblockDescriptor?.action || UNBLOCK_ACTION;
    // Through the one gate (routeGate), against the snapshot the wake
    // decides from: a status anyone else recorded since — or any other
    // change — stands, and nothing is said (a comment would end the run).
    try {
      const put = await routeGate(item.id, from, runId, { status: "blocked", unblockDescriptor: { owner: { agentId: me.id }, action } }, { unrouted: null, settled });
      if (!put.routed) tLog.info({ status: now.status }, "Paperclip escalation — the card changed since this wake read it; it is left as the board has it");
    } catch (err) {
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
  /** A lookup from a seat's or person's id to its name, for the prompt's card block. Ids it cannot name are shown as ids. */
  async function namesFor(issue) {
    const ids = [issue.assigneeAgentId, issue.assigneeUserId, issue.createdByAgentId, issue.createdByUserId, issue.unblockDescriptor?.owner?.agentId, issue.unblockDescriptor?.owner?.userId,
      ...(issue.executionPolicy?.stages ?? []).flatMap((st) => (st.participants ?? []).map((pt) => pt.agentId ?? pt.userId))].filter(Boolean);
    if (!ids.length) return null;
    const map = new Map();
    try {
      for (const a of await seatsOf()) map.set(a.id, a.name);
      for (const u of await peopleOf()) map.set(u.id, u.name);
    } catch (err) { log.warn({ err: err.message }, "Paperclip card block — names could not be read; ids are shown"); }
    return (id) => map.get(id) || undefined;
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
  /**
   * What the board shows now of each card a waiting ask names (SLA-1775): its
   * status, holder, last change and latest comments — the Foreman's progress
   * notes name its pull request there. Read at wake time, never from what the
   * bot said before. A card that cannot be read is left out.
   */
  async function blockerFacts(names, selfId) {
    const facts = [];
    let seats, people;
    for (const name of names) {
      let t;
      try { t = await taskNamed(name); } catch { t = null; }
      if (!t?.id || t.id === selfId) continue;
      let holder = null;
      if (t.assigneeAgentId) holder = (seats ??= await seatsOf()).find((a) => a.id === t.assigneeAgentId)?.name ?? "an agent seat";
      else if (t.assigneeUserId) holder = (people ??= await peopleOf()).find((u) => u.id === t.assigneeUserId)?.name ?? "a board user";
      let thread = [];
      try { thread = list(await api("GET", `/issues/${t.id}/comments`), "comments").filter((c) => !c.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); } catch { /* facts without its thread */ }
      facts.push({ name: t.identifier ?? name, title: t.title, status: t.status, holder, updatedAt: t.updatedAt,
        last: thread.at(-1)?.id ?? null, comments: thread.slice(-3).map((c) => `${c.createdAt}: ${firstLine(c.body)}`) });
    }
    return facts;
  }
  /** A card waited on that nobody is moving: no holder, stopped, or unchanged for three days. */
  const notWorked = (f, now = Date.now()) => !f.holder || ["blocked", "cancelled", "backlog"].includes(f.status)
    || (f.updatedAt && now - Date.parse(f.updatedAt) > 3 * 24 * 3600e3);
  /** Why this run woke, as Paperclip recorded it; null when the run cannot be read. */
  async function wakeOf(runId) {
    try {
      const ctx = (await api("GET", `/heartbeat-runs/${runId}`))?.contextSnapshot ?? {};
      return { reason: ctx.wakeReason ?? null, repair: ctx.legacyDispositionEpisode ?? null, skip: ctx.skipIssueComment === true };
    } catch { return { reason: null, repair: null, skip: false }; }
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
   * reconciliation hold, which refuses every later wake. Once the
   * attempt's worker has stopped, the bot says what became of it, from the
   * attempt's own record, and wakes itself: the stored result is delivered
   * under the new run, never run again. While the worker holds its lock
   * nothing is sent — the work is still going. True when the task waits on it.
   * The hold is read from the card's executionBlocker, as the board does: the
   * settle sweep closes a hold yet leaves replay blocked (SLA-1482), and
   * /recovery-actions lists only an active one. A cancelled run takes no write
   * (agent_run_cancelled): its hold is the board's to settle.
   */
  async function releaseLostRun(item, runId, key, tLog, cancelled) {
    const id = attemptIds.get(key);
    if (!attempts || !id) return false;
    let held;
    try { held = (await api("GET", `/issues/${item.id}`))?.executionBlocker; } catch { return false; }
    if (held?.cause !== "legacy_execution_requires_reconciliation" || held.runId !== runId || !held.recoveryActionId) return false;
    if (cancelled) {
      tLog.warn({ actionId: held.recoveryActionId }, "Paperclip lost this run to a cancel — its hold takes no write under that run, the board settles it");
      return false;
    }
    const s = attempts.current(id);
    if (s.phase === "running" || s.phase === "launching") {
      tLog.info({ attempt: id }, "Paperclip lost this run while its worker still runs — the hold is cleared once it stops");
      return true;
    }
    const executionReconciliation = stoppedAttempt(id, runId);
    const { actionOutcome } = executionReconciliation;
    await api("POST", `/issues/${item.id}/recovery-actions/resolve`, { actionId: held.recoveryActionId, outcome: "restored", sourceIssueStatus: "todo", executionReconciliation }, runId);
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
        if (continuing.get(k)?.prefix) body = `${continuing.get(k).prefix}\n\n${body}`;
        pending.set(k, body);
        saveState(stateFile, state);
      }
      // A comment alone, through the comments route: the recipient may hold
      // the card checked out by now, and the board's assignee run lock
      // refuses another seat's update to it, never a comment.
      await api("POST", `/issues/${issue.id}/comments`, { body: `${outcomeOf(body).comment || FALLBACK_REPLY}\n\n${mark}` }, attemptRuns.get(k));
    }
    pending.delete(k); since.delete(k); attemptRuns.delete(k); continuing.delete(k); attemptIds.delete(k); gates.delete(k);
    answered.add(k);
    saveState(stateFile, state);
    tLog.info("Paperclip attempt ended after its task was handed on by its own model — its answer is posted as a comment, the hand-off stands");
  }

  /**
   * A durable attempt's run was lost while its worker ran (watchRun), and the
   * worker has stopped now. Its answer is stored, told the run was lost, and
   * goes out under a new run only. The board settled the lost run
   * as "blocked, never replayed", and that settlement refuses every wake on
   * the card until its outcome is reconciled: the bot files what became of the
   * attempt, from its own record, on that settlement (the evidence path;
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
    unstarted(item.id);
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
      if (owedKey && await releaseLostRun(item, owedRun, owedKey, log.child({ paperclipTask: item.identifier ?? item.id, runId: owedRun }), cancelled)) return;
      if (!owedRun || handled.has(owedRun) || cancelled) return reconcileWaiting(item, runs);
      open = { id: owedRun };
    }
    const runId = runIdOf(open);
    // The run the answer goes out under: this one, or the one that replaced it when Paperclip lost it (watchRun).
    let postRun = runId;
    // This attempt's own runs: the wake's, and each one that replaced it
    // (watchRun). Only a write under one of them is the attempt's own (cardNow).
    const runsOfAttempt = new Set([runId]);
    const ownRuns = () => [...new Set([...runsOfAttempt, postRun])];
    // The board as this tick decides from it: whatever it writes leaves a
    // person's later change to the task's status or waits standing
    // (personDecided). Read before the task itself, so a change made between
    // the reads is after the mark, never taken as seen.
    const activity = await activityOf(item.id);
    const decidedAt = markOf(activity);
    const issue = await api("GET", `/issues/${item.id}`);
    const comments = list(await api("GET", `/issues/${item.id}/comments`), "comments")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // The wake-start snapshot: the card as this wake read it before deciding
    // anything, its record's mark, and this attempt's own runs. A note this
    // wake writes (acknowledge) routes only from it (d).
    const wake = { snap: snapOf(issue, comments, [runId]), mark: decidedAt };
    const wakeSnap = () => ({ ...wake, own: ownRuns() });
    // The snapshot answer `k` was produced from, saved with it (builtOn). Its
    // mark is the record as that card was read: anything recorded after it by
    // anyone but the attempt's own runs is a change, even when it came before
    // a restarted bot's first read (R13, R14). It is kept as saved: one with
    // no mark or no runs of its own stays without them, and a saved answer
    // with no such record is `legacy` — neither routes anything until the
    // answer is made again (routableSnapshot). An ask not yet answered is
    // decided from this wake's own read.
    const producing = (k) => {
      if (builtOn.has(k)) {
        const b = builtOn.get(k);
        return { ...b, ...(Array.isArray(b.own) ? { own: [...new Set([...b.own, ...ownRuns()])] } : {}) };
      }
      return pending.get(k) ? { legacy: true } : wakeSnap();
    };
    // A producing snapshot with this attempt's runs since merged into its own
    // (one saved without runs stays without them: it routes nothing).
    const withOwn = (w) => Array.isArray(w.own) ? { ...w, own: [...new Set([...w.own, ...ownRuns()])] } : w;
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
    // Handed back to the bot since its latest answer — away and in again,
    // whatever the card says — is a new ask (d): the answer was given under
    // the hand-off recorded with it (handedTo). An escalation's key already
    // carries its hand-off. A task answered before this was recorded is as it was.
    if (!escalated && answered.has(key) && !pending.has(key) && handedTo.has(item.id) && handedTo.get(item.id) !== handIn(activity)) {
      answered.delete(key); blockedAsks.delete(key); reviewAsks.delete(key); linked.delete(key); linkDone.delete(key); revisits.delete(key);
      saveState(stateFile, state);
    }
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
      gates.delete(k);
    };
    const owed = (except) => {
      const keys = owedKeys(except);
      const parts = keys.map((k) => ({ ...(pending.get(k) ? outcomeOf(pending.get(k))
        : { comment: continuing.has(k) ? `${continuing.get(k).prefix}\n\n${FALLBACK_REPLY}` : FALLBACK_REPLY, status: "blocked", waitsOn: [] }), mark: attemptIds.has(k) ? attemptMark(attemptIds.get(k)) : "" }));
      const last = parts.at(-1) ?? { status: "done", waitsOn: [] };
      // The latest attempt's own answer, without what a go-on or a resume put before it.
      const lead = keys.length ? leads.get(keys.at(-1)) : undefined;
      const own = last.comment && lead && last.comment.startsWith(lead) ? last.comment.slice(lead.length).trim() : last.comment;
      return { comment: parts.map((p) => [p.comment || FALLBACK_REPLY, p.mark].filter(Boolean).join("\n\n")).join("\n\n---\n\n"), status: last.status, waitsOn: last.waitsOn, person: last.person ?? null, escalate: Boolean(last.escalate), giveBack: Boolean(last.giveBack), followUp: Boolean(last.followUp),
        latest: own || FALLBACK_REPLY };
    };
    // Each ask still owed is answered as its own answer says, in the post the
    // run `by` wrote: one posted with a newer ask's answer keeps its own. A
    // blocked answer is in a wait named by that run, fixed here and never
    // worked out again from what the task waits on; any other answer is final.
    // `decided`: the status the post wrote, when it is not the answer's own (a
    // finished answer left in its requester's review).
    // A write refused because a dependency the answer was built on is open
    // again (routeGate, waitKept) — on this wake, or saved before a restart
    // that found its answer landed: each ask settles waiting on those
    // dependencies, so the wake that reads them done resumes it. The refusal
    // is used up here, and returned (an escalation links its wait from it).
    const settle = (by, decided) => {
      const latest = owedKeys().at(-1);
      if (latest) { lastAnswered.set(item.id, latest); handedTo.set(item.id, handIn(activity)); }
      const saved = depsRefused.get(item.id);
      depsRefused.delete(item.id);
      // Made for an attempt still owed here; one left from asks since settled stands for none.
      const refusal = saved && (!Array.isArray(saved.owed) || saved.owed.some((k) => pending.has(k))) ? saved : undefined;
      for (const k of [...pending.keys()]) {
        if (!k.startsWith(mine)) continue;
        const o = pending.get(k) ? outcomeOf(pending.get(k)) : { status: "blocked", waitsOn: [] };
        const status = refusal ? "blocked" : decided === "in_review" ? decided : o.escalate ? "blocked" : o.status;
        // What the answer waits on, read again on its next wake (revisit).
        revisits.set(k, { ...(revisits.get(k) ?? { n: 0 }), waits: refusal ? refusal.tasks.map(nameOf) : o.waitsOn });
        pending.delete(k); since.delete(k); attemptRuns.delete(k); continuing.delete(k); attemptIds.delete(k); attemptSeq.delete(k); leads.delete(k); builtOn.delete(k); gates.delete(k);
        answered.add(k);
        if (status === "blocked") blockedAsks.set(k, by);
        else blockedAsks.delete(k);
        if (status === "in_review") reviewAsks.add(k);
        else reviewAsks.delete(k);
      }
      return refusal;
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
      // Said with its wait kept (waitKept, the refusal saved before that write): the same text, why after it.
      const keptAs = depsRefused.has(item.id) ? `${saved}\n\n${depsReopened(depsRefused.get(item.id).open.map(nameOf))}` : null;
      const landed = comments.find((c) => c.authorAgentId === me.id && c.createdAt > from && (c.body === saved || c.body === `${saved}\n\n${NO_GIVER}` || (keptAs !== null && c.body === keptAs)
        || (marks.length === saving.length && marks.every((m) => c.body?.includes(m)))));
      if (landed) {
        const current = pending.has(key);
        // An escalation's blocked answer whose link write landed with it, its
        // response lost: the links are read back from the card (w5).
        const latest = owedKeys().at(-1), { status: as, waitsOn } = owed();
        if (escalated && as === "blocked" && waitsOn.length) {
          const names = waitsOn.map((n) => n.toUpperCase());
          const on = issue.blockedBy ?? [];
          const id = (n) => on.find((b) => String(b.identifier ?? "").toUpperCase() === n)?.id;
          // Every task it named, by the card's link where there is one (resolveWaits).
          if (names.some(id)) linked.set(latest, [...new Set(names.map((n) => id(n) ?? n))]);
        }
        // An answer that landed with its wait kept (the refusal saved before
        // that write): settled as the wait, and an escalation's linked from it.
        const refusal = settle(landed.createdByRunId ?? runId);
        if (escalated && refusal && latest) linked.set(latest, [...new Set([...(linked.get(latest) ?? []), ...refusal.tasks.map((t) => t.id)])]);
        saveState(stateFile, state);
        if (current && !escalated && !heldElsewhere(issue)) return acknowledge(item, runId, comments, key, decidedAt, issue, wakeSnap());
      }
    }
    // Handed to someone else, or to nobody, after the inbox listed it and
    // before this read: theirs. Nothing runs; an answer still owed is posted
    // as a comment only (reply), and a live run ends on a note (w1).
    if (heldElsewhere(issue)) {
      const older = owedKeys().at(-1);
      if (older) {
        const { comment, status } = owed();
        await reply(item, runId, older, wakeSnap(), comment, status, { mark: decidedFrom.get(older) ?? decidedAt });
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
        await reply(item, runId, older, wakeSnap(), comment, status, { mark: decidedFrom.get(older) ?? decidedAt });
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
    // A person's stop, by the write's writer (writerOf): the Foreman's sync
    // writes with a board user's key but credits its own agent, so its
    // hand-off is an agent's; a person's block stands even when it also
    // hands the task to the bot.
    const personStop = (s) => Boolean(s) && writerOf(s).type === "user";
    const heldBy = (status, activity) => {
      const decided = decidedStatus(status, activity, me.id);
      // A task another writer owns is that writer's to stop as well — its sync
      // blocks a card for the bot to clear — so there only a person's stop holds.
      // The Foreman's sync writes with a board user's key, credited to its own
      // agent, so its stop is an agent's, not a person's hold (SLA-1335).
      const setter = () => statusSetter(activity, decided, me.id);
      // A cancelled card is never worked, whoever cancelled it and whatever
      // else that write did — handed it to the bot as well (d).
      if (decided === "cancelled" || status === "cancelled") return { decided, held: true };
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
    // every one done on a fresh read (depsGate): it is blocked throughout,
    // whoever blocked it.
    const waiting = answered.has(key) && blockedAsks.has(key);
    let links = waiting && escalated && linked.get(key)?.length ? await depsGate(linked.get(key), item.id) : null;
    // An ordinary card resumes from its links only when every task its answer
    // waited on — as it named them, and as the card links them now — reads
    // done afresh: a link trimmed when it was done and reopened since still
    // holds the wait (w4). `stillWaits` names them, to link again.
    let stillWaits = null;
    if (waiting && !escalated && !external(issue) && doneBlockers(issue).length > 0) {
      const names = [...new Set([...(revisits.get(key)?.waits ?? []), ...(issue.blockedBy ?? []).map(nameOf)])];
      if (!(await allDone(names, item.id)).length) stillWaits = names;
    }
    const resumes = waiting && (escalated ? Boolean(links?.done)
      : (!external(issue) && doneBlockers(issue).length > 0 && !stillWaits) || (!STOPPED.has(decided) && await movedSinceAnswer()));
    const step = wakeStep({ live, owes: pending.has(key), answered: answered.has(key), escalated, resumes, held });
    // A live re-wake on an ask answered as waiting is looked at again by the
    // model, told what it said and what the board shows now, and it decides
    // the next step: block, escalate, or work (SLA-1775). A wait is where a
    // card loops; an answer that finished the ask is final, and its re-wake
    // still gets the mechanical note, as do an ask in review (the reviewer's
    // to move), a card someone else stopped, and a run the model fails on.
    // A wait that still stands though the card's links read done is not
    // looked at again: the note links what it waits on once more (w4).
    // Otherwise whether it is looked at again is the operator's (PAPERCLIP_REWAKE):
    // off, or up to that many looks on one ask, after which the note answers it.
    const revisitable = step === "acknowledge" && live && !held && blockedAsks.has(key) && !reviewAsks.has(key) && !stillWaits;
    const looks = revisits.get(key)?.n ?? 0;
    const revisiting = revisitable && looks < rewake;
    const tLog = log.child({ paperclipTask: issue.identifier, runId });
    if (revisitable && !revisiting) tLog.info({ setting: "PAPERCLIP_REWAKE", rewake: rewake || "off", looks },
      rewake ? "Paperclip task woke again on an answered ask — its looks are used up, so the note answers it and the model is not started"
        : "Paperclip task woke again on an answered ask — re-wakes are off, so the note answers it and the model is not started");
    if (step === "acknowledge" && !revisiting) return acknowledge(item, runId, comments, key, decidedAt, issue, wakeSnap(), stillWaits ?? undefined, { handToRequester: !escalated && !external(issue) });

    // What a hand-off through process.escalate made of this run, for its log line.
    let handoff = null, fallback = null;
    const handOff = (operation) => async (text, from) => { ({ handoff, fallback = null } = await handOffVia(item, postRun, key, text, operation, tLog, from)); };
    // Paperclip re-wakes an unchanged stopped card: each run still ends on a
    // note of its own (endRun, SLA-1335).
    const hold = async () => {
      // An answer an older ask still owes — its post failed, and a newer ask
      // came with the stop — is still posted, a comment only on the stopped
      // task (reply); it ends the run in place of the note.
      const older = pending.has(key) ? undefined : owedKeys().at(-1);
      if (older) {
        const { comment, status } = owed();
        await reply(item, runId, older, wakeSnap(), comment, status, { mark: decidedFrom.get(older) ?? decidedAt });
        settle(runId);
      } else await endRun(item, runId, comments, HELD_NOTE);
      handled.add(runId);
      saveState(stateFile, state);
      tLog.info({ status: decided }, "Paperclip task is stopped by someone else — not picked up");
    };
    let lostRun = null;
    // The state file as it was before the attempt about to run began: put
    // back when the card moved before it ran (cardNow), so nothing of it stays.
    let undo = null;
    // One run of the bot on the card as read (`card`: this wake's read, or a
    // fresher one an escalation is reworked from), under the run it goes out
    // under; `attemptId` names a durable attempt's worker.
    // `deps`, on a run that resumes or goes on because its dependencies
    // finished: `{ refs, say }`. Immediately before the model is invoked every
    // ref is read afresh (depsGate); one not done, and nothing runs — the
    // state as it was before the attempt, DepsOpen thrown with that read, the
    // wait left standing for the caller to end the run on. `say(names)` makes
    // the prompt's dependency note, and the lead said above the answer, from
    // that read alone; its lead is left on `deps.lead`.
    // The one preflight every model run passes, last before answer() (d):
    // every dependency of a resume or a going-on read first (depsGate) —
    // one not done, DepsOpen, nothing runs — and the card it is run on read
    // after them, the last read before the model, compared with that card
    // (cardNow): changed since — its holder, labels, ask, a decision, a
    // cancel — CardMoved, nothing runs. A change made while the
    // dependencies were read is seen. Resolves to the fresh card and the
    // dependency read.
    const preflight = async (card, deps) => {
      const now = deps ? await depsGate(deps.refs, item.id) : null;
      if (now && !now.done) throw new DepsOpen(now);
      const fresh = await cardNow(item.id, snapshotOf(card, ownRuns()));
      if (fresh.moved) throw new CardMoved();
      return { fresh, now };
    };
    const run = async (note, card = { issue, comments, activity }, as = key, attemptId = undefined, deps = undefined) => {
      let moved = false;
      const unwatch = watchRun(item, postRun, tLog, (next) => {
        postRun = next;
        runsOfAttempt.add(next);
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
        const policyNote = await policyText(tLog);
        // The card the run was built on, read again just before it runs (d):
        // changed since — its holder, labels, ask, a decision, a cancel — and
        // nothing runs. The attempt ends unrun, the state file as it was before
        // it, and the next wake decides from the card as it is then. A worker
        // already launched is only followed to its end: it is not run here. A
        // claimed launch whose worker has not started (launching) may still be
        // launched again once its grace runs out (lib/attempts.js), so it
        // passes the preflight as an unlaunched one does.
        const following = attemptId && attempts && !["none", "unlaunched", "launching"].includes(attempts.current(attemptId).phase);
        // Every launch of this attempt's worker — the first, a relaunch of a
        // claim that never started, a fresh-session fallback — passes the same
        // preflight first, deps then card (`gate`, run by lib/attempts.js just
        // before it launches). Compared with the card the preflight here read.
        let base = card;
        const gate = async () => { base = (await preflight(base, deps)).fresh; };
        if (!following) {
          // Nothing runs on a refused preflight: the state as it was before
          // the attempt (undo), and the caller ends the run.
          let fresh, now;
          try { ({ fresh, now } = await preflight(card, deps)); } catch (err) {
            if (err instanceof CardMoved || err instanceof DepsOpen) { moved = true; if (undo) restore(undo); }
            throw err;
          }
          // The answer's routing writes check the dependencies again
          // (builtOn's `deps`, routeGate).
          let depIds = null;
          if (now) {
            const told = deps.say([...new Set(now.tasks.map(nameOf))]);
            note = [note, told.note].filter(Boolean).join("\n\n");
            deps.lead = told.lead;
            depIds = now.tasks.map((t) => t.id);
          }
          // The card this answer is made from, saved with it (builtOn).
          builtOn.set(as, { snap: snapOf(fresh.issue, fresh.comments, ownRuns()), own: ownRuns(), mark: markOf(fresh.activity), ...(depIds ? { deps: depIds } : {}) });
          saveState(stateFile, state);
          base = fresh;
        }
        return (await answer(buildTaskPrompt(base.issue ?? card.issue, card.comments, me, url, { note, returnable: !escalated && !external(card.issue), contract: contractNote, policy: policyNote, names: await namesFor(base.issue ?? card.issue), runId: postRun, mirrored: external(card.issue) }), card.issue, { runId: postRun, attemptId, gate })).trim();
      } catch (err) {
        // A launch the gate refused ran nothing, as a refused preflight.
        if ((err instanceof CardMoved || err instanceof DepsOpen) && !moved) { moved = true; if (undo) restore(undo); }
        if (err instanceof CardMoved || err instanceof DepsOpen) throw err;
        tLog.error({ err: err.message, attempt: attemptId }, "Paperclip task failed");
        // A worker that died after it started is never run again: it may have acted.
        const s = attemptId && attempts?.current(attemptId);
        if (s?.phase === "died") return workerDiedNote(attemptId, s.started?.at, s.exit?.signal);
      } finally {
        unwatch();
        // A worker that ended before the watch's next look: the board may
        // have lost its run all the same. Looked at once more, so delivery
        // never rests on the watch's timing.
        if (attemptId && attempts && !lostRun && !moved) {
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
    // What a saved resume of `k` was admitted on, for a recovery that would
    // run it again (an unlaunched worker, an interrupted run): the
    // dependencies saved when it began (gates), else those its answer was
    // built on (builtOn's `deps`) — read done again in its preflight, or
    // nothing runs. An interrupted going-on carries its own (contDeps).
    const savedDeps = (k, what) => {
      const g = gates.get(k);
      const refs = g?.refs?.length ? g.refs : builtOn.get(k)?.deps;
      return refs?.length ? { refs, say: (names) => resumeText(g?.what ?? what, names) } : undefined;
    };
    undo = checkpoint();
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
        // A worker never launched runs here first: gated on what it was
        // admitted on (preflight). One open again, and nothing launches —
        // the attempt stays owed, the wait linked again, for the wake that
        // reads them done.
        // An unlaunched going-on open again is its earlier answer, posted
        // with its wait linked, as an interrupted one is.
        let deps, refused = false;
        try { body = await run("", undefined, key, attemptId, (deps = cont ? contDeps(cont, "task") : savedDeps(key, "task"))); } catch (err) {
          if (!(err instanceof DepsOpen)) throw err;
          tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip attempt's waits read open again before its worker launched — not run, the wait stands");
          if (!cont) return acknowledge(item, runId, comments, key, decidedAt, issue, wakeSnap(), err.now.tasks.map(nameOf));
          refused = true;
          body = cont.was ?? ""; continuing.delete(key);
        }
        if (refused) { /* its earlier answer, as it was */ }
        else if (body && cont) { body = `${cont.prefix}\n\n${body}`; continuing.delete(key); }
        else if (body && deps?.lead) body = `${deps.lead}\n\n${body}`;
        pending.set(key, body || "");
        saveState(stateFile, state);
      } else if (resumeInterrupted && (cont ? !cont.resumed && Array.isArray(cont.deps) : !resumed.has(attemptOf(key)))) {
        // Run again only over the board the attempt was admitted from: anyone
        // else's decision since its mark stands (decidedSince).
        if (held || (decidedFrom.has(key) && decidedSince(activity, decidedFrom.get(key)))) return hold();
        tLog.warn("Paperclip attempt never finished — running it once more, told it was interrupted");
        if (cont) cont.resumed = true;
        else resumed.add(attemptOf(key));
        decidedFrom.set(key, decidedAt);
        attemptRuns.set(key, runId);
        saveState(stateFile, state);
        // An interrupted going-on goes on again only from its dependencies
        // read done now (depsGate); one open, and the answer it went on
        // from is posted instead, its wait linked again.
        // Its marks stand when a wait reads open: it is not run a second time.
        // A resume run again is gated on what it resumed from (savedDeps):
        // one open again, and it is not run — not used up either, it runs
        // once more when they read done — the wait linked again.
        undo = null;
        const deps = cont ? contDeps(cont, "task") : savedDeps(key, "task");
        try {
          body = await run(INTERRUPTED_NOTE, undefined, key, undefined, deps);
          if (body && cont) { body = `${cont.prefix}\n\n${body}`; continuing.delete(key); }
          else if (body && deps?.lead) body = `${deps.lead}\n\n${body}`;
          pending.set(key, body || "");
        } catch (err) {
          if (!(err instanceof DepsOpen)) throw err;
          if (!cont) {
            tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip resume's waits read open again — not run, the wait stands");
            resumed.delete(attemptOf(key));
            saveState(stateFile, state);
            return acknowledge(item, runId, comments, key, decidedAt, issue, wakeSnap(), err.now.tasks.map(nameOf));
          }
          tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip attempt's waits read open again — not run, its earlier answer posted");
          pending.set(key, cont.was ?? ""); continuing.delete(key);
        }
        saveState(stateFile, state);
      } else tLog.warn("Paperclip attempt never finished — posting the fallback, not running it again");
    } else {
      if (step === "hold") return hold();
      // A new ask starts the model only in a status the operator lets it
      // (PAPERCLIP_INTAKE). Any other gets one note and the card goes back to
      // where it was before the wake checked it out. A status the board did
      // not report is not one the operator left out.
      const startedIn = intakeStatus(issue.status, activity);
      if (!revisiting && !resumes && CARD_STATUSES.includes(startedIn) && !intake.includes(startedIn)) {
        const note = intakeNote(startedIn, intake);
        try {
          if (comments.some((c) => c.createdByRunId === runId)) { /* this run already ended on a comment */ }
          // The put-back passes the one gate: changed since this wake read it, the note goes alone.
          else if (startedIn !== issue.status && !external(issue)) await routeGate(item.id, wakeSnap(), runId, { status: startedIn }, { comment: note, unrouted: note });
          else await endRun(item, runId, comments, note);
        } catch (err) {
          tLog.warn({ err: err.message, status: startedIn }, "Paperclip card could not be put back in its status — ending the run on the note alone");
          await endRun(item, runId, comments, note, { alone: true });
        }
        handled.add(runId);
        saveState(stateFile, state);
        tLog.info({ status: startedIn, setting: "PAPERCLIP_INTAKE", intake }, "Paperclip task not started — its status is outside PAPERCLIP_INTAKE");
        return;
      }
      // Back from waiting: every task it was blocked on is done. The card goes
      // back in progress now and its answer opens by saying why. Not a comment
      // of its own: a comment under the run ends the run (the board's waiter),
      // and Paperclip refuses the close from an ended run on an in-progress card.
      const back = decided === "blocked" && !external(issue) ? doneBlockers(issue) : [];
      let note = "", deps;
      // What it waits on, as its answer named them and the card links them
      // (the eligibility lookup's names): read done again just before the
      // model (depsGate, run's `deps`), and before the card leaves its block.
      const refs = [...new Set([...(waiting ? revisits.get(key)?.waits ?? [] : []), ...back.map(nameOf)])];
      // A dependency read open again: the resume ends as a wait that still
      // stands does (stillWaits) — its note links them again, nothing runs.
      // A new ask on the card is left for the next wake, which reads it then.
      const depsOpen = (now) => {
        tLog.info({ waitsOn: now.open.map(nameOf) }, "Paperclip task's waits read open again just before resuming — not run, the wait stands");
        return waiting ? acknowledge(item, runId, comments, key, decidedAt, issue, wakeSnap(), refs) : undefined;
      };
      if (back.length) {
        if (issue.status === "blocked") {
          // A person changed it since this tick read it: the next tick decides from theirs.
          if (await personDecided(item.id, decidedAt)) return;
          // Through the one gate: changed since this wake read it, the next
          // tick decides; a dependency open again, the wait stands.
          const out = await routeGate(item.id, { ...wakeSnap(), deps: refs }, runId, { status: "in_progress" }, { unrouted: null });
          if (out.why === "deps") return depsOpen(out);
          if (!out.routed) return;
        }
        deps = { refs, say: (names) => resumeText("task", names) };
        tLog.info({ resumedFrom: back.map(nameOf) }, "Paperclip task's waits are done — resuming it");
      }
      // A re-wake on an answered ask (revisiting): what it said, why it woke,
      // and each card it waits on as the board shows it now. A loop the model
      // would not break is escalated by the code, on its last look (PAPERCLIP_REWAKE).
      let revisit = null;
      if (revisiting) {
        const said = comments.filter((c) => !c.deletedAt && c.authorAgentId === me.id && c.body && !isNote(c.body)).at(-1)?.body ?? "";
        const was = revisits.get(key) ?? { n: 0, waits: [] };
        // A card left in the bot's block waits on what it links now — a link
        // cut since is cut; one left open by a comment-only answer waits on
        // what that answer named (SLA-1775: SLA-1783, never linked).
        const names = [...new Set([...(decided === "blocked" ? [] : was.waits ?? []), ...(issue.blockedBy ?? []).map(nameOf)])];
        const facts = await blockerFacts(names, item.id);
        const { reason, repair } = await wakeOf(runId);
        const print = JSON.stringify(facts.map((f) => [f.name, f.status, f.holder, f.updatedAt, f.last]));
        const n = (was.n ?? 0) + 1;
        const unchanged = was.print !== undefined && was.print === print;
        // Only a card waited on can be seen not being worked; a wait on a
        // person or an event is the model's to judge, and the loop guard's.
        const idle = facts.some((f) => notWorked(f));
        const mustEscalate = reason === "issue_disposition_repair" && repair?.attempt && repair.attempt >= (repair.maxAttempts ?? Infinity)
          ? "this is Paperclip's last disposition repair on it, and the board blocks it to nobody next."
          : n >= rewake ? `it has been woken ${n} times on this one ask without moving on, the most this bot is set to look again.`
            : unchanged && idle ? "nothing changed since you last looked, and what it waits on is not being worked." : null;
        revisits.set(key, { ...was, n, print });
        saveState(stateFile, state);
        revisit = { said, unchanged, mustEscalate, waits: facts.filter((f) => f.status !== "done").map((f) => f.name), from: decidedFrom.get(key) };
        note = revisitNote({ reason, repair, previous: said, blockers: facts, mustEscalate, escalateName: escalateTo?.name ?? null, next: n });
        tLog.info({ wake: reason, revisit: n, waitsOn: names, ...(mustEscalate ? { mustEscalate } : {}) }, "Paperclip task woke again on an answered ask — the model decides the next step");
      }
      tLog.info({ trigger, why: revisiting ? `PAPERCLIP_REWAKE allows ${rewake} looks` : resumes ? "its waits are done" : `its status ${startedIn} is in PAPERCLIP_INTAKE` }, "Paperclip task waiting — running the bot");
      // Mark the attempt before it starts. A bot that dies mid-run may already
      // have sent mail or written a record, so a restart posts the fallback
      // for this ask rather than running it a second time. Its post can only
      // be a comment made after it starts: after the ask, and after anything
      // of ours already there — the answer that left the ask in the wait it
      // resumes from may say the same words.
      begin(key);
      // What it resumes from, saved with the attempt: a restart that would run it again is gated alike (savedDeps).
      if (deps) gates.set(key, { refs, what: "task" });
      since.set(key, [asked, ...comments.filter((c) => c.authorAgentId === me.id).map((c) => c.createdAt)].sort().at(-1));
      decidedFrom.set(key, decidedAt);
      attemptRuns.set(key, runId);
      const attemptId = nameAttempt(key);
      saveState(stateFile, state);
      try { body = await run(note, undefined, key, attemptId, deps); } catch (err) {
        if (err instanceof DepsOpen) return depsOpen(err.now);
        throw err;
      }
      if (body && deps?.lead) body = `${deps.lead}\n\n${body}`;
      if (revisit) {
        body = revisitAnswer(body, revisit);
        // The model gave nothing and nothing forces an escalation: the last
        // resort is the mechanical note, the card left as it was — the attempt
        // is dropped, the ask still answered by what it said before.
        if (body === null) {
          pending.delete(key); since.delete(key); attemptRuns.delete(key); attemptIds.delete(key); attemptSeq.delete(key); leads.delete(key); continuing.delete(key); gates.delete(key);
          // Judged from what the answer saw, as before: a person's change since stands.
          if (revisit.from === undefined) decidedFrom.delete(key); else decidedFrom.set(key, revisit.from);
          saveState(stateFile, state);
          return acknowledge(item, runId, comments, key, decidedAt, issue, wakeSnap());
        }
      }
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
      // An attempt like any other, marked before it starts: a bot that dies in
      // it finds it under way (continuing), not the earlier answer to post.
      // What it is told, and the going-on itself, wait for the dependency
      // gate just before the model (depsGate): one read open again, and the
      // state is as before, the answer posted with its wait linked.
      const was = pending.get(k);
      const cont = { deps: first.waitsOn, said: first.comment, was };
      undo = checkpoint();
      // Recorded unstarted with its go-on mark, in the same save: a restart
      // inside the preflight puts both back (unstarted), never one alone.
      preContinue(k, attemptOf(k), cont);
      continued.add(attemptOf(k));
      const attemptId = nameAttempt(k);
      saveState(stateFile, state);
      tLog.info({ waitsOn: ready }, "Paperclip task said it waits on tasks already done — going on with it");
      const deps = contDeps(cont, "task", k);
      let again;
      try { again = await run("", undefined, key, attemptId, deps); } catch (err) {
        if (!(err instanceof DepsOpen)) throw err;
        tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip task's waits read open again just before going on — not run, the answer posted with its wait");
        return false;
      }
      pending.set(k, again ? `${deps.lead}\n\n${again}` : was);
      continuing.delete(k);
      saveState(stateFile, state);
      // Lost to a board restart like any attempt: nothing under that run, the answer waits for a new one.
      return Boolean(lostRun) && deferLost(item, k, lostRun, tLog);
    };
    // Comment and close in one write. Paperclip re-wakes an agent whose run
    // ends with the task still open, and refuses in_review without a named
    // reviewer — so an answered ask is done. A reply on the task reopens it.
    const post = async (unlessReady) => {
      let { comment, status: as, waitsOn, person, escalate, giveBack, followUp } = owed();
      // `review`: in review with whoever gave the bot the task as the
      // reviewer, else its manager; with neither the work waits, blocked.
      let text = comment, giveTo = null, reviewer = null, via = null;
      const reviewing = issue.status === "in_review" && issue.assigneeAgentId === me.id;
      // `follow-up` from the reviewer: Paperclip's changes-requested — any
      // status but done, with the comment — returns the card to whoever did
      // the work and wakes them. From anyone else it means nothing.
      if (followUp && reviewing && !external(issue)) {
        as = "in_progress";
        tLog.info("Paperclip review — follow-up sent back to whoever did the work");
      } else if (policy && (as === "done" || giveBack) && !reviewing && !external(issue) && !escalate) {
        // The requester accepts (SLA-C1 task-completion): on a board whose
        // company policy says so, a finished answer on a task this seat did
        // not create goes to its creator's review. A `return` answer is the
        // same hand-back to the same person, so it goes there too, never up
        // the chain as a hand-off.
        const req = requesterOf(issue, me.id);
        const who = req && await targetOf(req);
        reviewer = who && await holderFor(who);
        if (reviewer) as = "in_review";
        tLog.info({ reviewer: reviewer?.name ?? null, requester: req }, reviewer ? "Paperclip task answered — left open for its requester's review" : "Paperclip task answered — no requester to review it");
      } else if (as === "in_review") {
        const who = await targetOf(giverOf(activity, issue)) ?? (me.reportsTo ? await targetOf(`agent:${me.reportsTo}`) : null);
        reviewer = who && await holderFor(who);
        if (!reviewer) { as = "blocked"; text = `${comment}\n\n${NO_REVIEWER}`; }
        tLog.info({ reviewer: reviewer?.name ?? null }, reviewer ? "Paperclip task finished — sent to review" : "Paperclip task finished for review, but no one can review it — it stays with this bot");
      }
      // `return` through process.escalate: up the reporting line (hand_up), or
      // back down a recorded hand-up this bot holds (return). A seat with no
      // manager hands back to its giver, as before.
      // `escalate` on a card that is not an escalation (SLA-1775): the card
      // goes up, blocked, to whoever decides — up the reporting line through
      // process.escalate, else to the configured escalation holder, who is
      // also told off the board. A mirrored card escalates too: its block
      // and holder are the only things written there.
      let up = null;
      if (escalate) {
        as = "blocked";
        if (escalateClient && me.reportsTo && !external(issue)) via = handOff("hand_up");
        else if (escalateTo) {
          const to = await holderFor(escalateTo);
          giveTo = to && { ...to, person: Boolean(to.userId) };
          up = giveTo;
          if (!giveTo) text = `${comment}\n\nI could not escalate this to ${escalateTo.name}: the board has no seat by that name, so it stays with me, blocked.`;
        } else text = `${comment}\n\nI have no one configured to escalate this to, so it stays with me, blocked.`;
        tLog.info({ to: up?.name ?? (via ? "hand_up" : null) }, "Paperclip task escalated");
      } else if (giveBack && as === "blocked" && !external(issue) && escalateClient && (me.reportsTo || hop)) {
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
        // A name may also be an agent seat (the creator's): it is held the same way.
        giveTo = await personNamed(person) ?? await holderFor({ kind: "agent", ref: person });
        if (!giveTo) text = `${comment}\n\n${noPerson(person)}`;
        tLog.info({ to: giveTo?.name ?? null, named: person }, giveTo ? "Paperclip task waits on a person — handed to them, blocked" : "Paperclip task waits on a person the board does not have — it stays with this bot");
      } else if (as === "blocked" && !waitsOn.length && !external(issue) && !escalated && !hop && !reviewing && issue.createdByAgentId && issue.createdByAgentId !== me.id) {
        // A plain block on a card another agent created: nothing in it names
        // a wait this bot can clear, and a card it holds as its own unblock
        // owner is woken by the board every window (a clock each re-block
        // restarts). It goes to the agent that created it, in the same write.
        const who = await targetOf(requesterOf(issue, me.id));
        giveTo = who && await holderFor(who);
        if (giveTo) text = `${comment}\n\nNothing here is mine to clear, so this card goes back to ${giveTo.name}, who created it.`;
        tLog.info({ to: giveTo?.name ?? null }, giveTo ? "Paperclip task blocked with nothing this bot can clear — handed to its creator" : "Paperclip task blocked — its creator is not a seat the board has, so it stays with this bot");
      }
      const closed = await reply(item, postRun, key, producing(key), text, as, { waitsOn, unlessReady, mark: decidedFrom.get(key) ?? decidedAt, giveTo,
        handOff: via, resumed: hopBlocked(hop, statusSetter(activity, "blocked", me.id)), reviewer });
      if (closed && closed !== READY && up?.userId && onEscalate) {
        try { await onEscalate({ task: issue.identifier, link: cardLink(issue), to: up.name, ask: firstLine(comment) }); } catch (err) {
          tLog.warn({ err: err.message }, "Paperclip escalation — telling the person off the board failed; the card is with them");
        }
      }
      return { status: as, closed };
    };
    if (await goOn()) return;
    let { status, closed } = await post(mayGoOn());
    if (closed === READY) {
      if (await goOn()) return;
      ({ status, closed } = await post(false));
    }
    settle(postRun, status);
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
      await keepBlocked(item, runId, tLog, wakeSnap());
      // An escalation already worked, with nothing new since, is left as it is:
      // Paperclip re-wakes the holder of a blocked card it sees unchanged. The
      // run ends on a note of its own (endRun).
      if (step === "settle") {
        // A task its answer linked that reads open now but is no longer on the
        // card — trimmed when it was done, reopened since — is linked again:
        // the wait stands, and its finish wakes the card (w4).
        const on = (issue.blockedBy ?? []).map((b) => b.id);
        const missing = (links?.open ?? []).filter((t) => t.status !== "unknown" && !on.includes(t.id)).map((t) => t.id);
        // Read again first, as before any routing write (d): changed since this wake's reads, it is left.
        // Through the one gate (routeGate): changed since, and nothing is linked.
        if (missing.length && !await personDecided(item.id, decidedAt)) {
          try { await routeGate(item.id, wakeSnap(), runId, { blockedByIssueIds: [...on, ...missing] }, { unrouted: null }); } catch (err) {
            if (!(err.status >= 400 && err.status < 500)) throw err;
            tLog.warn({ err: err.message }, "Paperclip escalation — the board refused linking a reopened wait again; it is said on the next wake");
          }
        }
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
          // started a second time, as on any task.
          if (held && attempts.stop(attemptId)) { tLog.warn({ attempt: attemptId }, "Paperclip escalation stopped by someone else — its worker is stopped"); return hold(); }
          tLog.info({ attempt: attemptId, phase: attempts.current(attemptId).phase }, "Paperclip escalation attempt under way before the restart — following it, not running it again");
          // Never launched, it is gated on what it was admitted on first (preflight).
          let body, deps, refused = false;
          try { body = await run("", undefined, key, attemptId, (deps = cont ? contDeps(cont, "card") : savedDeps(key, "card"))); } catch (err) {
            if (!(err instanceof DepsOpen)) throw err;
            tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip escalation's waits read open again before its worker launched — not run, the wait stands");
            if (!cont) { links = err.now; return ownEscalation("settle"); }
            refused = true;
            body = cont.was ?? ""; continuing.delete(key);
          }
          if (refused) { /* its earlier answer, as it was */ }
          else if (body && cont) { body = `${cont.prefix}\n\n${body}`; leads.set(key, cont.prefix); continuing.delete(key); }
          else if (body && deps?.lead) { body = `${deps.lead}\n\n${body}`; leads.set(key, deps.lead); }
          pending.set(key, body || "");
          saveState(stateFile, state);
        } else if (resumeInterrupted && (cont ? !cont.resumed && Array.isArray(cont.deps) : !resumed.has(attemptOf(key)))) {
          // Run again only over the board the attempt was admitted from: anyone
          // else's decision since its mark stands, and the mark is not moved past it.
          if (held || (decidedFrom.has(key) && decidedSince(activity, decidedFrom.get(key)))) return hold();
          tLog.warn("Paperclip escalation attempt never finished — running it once more, told it was interrupted");
          if (cont) cont.resumed = true;
          else resumed.add(attemptOf(key));
          decidedFrom.set(key, decidedAt);
          attemptRuns.set(key, runId);
          saveState(stateFile, state);
          // Gated as the going-on it was (depsGate): a wait open again, and
          // the answer it went on from is posted, its wait linked again.
          undo = null;
          const deps = cont ? contDeps(cont, "card") : savedDeps(key, "card");
          try {
            let body = await run(INTERRUPTED_NOTE, undefined, key, undefined, deps);
            if (body && cont) { body = `${cont.prefix}\n\n${body}`; leads.set(key, cont.prefix); continuing.delete(key); }
            else if (body && deps?.lead) { body = `${deps.lead}\n\n${body}`; leads.set(key, deps.lead); }
            pending.set(key, body || "");
          } catch (err) {
            if (!(err instanceof DepsOpen)) throw err;
            if (!cont) {
              tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip escalation resume's waits read open again — not run, the wait stands");
              resumed.delete(attemptOf(key));
              saveState(stateFile, state);
              links = err.now;
              return ownEscalation("settle");
            }
            tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip escalation attempt's waits read open again — not run, its earlier answer posted");
            pending.set(key, cont.was ?? ""); continuing.delete(key);
          }
          saveState(stateFile, state);
        } else tLog.warn("Paperclip escalation attempt never finished — posting the fallback, not running it again");
      } else {
        // Back from the wait its answer linked (p7): every linked task is done.
        // Read done again just before the model (depsGate, run's `deps`):
        // one open now, and the wake ends as a wait that still stands does.
        const deps = resumes ? { refs: linked.get(key), say: (names) => resumeText("card", names) } : undefined;
        if (resumes) tLog.info({ resumedFrom: links.tasks.map(nameOf) }, "Paperclip escalation's linked waits are done — resuming it");
        tLog.info({ trigger }, "Paperclip escalation waiting — running the bot, the card kept blocked");
        // Marked before it starts, as every attempt is (see the work step).
        begin(key);
        if (deps) gates.set(key, { refs: deps.refs, what: "card" });
        since.set(key, [asked, ...comments.filter((c) => c.authorAgentId === me.id).map((c) => c.createdAt)].sort().at(-1));
        decidedFrom.set(key, decidedAt);
        attemptRuns.set(key, runId);
        const attemptId = nameAttempt(key);
        saveState(stateFile, state);
        let body;
        try { body = await run("", undefined, key, attemptId, deps); } catch (err) {
          if (!(err instanceof DepsOpen)) throw err;
          tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip escalation's waits read open again just before resuming — not run, the wait stands");
          links = err.now;
          return ownEscalation("settle");
        }
        const lead = deps?.lead ?? "";
        if (body && lead) leads.set(key, lead);
        pending.set(key, body ? (lead ? `${lead}\n\n${body}` : body) : "");
        saveState(stateFile, state);
      }
      if (lostRun && await deferLost(item, key, lostRun, tLog)) return;
      // The ask the answer answers is the latest attempt owed (the sequence).
      let answering = owedKeys().at(-1) ?? key;
      let mark = decidedFrom.get(answering) ?? decidedAt;
      // Checked against the card the answer was made from, saved with it
      // (builtOn): after a restart, this wake's read is not that card.
      let was = { issue, comments, activity, ...producing(answering) };
      // The tasks this wake's answer links, when it is blocked on open ones (r6).
      let linkedNow = null;
      const settledKeys = owedKeys();
      for (let rounds = 0; ; rounds++) {
        // A wake since may have checked the card out again.
        await keepBlocked(item, postRun, tLog, withOwn(was), { settled: true });
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
          await say(item.id, comment, postRun);
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
        // The same ask on a card that is not the one the answer was built on —
        // its labels, status or holder changed, or anything recorded on it
        // since by anyone else (cardNow) — is worked again before anything is
        // routed: an answer is never handed on from a card it did not see.
        // Comments this wake's own runs posted are its output, not a change.
        const drifted = now === answering && changedFrom(was, { issue: card, comments: thread, activity: record }, ownRuns());
        // Through the shared action (SLA-1493): every hand-up up the reporting
        // line, label or record alike; and, on a card a recorded hand-up brought
        // here, the answer back down that chain, resolved or handed back undone.
        // Down a chain only a label made, the action has no record to walk.
        const recorded = cardHop?.kind === "escalated";
        const op = !escalateClient ? null : outcome.escalate ? (me.reportsTo ? "hand_up" : null)
          : !recorded ? null : outcome.giveBack ? "return" : outcome.status !== "blocked" ? "resolve" : null;
        if (now === answering && !drifted) {
          // The links this card's answer made earlier, done now, are cleared by
          // this write's attempt (p7); a link anyone else made stays.
          const doneOf = (c) => new Set((c.blockedBy ?? []).filter((b) => b.status === "done" && wasLinked.includes(b.id)).map((b) => b.id));
          const waits = !target && outcome.status === "blocked" && outcome.waitsOn.length ? await resolveWaits(outcome.waitsOn, item.id) : null;
          const goneOn = `${answering}#${attemptSeq.get(answering) ?? 0}`;
          // The card is read again last, just before a write that hands it on,
          // links it or unlinks it (d, w10): changed since this round's reads,
          // the next round decides from fresh reads; past the rounds, the answer
          // is only posted. The write is decided from that last read.
          const stays = "Paperclip escalation worked — the card kept changing under the write, so the answer is posted and the card left as it is";
          let seen = { issue: card, comments: thread, activity: record };
          if (op || target || waits?.ids.length || doneOf(card).size) {
            seen = await cardNow(item.id, was, ownRuns());
            if (seen.moved) {
              if (rounds < MAX_REWORK) continue;
              await finish(outcome.comment, stays);
              break;
            }
          }
          const links = seen.issue.blockedBy ?? [];
          const done = doneOf(seen.issue);
          const kept = links.map((b) => b.id).filter((id) => !done.has(id));
          // True when the unlink went out: the card is then read again before
          // a hand-on, which the unlink's round trip came before. "moved" when
          // the gate found the card changed and wrote nothing.
          const unlink = async () => {
            if (!done.size) return false;
            try {
              // Through the one gate: changed since, and nothing is unlinked.
              const out = await routeGate(item.id, withOwn(was), postRun, { blockedByIssueIds: kept }, { unrouted: null });
              return out.routed ? true : out.why === "deps" ? "deps" : "moved";
            } catch (err) {
              if (!(err.status >= 400 && err.status < 500)) throw err;
              tLog.warn({ err: err.message }, "Paperclip escalation — the board refused clearing the done links; they are left");
              return false;
            }
          };
          // A write refused because a dependency the answer was built on is
          // open again: the answer is said with why, the wait kept (keepWait).
          const waitsStand = "Paperclip escalation worked — a dependency it was built on is open again, so the answer is posted and the wait kept";
          const reopened = () => `${outcome.comment}\n\n${depsReopened(depsRefused.get(item.id).open.map(nameOf))}`;
          // After the unlink, before the hand-on: changed during it, nothing is handed on.
          const changedSinceUnlink = async () => {
            const again = await cardNow(item.id, was, ownRuns());
            if (!again.moved) { seen = again; return false; }
            return true;
          };
          if (op && recorded && personStop(statusSetter(record, "blocked", me.id), record)) {
            // A card a recorded hand-up brought here that a person has blocked
            // since pickup is theirs: the answer is said, and nothing is handed on.
            await finish(outcome.comment, "Paperclip escalation worked, but a person holds the card — a note posted, nothing handed on");
          } else if (op) {
            // The action moves the card and records the hop in one write; the answer rides in it.
            const cut = await unlink();
            if (cut === "deps") { await finish(reopened(), waitsStand); break; }
            if (cut === "moved" || (cut && await changedSinceUnlink())) {
              if (rounds < MAX_REWORK) continue;
              await finish(outcome.comment, stays);
              break;
            }
            ({ handoff, fallback = null } = await handOffVia(item, postRun, answering, outcome.comment, op, tLog, withOwn(was)));
          } else if (target) {
            // r1-r3: handed down, or up, the person told the latest attempt's ask.
            const cut = await unlink();
            if (cut === "deps") { await finish(reopened(), waitsStand); break; }
            if (cut === "moved" || (cut && await changedSinceUnlink())) {
              if (rounds < MAX_REWORK) continue;
              await finish(outcome.comment, stays);
              break;
            }
            await handOn(item, postRun, withOwn(was), seen.issue, outcome, target, tLog, seats);
          } else if (waits?.ids.length) {
            // r6: linked to the tasks still open, in the one write that posts it;
            // the unblock step is left as it is (the Foreman reads it back).
            const ids = [...new Set([...kept, ...waits.ids])];
            try {
              const link = await routeGate(item.id, withOwn(was), postRun, { blockedByIssueIds: ids }, { comment: outcome.comment, unrouted: null });
              if (!link.routed) {
                if (rounds < MAX_REWORK) continue;
                await finish(outcome.comment, stays);
                break;
              }
              // Every task it named is waited on, not only those linked: one
              // done now, or one the board does not have, still holds the
              // resume until it reads done (R4, R5).
              linkedNow = waits.all;
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
            const said = outcomeOf(pending.get(answering)).comment;
            const before = pending.get(answering);
            const cont = { deps: waits.all, said, was: before };
            undo = checkpoint();
            // Recorded unstarted with its go-on mark, in one save (preContinue, unstarted).
            preContinue(answering, goneOn, cont);
            continued.add(goneOn);
            decidedFrom.set(answering, markOf(record));
            // An attempt of its own, named and saved before it launches: a
            // restart follows this worker, never the one it went on from.
            const contId = nameAttempt(answering);
            saveState(stateFile, state);
            tLog.info({ waitsOn: waits.done }, "Paperclip escalation said it waits on tasks already done — going on with it");
            // Told, and gone on, only from its waits read done just before the
            // model (depsGate): one open again, the state is as before and the
            // next round links it (r6).
            const deps = contDeps(cont, "card", answering);
            let again;
            try { again = await run("", { issue: card, comments: thread, activity: record }, answering, contId, deps); } catch (err) {
              if (!(err instanceof DepsOpen)) throw err;
              tLog.info({ waitsOn: err.now.open.map(nameOf) }, "Paperclip escalation's waits read open again just before going on — not run, linked instead");
              continue;
            }
            const prefix = deps.lead;
            if (again && prefix) { pending.set(answering, `${prefix}\n\n${again}`); leads.set(answering, prefix); } else pending.set(answering, before);
            continuing.delete(answering);
            saveState(stateFile, state);
            mark = markOf(record);
            was = { issue: card, comments: thread, activity: record, ...producing(answering) };
            continue;
          } else {
            // r4, r5, r8 (and r7 past its go-on): a comment only, the card left blocked with this bot.
            if (await unlink() === "moved" && rounds < MAX_REWORK) continue;
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
          askOf(thread, me.id)?.id !== askOf(was.comments, me.id)?.id && "a new comment came in", handedAt(record) !== handedAt(was.activity) && "it was handed to you again",
          drifted && labelsOf(card).join() !== labelsOf(was.issue).join() && "its labels changed"].filter(Boolean);
        if (drifted && !what.length) what.push("the card changed");
        tLog.info({ changed: what }, "Paperclip escalation asked something newer while it was worked — working it again before any hand-off");
        const above = owed(now).comment;
        const from = since.get(answering) ?? asked;
        undo = checkpoint();
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
        was = { issue: card, comments: thread, activity: record, ...producing(now) };
      }
      const refusal = settle(postRun);
      // p6: a linked wait is recorded on the attempt that made it; any earlier
      // link of these asks is ended by this answer (resumed once per wait).
      for (const k of [key, ...settledKeys]) { linked.delete(k); linkDone.delete(k); }
      // A write refused on a dependency open again keeps the wait on what the answer was built on (waitKept).
      if (refusal) linked.set(answering, [...new Set([...(linkedNow ?? []), ...refusal.tasks.map((t) => t.id)])]);
      else if (linkedNow) linked.set(answering, linkedNow);
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
          if (err instanceof CardMoved || err instanceof DepsOpen) log.info({ issue: item.id }, "Paperclip task changed before its answer ran — nothing run, left for the next wake");
          else log.warn({ err: err.message, status: err.status, code: err.code, issue: item.id }, "Paperclip task failed — retrying it next tick");
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
    let policy = null;
    try { policy = parsePolicy(env.PAPERCLIP_POLICY, "PAPERCLIP_POLICY"); } catch (err) { problems.push(err.message); }
    if (problem) problems.push(problem);
    else boards.push({ id: null, url: env.PAPERCLIP_URL, apiKey: env.PAPERCLIP_API_KEY, keyEnv: "PAPERCLIP_API_KEY", promptChannel: env.PAPERCLIP_PROMPT_CHANNEL || undefined, contract, policy,
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
    let policy;
    try { policy = parsePolicy(b.policy, `${label} policy`); } catch (err) { problems.push(err.message); continue; }
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
    boards.push({ id, url: b.url, apiKey: env[b.keyEnv], keyEnv: b.keyEnv, promptChannel: b.promptChannel ? String(b.promptChannel) : undefined, contract, policy, ...(b.events === undefined ? {} : { events: b.events }), escalation });
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

module.exports = { requesterOf, writerOf, parsePolicy, POLICY_UNAVAILABLE, REVIEW_ROUNDS, revisitNote, revisitAnswer, parseIntake, parseRewake, intakeStatus, intakeNote, INTAKE_HEAD, DEFAULT_INTAKE, CARD_STATUSES, isNote, ESCALATION_LABELS, handedWith, decisionKind, lastDecision, personSince, markAt, boardKeyEnvs, parseEscalateTo, escalationNote, statusSetter, decidedStatus, reconcilable, handedBack, movable, wakeStep, HELD_NOTE, ESCALATION_KEPT, CARD_CHANGED, depsReopened, NEWER_ASK, PERSON_STANDS, TRANSPORT_NOTE, INTERRUPTED_NOTE, HANDED_AWAY, handedSince, waitAction, paperclipBoards, pickOpenRun, askOf, askKey, buildTaskPrompt, replyCollector, createPaperclipPoller, FALLBACK_REPLY, ALREADY_ANSWERED, unchangedNote, COMMENT_WAKES, quietWake, QUIET_MARK, UNBLOCK_ACTION, OUTCOME_MARK, outcomeOf, refusal, routableSnapshot };
