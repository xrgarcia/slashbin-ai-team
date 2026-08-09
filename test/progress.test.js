/**
 * Progress reporting: one status message, edited in place, then removed.
 *
 * Streaming was removed on 2026-03-28 (commit 3c79e5e) because text emitted
 * BEFORE a tool call — "Let me check..." — was posted as its own Discord message,
 * so the bot appeared to answer twice. That diagnosis was right. The cure batched
 * everything to the end and took all progress visibility with it.
 *
 * These tests pin the property that lets progress come back without the bug:
 * NO PART OF THE REPLY IS EVER SENT EARLY. Only activity is reported, on a single
 * message that is edited and then deleted.
 *
 * The reporter is extracted from source and run against a fake Discord message —
 * bot.js cannot be require()d, since importing it logs a live bot into Discord.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const REPO = join(__dirname, "..");
const src = readFileSync(join(REPO, "bot.js"), "utf8");

const fnSrc = /function createProgressReporter\(msg, reqLog\) \{[\s\S]*?\n\}/.exec(src);
assert.ok(fnSrc, "createProgressReporter not found in bot.js");

/** Build a reporter with injected config and a fake Discord message. */
function make({ enabled = true, intervalMs = 5 } = {}) {
  const sent = [];
  const edits = [];
  let deleted = false;
  const statusStub = {
    edit: async (body) => { edits.push(body); },
    delete: async () => { deleted = true; },
  };
  const msg = { reply: async (body) => { sent.push(body); return statusStub; } };
  const reqLog = { debug() {}, info() {}, warn() {} };
  const factory = new Function(
    "PROGRESS_ENABLED", "PROGRESS_INTERVAL_MS", "setTimeout", "clearTimeout",
    `${fnSrc[0]}; return createProgressReporter;`
  )(enabled, intervalMs, setTimeout, clearTimeout);
  return { reporter: factory(msg, reqLog), sent, edits, deleted: () => deleted };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

(async () => {
  console.log("\nProgress reporting");

  await check("disabled by configuration returns nothing at all", () => {
    const { reporter } = make({ enabled: false });
    assert.strictEqual(reporter, null, "must be inert when BOT_PROGRESS_ENABLED=false");
  });

  await check("a run with no tool calls posts nothing", async () => {
    const h = make();
    await h.reporter.finish();
    assert.deepStrictEqual(h.sent, [], "a simple Q&A must look exactly as it does today");
  });

  await check("many tool calls produce ONE message, then edits", async () => {
    const h = make({ intervalMs: 5 });
    for (let i = 0; i < 8; i++) h.reporter.tool("Read", { file_path: `/a/b/f${i}.js` });
    await sleep(40);
    h.reporter.tool("Grep", { pattern: "needle" });
    await sleep(40);
    assert.strictEqual(h.sent.length, 1, `expected 1 posted message, got ${h.sent.length}`);
    assert.ok(h.edits.length >= 1, "later updates must EDIT, not post again");
  });

  await check("updates are coalesced, not one per tool call", async () => {
    const h = make({ intervalMs: 50 });
    for (let i = 0; i < 20; i++) h.reporter.tool("Read", { file_path: "/x.js" });
    await sleep(80);
    const total = h.sent.length + h.edits.length;
    assert.ok(total <= 3, `20 tool calls produced ${total} Discord writes — rate limits will bite`);
  });

  await check("tool INPUT is never shown for Bash", async () => {
    const h = make({ intervalMs: 5 });
    // A Bash command routinely carries a connection string or an API key, and this
    // text goes to a channel, not to the transcript's security boundary.
    h.reporter.tool("Bash", { command: "psql postgresql://user:hunter2@host/db -c 'select 1'" });
    await sleep(30);
    const all = [...h.sent, ...h.edits].join("\n");
    assert.ok(!/hunter2|postgresql:\/\//.test(all), "tool input leaked into a Discord message");
    assert.ok(/Bash/.test(all), "the tool name should still be reported");
  });

  await check("file tools show a basename, never a full path", async () => {
    const h = make({ intervalMs: 5 });
    h.reporter.tool("Read", { file_path: "/home/someone/secret-project/plans.md" });
    await sleep(30);
    const all = [...h.sent, ...h.edits].join("\n");
    assert.ok(/plans\.md/.test(all), "basename should be shown");
    assert.ok(!/secret-project/.test(all), "the full path should not be");
  });

  await check("finish() removes the status message", async () => {
    const h = make({ intervalMs: 5 });
    h.reporter.tool("Read", { file_path: "/a.js" });
    await sleep(30);
    await h.reporter.finish();
    assert.ok(h.deleted(), "the status message must be deleted, not left behind");
  });

  await check("a Discord failure never breaks the run", async () => {
    const factory = new Function(
      "PROGRESS_ENABLED", "PROGRESS_INTERVAL_MS", "setTimeout", "clearTimeout",
      `${fnSrc[0]}; return createProgressReporter;`
    )(true, 5, setTimeout, clearTimeout);
    const reporter = factory(
      { reply: async () => { throw new Error("missing permissions"); } },
      { debug() {}, info() {}, warn() {} }
    );
    reporter.tool("Read", { file_path: "/a.js" });
    await sleep(30);
    await reporter.finish();   // must not throw
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
