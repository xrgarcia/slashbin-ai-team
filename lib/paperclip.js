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
  return comments.filter((c) => !c.deletedAt && c.authorAgentId !== agentId).at(-1) ?? null;
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
function buildTaskPrompt(issue, comments, me, boardUrl, { maxBytes = PROMPT_MAX_BYTES } = {}) {
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
      "",
      "You cannot book a follow-up or a scheduled job from a board task: nothing scheduled here can post back to it. If one is asked for, say so.",
      "You cannot attach a file to a board comment. If a file is asked for, say so; put short content in the reply itself.",
      "Your Discord conversations, their summaries and the files shared there are private to those channels and are not available here. Never quote, recall or summarize them on the board.",
      "Answer the latest ask. Reply with the comment body only.",
    ].join("\n");
  };
  // The size of the prompt build() would return, without building it: each
  // comment is measured once, so shedding a long thread is linear, not a
  // rebuild per comment dropped (second pass on 52e8de4: 4,000 comments held
  // the bot's event loop for 52 seconds). The head and the ask are measured
  // again only when a cut changes them.
  const sizes = live.map((c) => byteLength(render(c)));
  const pre = [0];
  for (const n of sizes) pre.push(pre.at(-1) + n);
  const SEP = byteLength("\n\n"), THREAD_HEAD = byteLength("\nThread so far:\n\n");
  let headFor, headBytes, askFor, askBytes;
  const size = () => {
    if (headFor !== `${parts.title}\0${parts.description}`) { headFor = `${parts.title}\0${parts.description}`; headBytes = byteLength(build("")); }
    if (ask && askFor !== parts.askBody) { askFor = parts.askBody; askBytes = byteLength(render(ask, parts.askBody)); }
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
/** Statuses a person sets to decide a task's fate; the bot never writes over them. */
const DECIDED = new Set(["blocked", "cancelled"]);
const ALREADY_ANSWERED = "This was answered above. Add a comment with anything new and I will pick it up.";

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
 * yet succeeded, so it is retried on every poll until it does.
 *
 * Only a missing file is a fresh start. One that cannot be read throws: read as
 * empty, it would run every answered task again.
 */
function loadState(file) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch (err) {
    if (err.code === "ENOENT") return { handled: new Set(), answered: new Set(), pending: new Map(), closing: new Map() };
    throw err;
  }
  const s = JSON.parse(raw);
  // A saved answer is keyed `<task>:<ask>`; anything else predates that and can never be matched.
  const pending = new Map(Object.entries(s.pendingReplies ?? {}).filter(([k]) => k.includes(":")));
  return { handled: new Set(s.handledRuns ?? []), answered: new Set(s.answeredAsks ?? []), pending,
    closing: new Map(Object.entries(s.closing ?? {})) };
}
/** Written whole or not at all: a temp file, flushed, then renamed over the old one. */
function saveState(file, { handled, answered, pending, closing }) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify({
      handledRuns: [...handled].slice(-500),
      answeredAsks: [...answered],
      pendingReplies: Object.fromEntries(pending),
      closing: Object.fromEntries(closing),
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
 */
function createPaperclipPoller({ url, apiKey, stateFile, answer, log, fetch: fetchImpl = fetch }) {
  const base = `${url.replace(/\/+$/, "")}/api`;
  let state;
  try { state = loadState(stateFile); } catch (err) {
    // Stay off rather than forget what was answered. Discord is unaffected.
    log.error({ err: err.message, stateFile }, "Paperclip state unreadable — board tasks are off until it is fixed");
    return { tick: async () => {} };
  }
  const { handled, answered, pending, closing } = state;
  let me = null;
  let busy = false;

  async function api(method, path, body, runId) {
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    if (runId) headers["x-paperclip-run-id"] = runId;
    const r = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  /** The ask on the task as the board shows it now, and the task's status. */
  async function boardNow(taskId) {
    const comments = list(await api("GET", `/issues/${taskId}/comments`), "comments")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const issue = await api("GET", `/issues/${taskId}`);
    return { key: askKey(taskId, issue, askOf(comments, me.id)), status: issue.status };
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
  function closingNow(item, runId, key) {
    closing.set(item.id, { runId, key });
    saveState(stateFile, state);
  }
  /** The status this run's close replaced, as Paperclip recorded it. */
  async function statusBeforeClose(taskId, runId) {
    const close = list(await api("GET", `/issues/${taskId}/activity`), "activity")
      .find((a) => a.runId === runId && a.action === "issue.updated" && a.details?.changes?.status?.to === "done");
    return close?.details.changes.status.from;
  }
  /** Paperclip's record of the newest status change this run made, from/to. */
  async function lastStatusWrite(taskId, runId) {
    const write = list(await api("GET", `/issues/${taskId}/activity`), "activity")
      .find((a) => a.runId === runId && a.action === "issue.updated" && a.details?.changes?.status);
    return write?.details.changes.status;
  }
  /**
   * Put a status on a task that may have changed since it was read. No read
   * makes that safe, so the write is checked after it lands: Paperclip records
   * what each write replaced, under the row lock, and a write that replaced
   * anything but what was read stepped on a person's newer decision, which is
   * put back. The write is recorded before it is sent, so a response lost on
   * the way is settled from the board's record on the next tick.
   */
  async function writeStatus(taskId, entry, status, expected) {
    entry.wrote = { status, expected };
    closing.set(taskId, entry);
    saveState(stateFile, state);
    await api("PATCH", `/issues/${taskId}`, { status }, entry.runId);
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
      await writeStatus(taskId, entry, last.from, status);
    }
    return true;
  }
  async function reopenIfMoved(taskId, { runId, key }, tLog) {
    const entry = closing.get(taskId)?.key === key ? closing.get(taskId) : { runId, key };
    if (!(entry.wrote && await settleWrite(taskId, entry, tLog))) {
      const now = await boardNow(taskId);
      if (now.status === "done") {
        const before = await statusBeforeClose(taskId, runId);
        if (DECIDED.has(before)) {
          await writeStatus(taskId, entry, before, "done");
          tLog.info({ issue: taskId, status: before }, "Paperclip task was decided as it closed — put back");
        } else if (now.key !== key) {
          await writeStatus(taskId, entry, "todo", "done");
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
   */
  async function acknowledge(item, runId, comments, key) {
    // A note that already landed was recorded as a close when it was sent.
    const closed = !comments.some((c) => c.createdByRunId === runId)
      && await reply(item, runId, key, ALREADY_ANSWERED);
    handled.add(runId);
    saveState(stateFile, state);
    if (closed) await reopenIfMoved(item.id, { runId, key }, log);
  }

  /**
   * Post a comment under the run, and close the task with it only if the board
   * still shows the ask it answers and nobody has decided the task's fate since:
   * a newer comment or a revised task is an ask this answer never saw, and a
   * task a person blocked or cancelled stays that way. Resolves to whether the
   * task was closed.
   */
  async function reply(item, runId, key, comment) {
    const now = await boardNow(item.id);
    const close = now.key === key && !DECIDED.has(now.status);
    if (close) closingNow(item, runId, key);
    await api("PATCH", `/issues/${item.id}`, close ? { status: "done", comment } : { comment }, runId);
    return close;
  }

  /** One task. Its failure is its own: it never holds up the rest of the inbox. */
  async function handleTask(item) {
    const open = pickOpenRun(await api("GET", `/issues/${item.id}/runs`), me.id, handled);
    if (!open) return;
    const runId = runIdOf(open);
    const issue = await api("GET", `/issues/${item.id}`);
    const comments = list(await api("GET", `/issues/${item.id}/comments`), "comments")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // A saved answer belongs to the task and the ask, not the run: Paperclip
    // re-wakes an open task under a new run id, and that run must find it too.
    const ask = askOf(comments, me.id);
    const key = askKey(item.id, issue, ask);
    // Everything still owed on this task goes out in one comment, oldest ask
    // first, so an earlier ask whose answer never posted is not dropped by a
    // newer one. Built from saved state only, so a retry posts the same text.
    const mine = `${item.id}:`;
    const owed = () => [...pending].filter(([k]) => k.startsWith(mine)).map(([, b]) => b || FALLBACK_REPLY)
      .join("\n\n---\n\n");
    const settle = () => {
      for (const k of [...pending.keys()]) if (k.startsWith(mine)) { pending.delete(k); answered.add(k); }
    };
    if (pending.has(key)) {
      // A saved answer is delivered unless THAT answer is already on the task (its
      // post landed but the response was lost). Any other comment of ours — a
      // progress note written during the run — is not the answer.
      const since = ask?.createdAt ?? issue.createdAt;
      const saved = owed();
      if (comments.some((c) => c.authorAgentId === me.id && c.createdAt > since && c.body === saved)) {
        settle();
        saveState(stateFile, state);
        return acknowledge(item, runId, comments, key);
      }
    } else if (answered.has(key)) {
      return acknowledge(item, runId, comments, key);
    }

    const tLog = log.child({ paperclipTask: issue.identifier, runId });
    let body;
    if (pending.has(key)) {
      // Attempted already; only the post failed, or the bot died mid-run.
      // Retry the post, never the run.
      body = pending.get(key);
      if (body) tLog.info("Paperclip answer not yet posted — retrying the post only");
      else tLog.warn("Paperclip attempt never finished — posting the fallback, not running it again");
    } else {
      tLog.info("Paperclip task waiting — running the bot");
      // Mark the attempt before it starts. A bot that dies mid-run may already
      // have sent mail or written a record, so a restart posts the fallback
      // for this ask rather than running it a second time.
      pending.set(key, "");
      saveState(stateFile, state);
      try {
        body = (await answer(buildTaskPrompt(issue, comments, me, url), issue)).trim();
      } catch (err) {
        tLog.error({ err: err.message }, "Paperclip task failed");
      }
      pending.set(key, body || "");
      saveState(stateFile, state);
    }
    // Comment and close in one write. Paperclip re-wakes an agent whose run
    // ends with the task still open, and refuses in_review without a named
    // reviewer — so an answered ask is done. A reply on the task reopens it.
    const closed = await reply(item, runId, key, owed());
    settle();
    handled.add(runId);
    saveState(stateFile, state);
    tLog.info({ answered: Boolean(body), leftOpen: !closed }, "Paperclip task answered");
    if (closed) await reopenIfMoved(item.id, { runId, key }, tLog);
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
          log.warn({ err: err.message, issue: item.id }, "Paperclip task failed — retrying it next tick");
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, "Paperclip poll failed — retrying next tick");
    } finally {
      busy = false;
    }
  }

  return { tick };
}

module.exports = { pickOpenRun, askOf, askKey, buildTaskPrompt, replyCollector, createPaperclipPoller, FALLBACK_REPLY, ALREADY_ANSWERED };
