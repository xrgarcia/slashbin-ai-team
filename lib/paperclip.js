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
const { createHash } = require("crypto");
const { byteLength, truncateToBytes } = require("./argv-budget");

/**
 * How a run says it could not do the task. Without it every answer closed the
 * task as done, a "Blocked" reply included. `blocked` is the only outcome:
 * Paperclip refuses an agent's in_review unless a reviewer or approval is
 * already attached, which a reply cannot arrange.
 */
const OUTCOME_MARK = "PAPERCLIP-OUTCOME:";
const OUTCOME_LINE = /^[ \t>*_`]*PAPERCLIP-OUTCOME:[ \t]*([a-z_-]*)[^\n]*$/gim;

/** A task as the board names it, e.g. ACME-12. */
const IDENTIFIER = /\b[A-Z][A-Z0-9]*-\d+\b/g;

/**
 * The comment to post and the status to close with. Every outcome line is
 * taken out of the comment; any `blocked` one makes the task blocked. A blocked
 * line may name the tasks it waits on (`blocked on ACME-12, ACME-13`): the task
 * is then linked to them, and Paperclip wakes the bot when the last is done.
 *
 * @param {string} text the run's reply
 * @returns {{ comment: string, status: "done" | "blocked", waitsOn: string[] }}
 */
function outcomeOf(text) {
  let status = "done";
  const waitsOn = [];
  const comment = String(text).replace(OUTCOME_LINE, (line, word) => {
    if (word.toLowerCase() === "blocked") {
      status = "blocked";
      const rest = line.slice(line.toUpperCase().indexOf(OUTCOME_MARK) + OUTCOME_MARK.length);
      for (const id of rest.match(IDENTIFIER) ?? []) if (!waitsOn.includes(id)) waitsOn.push(id);
    }
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { comment, status, waitsOn };
}

/**
 * The last status decision in Paperclip's activity record (newest first) and
 * the status it set: a status update, Paperclip's own recovery settling a run
 * it lost, or a write Paperclip counts as a fresh decision though the status
 * string stays the same — it bumps `statusVersion` when blocked is reasserted
 * or a blocked task's blockers or wait are rewritten, so a person who holds a
 * task the bot had blocked is recorded only that way. Null when the record
 * does not say. `agentId` is the bot reading it (reconcilable).
 */
function lastDecision(activity, agentId) {
  const all = list(activity, "activity");
  const at = all.findIndex((a) => a.action === "issue.execution_recovery_settled"
    || (a.action === "issue.updated" && (a.details?.changes?.status || a.details?.changes?.statusVersion)));
  if (at < 0) return null;
  const w = all[at];
  const before = () => lastDecision(all.slice(at + 1), agentId);
  if (w.action === "issue.execution_recovery_settled") {
    // Paperclip settles a lost run as blocked whatever stop the task was in
    // already, and says so: an already-blocked task may carry a separate
    // hold. A stop decided before it is still the decision, then — a person's
    // stays a person's — and the settlement decides only a task it stopped.
    // A stop that was no one's choice either — the bot's own block, which a
    // wake checks out with no record, or an earlier settlement — is no hold:
    // the newer settlement decides, and names the run it lost.
    const b = w.details?.outcome === "blocked" ? before() : null;
    return b && STOPPED.has(b.to) && !reconcilable(b.w, agentId) ? b : { w, to: w.details?.outcome };
  }
  const c = w.details.changes;
  // The bot reasserting a block is not a decision of its own: the block keeps
  // whoever decided it. It does so only on its own block, or when someone
  // blocked the task just before its close landed — no write can be made
  // conditional — and then the hold stays theirs.
  if (!c.status && w.actorType === "agent" && w.actorId === agentId) {
    const b = before();
    if (b?.to === "blocked") return b;
  }
  return { w, to: c.status?.to ?? w.details.status ?? (c.blockedByIssueIds || c.unblockDescriptor ? "blocked" : null) };
}

/** A write Paperclip recorded to a task's status or to what it waits on. */
const statusOrWaits = (a) => a.action === "issue.updated"
  && ["status", "statusVersion", "blockedByIssueIds", "unblockDescriptor"].some((f) => a.details?.changes?.[f]);
/** The board as of a read of a task's activity: the time of its newest entry, on Paperclip's own clock. */
const markOf = (activity) => list(activity, "activity")[0]?.createdAt ?? "";
/** The newest write by a person to the task's status or waits made after `mark` (markOf); undefined when none. */
const personSince = (activity, mark) => list(activity, "activity").find((a) => a.actorType === "user" && statusOrWaits(a) && a.createdAt > mark);

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
 * an edited ask or a revised task is a new one and is answered.
 */
function askKey(taskId, issue, ask) {
  const what = JSON.stringify([issue.title ?? "", issue.description ?? "", ask?.id ?? null, ask?.body ?? ""]);
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
function buildTaskPrompt(issue, comments, me, boardUrl, { maxBytes = PROMPT_MAX_BYTES, note = "" } = {}) {
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
      "",
      "You cannot book a follow-up or a scheduled job from a board task: nothing scheduled here can post back to it. If one is asked for, say so.",
      "You cannot attach a file to a board comment. If a file is asked for, say so; put short content in the reply itself.",
      "Your Discord conversations, their summaries and the files shared there are private to those channels and are not available here. Never quote, recall or summarize them on the board.",
      `If you could not do what was asked — a tool, access or decision you do not have — say what blocks it and who can clear it, and end your reply with the line ${OUTCOME_MARK} blocked. The task is then marked blocked instead of done.`,
      `If it waits on other tasks on this board, name them on that line (${OUTCOME_MARK} blocked on ACME-12, ACME-13): the task is linked to them and comes back to you when the last one is done.`,
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
const HELD_NOTE = "This task is stopped by someone else, so I have not picked it up. Move it out of that status to have me work on it.";
/** On a task someone blocked as the bot closed it: their hold stands, and what its note said. */
const keptHold = (said) => `Someone blocked this task as I closed it, and the board let my close replace their hold's note. Their hold stands: I will not pick the task up until it is moved out of blocked.${said ? ` Their note said: ${said}` : ""}`;
/** Posted instead of a status or blocker write when a person changed the task after the bot read it (personSince). */
const PERSON_STANDS = "Someone changed this task's status or what it waits on after I last read it. Their change stands: I left the task as they set it.";
const ALREADY_ANSWERED = "This was answered above. Add a comment with anything new and I will pick it up.";
/** Posted when Paperclip blocks a task because it lost the run, while the bot is still working on it. */
const TRANSPORT_NOTE = "The board lost its connection to this run and marked the task blocked. The work is still running here — one attempt, not restarted — and its result will be posted on this task when it finishes.";
/** What the bot posts that is no answer: bookkeeping on a run or a task. */
const NOTES = new Set([HELD_NOTE, PERSON_STANDS, ALREADY_ANSWERED, TRANSPORT_NOTE]);
/** Prepended to a task whose last attempt the bot never finished (it restarted mid-run). */
/** reply() wrote nothing: every task the block named was done before it went out. */
const READY = Symbol("ready");
const INTERRUPTED_NOTE = "Your last attempt at this ask was interrupted before its answer was posted: the bot restarted mid-run. Whatever it started may have finished or may still be running. Find out what happened before doing anything again, and never repeat an action that may already have taken place. If you cannot tell, say so and mark the task blocked.";

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
 *
 * Only a missing file is a fresh start. One that cannot be read throws: read as
 * empty, it would run every answered task again.
 */
function loadState(file) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch (err) {
    if (err.code === "ENOENT") return { handled: new Set(), answered: new Set(), pending: new Map(), closing: new Map(), since: new Map(), decidedFrom: new Map(), attemptRuns: new Map(), resumed: new Set(), blockedAsks: new Map(), continued: new Set(), continuing: new Map() };
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
  return { handled: new Set(s.handledRuns ?? []), answered: new Set(asks(s.answeredAsks)), pending,
    closing: new Map(Object.entries(s.closing ?? {}).map(([t, c]) => [t, { ...c, key: ask(c.key) }])), since: new Map(byAsk(s.pendingSince)), decidedFrom: new Map(Object.entries(s.decidedFrom ?? {})),
    attemptRuns: new Map(byAsk(s.attemptRuns)), resumed: new Set(asks(s.resumedAsks)), blockedAsks,
    continued: new Set(asks(s.continuedAsks)), continuing: new Map(Object.entries(s.continuing ?? {})) };
}
/** Written whole or not at all: a temp file, flushed, then renamed over the old one. */
function saveState(file, { handled, answered, pending, closing, since = new Map(), decidedFrom = new Map(), attemptRuns = new Map(), resumed = new Set(), blockedAsks = new Map(), continued = new Set(), continuing = new Map() }) {
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
      continuedAsks: [...continued].slice(-500),
      continuing: Object.fromEntries([...continuing].filter(([k]) => pending.has(k))),
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
 */
function createPaperclipPoller({ url, apiKey, stateFile, answer, log, fetch: fetchImpl = fetch, requestTimeoutMs = 30000,
  resumeInterrupted = false, externalWriter = null, watchMs = 60000 }) {
  const base = `${url.replace(/\/+$/, "")}/api`;
  let state;
  try { state = loadState(stateFile); } catch (err) {
    // Stay off rather than forget what was answered. Discord is unaffected.
    log.error({ err: err.message, stateFile }, "Paperclip state unreadable — board tasks are off until it is fixed");
    return { tick: async () => {} };
  }
  const { handled, answered, pending, closing } = state;
  state.since ??= new Map();
  state.decidedFrom ??= new Map();
  state.attemptRuns ??= new Map();
  state.resumed ??= new Set();
  state.blockedAsks ??= new Map();
  state.continued ??= new Set();
  state.continuing ??= new Map();
  const { since, decidedFrom, attemptRuns, resumed, blockedAsks, continued, continuing } = state;
  let me = null;
  let busy = false;

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
  /** Whether this bot may move a task out of the stop it is in now (see reconcilable). */
  async function mayMove(taskId, status) {
    return reconcilable(statusSetter(await api("GET", `/issues/${taskId}/activity`), status, me.id), me.id);
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
    return Boolean(personSince(await api("GET", `/issues/${taskId}/activity`), mark));
  }
  /** The comment a write a person's change stood over is replaced with, once per change. */
  async function personStands(taskId, mark, runId) {
    const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments");
    if (!comments.some((c) => c.authorAgentId === me.id && c.body === PERSON_STANDS && c.createdAt > mark)) {
      await api("PATCH", `/issues/${taskId}`, { comment: PERSON_STANDS }, runId);
    }
  }

  /** The task's activity record — read only where it can change the status decided (decidedStatus). */
  async function recordFor(taskId, status) {
    return status === "in_progress" || STOPPED.has(status) ? api("GET", `/issues/${taskId}/activity`) : null;
  }

  /** The ask on the task as the board shows it now, and the task's status as decided. */
  async function boardNow(taskId) {
    const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const issue = await api("GET", `/issues/${taskId}`);
    const status = decidedStatus(issue.status, await recordFor(taskId, issue.status), me.id);
    return { key: askKey(taskId, issue, askOf(comments, me.id)), status, external: external(issue) };
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
  function closingNow(item, runId, key, as, mark) {
    closing.set(item.id, { runId, key, ...(as === "done" ? {} : { as }), mark });
    saveState(stateFile, state);
  }
  /**
   * The status this run's close (to `as`) replaced, and the write that had set
   * it, as Paperclip recorded them — with the waits the close replaced, and
   * whether a person changed the task's status or waits after `mark` and
   * before the close landed.
   */
  async function statusBeforeClose(taskId, runId, as, mark) {
    const activity = list(await api("GET", `/issues/${taskId}/activity`), "activity");
    const at = activity.findIndex((a) => a.runId === runId && a.action === "issue.updated" && a.details?.changes?.status?.to === as);
    if (at < 0) return {};
    const { status: { from }, blockedByIssueIds: waits } = activity[at].details.changes;
    return { from, setter: statusSetter(activity.slice(at + 1), from, me.id), at: activity[at].createdAt,
      waits: waits?.from, person: mark !== undefined && Boolean(personSince(activity.slice(at + 1), mark)) };
  }
  /** Paperclip's record of the newest status change this run made, from/to, and when. */
  async function lastStatusWrite(taskId, runId) {
    const write = list(await api("GET", `/issues/${taskId}/activity`), "activity")
      .find((a) => a.runId === runId && a.action === "issue.updated" && a.details?.changes?.status);
    return write && { ...write.details.changes.status, at: write.createdAt };
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
  const statusWrite = (status, waits) => (status === "blocked"
    ? { status, unblockDescriptor: { owner: { agentId: me.id }, action: waits?.names.length ? waitAction(waits.names) : UNBLOCK_ACTION },
      ...(waits ? { blockedByIssueIds: waits.ids } : {}) }
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
   * throws, so the post is retried rather than the wait dropped.
   */
  async function resolveWaits(names, selfId) {
    const waits = { ids: [], names: [] };
    for (const n of names) {
      const t = await taskNamed(n);
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
    const activity = list(await api("GET", `/issues/${taskId}/activity`), "activity");
    const mine = (a) => a.runId === runId && a.action === "issue.updated" && a.actorType === "agent" && a.actorId === me.id;
    const at = activity.findIndex((a) => mine(a) && a.details?.status === "blocked" && !a.details.changes?.status && a.details.changes?.statusVersion);
    if (at < 0) return false;
    const held = statusSetter(activity.slice(at + 1), "blocked", me.id);
    if (!held || reconcilable(held, me.id)) return false;
    // Changed by a person since the close: their newer hold stands as they set it.
    if (personSince(activity, activity[at].createdAt)) {
      await personStands(taskId, activity[at].createdAt, runId);
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
        const { from: before, setter, at, waits, person } = await statusBeforeClose(taskId, runId, as, entry.mark);
        // A stop someone chose, or anything a person set — status or waits —
        // after the close was decided: their status goes back, and their waits.
        const theirs = person || (STOPPED.has(before) && !reconcilable(setter, me.id));
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
   */
  async function acknowledge(item, runId, comments, key, mark, issue) {
    const as = blockedAsks.has(key) ? "blocked" : "done";
    const waitsOn = as === "blocked" ? (issue.blockedBy ?? []).map(nameOf) : [];
    // A note that already landed was recorded as a close when it was sent.
    const closed = !comments.some((c) => c.createdByRunId === runId)
      && await reply(item, runId, key, ALREADY_ANSWERED, as, { moveStopped: as === "blocked", waitsOn, unlessReady: as === "blocked", mark: decidedFrom.get(key) ?? mark });
    // The last of its waits finished since this tick read the task: nothing
    // was written, and the run is left for the next tick, which resumes the ask.
    if (closed === READY) return;
    handled.add(runId);
    saveState(stateFile, state);
    if (closed) await reopenIfMoved(item.id, { runId, key, as }, log);
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
  async function reply(item, runId, key, comment, as = "done", { moveStopped = true, waitsOn = [], unlessReady = false, mark } = {}) {
    const now = await boardNow(item.id);
    let close = now.key === key && !now.external
      && (!STOPPED.has(now.status) || (moveStopped && await mayMove(item.id, now.status)));
    const waits = close && as === "blocked" ? await resolveWaits(waitsOn, item.id) : undefined;
    // Every task the block names is done by now: it would wait for a wake that
    // never comes. Nothing is written, so the caller can go on with the work.
    if (unlessReady && waits && !waits.ids.length && waitsOn.length && (await allDone(waitsOn, item.id)).length) return READY;
    close &&= !await personDecided(item.id, mark);
    if (close) closingNow(item, runId, key, as, mark);
    await api("PATCH", `/issues/${item.id}`, close ? { ...statusWrite(as, waits), comment } : { comment }, runId);
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
  async function reconcileWaiting(item, runs) {
    if (item.status !== "blocked" || !item.unresolvedBlockerIssueIds?.length) return;
    const last = list(runs, "runs").find((r) => r.agentId === me.id && (r.contextIssueId ?? item.id) === item.id);
    if (!last) return;
    // Read before the task, so a person's change between the reads is after the mark (handleTask).
    const record = await api("GET", `/issues/${item.id}/activity`);
    const issue = await api("GET", `/issues/${item.id}`);
    const blockers = issue.blockedBy ?? [];
    const done = blockers.filter((b) => b.status === "done"), open = blockers.filter((b) => b.status !== "done");
    if (!done.length || !open.length || external(issue)) return;
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
   */
  function watchRun(item, runId, tLog, moved) {
    let current = runId, noted = false, looking = false;
    const timer = setInterval(async () => {
      if (noted || looking) return;
      looking = true;
      try {
        const issue = await api("GET", `/issues/${item.id}`);
        if (issue.status !== "blocked" || external(issue)) return;
        const setter = statusSetter(await api("GET", `/issues/${item.id}/activity`), "blocked", me.id);
        if (setter?.action !== "issue.execution_recovery_settled" || setter.runId !== current || !reconcilable(setter, me.id)) return;
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
      if (!owedRun || handled.has(owedRun)) return reconcileWaiting(item, runs);
      open = { id: owedRun };
    }
    const runId = runIdOf(open);
    // The run the answer goes out under: this one, or the one that replaced it when Paperclip lost it (watchRun).
    let postRun = runId;
    // The board as this tick decides from it: whatever it writes leaves a
    // person's later change to the task's status or waits standing
    // (personDecided). Read before the task itself, so a change made between
    // the reads is after the mark, never taken as seen.
    const activity = await api("GET", `/issues/${item.id}/activity`);
    const decidedAt = markOf(activity);
    const issue = await api("GET", `/issues/${item.id}`);
    const comments = list(await api("GET", `/issues/${item.id}/comments`), "comments")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // A saved answer belongs to the task and the ask, not the run: Paperclip
    // re-wakes an open task under a new run id, and that run must find it too.
    const ask = askOf(comments, me.id);
    const mine = `${item.id}:`;
    const key = askKey(item.id, issue, ask);
    // Everything still owed on this task goes out in one comment, oldest ask
    // first, so an earlier ask whose answer never posted is not dropped by a
    // newer one. Built from saved state only, so a retry posts the same text.
    // The newest owed answer decides the status: blocked when it says it could
    // not do its ask — or when its run produced no answer (it failed, or the
    // bot died mid-run): the fallback says nothing was done. An older answer
    // still owed goes out as text only; a newer ask has moved past it.
    const owed = () => {
      const parts = [...pending].filter(([k]) => k.startsWith(mine))
        .map(([k, b]) => (b ? outcomeOf(b)
          : { comment: continuing.has(k) ? `${continuing.get(k).prefix}\n\n${FALLBACK_REPLY}` : FALLBACK_REPLY, status: "blocked", waitsOn: [] }));
      const last = parts.at(-1) ?? { status: "done", waitsOn: [] };
      return { comment: parts.map((p) => p.comment || FALLBACK_REPLY).join("\n\n---\n\n"), status: last.status, waitsOn: last.waitsOn };
    };
    // Each ask still owed is answered as its own answer says, in the post the
    // run `by` wrote: one posted with a newer ask's answer keeps its own. A
    // blocked answer is in a wait named by that run, fixed here and never
    // worked out again from what the task waits on; any other answer is final.
    const settle = (by) => {
      for (const k of [...pending.keys()]) {
        if (!k.startsWith(mine)) continue;
        const status = pending.get(k) ? outcomeOf(pending.get(k)).status : "blocked";
        pending.delete(k); since.delete(k); attemptRuns.delete(k); continuing.delete(k);
        answered.add(k);
        if (status === "blocked") blockedAsks.set(k, by);
        else blockedAsks.delete(k);
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
      const landed = comments.find((c) => c.authorAgentId === me.id && c.createdAt > from && c.body === saved);
      if (landed) {
        const current = pending.has(key);
        settle(landed.createdByRunId ?? runId);
        saveState(stateFile, state);
        if (current) return acknowledge(item, runId, comments, key, decidedAt, issue);
      }
    }
    // A gone run takes no new work. When a newer ask came in after the attempt
    // it still owes, that attempt is posted under it as a comment only — the
    // newer ask has moved past it — and the newer ask waits for a live run.
    if (!live && !pending.has(key)) {
      const older = [...pending.keys()].filter((k) => k.startsWith(mine)).at(-1);
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
    const heldBy = (status, activity) => {
      const decided = decidedStatus(status, activity, me.id);
      // A task another writer owns is that writer's to stop as well — its sync
      // blocks a card for the bot to clear — so there only a person's stop holds.
      const setter = () => statusSetter(activity, decided, me.id);
      return { decided, held: STOPPED.has(decided) && (external(issue) ? setter()?.actorType === "user" : !reconcilable(setter(), me.id)) };
    };
    const { decided, held } = heldBy(issue.status, activity);
    // Someone may stop the task while the bot works it: then it is not worked again.
    const stoppedSince = async () => {
      const status = (await api("GET", `/issues/${item.id}`)).status;
      return heldBy(status, await recordFor(item.id, status)).held;
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
      // a note since (an acknowledgement, a hold), which would hide a move
      // made before it. An answer saved before its run was recorded is the
      // last of ours that is not such a note.
      const ours = comments.filter((c) => c.authorAgentId === me.id);
      const answeredAt = (ours.filter((c) => c.createdByRunId === blockedAsks.get(key)).at(-1)
        ?? ours.filter((c) => !NOTES.has(c.body)).at(-1))?.createdAt;
      const moved = lastDecision(await api("GET", `/issues/${item.id}/activity`), me.id)?.w;
      return Boolean(answeredAt && moved && moved.createdAt > answeredAt && moved.runId !== blockedAsks.get(key));
    };
    const resumes = answered.has(key) && blockedAsks.has(key)
      && ((!external(issue) && doneBlockers(issue).length > 0) || (!STOPPED.has(decided) && await movedSinceAnswer()));
    if (!pending.has(key) && answered.has(key) && !resumes) return acknowledge(item, runId, comments, key, decidedAt, issue);

    const tLog = log.child({ paperclipTask: issue.identifier, runId });
    const hold = async () => {
      if (!comments.some((c) => c.createdByRunId === runId)) await api("PATCH", `/issues/${item.id}`, { comment: HELD_NOTE }, runId);
      handled.add(runId);
      saveState(stateFile, state);
      tLog.info({ status: decided }, "Paperclip task is stopped by someone else — not picked up");
    };
    const run = async (note) => {
      const unwatch = watchRun(item, postRun, tLog, (next) => {
        postRun = next;
        if (attemptRuns.has(key)) attemptRuns.set(key, next);
        saveState(stateFile, state);
      });
      try {
        return (await answer(buildTaskPrompt(issue, comments, me, url, { note }), issue)).trim();
      } catch (err) {
        tLog.error({ err: err.message }, "Paperclip task failed");
      } finally { unwatch(); }
    };
    let body;
    if (pending.has(key)) {
      // Attempted already; only the post failed, or the bot died mid-run.
      // Retry the post, never the run — unless the operator lets an attempt the
      // bot never finished run once more, told it was interrupted, for work
      // that can find out what its last attempt did (resumeInterrupted).
      // An interrupted going-on (goOn) is run once more as itself: told what
      // was said before it, and that it was interrupted.
      body = pending.get(key);
      const cont = continuing.get(key);
      if (body) tLog.info("Paperclip answer not yet posted — retrying the post only");
      else if (resumeInterrupted && (cont ? !cont.resumed : !resumed.has(attemptOf(key)))) {
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
      if (held) return hold();
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
      tLog.info("Paperclip task waiting — running the bot");
      // Mark the attempt before it starts. A bot that dies mid-run may already
      // have sent mail or written a record, so a restart posts the fallback
      // for this ask rather than running it a second time. Its post can only
      // be a comment made after it starts: after the ask, and after anything
      // of ours already there — the answer that left the ask in the wait it
      // resumes from may say the same words.
      pending.set(key, "");
      since.set(key, [asked, ...comments.filter((c) => c.authorAgentId === me.id).map((c) => c.createdAt)].sort().at(-1));
      decidedFrom.set(key, decidedAt);
      attemptRuns.set(key, runId);
      saveState(stateFile, state);
      body = await run(note);
      if (body && resuming) body = `${resuming}\n\n${body}`;
      pending.set(key, body || "");
      saveState(stateFile, state);
    }
    // A blocked answer whose waits are all done gets no wake from them — done
    // before it was made, or since: the last finished before its post went
    // out, or before a saved answer's post was retried. The work goes on now,
    // once per ask, under a live run, told what the answer said so nothing it
    // did is done again. Never on a task someone stopped, nor one another
    // writer owns.
    const newest = () => [...pending.keys()].filter((k) => k.startsWith(mine)).at(-1);
    const mayGoOn = () => live && !held && !external(issue) && Boolean(newest()) && !continued.has(attemptOf(newest()));
    const goOn = async () => {
      if (!mayGoOn()) return;
      const k = newest();
      const first = pending.get(k) ? outcomeOf(pending.get(k)) : null;
      if (first?.status !== "blocked" || !first.waitsOn.length) return;
      const ready = await allDone(first.waitsOn, item.id);
      if (!ready.length || await stoppedSince().catch(() => true)) return;
      const names = ready.join(", ");
      const note = `This task said it was blocked waiting on ${names}; ${ready.length === 1 ? "it is" : "they are"} already done. What it said so far:\n\n${first.comment}\n\nPick the task up where it stopped, and do not repeat anything it says was already done.`;
      const prefix = `${first.comment}\n\nResuming: ${names}, which this task waited on, ${ready.length === 1 ? "is" : "are"} already done.`;
      // An attempt like any other, marked before it starts: a bot that dies in
      // it finds it under way (continuing), not the earlier answer to post.
      const was = pending.get(k);
      continued.add(attemptOf(k));
      continuing.set(k, { prefix, note });
      pending.set(k, "");
      saveState(stateFile, state);
      tLog.info({ waitsOn: ready }, "Paperclip task said it waits on tasks already done — going on with it");
      const again = await run(note);
      pending.set(k, again ? `${prefix}\n\n${again}` : was);
      continuing.delete(k);
      saveState(stateFile, state);
    };
    // Comment and close in one write. Paperclip re-wakes an agent whose run
    // ends with the task still open, and refuses in_review without a named
    // reviewer — so an answered ask is done. A reply on the task reopens it.
    const post = async (unlessReady) => {
      const { comment, status: as, waitsOn } = owed();
      return { status: as, closed: await reply(item, postRun, key, comment, as, { waitsOn, unlessReady, mark: decidedFrom.get(key) ?? decidedAt }) };
    };
    await goOn();
    let { status, closed } = await post(mayGoOn());
    if (closed === READY) {
      await goOn();
      ({ status, closed } = await post(false));
    }
    settle(postRun);
    handled.add(runId);
    handled.add(postRun);
    saveState(stateFile, state);
    tLog.info({ answered: Boolean(body), outcome: status, leftOpen: !closed, ...(postRun !== runId ? { postRun } : {}) }, "Paperclip task answered");
    if (closed) await reopenIfMoved(item.id, { runId: postRun, key, as: status }, tLog);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      me ??= await api("GET", "/agents/me");
      for (const [taskId, c] of [...closing]) {
        try {
          await reopenIfMoved(taskId, c, log);
        } catch (err) {
          log.warn({ err: err.message, issue: taskId }, "Paperclip close not yet checked — retrying it next tick");
        }
      }
      for (const item of list(await api("GET", "/agents/me/inbox-lite"), "issues")) {
        try {
          await handleTask(item);
        } catch (err) {
          log.warn({ err: err.message, status: err.status, code: err.code, issue: item.id }, "Paperclip task failed — retrying it next tick");
        }
      }
    } catch (err) {
      log.warn({ err: err.message, status: err.status, code: err.code }, "Paperclip poll failed — retrying next tick");
    } finally {
      busy = false;
    }
  }

  return { tick };
}

/**
 * The boards this bot answers on. The first is PAPERCLIP_URL with
 * PAPERCLIP_API_KEY; PAPERCLIP_EXTRA_BOARDS adds more, as a JSON array of
 * `{ "id", "url", "keyEnv", "promptChannel" }`. An extra board names the
 * variable that holds its key rather than carrying the key, so the setting can
 * be logged and the key stays in the environment, where the bot scrubs it.
 * Each board gets its own poller, state file and sessions, since one agent is a
 * separate seat on every board it sits on. A broken entry is reported and
 * skipped; the rest still come on.
 */
function paperclipBoards(env = process.env) {
  const boards = [], problems = [];
  if (env.PAPERCLIP_URL && env.PAPERCLIP_API_KEY) {
    boards.push({ id: null, url: env.PAPERCLIP_URL, apiKey: env.PAPERCLIP_API_KEY, keyEnv: "PAPERCLIP_API_KEY", promptChannel: env.PAPERCLIP_PROMPT_CHANNEL || undefined });
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
    // Two pollers on one board would race each other for the same runs.
    if (boards.some((x) => origin(x.url) === origin(b.url))) { problems.push(`${label}: ${b.url} is already answered by another entry`); continue; }
    boards.push({ id, url: b.url, apiKey: env[b.keyEnv], keyEnv: b.keyEnv, promptChannel: b.promptChannel ? String(b.promptChannel) : undefined });
  }
  return { boards, problems };
}

module.exports = { statusSetter, decidedStatus, reconcilable, HELD_NOTE, PERSON_STANDS, TRANSPORT_NOTE, INTERRUPTED_NOTE, waitAction, paperclipBoards, pickOpenRun, askOf, askKey, buildTaskPrompt, replyCollector, createPaperclipPoller, FALLBACK_REPLY, ALREADY_ANSWERED, UNBLOCK_ACTION, OUTCOME_MARK, outcomeOf, refusal };
