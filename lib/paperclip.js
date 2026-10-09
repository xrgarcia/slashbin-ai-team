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

const { mkdirSync, readFileSync, writeFileSync } = require("fs");
const { dirname } = require("path");
const { createHash } = require("crypto");

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

/** The prompt for one task: the task, then its whole thread, oldest first. */
function buildTaskPrompt(issue, comments, me, boardUrl) {
  const thread = comments
    .filter((c) => !c.deletedAt)
    .map((c) => `--- ${c.authorAgentId === me.id ? `You (${me.name})` : "A board user"}, ${c.createdAt}\n${c.body}`)
    .join("\n\n");
  return [
    `This is a task assigned to you on a Paperclip board (${boardUrl}).`,
    "Everyone with access to the board reads it. Your reply is posted as your comment on the task — it is not a chat channel, and no one sees anything else you write.",
    "",
    `Task ${issue.identifier}: ${issue.title}`,
    issue.description ? `\n${issue.description}` : "",
    thread ? `\nThread so far:\n\n${thread}` : "",
    "",
    "You cannot book a follow-up or a scheduled job from a board task: nothing scheduled here can post back to it. If one is asked for, say so.",
    "Answer the latest ask. Reply with the comment body only.",
  ].join("\n");
}

const FALLBACK_REPLY = "I could not answer this one just now. It has been logged and someone will follow up.";

/**
 * What survives a restart. `handled` — runs already closed, so a slow close is
 * never answered twice. `answered` — asks (`<task>:<ask>`) already answered, so a
 * re-wake under a new run is not answered again; it is a record, not a guess from
 * the thread, because a progress note the bot wrote mid-run looks like an answer.
 * `pending` — answers produced but not yet posted: running the task again to
 * recover one could repeat whatever the run did (mail, a record). Unposted
 * answers are never trimmed: one leaves only when its post lands.
 */
function loadState(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    // A saved answer is keyed `<task>:<ask>`; anything else predates that and can never be matched.
    const pending = new Map(Object.entries(s.pendingReplies ?? {}).filter(([k]) => k.includes(":")));
    return { handled: new Set(s.handledRuns ?? []), answered: new Set(s.answeredAsks ?? []), pending };
  } catch { return { handled: new Set(), answered: new Set(), pending: new Map() }; }
}
function saveState(file, { handled, answered, pending }) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    handledRuns: [...handled].slice(-500),
    answeredAsks: [...answered].slice(-5000),
    pendingReplies: Object.fromEntries(pending),
  }, null, 2));
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
  const state = loadState(stateFile);
  const { handled, answered, pending } = state;
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
        handled.add(runId);
        saveState(stateFile, state);
        return;
      }
    } else if (answered.has(key)) {
      handled.add(runId);
      saveState(stateFile, state);
      return;
    }

    const tLog = log.child({ paperclipTask: issue.identifier, runId });
    let body;
    if (pending.has(key)) {
      // Answered already; only the post failed. Retry the post, never the run.
      body = pending.get(key);
      tLog.info("Paperclip answer not yet posted — retrying the post only");
    } else {
      tLog.info("Paperclip task waiting — running the bot");
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
    // Unless the task moved while the bot was answering: a newer comment or a
    // revised task is an ask this answer never saw, so the comment posts and
    // the task stays open for the re-wake to answer it.
    const now = askKey(item.id, await api("GET", `/issues/${item.id}`),
      askOf(list(await api("GET", `/issues/${item.id}/comments`), "comments")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)), me.id));
    const moved = now !== key;
    await api("PATCH", `/issues/${item.id}`, moved ? { comment: owed() } : { status: "done", comment: owed() }, runId);
    settle();
    handled.add(runId);
    saveState(stateFile, state);
    tLog.info({ answered: Boolean(body), leftOpen: moved }, "Paperclip task answered");
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      me ??= await api("GET", "/agents/me");
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

module.exports = { pickOpenRun, askOf, askKey, buildTaskPrompt, createPaperclipPoller, FALLBACK_REPLY };
