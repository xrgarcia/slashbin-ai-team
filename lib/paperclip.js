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
 * Has the bot already answered what woke this run? The server-side wait ends a
 * run the bot commented under, but a run can be opened by a comment the bot
 * already replied to (a slow close, a re-wake) — answering twice is noise on a
 * board people read.
 */
function alreadyAnswered(comments, wakeCommentId, agentId, issueCreatedAt) {
  const since = comments.find((c) => c.id === wakeCommentId)?.createdAt
    ?? comments.filter((c) => c.authorAgentId !== agentId).at(-1)?.createdAt
    ?? issueCreatedAt;
  return comments.some((c) => c.authorAgentId === agentId && c.createdAt > since);
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
    "Answer the latest ask. Reply with the comment body only.",
  ].join("\n");
}

const FALLBACK_REPLY = "I could not answer this one just now. It has been logged and someone will follow up.";

/**
 * Runs already answered survive a restart, so a slow close never gets a second
 * answer. So does an answer that was produced but not yet posted: running the
 * task again to recover it could repeat whatever the run did (mail, a record).
 */
function loadState(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return { handled: new Set(s.handledRuns ?? []), pending: new Map(Object.entries(s.pendingReplies ?? {})) };
  } catch { return { handled: new Set(), pending: new Map() }; }
}
function saveState(file, handled, pending) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    handledRuns: [...handled].slice(-500),
    pendingReplies: Object.fromEntries([...pending].slice(-50)),
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
  const { handled, pending } = loadState(stateFile);
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

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      me ??= await api("GET", "/agents/me");
      for (const item of list(await api("GET", "/agents/me/inbox-lite"), "issues")) {
        const open = pickOpenRun(await api("GET", `/issues/${item.id}/runs`), me.id, handled);
        if (!open) continue;
        const runId = runIdOf(open);
        const issue = await api("GET", `/issues/${item.id}`);
        const comments = list(await api("GET", `/issues/${item.id}/comments`), "comments")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const ctx = (await api("GET", `/heartbeat-runs/${runId}`))?.contextSnapshot ?? {};
        if (alreadyAnswered(comments, ctx.wakeCommentId, me.id, issue.createdAt)) {
          handled.add(runId);
          continue;
        }

        const tLog = log.child({ paperclipTask: issue.identifier, runId });
        let body;
        if (pending.has(runId)) {
          // Answered already; only the post failed. Retry the post, never the run.
          body = pending.get(runId);
          tLog.info("Paperclip answer not yet posted — retrying the post only");
        } else {
          tLog.info("Paperclip task waiting — running the bot");
          try {
            body = (await answer(buildTaskPrompt(issue, comments, me, url), issue)).trim();
          } catch (err) {
            tLog.error({ err: err.message }, "Paperclip task failed");
          }
          pending.set(runId, body || "");
          saveState(stateFile, handled, pending);
        }
        // Comment and close in one write. Paperclip re-wakes an agent whose run
        // ends with the task still open, and refuses in_review without a named
        // reviewer — so an answered ask is done. A reply on the task reopens it.
        await api("PATCH", `/issues/${item.id}`, { status: "done", comment: body || FALLBACK_REPLY }, runId);
        pending.delete(runId);
        handled.add(runId);
        saveState(stateFile, handled, pending);
        tLog.info({ answered: Boolean(body) }, "Paperclip task answered");
      }
    } catch (err) {
      log.warn({ err: err.message }, "Paperclip poll failed — retrying next tick");
    } finally {
      busy = false;
    }
  }

  return { tick };
}

module.exports = { pickOpenRun, alreadyAnswered, buildTaskPrompt, createPaperclipPoller, FALLBACK_REPLY };
