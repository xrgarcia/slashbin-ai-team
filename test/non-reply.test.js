// A turn that answers a person with "No response requested." is a failed turn.
// Both directions matter: missing one leaves Ray unanswered; catching a real
// reply that merely mentions the phrase would swallow an answer.

const assert = require("assert");
const { isNonReply, nonReplyCorrection } = require("../lib/non-reply");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const CATCH = [
  "No response requested.", "No response requested", "no response requested",
  "  No response requested.\n", "(No response requested.)", "[no response needed]",
  "No reply needed.", "No response is required.", "Nothing to respond to.",
];

const KEEP = [
  "", "   ", null,
  "No response requested from Kenny yet — I'll chase it at 9:00 am.",
  "The PO wrote 'no response requested' on the card; I filed it anyway.",
  "Nothing to report.",
  "Done. No response needed from you.",
  "Epic filed: #687.",
];

console.log("non-reply:");
for (const t of CATCH) check(`catches ${JSON.stringify(t)}`, () => assert.strictEqual(isNonReply(t), true));
for (const t of KEEP) check(`keeps ${JSON.stringify(t)}`, () => assert.strictEqual(isNonReply(t), false));
check("correction quotes the skipped message", () => {
  const p = nonReplyCorrection("xrgarcia", "yes proceed");
  assert.ok(p.includes("yes proceed") && p.includes("xrgarcia") && p.includes("Answer that message now"));
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
