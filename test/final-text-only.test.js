/**
 * REPLY_FINAL_TEXT_ONLY — only the text after the run's last tool call is posted.
 *
 * the issue: Bot's first answer in #acme-po, a channel acme.com reads, opened
 * with "Grep the file for titles/horizon/state." — a note he wrote to himself
 * before a tool call, joined onto the answer because every text block of the run
 * accumulated into one reply. Off by default: every other bot must reply exactly
 * as it did before the flag existed.
 *
 * Runs the real handleStreamEvent from bot.js source — the file cannot be
 * require()d, importing it logs a live bot into Discord.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const SRC = readFileSync(join(__dirname, "..", "bot.js"), "utf8");

function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in bot.js`);
  let i = SRC.indexOf("{", SRC.indexOf(")", start));
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

const handlerSrc = extractFn("handleStreamEvent");
const silentLog = { info() {}, debug() {}, warn() {}, error() {} };

function run(flag, events) {
  const handle = new Function(
    "REPLY_FINAL_TEXT_ONLY", "ATTACH_RE",
    `${handlerSrc}; return handleStreamEvent;`
  )(flag, /\.(csv|pdf)$/i);
  let turnText = "";
  const state = {
    getTurnText: () => turnText,
    setTurnText: (t) => { turnText = t; },
    writtenFiles: [],
    toolCalls: 0,
    progress: null,
  };
  for (const e of events) handle(e, silentLog, () => {}, state);
  return { turnText, toolCalls: state.toolCalls };
}

const text = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const tool = (name) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });

// The shape that leaked on 2026-10-08: a working note, a tool call, the answer.
const leaked = [
  text("Grep the file for titles/horizon/state."),
  tool("Grep"),
  text("Owner, there are 11 acme.com items in flight."),
];

// 1. Flag on: only the text after the last tool call survives.
{
  const r = run(true, leaked);
  assert.strictEqual(r.turnText, "Owner, there are 11 acme.com items in flight.");
  assert.ok(!r.turnText.includes("Grep the file"), "pre-tool-call text must not be posted");
  assert.strictEqual(r.toolCalls, 1);
}

// 2. Flag on, several tool calls with notes between: only the tail survives,
//    including a text block and tool call in the SAME message.
{
  const r = run(true, [
    text("Let me check."),
    tool("Read"),
    { type: "assistant", message: { content: [
      { type: "text", text: "Now the roadmap." },
      { type: "tool_use", name: "Grep", input: {} },
    ] } },
    text("Answer part one. "),
    text("Answer part two."),
  ]);
  assert.strictEqual(r.turnText, "Answer part one. Answer part two.");
  assert.strictEqual(r.toolCalls, 2);
}

// 3. Flag on, no tool calls: the whole reply is posted, unchanged.
{
  const r = run(true, [text("Plain answer.")]);
  assert.strictEqual(r.turnText, "Plain answer.");
}

// 4. Flag off (every bot that does not opt in): behaviour is exactly as before —
//    all text across tool calls is joined into the reply.
{
  const r = run(false, leaked);
  assert.strictEqual(
    r.turnText,
    "Grep the file for titles/horizon/state.Owner, there are 11 acme.com items in flight."
  );
}

// 5. The flag reads "true" only — an unset or other value leaves it off.
assert.ok(
  /const REPLY_FINAL_TEXT_ONLY = process\.env\.REPLY_FINAL_TEXT_ONLY === "true";/.test(SRC),
  "REPLY_FINAL_TEXT_ONLY must default off"
);

console.log("final-text-only: 5 checks passed");
