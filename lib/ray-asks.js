/**
 * Asks to a person, answered by a bare "yes" on Discord.
 *
 * A seat that concludes a decision is only the board operator's makes it with
 * the shared `request_ray_action` operation: one to-do card for that person,
 * linked to the seat's own card, which stays blocked on it. Nothing in that
 * path tells the person — the escalation policy reports no notification — so an
 * ask sat unseen for days (a card waiting "for a yes", 2026-10-21). And when a
 * person did say "yes" in a channel, the harness passed a fresh session only
 * the replied-to message's attachments, never its words, and the session asked
 * "What are you saying yes to?".
 *
 * This module is the two halves that close that gap:
 *
 *   1. announce — one Discord message per ask, in plain business terms, and a
 *      binding (message id -> card, the Ray card, what a yes does) kept in the
 *      bot's state folder. Keyed by board and Ray card, so a re-wake, a poll
 *      that sees the same ask again, or a restart posts nothing twice.
 *   2. resolve — a human message that is a reply to a bound ask, or a bare
 *      yes/no while exactly one ask is open in the channel, is the answer. It
 *      is never guessed: a bare yes with several open asks asks which.
 *
 * Pure decisions and the file store live here; Discord and the board are
 * injected, so nothing in this file logs a bot in or writes to a board.
 */

const { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } = require("fs");
const { dirname } = require("path");

// What a bare reply means. "stop" is NOT a negative: it is already a kill
// command the harness answers before anything here sees the message.
const YES = ["yes", "y", "yep", "proceed", "go", "go ahead", "approved", "do it", "ship it"];
const NO = ["no", "n", "hold", "don't", "dont", "do not"];

/**
 * "yes" | "no" | null. Case-insensitive, trailing punctuation allowed, any
 * leading bot mentions ignored. The whole message must be the word: "yes, but
 * only the first" is a conversation, not an answer, and goes to the model.
 */
function classifyReply(text) {
  const t = String(text ?? "")
    .replace(/^(?:<@!?\d+>\s*)+/, "")
    .replace(/[’‘]/g, "'")
    .trim().toLowerCase()
    .replace(/[\s.!?,;:]+$/, "")
    .replace(/\s+/g, " ");
  if (YES.includes(t)) return "yes";
  if (NO.includes(t)) return "no";
  return null;
}

/**
 * First line of the comment the harness writes on the seat's card when it
 * relays an answer. The seat's own comments are not asks (askOf), so without
 * this mark the relayed answer would leave the card's ask unchanged and the
 * woken seat would be told it already answered. askOf and the prompt both
 * recognise it.
 */
const RELAYED_MARK = "<!-- ray.answer:discord -->";
const isRelayedAnswer = (body) => String(body ?? "").startsWith(RELAYED_MARK);

/** The text under a `**Label**` heading in a Ray card's description (quoted lines, `> ` stripped). */
function sectionOf(description, label) {
  const lines = String(description ?? "").split("\n");
  const at = lines.findIndex((l) => l.trim() === `**${label}**`);
  if (at < 0) return "";
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith(">")) { if (out.length) break; if (l.trim()) break; continue; }
    out.push(l.replace(/^>\s?/, ""));
  }
  return out.join("\n").trim();
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the ask is and what a yes will do, in business terms. The recommendation
 * is what the seat proposes, so it is what a yes approves; with none written, a
 * yes only releases the card to carry on as the seat recommended in its notes.
 */
function describeAsk({ decision, recommendation, evidence }) {
  return {
    decision: decision || "A decision is waiting on you.",
    yesAction: recommendation || "the card goes back to the team to carry on with what it proposed",
    evidence: evidence || "",
  };
}

/** The one Discord message an ask is announced with. No internal names beyond the card's own link. */
function askMessage(b) {
  return [
    `Decision needed from you: ${clip(b.decision, 700)}`,
    "",
    `If you say yes: ${clip(b.yesAction, 500)}`,
    "If you say no: the team is told not to go ahead and works out what to do instead.",
    "",
    "Reply to this message with yes or no.",
    ...(b.link ? [b.link] : []),
  ].join("\n");
}

/** The binding store: a small JSON file, written whole or not at all. */
function createRayAsks({ file, clock = () => new Date().toISOString() }) {
  let asks = {};
  try { asks = JSON.parse(readFileSync(file, "utf8")).asks ?? {}; } catch (err) {
    // Only a missing file is a fresh start: one that cannot be read, read as
    // empty, would announce every ask again.
    if (err.code !== "ENOENT") throw err;
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w");
    try { writeSync(fd, JSON.stringify({ asks }, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  };
  const keyOf = (board, rayCardId) => `${board ?? "default"}:${rayCardId}`;
  return {
    keyOf,
    get: (key) => asks[key] ?? null,
    all: () => Object.values(asks),
    byMessage: (channelId, messageId) => Object.values(asks).find((a) => a.channelId === channelId && a.discordMessageId === messageId) ?? null,
    /** Asks posted to a channel and still waiting, oldest first. */
    open: (channelId) => Object.values(asks).filter((a) => a.state === "open" && a.discordMessageId && a.channelId === channelId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    put(binding) { asks[binding.key] = binding; save(); return binding; },
    create(fields) { return this.put({ state: "open", discordMessageId: null, createdAt: clock(), steps: {}, ...fields }); },
  };
}

/**
 * Announce an ask once. Idempotent: an ask already posted is returned as it is.
 * The binding is written BEFORE the post (without a message id), so a restart
 * between the two retries the post: at-least-once. The other order could lose
 * an ask for good, which is the failure this exists to end.
 *
 * @param {{ registry: ReturnType<typeof createRayAsks>, ask: object, board?: string|null, channelId: string,
 *   send: (text: string) => Promise<{ id: string }|null> }} o
 * @returns {Promise<{ binding: object, posted: boolean }>}
 */
async function announceAsk({ registry, ask, board = null, channelId, send, answerers = [] }) {
  const key = registry.keyOf(board, ask.rayCardId);
  let binding = registry.get(key);
  if (binding?.discordMessageId) return { binding, posted: false };
  const { decision, yesAction } = describeAsk(ask);
  binding ??= registry.create({
    key, board, channelId, cardIdentifier: ask.cardIdentifier, issueId: ask.issueId, runId: ask.runId ?? null,
    rayCardId: ask.rayCardId, rayCardIdentifier: ask.rayCardIdentifier ?? null, marker: ask.marker ?? null,
    decision, yesAction, link: ask.link ?? null, answerers: [...answerers],
  });
  const sent = await send(askMessage(binding));
  if (!sent?.id) return { binding, posted: false };
  binding.discordMessageId = sent.id;
  registry.put(binding);
  return { binding, posted: true };
}

/**
 * The prompt block for a reply to a message: what it said, and, when it was a
 * bound ask, which card it concerns and what a yes does. Without it a fresh
 * session is handed "yes" and nothing else.
 */
function replyContext({ author, content, binding = null }) {
  const said = String(content ?? "").trim();
  const lines = [`[This message is a reply to ${author ? `${author}'s` : "an earlier"} message${said ? `: "${clip(said, 2000)}"` : " (no text)"}]`];
  if (binding) {
    lines.push(`[That message is an open ask for a decision on ${binding.cardIdentifier}: ${clip(binding.decision, 700)} A yes would: ${clip(binding.yesAction, 500)}.]`);
  }
  return lines.join("\n");
}

/**
 * Whether this Discord user is the person the ask was put to. The ids are
 * fixed on the binding when the ask is announced (the board's escalation
 * mention); a binding with none can be answered by no one, never by everyone.
 */
function mayAnswer(binding, userId) {
  return Boolean(userId) && Array.isArray(binding?.answerers) && binding.answerers.includes(String(userId));
}

/** Discord user ids named in a mention string such as `<@1234> <@!5678>`. */
const idsIn = (mention) => [...String(mention ?? "").matchAll(/<@!?(\d{15,25})>/g)].map((m) => m[1]);

/**
 * Decide what a human message in a channel means for the asks bound there.
 *
 *   { kind: "none" }                                  not about an ask: carry on as before
 *   { kind: "context", binding }                      a reply to an open ask that is not a yes/no: the model, with the ask in its prompt
 *   { kind: "resolve", binding, verdict }             an answer
 *   { kind: "which", open }                           a bare yes/no with several asks open: ask which, never guess
 *   { kind: "closed", binding }                       a reply to an ask already answered
 */
function routeReply({ registry, channelId, text, referenceId = null, userId = null }) {
  const verdict = classifyReply(text);
  const bound = referenceId ? registry.byMessage(channelId, referenceId) : null;
  if (bound) {
    // Only the person asked may answer: anyone else's reply is an ordinary message.
    if (!mayAnswer(bound, userId)) return { kind: "none" };
    if (bound.state !== "open") return verdict ? { kind: "closed", binding: bound } : { kind: "context", binding: bound };
    return verdict ? { kind: "resolve", binding: bound, verdict } : { kind: "context", binding: bound };
  }
  // A reply to some other message is that message's business, not an ask's.
  if (!verdict || referenceId) return { kind: "none" };
  const open = registry.open(channelId).filter((b) => mayAnswer(b, userId));
  if (open.length === 1) return { kind: "resolve", binding: open[0], verdict };
  if (open.length > 1) return { kind: "which", open };
  return { kind: "none" };
}

/** The question a bare yes with several open asks gets back. */
function whichMessage(open) {
  return [
    `${open.length} decisions are waiting on you, so I can't tell which one that answers:`,
    ...open.map((b, i) => `${i + 1}. ${clip(b.decision, 160)}`),
    "Reply (Discord's reply button) to the one you mean with yes or no.",
  ].join("\n");
}

/**
 * Resolve a bound ask with a yes/no: relay it to the board, mark the binding
 * answered, and say what happened. Never throws. A relay that fails leaves the
 * binding open (what already landed is kept in its steps), so saying yes again
 * retries without repeating anything.
 *
 * @param {{ registry: ReturnType<typeof createRayAsks>, binding: object, verdict: "yes"|"no", text: string,
 *   relays: Record<string, Function>, link?: string|null, clock?: () => string }} o
 * @returns {Promise<{ ok: boolean, reply: string }>}
 */
async function answerAsk({ registry, binding, verdict, text, relays, link = null, by = null, clock = () => new Date().toISOString() }) {
  if (!mayAnswer(binding, by?.id)) return { ok: false, reply: "That decision was put to someone else, so nothing was recorded." };
  const relay = relays[binding.board ?? "default"];
  if (!relay) return { ok: false, reply: "I can't reach the board this decision belongs to right now, so nothing was recorded. Say it again once it is back." };
  try {
    const { woke } = await relay(binding, verdict, { text, link, by, save: () => registry.put(binding) });
    binding.state = "answered";
    binding.answer = { verdict, text: String(text).slice(0, 500), by: by ? { id: String(by.id), tag: by.tag ?? null } : null, at: clock() };
    registry.put(binding);
    const what = verdict === "yes" ? `Recorded: yes. ${clip(binding.yesAction, 300)}` : "Recorded: no. The team has been told not to go ahead.";
    return { ok: true, reply: woke ? what : `${what}\nThe answer is on the card, but I could not wake it: the team may need a nudge.` };
  } catch {
    registry.put(binding);
    return { ok: false, reply: "I couldn't record that on the card, so nothing has changed. Your answer is not lost: say it again to retry." };
  }
}

module.exports = { answerAsk, classifyReply, RELAYED_MARK, isRelayedAnswer, sectionOf, describeAsk, askMessage, createRayAsks, announceAsk,
  replyContext, routeReply, mayAnswer, idsIn, whichMessage, YES, NO };
