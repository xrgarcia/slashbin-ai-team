/**
 * Paperclip — a seat the board stops starting runs for is said, once per
 * stretch (slashbin-ai-team#128). The board left the EM's runs queued for two
 * days behind one it could not claim, and the agent's status read error, while
 * every poll succeeded: nothing on a card said so. The poller now checks the
 * seat itself and calls onSeatStalled when its oldest queued run passes
 * stallMinutes, or the board has it in status error.
 */
const assert = require("assert");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const ME = { id: "agent-1", name: "Bot", companyId: "co-1" };
const MIN = 60000;

/** A board with no cards: only the seat's status and its runs, both settable. */
function seat({ stallMinutes = 15, stallCheckMs = 5 * MIN, stallCard = false, escalateTo = null, stateFile = join(mkdtempSync(join(tmpdir(), "seat-")), "s.json"), failCreate = 0 } = {}) {
  const s = { status: "idle", runs: [], now: Date.parse("2026-10-27T12:00:00Z"), told: [], refuse: 0, cards: {}, created: [], writes: [], failCreate };
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === `/companies/${ME.companyId}/agents`) return { ok: true, text: async () => JSON.stringify(s.seats ?? []) };
    const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
    if (init.method && init.method !== "GET") {
      if (path === `/companies/${ME.companyId}/issues` && init.method === "POST") {
        if (s.failCreate > 0) { s.failCreate--; return { ok: false, status: 500, text: async () => "boom" }; }
        s.created.push(JSON.parse(init.body)); return ok({ id: "new-1", identifier: "ACME-99" });
      }
      s.writes.push(`${init.method} ${path}`); return ok({});
    }
    if (path === "/agents/me") return ok({ ...ME, status: s.status });
    if (path === "/agents/me/inbox-lite") return ok([]);
    if (path.startsWith(`/companies/${ME.companyId}/issues`)) return ok([]);
    if (path.startsWith(`/companies/${ME.companyId}/heartbeat-runs?agentId=${ME.id}`)) return ok(s.runs);
    const byRun = path.match(/^\/heartbeat-runs\/(.+)$/);
    if (byRun && s.runById?.[byRun[1]]) return ok(s.runById[byRun[1]]);
    const card = path.match(/^\/issues\/(.+)$/);
    if (card && s.cards[card[1]]) return ok(s.cards[card[1]]);
    return { ok: false, status: 404, text: async () => "" };
  };
  const poller = createPaperclipPoller({
    url: "https://board.test", apiKey: "k", stateFile, stallCard, escalateTo,
    answer: async () => "", log: silent, fetch, stallMinutes, stallCheckMs, clock: () => s.now,
    onSeatStalled: async (t) => {
      if (s.refuse > 0) { s.refuse--; throw new Error("discord down"); }
      s.told.push(t);
    },
  });
  const queuedFor = (minutes) => ({ id: `r${s.runs.length}`, status: "queued", createdAt: new Date(s.now - minutes * MIN).toISOString() });
  return { s, tick: () => poller.tick(), later: (minutes) => { s.now += minutes * MIN; }, queuedFor };
}

(async () => {
  await check("a run queued past stallMinutes is said once, with how many wait and for how long", async () => {
    const b = seat();
    b.s.runs = [b.queuedFor(20), b.queuedFor(3), { id: "done", status: "succeeded", createdAt: new Date(b.s.now - 60 * MIN).toISOString() }];
    await b.tick();
    assert.deepStrictEqual(b.s.told, [{ seat: "Bot", reason: "queued", status: "idle", queued: 2, oldestMinutes: 20, cards: [] }]);
    b.later(10);
    await b.tick();
    assert.strictEqual(b.s.told.length, 1, "still stalled: not said again");
  });

  await check("the stuck cards are named: queued ones waiting, running ones this bot is not working blocking, one line per card", async () => {
    const b = seat();
    b.s.cards = {
      "i-1": { id: "i-1", identifier: "ACME-1", title: "Waiting card" },
      "i-2": { id: "i-2", identifier: "ACME-2", title: "Orphan card" },
    };
    const ctx = (issueId, wakeReason) => ({ contextSnapshot: { issueId, wakeReason } });
    b.s.runs = [
      { ...b.queuedFor(25), ...ctx("i-1", "issue_assigned") },
      { ...b.queuedFor(20), ...ctx("i-1", "issue_assigned") },
      { id: "o1", status: "running", createdAt: new Date(b.s.now - 90 * MIN).toISOString(), startedAt: new Date(b.s.now - 47 * MIN).toISOString(), ...ctx("i-2", "recovery") },
      { id: "o2", status: "running", createdAt: new Date(b.s.now - 90 * MIN).toISOString(), ...ctx("i-2", "recovery") },
    ];
    await b.tick();
    assert.strictEqual(b.s.told.length, 1);
    assert.deepStrictEqual(b.s.told[0].cards, [
      { id: "i-2", identifier: "ACME-2", title: "Orphan card", link: "https://board.test/ACME/issues/ACME-2", role: "blocking", minutes: 90, wakeReason: "recovery" },
      { id: "i-1", identifier: "ACME-1", title: "Waiting card", link: "https://board.test/ACME/issues/ACME-1", role: "waiting", minutes: 25, wakeReason: "issue_assigned" },
    ]);
  });

  await check("a card whose run is read from the run (no snapshot in the list) is still named", async () => {
    const b = seat();
    b.s.cards = { "i-1": { id: "i-1", identifier: "ACME-1", title: "T" } };
    b.s.runs = [b.queuedFor(30)];
    const orig = b.s.runs[0];
    b.s.runById = { [orig.id]: { contextSnapshot: { taskId: "i-1" } } };
    await b.tick();
    assert.deepStrictEqual(b.s.told[0].cards.map((c) => [c.identifier, c.role]), [["ACME-1", "waiting"]]);
  });

  const lead = { kind: "agent", ref: "lead", name: "Lead" };
  const withSeats = (b) => { b.s.seats = [{ id: "agent-9", name: "Lead" }]; };
  const stuckBoard = (o) => {
    const b = seat({ stallCard: true, escalateTo: lead, ...o });
    withSeats(b);
    b.s.cards = { "i-1": { id: "i-1", identifier: "ACME-1", title: "Waiting card" }, "i-2": { id: "i-2", identifier: "ACME-2", title: "Orphan card" } };
    b.s.runs = [{ ...b.queuedFor(25), contextSnapshot: { issueId: "i-1" } },
      { id: "o1", status: "running", createdAt: new Date(b.s.now - 90 * MIN).toISOString(), contextSnapshot: { issueId: "i-2" } }];
    return b;
  };

  await check("a stall opens one card for the escalation target with the diagnosis and the card list, and writes to no stuck card", async () => {
    const b = stuckBoard();
    await b.tick();
    assert.strictEqual(b.s.created.length, 1);
    const c = b.s.created[0];
    assert.strictEqual(c.assigneeAgentId, "agent-9");
    assert.strictEqual(c.title, "Bot is stalled: 2 cards stuck");
    assert.match(c.description, /1 run of Bot has been queued, the oldest for 25 minutes/);
    assert.match(c.description, /blocking, 90 min: ACME-2 Orphan card https:\/\/board.test\/ACME\/issues\/ACME-2/);
    assert.match(c.description, /waiting, 25 min: ACME-1 Waiting card/);
    assert.match(c.description, /Only a board operator can cancel a blocking run/);
    assert.deepStrictEqual(b.s.writes, [], "no write to any card or run");
    assert.strictEqual(b.s.told.length, 1, "Discord still told");
    b.later(10); await b.tick();
    assert.strictEqual(b.s.created.length, 1, "once per stretch");
  });

  await check("a restart mid-stretch makes no second card; a new stretch makes a new one", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "seat-")), "s.json");
    const a = stuckBoard({ stateFile }); withSeats(a);
    await a.tick();
    const b = stuckBoard({ stateFile }); withSeats(b);
    await b.tick();
    assert.strictEqual(a.s.created.length + b.s.created.length, 1);
    b.s.runs = []; b.later(6); await b.tick();   // healthy
    b.s.runs = [b.queuedFor(30)]; b.later(6); await b.tick();
    assert.strictEqual(b.s.created.length, 1, "the next stretch opens its own");
  });

  await check("a failed create is retried at the next check and Discord still goes out", async () => {
    const b = stuckBoard({ failCreate: 1 }); withSeats(b);
    await b.tick();
    assert.strictEqual(b.s.created.length, 0);
    assert.strictEqual(b.s.told.length, 1);
    b.later(6); await b.tick();
    assert.strictEqual(b.s.created.length, 1);
    assert.strictEqual(b.s.told.length, 1, "Discord not repeated");
  });

  await check("a person as target gets the card by assigneeUserId; with no target only Discord is used", async () => {
    const u = stuckBoard({ escalateTo: { kind: "user", ref: "u-1", name: "Someone" } });
    await u.tick();
    assert.strictEqual(u.s.created[0].assigneeUserId, "u-1");
    assert.strictEqual(u.s.created[0].assigneeAgentId, undefined);
    const n = stuckBoard({ escalateTo: null });
    await n.tick();
    assert.deepStrictEqual(n.s.created, []);
    assert.strictEqual(n.s.told.length, 1);
  });

  await check("the card is off unless asked for", async () => {
    const b = stuckBoard({ stallCard: false }); withSeats(b);
    await b.tick();
    assert.deepStrictEqual(b.s.created, []);
  });

  await check("a run queued under stallMinutes is not said", async () => {
    const b = seat();
    b.s.runs = [b.queuedFor(14)];
    await b.tick();
    assert.deepStrictEqual(b.s.told, []);
  });

  await check("a seat in status error is said at once, queued runs or not", async () => {
    const b = seat();
    b.s.status = "error";
    await b.tick();
    assert.deepStrictEqual(b.s.told, [{ seat: "Bot", reason: "error", status: "error", queued: 0, oldestMinutes: 0, cards: [] }]);
  });

  await check("a seat healthy again and then stalled again is said again", async () => {
    const b = seat();
    b.s.runs = [b.queuedFor(30)];
    await b.tick();
    b.s.runs = [];
    b.later(6);
    await b.tick();
    b.s.runs = [b.queuedFor(16)];
    b.later(6);
    await b.tick();
    assert.strictEqual(b.s.told.length, 2);
  });

  await check("the seat is checked once per stallCheckMs, not every poll", async () => {
    const b = seat();
    await b.tick();
    b.s.runs = [b.queuedFor(40)];
    b.later(1);
    await b.tick();
    assert.deepStrictEqual(b.s.told, [], "inside the interval: not checked");
    b.later(5);
    await b.tick();
    assert.strictEqual(b.s.told.length, 1);
  });

  await check("a tell that fails is tried again at the next check", async () => {
    const b = seat();
    b.s.refuse = 1;
    b.s.runs = [b.queuedFor(20)];
    await b.tick();
    assert.deepStrictEqual(b.s.told, []);
    b.later(6);
    await b.tick();
    assert.strictEqual(b.s.told.length, 1);
  });

  await check("a stretch whose reason changes, error then queued, is said once", async () => {
    const b = seat();
    b.s.status = "error";
    b.s.runs = [b.queuedFor(30)];
    await b.tick();
    b.s.status = "idle";
    b.later(6);
    await b.tick();
    assert.deepStrictEqual(b.s.told.map((t) => t.reason), ["error"]);
  });

  await check("stallMinutes 0 never checks", async () => {
    const b = seat({ stallMinutes: 0 });
    b.s.status = "error";
    await b.tick();
    assert.deepStrictEqual(b.s.told, []);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
