/**
 * The shared handoff contract: a run whose tools carry it is told to call the
 * tool and never rebuild it; a run without the tool gets the reader's text, and
 * a reader that cannot answer gives an explicit CONTRACT UNAVAILABLE block —
 * never silence, never a stale copy presented as current.
 */
const assert = require("assert");
const { mkdtempSync, writeFileSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { parseContract, contractText, toolLine } = require("../lib/handoff-contract");
const { createPaperclipPoller, buildTaskPrompt, paperclipBoards } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const dir = mkdtempSync(join(tmpdir(), "contract-"));
const reader = (name, body) => { const p = join(dir, `${name}.mjs`); writeFileSync(p, body); return p; };
const TOOL = "tool:process.handoff_contract";

/** One task held by the bot with a live run; captures the prompt it is answered with. */
function board() {
  const card = { id: "c-1", identifier: "ACME-1", title: "Route the blocker", description: "Who owns this?",
    status: "in_progress", assigneeAgentId: "agent-a", assigneeUserId: null, labels: [], createdAt: "2026-01-01T00:00:00Z", createdByAgentId: "agent-b" };
  const comments = [{ id: "c0", authorAgentId: null, authorUserId: "user-avery", createdAt: "2026-01-01T00:00:01Z", body: "Who decides this?" }];
  const runs = [{ id: "r1", agentId: "agent-a", status: "running" }];
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-a", name: "Agent A", companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok([{ id: "agent-a", name: "Agent A" }, { id: "agent-b", name: "Agent B" }]);
    if (path === "/agents/me/inbox-lite") return ok(card.status === "in_progress" ? [{ id: card.id, status: card.status, unresolvedBlockerIssueIds: [] }] : []);
    const m = path.match(/^\/issues\/([^/]+)(\/[a-z]+)?$/);
    if (!m) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      if (body.status) card.status = body.status;
      if (body.comment) { comments.push({ id: `c${comments.length}`, authorAgentId: "agent-a", createdAt: new Date().toISOString(), body: body.comment, createdByRunId: init.headers["x-paperclip-run-id"] }); runs[0].status = "succeeded"; }
      return ok({});
    }
    if (!m[2]) return ok({ ...card, blockedBy: [] });
    if (m[2] === "/activity") return ok([]);
    if (m[2] === "/comments") return ok(comments);
    if (m[2] === "/runs") return ok(runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { fetch };
}
async function promptFor(contract) {
  const b = board();
  let prompt = null;
  await createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile: join(mkdtempSync(join(dir, "s-")), "s.json"),
    log: silent, fetch: b.fetch, contract, answer: async (p) => { prompt = p; return "Agent B owns it."; } }).tick();
  assert.ok(prompt, "the task was answered");
  return prompt;
}

(async () => {
  await check("settings: tool and absolute reader parse; anything else is a problem, unset is none", async () => {
    assert.deepStrictEqual(parseContract(TOOL).setting, { kind: "tool", server: "process", tool: "handoff_contract" });
    assert.deepStrictEqual(parseContract("reader:/opt/c.mjs").setting, { kind: "reader", path: "/opt/c.mjs" });
    assert.deepStrictEqual(parseContract(undefined), { setting: null, problem: null });
    assert.deepStrictEqual(parseContract("  "), { setting: null, problem: null });
    for (const bad of ["reader:rel/c.mjs", "tool:process", "tool:a.b.c", "process.handoff_contract", 7]) {
      const r = parseContract(bad, "X");
      assert.strictEqual(r.setting, null, String(bad));
      assert.match(r.problem, /^X/, String(bad));
    }
  });

  await check("tool: the line names the call, the revision and the no-rebuild rule", async () => {
    const text = await contractText(parseContract(TOOL).setting);
    assert.strictEqual(text, toolLine({ server: "process", tool: "handoff_contract" }));
    assert.match(text, /call the process MCP tool handoff_contract and cite the revision/);
    assert.match(text, /If the call fails, say so and name the error; never reconstruct/);
  });

  await check("reader: its text is used, an unavailable block passes through as written", async () => {
    const good = reader("good", "export function runnerBlock() { return { ok: true, text: 'contract X revision 9\\n\\nclauses' }; }");
    assert.strictEqual(await contractText(parseContract(`reader:${good}`).setting), "contract X revision 9\n\nclauses");
    const stale = reader("stale", "export const runnerBlock = () => ({ ok: false, text: 'CONTRACT UNAVAILABLE: snapshot is stale. Do not reconstruct.' });");
    assert.strictEqual(await contractText(parseContract(`reader:${stale}`).setting), "CONTRACT UNAVAILABLE: snapshot is stale. Do not reconstruct.");
  });

  await check("reader failures are explicit CONTRACT UNAVAILABLE blocks, never silence or a throw", async () => {
    const cases = {
      missing: join(dir, "nope.mjs"),
      noexport: reader("noexport", "export const other = 1;"),
      throws: reader("throws", "export function runnerBlock() { throw new Error('disk gone'); }"),
      shape: reader("shape", "export const runnerBlock = () => ({ ok: true });"),
      empty: reader("empty", "export const runnerBlock = () => ({ ok: true, text: '  ' });"),
      unflagged: reader("unflagged", "export const runnerBlock = () => ({ ok: false, text: 'old copy of the contract' });"),
      syntax: reader("syntax", "export function ("),
    };
    for (const [name, path] of Object.entries(cases)) {
      const text = await contractText(parseContract(`reader:${path}`).setting);
      assert.match(text, /^CONTRACT UNAVAILABLE: /, name);
      assert.match(text, /Do not reconstruct the handoff contract/, name);
      assert.ok(!/old copy of the contract\n|^contract /.test(text), name);
    }
    assert.match(await contractText({ kind: "reader", path: "/x.mjs" }, { importer: async () => { throw Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" }); } }), /could not be loaded \(ERR_MODULE_NOT_FOUND\)/);
  });

  await check("no setting: the task prompt is unchanged", async () => {
    const issue = { identifier: "ACME-1", title: "t", description: "d" };
    const me = { id: "agent-a", name: "Agent A" };
    assert.strictEqual(buildTaskPrompt(issue, [], me, "https://b", { contract: "" }), buildTaskPrompt(issue, [], me, "https://b"));
    assert.strictEqual(await promptFor(null), await promptFor(undefined));
    assert.ok(!/Handoff contract/.test(await promptFor(null)));
  });

  await check("a board task carries the tool line or the reader's text", async () => {
    assert.ok((await promptFor(parseContract(TOOL).setting)).includes(`--- Handoff contract ---\n${toolLine({ server: "process", tool: "handoff_contract" })}\n--- End handoff contract ---`));
    const path = reader("rev1", "export const runnerBlock = () => ({ ok: true, text: 'contract X revision 1' });");
    assert.ok((await promptFor(parseContract(`reader:${path}`).setting)).includes("--- Handoff contract ---\ncontract X revision 1\n--- End handoff contract ---"));
    const gone = join(dir, "gone.mjs");
    assert.match(await promptFor({ kind: "reader", path: gone }), /--- Handoff contract ---\nCONTRACT UNAVAILABLE: the contract reader .*gone\.mjs could not be loaded/);
  });

  await check("a long thread is shed before the contract is: it survives the byte budget", async () => {
    const issue = { identifier: "ACME-1", title: "t", description: "d" };
    const me = { id: "agent-a", name: "Agent A" };
    const comments = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, authorUserId: "u", createdAt: "2026-01-01T00:00:00Z", body: "x".repeat(500) }));
    const p = buildTaskPrompt(issue, comments, me, "https://b", { maxBytes: 20000, contract: "contract X revision 7" });
    assert.ok(Buffer.byteLength(p) <= 20000, `prompt ${Buffer.byteLength(p)} bytes`);
    assert.ok(p.includes("--- Handoff contract ---\ncontract X revision 7\n--- End handoff contract ---"));
  });

  await check("boards: each takes its own setting, else the bot-wide one; a malformed one is a problem, the board off", async () => {
    const env = { PAPERCLIP_URL: "https://one.example.com", PAPERCLIP_API_KEY: "k1", HANDOFF_CONTRACT: TOOL, KEY_TWO: "k2", KEY_THREE: "k3",
      PAPERCLIP_EXTRA_BOARDS: JSON.stringify([
        { id: "two", url: "https://two.example.com", keyEnv: "KEY_TWO", contract: "reader:/opt/c.mjs" },
        { id: "three", url: "https://three.example.com", keyEnv: "KEY_THREE" },
        { id: "four", url: "https://four.example.com", keyEnv: "KEY_TWO", contract: "reader:relative.mjs" },
      ]) };
    const { boards, problems } = paperclipBoards(env);
    assert.deepStrictEqual(boards.map((b) => [b.id, b.contract]), [
      [null, { kind: "tool", server: "process", tool: "handoff_contract" }],
      ["two", { kind: "reader", path: "/opt/c.mjs" }],
      ["three", { kind: "tool", server: "process", tool: "handoff_contract" }],
    ]);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /extra board "four" contract: a reader path must be absolute/);
    const first = paperclipBoards({ PAPERCLIP_URL: "https://one.example.com", PAPERCLIP_API_KEY: "k1", PAPERCLIP_CONTRACT: "nonsense" });
    assert.deepStrictEqual(first.boards, []);
    assert.match(first.problems[0], /^PAPERCLIP_CONTRACT must be/);
    assert.strictEqual(paperclipBoards({ PAPERCLIP_URL: "https://one.example.com", PAPERCLIP_API_KEY: "k1" }).boards[0].contract, null);
  });

  await check("bot: the Discord prompt carries the tool line unless the task prompt already does; a bad setting stops startup", async () => {
    const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
    assert.match(src, /HANDOFF_CONTRACT\?\.kind === "tool" && !opts\.taskCarriesContract \? \["", "--- Handoff contract ---", toolLine\(HANDOFF_CONTRACT\)/);
    assert.match(src, /taskCarriesContract: Boolean\(board\.contract\)/);
    assert.match(src, /if \(HANDOFF_CONTRACT_PROBLEM\) \{\n  log\.fatal\(HANDOFF_CONTRACT_PROBLEM\);\n  process\.exit\(EXIT_CONFIG\);/);
    assert.match(src, /contract: board\.contract,/);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
