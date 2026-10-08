/**
 * The calendar gate — a bot allowed to write Owner's calendar may never invite anyone.
 *
 * A permission rule sees a tool's name, never its arguments, so allowing
 * create_event allows an event with any guest list. bot_calendar_gate.py is the
 * argument check (the issue: Bot's "Bot:" events have no attendees). Every
 * refusal below is a case the permission system alone would have let through.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");
const assert = require("assert");

const REPO = join(__dirname, "..");
const GATE = join(REPO, "skill-pack", "hooks", "bot_calendar_gate.py");
const CAL = "mcp__claude_ai_Google_Calendar__";
const BOT = { BOT_CALENDAR_NO_ATTENDEES: "true" };

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

function gate(tool, toolInput, env = BOT) {
  const base = { ...process.env };
  delete base.BOT_CALENDAR_NO_ATTENDEES;
  const raw = typeof toolInput === "string" ? toolInput : JSON.stringify({ tool_name: tool, tool_input: toolInput });
  const r = spawnSync("python3", [GATE], { input: raw, env: { ...base, ...env }, encoding: "utf8" });
  return { code: r.status, err: r.stderr };
}
const ok = (tool, input, env) => { const r = gate(CAL + tool, input, env); assert.strictEqual(r.code, 0, r.err); };
const no = (tool, input, env) => { const r = gate(CAL + tool, input, env); assert.strictEqual(r.code, 2, `allowed: ${tool} ${JSON.stringify(input)}`); };
const event = (extra) => ({
  summary: "Bot: samples due — the customer asked", startTime: "2026-10-20", endTime: "2026-10-21", allDay: true,
  description: "the customer, #acme-po", ...extra,
});
const change = (extra) => ({ eventId: "e1", notificationLevel: "NONE", ...extra });

console.log("\nCalendar gate");

check("an all-day event with no attendees is allowed", () => ok("create_event", event()));
check("an empty attendee list is allowed", () => ok("create_event", event({ attendees: [] })));
check("calendarId 'primary' is allowed", () => ok("create_event", event({ calendarId: "primary" })));
check("an attendee on create is refused", () => no("create_event", event({ attendees: [{ email: "someone@example.invalid" }] })));
check("the deprecated attendeeEmails on create is refused", () => no("create_event", event({ attendeeEmails: ["someone@example.invalid"] })));
check("another calendar is refused", () => no("create_event", event({ calendarId: "someone@example.invalid" })));
check("an argument the gate does not know is refused", () => no("create_event", event({ guests: ["someone@example.invalid"] })));

check("moving a date with notificationLevel NONE is allowed", () =>
  ok("update_event", change({ startTime: "2026-10-22", endTime: "2026-10-23", description: "moved by the customer" })));
check("an added attendee on update is refused", () => no("update_event", change({ addedAttendees: [{ email: "someone@example.invalid" }] })));
check("the deprecated addedAttendeeEmails on update is refused", () => no("update_event", change({ addedAttendeeEmails: ["someone@example.invalid"] })));
check("an update without notificationLevel is refused", () => no("update_event", { eventId: "e1", summary: "Bot: x" }));
check("an update that notifies is refused", () => no("update_event", change({ notificationLevel: "ALL" })));
check("an update on another calendar is refused", () => no("update_event", change({ calendarId: "team@example.invalid" })));

check("deleting with notificationLevel NONE is allowed", () => ok("delete_event", change()));
check("a delete without notificationLevel is refused", () => no("delete_event", { eventId: "e1" }));
check("a delete that notifies is refused", () => no("delete_event", change({ notificationLevel: "EXTERNAL_ONLY" })));

check("unreadable input is refused when the gate is on", () => {
  assert.strictEqual(gate(CAL + "create_event", "not json").code, 2);
});
check("a bot without BOT_CALENDAR_NO_ATTENDEES is untouched", () => {
  ok("create_event", event({ attendees: [{ email: "someone@example.invalid" }] }), {});
  assert.strictEqual(gate(CAL + "create_event", "not json", {}).code, 0);
});
check("reads and other tools pass through", () => {
  ok("search_events", { query: "Bot:" });
  assert.strictEqual(gate("Bash", { command: "ls" }).code, 0);
});
check("hooks.json routes the three writes to the gate, and nothing else", () => {
  const hooks = JSON.parse(readFileSync(join(REPO, "skill-pack", "hooks", "hooks.json"), "utf8")).hooks.PreToolUse;
  const entry = hooks.find((h) => /bot_calendar_gate\.py/.test(JSON.stringify(h)));
  assert.ok(entry, "no PreToolUse entry for the calendar gate");
  const re = new RegExp(`^(?:${entry.matcher})$`);
  for (const t of ["create_event", "update_event", "delete_event"]) assert.ok(re.test(CAL + t), `${t} not matched`);
  for (const t of ["search_events", "respond_to_event"]) assert.ok(!re.test(CAL + t), `${t} matched`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
