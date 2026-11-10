/**
 * The stall alert reaches Discord whole: every message is at most 2000
 * characters (Discord refuses more), every card's link is in one of them, the
 * mention leads only the first, and a line too long on its own loses title
 * characters, never its link.
 */
const assert = require("assert");
const { stallMessages } = require("../lib/stall-message");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const cardsOf = (waiting, blocking, titleLen) => [
  ...Array.from({ length: blocking }, (_, i) => ({ id: `b${i}`, identifier: `ACME-${100 + i}`, title: "B".repeat(titleLen), link: `https://board.test/ACME/issues/ACME-${100 + i}`, role: "blocking", minutes: 2500 })),
  ...Array.from({ length: waiting }, (_, i) => ({ id: `w${i}`, identifier: `ACME-${i + 1}`, title: "W".repeat(titleLen), link: `https://board.test/ACME/issues/ACME-${i + 1}`, role: "waiting", minutes: 25 })),
];
const build = (cards) => stallMessages({ mention: "<@1>", cards, footer: "https://board.test",
  head: "Paperclip is not starting Bot's runs: 14 runs queued, the oldest for 25 minutes. Hand-offs to Bot wait until it does." });
function holds(msgs, cards) {
  for (const m of msgs) assert.ok(m.length <= 2000, `a message is ${m.length} characters`);
  const all = msgs.join("\n");
  for (const c of cards) assert.ok(all.includes(c.link), `${c.link} missing`);
  assert.ok(msgs[0].startsWith("<@1> Paperclip is not starting"));
  assert.strictEqual(msgs.filter((m) => m.includes("<@1>")).length, 1, "the mention leads only the first");
  assert.ok(all.includes("Hand-offs to Bot wait"), "the diagnosis is there");
}

check("14 waiting + 1 blocking with 84-character titles: every message within 2000, all 15 links", () => {
  const cards = cardsOf(14, 1, 84), msgs = build(cards);
  assert.ok(msgs.length > 1);
  holds(msgs, cards);
  assert.ok(msgs.join("\n").includes("W".repeat(84)), "titles that fit are kept whole");
});
check("13 waiting + 2 blocking with 42-character titles: every message within 2000, all 15 links", () => {
  const cards = cardsOf(13, 2, 42), msgs = build(cards);
  holds(msgs, cards);
});
check("a card line is never split across messages", () => {
  const cards = cardsOf(14, 1, 84);
  for (const m of build(cards)) for (const l of m.split("\n").filter((x) => x.startsWith("- "))) assert.match(l, /https:\/\/board\.test\/ACME\/issues\/ACME-\d+$/);
});
check("a line too long on its own is trimmed in the title, never the link", () => {
  const cards = cardsOf(1, 0, 3000), msgs = build(cards);
  holds(msgs, cards);
  assert.ok(msgs.join("\n").includes("…"));
});
check("a few cards are one message", () => {
  assert.strictEqual(build(cardsOf(2, 1, 20)).length, 1);
});
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
