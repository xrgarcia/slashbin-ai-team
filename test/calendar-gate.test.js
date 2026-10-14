/**
 * The calendar gate — a bot allowed to write its owner's calendar may never invite anyone.
 *
 * A permission rule sees a tool's name, never its arguments, so allowing
 * create_event allows an event with any guest list. bot_calendar_gate.py is the
 * argument check: the bot's own events have no attendees. Every
 * refusal below is a case the permission system alone would have let through.
 */
const { readFileSync, mkdtempSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { spawnSync } = require("child_process");
const assert = require("assert");

const REPO = join(__dirname, "..");
const GATE = join(REPO, "skill-pack", "hooks", "bot_calendar_gate.py");
const LEDGER = join(REPO, "skill-pack", "hooks", "bot_calendar_ledger.py");
const GATE_VARS = ["BOT_CALENDAR_NO_ATTENDEES", "BOT_CALENDAR_OWN_EVENTS", "BOT_CALENDAR_TITLE_PREFIX", "BOT_STATE_DIR"];
const CAL = "mcp__claude_ai_Google_Calendar__";
const BOT = { BOT_CALENDAR_NO_ATTENDEES: "true" };

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

function gate(tool, toolInput, env = BOT) {
  const base = { ...process.env };
  for (const k of GATE_VARS) delete base[k];
  const raw = typeof toolInput === "string" ? toolInput : JSON.stringify({ tool_name: tool, tool_input: toolInput });
  const r = spawnSync("python3", [GATE], { input: raw, env: { ...base, ...env }, encoding: "utf8" });
  return { code: r.status, err: r.stderr };
}
const ok = (tool, input, env) => { const r = gate(CAL + tool, input, env); assert.strictEqual(r.code, 0, r.err); };
const no = (tool, input, env) => { const r = gate(CAL + tool, input, env); assert.strictEqual(r.code, 2, `allowed: ${tool} ${JSON.stringify(input)}`); };
const event = (extra) => ({
  summary: "Bot: samples due — customer asked", startTime: "2026-10-20", endTime: "2026-10-21", allDay: true,
  description: "customer, #support", ...extra,
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

console.log("\nCalendar gate — only the bot's own events, and its title prefix");

const state = mkdtempSync(join(tmpdir(), "calendar-ledger-"));
const OWN = { ...BOT, BOT_CALENDAR_OWN_EVENTS: "true", BOT_STATE_DIR: state };
function record(response, vars = OWN) {
  const base = { ...process.env };
  for (const k of GATE_VARS) delete base[k];
  const r = spawnSync("python3", [LEDGER], {
    input: JSON.stringify({ tool_name: CAL + "create_event", tool_input: event(), tool_response: response }),
    env: { ...base, ...vars }, encoding: "utf8",
  });
  return { code: r.status, err: r.stderr };
}
const ledger = () => (existsSync(join(state, "calendar-events")) ? readFileSync(join(state, "calendar-events"), "utf8") : "");

check("with no ledger yet, every update and delete is refused", () => {
  no("update_event", change(), OWN);
  no("delete_event", change(), OWN);
});
check("creating stays allowed without a ledger", () => ok("create_event", event(), OWN));
check("a created event's id is recorded, from a JSON string", () => {
  assert.strictEqual(record(JSON.stringify({ id: "e1", summary: "Bot: x" })).code, 0);
  assert.strictEqual(ledger(), "e1\n");
});
check("a created event's id is recorded, from MCP content blocks", () => {
  assert.strictEqual(record([{ type: "text", text: JSON.stringify({ id: "e2", status: "confirmed" }) }]).code, 0);
  assert.ok(ledger().split("\n").includes("e2"));
});
check("an update or delete on a recorded event is allowed", () => {
  ok("update_event", change({ startTime: "2026-10-22", endTime: "2026-10-23" }), OWN);
  ok("delete_event", change({ eventId: "e2" }), OWN);
});
check("an update or delete on an event the bot did not create is refused", () => {
  no("update_event", change({ eventId: "owners-meeting" }), OWN);
  no("delete_event", change({ eventId: "owners-meeting" }), OWN);
  no("delete_event", { notificationLevel: "NONE" }, OWN);
});
check("a response with no id is reported, not guessed, and records nothing", () => {
  const before = ledger();
  const r = record("not json");
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /not recorded/);
  assert.strictEqual(ledger(), before);
});
check("an unreadable ledger refuses every update", () => {
  const dir = mkdtempSync(join(tmpdir(), "calendar-ledger-"));
  mkdirSync(join(dir, "calendar-events"));
  no("update_event", change(), { ...OWN, BOT_STATE_DIR: dir });
});
check("no state directory refuses every update", () => {
  const vars = { ...OWN }; delete vars.BOT_STATE_DIR;
  no("update_event", change(), vars);
});
check("without BOT_CALENDAR_OWN_EVENTS, updates are not checked against the ledger, and nothing is recorded", () => {
  ok("update_event", change({ eventId: "owners-meeting" }), { ...BOT, BOT_STATE_DIR: state });
  const before = ledger();
  assert.strictEqual(record(JSON.stringify({ id: "e9" }), { ...BOT, BOT_STATE_DIR: state }).code, 0);
  assert.strictEqual(ledger(), before);
});

const PREFIXED = { ...BOT, BOT_CALENDAR_TITLE_PREFIX: "Bot:" };
check("a title with the prefix is allowed", () => ok("create_event", event(), PREFIXED));
check("a created title without the prefix is refused", () => no("create_event", event({ summary: "Team offsite" }), PREFIXED));
check("an update that renames away from the prefix is refused", () => no("update_event", change({ summary: "Team offsite" }), PREFIXED));
check("an update that leaves the title alone is allowed", () => ok("update_event", change({ description: "moved" }), PREFIXED));

check("hooks.json records created events after create_event, and nothing else", () => {
  const post = JSON.parse(readFileSync(join(REPO, "skill-pack", "hooks", "hooks.json"), "utf8")).hooks.PostToolUse;
  const entry = (post || []).find((h) => /bot_calendar_ledger\.py/.test(JSON.stringify(h)));
  assert.ok(entry, "no PostToolUse entry for the calendar ledger");
  const re = new RegExp(`^(?:${entry.matcher})$`);
  assert.ok(re.test(CAL + "create_event"));
  for (const t of ["update_event", "delete_event", "search_events"]) assert.ok(!re.test(CAL + t), `${t} matched`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
