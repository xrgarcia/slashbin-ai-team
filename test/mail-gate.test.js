/**
 * The mail gate — a bot allowed send_message may mail only its listed addresses.
 *
 * A permission rule sees a tool's name, never its arguments, so allowing
 * send_message allows mail to anyone. bot_mail_gate.py is the argument check
 * (a bot that emails its owner, and only its owner). Every refusal below is a case the
 * permission system alone would have let through.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");
const assert = require("assert");

const REPO = join(__dirname, "..");
const GATE = join(REPO, "skill-pack", "hooks", "bot_mail_gate.py");
const TOOL = "mcp__claude_ai_Gmail__send_message";
const BOT = { BOT_MAIL_ALLOWED_RECIPIENTS: "owner@example.com,bot@example.com", BOT_MAIL_SUBJECT_PREFIX: "Bot:" };

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

function gate(toolInput, env = BOT, toolName = TOOL) {
  const base = { ...process.env };
  delete base.BOT_MAIL_ALLOWED_RECIPIENTS;
  delete base.BOT_MAIL_SUBJECT_PREFIX;
  const raw = typeof toolInput === "string" ? toolInput : JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const r = spawnSync("python3", [GATE], { input: raw, env: { ...base, ...env }, encoding: "utf8" });
  return { code: r.status, err: r.stderr };
}
const ok = (input, env) => { const r = gate(input, env); assert.strictEqual(r.code, 0, r.err); };
const no = (input, env) => { const r = gate(input, env); assert.strictEqual(r.code, 2, `allowed: ${JSON.stringify(input)}`); };
const send = (extra) => ({ to: ["owner@example.com"], subject: "Bot: a question", body: "b", ...extra });

console.log("\nMail gate");

check("to the owner, cc the bot, subject 'Bot:' is allowed", () => ok(send({ cc: ["bot@example.com"] })));
check("addresses compare case-insensitively", () => ok(send({ to: ["Owner@Example.COM"] })));
check("an attachment to the owner is allowed", () => ok(send({ attachments: [{ content: "aGk=" }] })));
check("an outside address in to is refused", () => no(send({ to: ["owner@example.com", "someone@example.invalid"] })));
check("an outside address in cc is refused", () => no(send({ cc: ["someone@example.invalid"] })));
check("an outside address in bcc is refused", () => no(send({ bcc: ["someone@example.invalid"] })));
check("a lookalike domain is refused", () => no(send({ to: ["owner@example.com.example.invalid"] })));
check("a second address hidden in one string is refused", () => no(send({ to: ["owner@example.com, someone@example.invalid"] })));
check("a display-name address is judged by its address", () => {
  ok(send({ to: ["Owner <owner@example.com>"] }));
  no(send({ to: ["owner@example.com <someone@example.invalid>"] }));
});
check("no recipient is refused", () => no({ subject: "Bot: x", body: "b" }));
check("a recipient that is not a string is refused", () => no(send({ to: [{ email: "someone@example.invalid" }] })));
check("sending a stored draft is refused", () => no(send({ draftId: "r123" })));
check("a reply by thread or message id is refused", () => {
  no(send({ replyThreadId: "t1" }));
  no(send({ replyToMessageId: "m1" }));
});
check("an argument the gate does not know is refused", () => no(send({ recipients: ["someone@example.invalid"] })));
check("a subject without the prefix is refused", () => no(send({ subject: "a question" })));
check("unreadable input is refused when the list is set", () => {
  assert.strictEqual(gate("not json").code, 2);
});
check("a bot without BOT_MAIL_ALLOWED_RECIPIENTS is untouched", () => {
  ok(send({ to: ["someone@example.invalid"] }), {});
  assert.strictEqual(gate("not json", {}).code, 0);
});
check("other tools pass through", () => {
  assert.strictEqual(gate({ command: "ls" }, BOT, "Bash").code, 0);
});
check("hooks.json routes send_message to the gate", () => {
  const hooks = JSON.parse(readFileSync(join(REPO, "skill-pack", "hooks", "hooks.json"), "utf8")).hooks.PreToolUse;
  const entry = hooks.find((h) => h.matcher === TOOL);
  assert.ok(entry && /bot_mail_gate\.py/.test(JSON.stringify(entry)), "no PreToolUse entry for send_message");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
