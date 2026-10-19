/**
 * The shared hand-off action, `process.escalate` (slashbin_mcp_services, MCP
 * #308), as the Paperclip bridge calls it (SLA-1493). The action owns the
 * chain, cycles and replays, and records every hop on the card as a
 * `<!-- process.escalate:… -->` comment; the bridge only says which operation.
 *
 * It acts as the seat: the seat's own Paperclip key and the open run ride in
 * request headers, never in the model's environment or a tool argument.
 */

const MARKER_PREFIX = "<!-- process.escalate:";
const MARKER_SUFFIX = " -->";

/** The record one marker comment carries, or null (only the comment's first line is read). */
function decodeRecord(body) {
  const line = String(body ?? "").split("\n", 1)[0].replace(/\r$/, "");
  if (!line.startsWith(MARKER_PREFIX) || !line.endsWith(MARKER_SUFFIX)) return null;
  const payload = line.slice(MARKER_PREFIX.length, line.length - MARKER_SUFFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const record = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const hopsOk = Array.isArray(record?.hops) && record.hops.every((h) => typeof h?.from === "string" && typeof h.to === "string" && typeof h.operation === "string");
    return typeof record?.card === "string" && hopsOk ? record : null;
  } catch {
    return null;
  }
}

/**
 * The card's latest record, read as the action reads it: of the markers an
 * agent wrote that name this card, the one with the most hops. A person's
 * comment never counts, so a pasted marker moves nothing.
 */
function latestRecord(comments, cardId) {
  let latest = null;
  for (const c of comments ?? []) {
    if (!c?.authorAgentId) continue;
    const record = decodeRecord(c.body);
    if (record && record.card === cardId && (!latest || record.hops.length > latest.hops.length)) latest = record;
  }
  return latest;
}

/** The hand-ups still open: each `hand_up` opens one, each step back down closes the latest. */
function openHandUps(hops) {
  const open = [];
  for (const h of hops ?? []) {
    if (h.operation === "hand_up") open.push(h);
    else if (["resolve", "return", "record_answer"].includes(h.operation)) open.pop();
  }
  return open;
}

/** Whether a comment is a hop record rather than something said. */
const isMarker = (body) => String(body ?? "").startsWith(MARKER_PREFIX);

/**
 * A client for the `escalate` tool of the process MCP at `url`. Resolves to
 * the tool's own result: `{ ok: true, operation, issue, holder, replayed, hops }`
 * or `{ ok: false, code, message }`. A transport failure resolves to
 * `{ ok: false, code: "escalate_unreachable", message }`, never throws: a
 * refused hand-off is reported on the card, not retried by a crash.
 */
function processEscalateClient({ url, bearer, agentKey, fetch: fetchImpl = fetch, timeoutMs = 30000 }) {
  let id = 0;
  async function rpc(session, body) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`, ...(session.id ? { "mcp-session-id": session.id } : {}), ...session.extra };
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    session.id ??= res.headers?.get?.("mcp-session-id") ?? null;
    if (!res.ok && res.status !== 202) throw new Error(`${body.method} -> HTTP ${res.status}`);
    if (body.id === undefined) return null;
    const text = await res.text();
    // The server answers in JSON or as an event stream; the reply is the message with our id.
    const messages = /^\s*\{/.test(text) ? [JSON.parse(text)]
      : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    const reply = messages.find((m) => m?.id === body.id);
    if (!reply) throw new Error(`${body.method} -> no reply`);
    if (reply.error) throw new Error(`${body.method} -> ${reply.error.message ?? JSON.stringify(reply.error)}`);
    return reply.result;
  }
  return async function escalate(args, { runId } = {}) {
    const session = { id: null, extra: { "x-paperclip-agent-key": agentKey, ...(runId ? { "x-paperclip-run-id": runId } : {}) } };
    try {
      await rpc(session, { jsonrpc: "2.0", id: ++id, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "slashbin-ai-team-paperclip", version: "1" } } });
      await rpc(session, { jsonrpc: "2.0", method: "notifications/initialized" });
      const result = await rpc(session, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "escalate", arguments: args } });
      const text = result?.content?.find((c) => c.type === "text")?.text;
      const out = text ? JSON.parse(text) : null;
      if (!out || typeof out.ok !== "boolean") return { ok: false, code: "escalate_unreadable", message: `escalate answered without a result${result?.isError ? " (tool error)" : ""}` };
      return out;
    } catch (err) {
      return { ok: false, code: "escalate_unreachable", message: err.message };
    }
  };
}

/**
 * The client for the one board the action serves, else null. The action is
 * one company's, so it serves one board: the board whose origin is
 * PAPERCLIP_ESCALATE_BOARD, or the first board when that is unset. A bot whose
 * first board belongs to another company names the served board by origin;
 * picking it by position gave that bot no client at all. The client acts with
 * the served board's own key. Unset URL or bearer: no board gets one, and
 * hand-offs stay direct writes.
 */
function escalateClientFor(board, { boards, env = process.env, client = processEscalateClient } = {}) {
  const url = env.PAPERCLIP_ESCALATE_URL;
  const bearer = env.PAPERCLIP_ESCALATE_BEARER_ENV ? env[env.PAPERCLIP_ESCALATE_BEARER_ENV] : undefined;
  if (!url || !bearer) return null;
  return escalateBoard(boards, env) === board ? client({ url, bearer, agentKey: board.apiKey }) : null;
}

/** The board the action serves: the one at PAPERCLIP_ESCALATE_BOARD, else the first. Null when the named origin matches none. */
function escalateBoard(boards, env = process.env) {
  const origin = (u) => String(u ?? "").replace(/\/+$/, "").toLowerCase();
  const named = env.PAPERCLIP_ESCALATE_BOARD;
  if (!named) return boards?.[0] ?? null;
  return (boards ?? []).find((b) => origin(b.url) === origin(named)) ?? null;
}

module.exports = { MARKER_PREFIX, decodeRecord, latestRecord, openHandUps, isMarker, processEscalateClient, escalateClientFor, escalateBoard };
