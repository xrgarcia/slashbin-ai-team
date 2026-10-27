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
function seat({ stallMinutes = 15, stallCheckMs = 5 * MIN } = {}) {
  const s = { status: "idle", runs: [], now: Date.parse("2026-10-27T12:00:00Z"), told: [], refuse: 0 };
  const fetch = async (url) => {
    const path = url.replace(/^.*\/api/, "");
    const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
    if (path === "/agents/me") return ok({ ...ME, status: s.status });
    if (path === "/agents/me/inbox-lite") return ok([]);
    if (path.startsWith(`/companies/${ME.companyId}/issues`)) return ok([]);
    if (path.startsWith(`/companies/${ME.companyId}/heartbeat-runs?agentId=${ME.id}`)) return ok(s.runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  const poller = createPaperclipPoller({
    url: "https://board.test", apiKey: "k", stateFile: join(mkdtempSync(join(tmpdir(), "seat-")), "s.json"),
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
    assert.deepStrictEqual(b.s.told, [{ seat: "Bot", reason: "queued", status: "idle", queued: 2, oldestMinutes: 20 }]);
    b.later(10);
    await b.tick();
    assert.strictEqual(b.s.told.length, 1, "still stalled: not said again");
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
    assert.deepStrictEqual(b.s.told, [{ seat: "Bot", reason: "error", status: "error", queued: 0, oldestMinutes: 0 }]);
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
