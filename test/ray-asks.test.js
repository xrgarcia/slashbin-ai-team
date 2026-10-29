/**
 * Asks to a person: announced once on Discord, answered by a bare yes/no there
 * (lib/ray-asks.js, and the poller's scan and relay in lib/paperclip.js).
 */
const assert = require("assert");
const { readFileSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { idsIn, classifyReply, createRayAsks, announceAsk, answerAsk, routeReply, replyContext, whichMessage, sectionOf, RELAYED_MARK } = require("../lib/ray-asks");
const { createPaperclipPoller, askOf, buildTaskPrompt } = require("../lib/paperclip");

const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const dir = () => mkdtempSync(join(tmpdir(), "ray-asks-"));
const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
const CH = "123456789012345678";
const RAY = "9000000000000001", COWORKER = "9000000000000002";
const ASK = (n, extra = {}) => ({ rayCardId: `ray-${n}`, rayCardIdentifier: `R-${n}`, cardIdentifier: `T-${n}`, issueId: `iss-${n}`, marker: `m${n}`,
  decision: `Approve change ${n}?`, recommendation: `ship change ${n} to production`, link: `https://board.example.com/T/issues/R-${n}`, ...extra });
const fresh = () => createRayAsks({ file: join(dir(), "ray-asks.json") });
async function post(registry, n, id) {
  const sent = [];
  const r = await announceAsk({ registry, ask: ASK(n), channelId: CH, answerers: [RAY], send: async (t) => { sent.push(t); return { id }; } });
  return { ...r, sent };
}

(async () => {
  await check("yes and no are recognised bare, with punctuation, case and a leading mention; stop is neither", () => {
    for (const t of ["yes", "Yes.", "YEP!", "go ahead", "<@123456789012345678> proceed", "Approved", "do it", "ship it!", "y", "go"]) assert.strictEqual(classifyReply(t), "yes", t);
    for (const t of ["no", "No.", "n", "hold", "don't", "Don’t!"]) assert.strictEqual(classifyReply(t), "no", t);
    for (const t of ["stop", "yes but only the first", "maybe", "", "what are you asking?", "go to the store"]) assert.strictEqual(classifyReply(t), null, t);
  });

  await check("an ask is posted once and bound; the same ask seen again, even after a restart, posts nothing", async () => {
    const file = join(dir(), "ray-asks.json");
    const a = createRayAsks({ file });
    const first = await announceAsk({ registry: a, ask: ASK(1), board: null, channelId: CH, send: async () => ({ id: "m-1" }) });
    assert.strictEqual(first.posted, true);
    const b = first.binding;
    assert.deepStrictEqual([b.discordMessageId, b.channelId, b.cardIdentifier, b.issueId, b.rayCardId, b.state], ["m-1", CH, "T-1", "iss-1", "ray-1", "open"]);
    assert.ok(b.createdAt && b.marker === "m1" && b.yesAction === "ship change 1 to production");
    let sends = 0;
    for (const reg of [a, createRayAsks({ file })]) {
      const again = await announceAsk({ registry: reg, ask: ASK(1), board: null, channelId: CH, send: async () => { sends++; return { id: "m-x" }; } });
      assert.strictEqual(again.posted, false);
    }
    assert.strictEqual(sends, 0);
    assert.strictEqual(createRayAsks({ file }).all().length, 1);
  });

  await check("a post that failed is retried, not lost; the posted text states the ask and what a yes does", async () => {
    const r = fresh();
    await assert.rejects(announceAsk({ registry: r, ask: ASK(1), channelId: CH, send: async () => { throw new Error("discord down"); } }));
    assert.strictEqual(r.get(r.keyOf(null, "ray-1")).discordMessageId, null);
    const { sent, posted } = await post(r, 1, "m-1");
    assert.strictEqual(posted, true);
    assert.match(sent[0], /Approve change 1\?/);
    assert.match(sent[0], /If you say yes: ship change 1 to production/);
    assert.match(sent[0], /Reply to this message with yes or no/);
  });

  await check("a yes replying to a bound ask resolves that ask, even with several open", async () => {
    const r = fresh(); await post(r, 1, "m-1"); await post(r, 2, "m-2");
    const route = routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "m-2", userId: RAY });
    assert.strictEqual(route.kind, "resolve");
    assert.strictEqual(route.binding.cardIdentifier, "T-2");
    assert.strictEqual(route.verdict, "yes");
  });

  await check("a bare yes with exactly one open ask resolves it", async () => {
    const r = fresh(); await post(r, 1, "m-1");
    const route = routeReply({ registry: r, channelId: CH, text: "Proceed.", referenceId: null, userId: RAY });
    assert.strictEqual(route.kind, "resolve");
    assert.strictEqual(route.binding.cardIdentifier, "T-1");
  });

  await check("a bare yes with two open asks names them and resolves neither", async () => {
    const r = fresh(); await post(r, 1, "m-1"); await post(r, 2, "m-2");
    const route = routeReply({ registry: r, channelId: CH, text: "yes", referenceId: null, userId: RAY });
    assert.strictEqual(route.kind, "which");
    const text = whichMessage(route.open);
    assert.match(text, /Approve change 1\?/); assert.match(text, /Approve change 2\?/);
    assert.ok(r.open(CH).length === 2);
  });

  await check("a bare yes with nothing open, or in another channel, is left to the model", async () => {
    const r = fresh(); await post(r, 1, "m-1");
    assert.strictEqual(routeReply({ registry: r, channelId: "2234567890123456", text: "yes", userId: RAY }).kind, "none");
    assert.strictEqual(routeReply({ registry: fresh(), channelId: CH, text: "yes", userId: RAY }).kind, "none");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "unrelated", userId: RAY }).kind, "none");
  });

  await check("no resolves with a no verdict, relays it, marks the ask answered, and a repeat is not guessed onto another ask", async () => {
    const r = fresh(); const { binding } = await post(r, 1, "m-1");
    const calls = [];
    const relays = { default: async (b, verdict, o) => { calls.push([b.issueId, verdict, o.text]); return { woke: true }; } };
    const route = routeReply({ registry: r, channelId: CH, text: "No", referenceId: "m-1", userId: RAY });
    assert.strictEqual(route.verdict, "no");
    const out = await answerAsk({ registry: r, binding: route.binding, verdict: "no", text: "No", relays, by: { id: RAY, tag: "ray" } });
    assert.strictEqual(out.ok, true);
    assert.match(out.reply, /Recorded: no/);
    assert.deepStrictEqual(calls, [["iss-1", "no", "No"]]);
    assert.strictEqual(r.get(binding.key).state, "answered");
    assert.strictEqual(r.get(binding.key).answer.verdict, "no");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "m-1", userId: RAY }).kind, "closed");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", userId: RAY }).kind, "none");
  });

  await check("a relay that fails leaves the ask open and says nothing was recorded", async () => {
    const r = fresh(); const { binding } = await post(r, 1, "m-1");
    const out = await answerAsk({ registry: r, binding, verdict: "yes", text: "yes", by: { id: RAY }, relays: { default: async () => { throw new Error("HTTP 500 secret-ish detail"); } } });
    assert.strictEqual(out.ok, false);
    assert.doesNotMatch(out.reply, /500|secret/);
    assert.strictEqual(r.get(binding.key).state, "open");
  });

  await check("reply context carries the replied-to words, and the ask's card and what a yes does", async () => {
    const r = fresh(); const { binding } = await post(r, 1, "m-1");
    const route = routeReply({ registry: r, channelId: CH, text: "what is the risk?", referenceId: "m-1", userId: RAY });
    assert.strictEqual(route.kind, "context");
    const withAsk = replyContext({ author: "bot", content: "Decision needed: Approve change 1?", binding: route.binding });
    assert.match(withAsk, /reply to bot's message: "Decision needed: Approve change 1\?"/);
    assert.match(withAsk, /T-1/); assert.match(withAsk, /A yes would: ship change 1 to production/);
    const plain = replyContext({ author: "ray", content: "see the doc" });
    assert.match(plain, /reply to ray's message: "see the doc"/);
    assert.doesNotMatch(plain, /open ask/);
    assert.match(bot, /replied = await msg\.fetchReference\(\)/);
    assert.match(bot, /runClaude\(runPrompt,/);
  });

  // --- the poller's half: notice the ask, relay the answer ---
  const ME = { id: "agent-1", name: "Bot", companyId: "co-1" };
  const record = { card: "iss-1", hops: [{ from: ME.id, to: "user-1", operation: "request_ray_action", idempotencyKey: "k1", rayCard: "ray-1" }], rayCard: "ray-1", rayCardIdentifier: "R-1" };
  const marker = `<!-- process.escalate:${Buffer.from(JSON.stringify(record)).toString("base64url")} -->`;
  const rayDescription = ["Decision needed for T-1.", "", "**Decision**", "> Approve the rollout?", "", "**Recommendation**", "> roll out to all stores", "", "Answer with a comment."].join("\n");
  function board(overrides = {}) {
    const writes = [], gets = [];
    const routes = {
      "GET /agents/me": ME,
      "GET /agents/me/inbox-lite": [{ id: "iss-1", status: "blocked", assigneeAgentId: ME.id, updatedAt: "2026-10-21T00:00:00Z" }],
      "GET /companies/co-1/issues?assigneeAgentId=agent-1&status=in_review": [],
      "GET /issues/iss-1/comments": [{ id: "c1", authorAgentId: ME.id, body: marker, createdAt: "2026-10-21T00:00:00Z", createdByRunId: "run-9" }],
      "GET /issues/iss-1": { id: "iss-1", identifier: "T-1", title: "Rollout", assigneeAgentId: ME.id, status: "blocked" },
      "GET /issues/ray-1": { id: "ray-1", identifier: "R-1", status: "todo", description: rayDescription },
      ...overrides,
    };
    const fetch = async (url, init) => {
      const key = `${init.method} ${url.replace(/^.*\/api/, "")}`;
      if (init.method !== "GET") { writes.push({ key, body: init.body ? JSON.parse(init.body) : null }); return { ok: true, text: async () => "{}" }; }
      gets.push(key);
      if (!(key in routes)) return { ok: false, status: 404, text: async () => "nf" };
      return { ok: true, text: async () => JSON.stringify(routes[key]) };
    };
    return { fetch, writes, gets, routes };
  }
  const poller = (b, extra) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile: join(dir(), "p.json"), log: silent, fetch: b.fetch,
    answer: async () => "", watchMs: 1e9, stallMinutes: 0, ...extra });

  await check("the poller hands an open request to onRayAsk with the decision and recommendation read off the person's card, once per poll while unchanged", async () => {
    const b = board(); const seen = [];
    const p = poller(b, { onRayAsk: async (a) => { seen.push(a); return true; } });
    await p.tick(); await p.tick();
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual([seen[0].issueId, seen[0].cardIdentifier, seen[0].rayCardId, seen[0].runId, seen[0].marker], ["iss-1", "T-1", "ray-1", "run-9", "k1"]);
    assert.strictEqual(seen[0].decision, "Approve the rollout?");
    assert.strictEqual(seen[0].recommendation, "roll out to all stores");
  });

  await check("no ask is raised once the person's card is done, or when the latest hop is not the request", async () => {
    const done = board({ "GET /issues/ray-1": { id: "ray-1", status: "done", description: rayDescription } });
    const seen = [];
    await poller(done, { onRayAsk: async (a) => { seen.push(a); return true; } }).tick();
    const back = JSON.stringify({ ...record, hops: [...record.hops, { from: ME.id, to: ME.id, operation: "record_answer", idempotencyKey: "k2" }], rayCard: undefined });
    const moved = board({ "GET /issues/iss-1/comments": [{ id: "c1", authorAgentId: ME.id, body: `<!-- process.escalate:${Buffer.from(back).toString("base64url")} -->`, createdAt: "2026-10-21T00:00:00Z" }] });
    await poller(moved, { onRayAsk: async (a) => { seen.push(a); return true; } }).tick();
    assert.strictEqual(seen.length, 0);
  });

  await check("a relayed answer is recorded on the seat's card as its newest ask, the person's card closed, the seat's card reopened; steps are not repeated on retry", async () => {
    const b = board();
    const p = poller(b, {});
    const binding = { key: "default:ray-1", issueId: "iss-1", rayCardId: "ray-1", rayCardIdentifier: "R-1", yesAction: "roll out to all stores", steps: {} };
    let saves = 0;
    const out = await p.relayRayAnswer(binding, "yes", { text: "yes", link: "https://discord.example/x", by: { id: RAY, tag: "ray" }, save: () => saves++ });
    assert.strictEqual(out.woke, true);
    assert.deepStrictEqual(b.writes.map((w) => w.key), ["POST /issues/iss-1/comments", "PATCH /issues/ray-1", "PATCH /issues/iss-1"]);
    assert.ok(b.writes[0].body.body.startsWith(RELAYED_MARK));
    assert.match(b.writes[0].body.body, /by ray \(Discord user 9000000000000001\)/);
    assert.match(b.writes[0].body.body, /Yes\. Go ahead: roll out to all stores/);
    assert.deepStrictEqual([b.writes[1].body, b.writes[2].body], [{ status: "done" }, { status: "todo" }]);
    await p.relayRayAnswer(binding, "yes", { text: "yes", save: () => saves++ });
    assert.strictEqual(b.writes.length, 3);
    assert.strictEqual(saves, 3);
  });

  await check("a relayed answer counts as the card's ask, and the woken seat is told who answered", () => {
    const comments = [
      { id: "c0", authorUserId: "u", body: "please decide", createdAt: "2026-10-21T00:00:00Z" },
      { id: "c1", authorAgentId: ME.id, body: "I need a decision", createdAt: "2026-10-21T01:00:00Z" },
      { id: "c2", authorAgentId: ME.id, body: `${RELAYED_MARK}\nYes. Go ahead.`, createdAt: "2026-10-22T00:00:00Z" },
    ];
    assert.strictEqual(askOf(comments, ME.id).id, "c2");
    const prompt = buildTaskPrompt({ identifier: "T-1", title: "Rollout", description: "" }, comments, ME, "https://board.example.com");
    assert.match(prompt, /The person you asked, answering on Discord/);
  });

  await check("the answer failing to wake the card is reported as such, not as an unrecorded answer", async () => {
    const b = board(); const inner = b.fetch;
    b.fetch = async (url, init) => (init.method === "PATCH" ? { ok: false, status: 403, text: async () => "{}" } : inner(url, init));
    const p = poller(b, {});
    const out = await p.relayRayAnswer({ key: "k", issueId: "iss-1", rayCardId: "ray-1", yesAction: "x", steps: {} }, "yes", { text: "yes", save() {} });
    assert.strictEqual(out.woke, false);
  });

  await check("S1: a coworker's bare yes, or reply to the announcement, leaves the ask open and both cards untouched; Ray's answer records who gave it", async () => {
    const r = fresh(); const { binding } = await post(r, 1, "m-1");
    const writes = [];
    const relays = { default: async (b, v, o) => { writes.push([b.issueId, v, o.by]); return { woke: true }; } };
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", userId: COWORKER }).kind, "none");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "m-1", userId: COWORKER }).kind, "none");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "m-1" }).kind, "none");
    // Even if a caller hands the binding straight to answerAsk, the sender is checked again.
    const out = await answerAsk({ registry: r, binding, verdict: "yes", text: "yes", relays, by: { id: COWORKER, tag: "cw" } });
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(writes, []);
    assert.strictEqual(r.get(binding.key).state, "open");
    assert.strictEqual(r.get(binding.key).answer, undefined);
    const mine = routeReply({ registry: r, channelId: CH, text: "yes", userId: RAY });
    assert.strictEqual(mine.kind, "resolve");
    await answerAsk({ registry: r, binding: mine.binding, verdict: "yes", text: "yes", relays, by: { id: RAY, tag: "ray" } });
    assert.deepStrictEqual(writes, [["iss-1", "yes", { id: RAY, tag: "ray" }]]);
    assert.deepStrictEqual(r.get(binding.key).answer.by, { id: RAY, tag: "ray" });
  });

  await check("S1: an ask with no recorded answerer can be answered by no one; two asks to different people do not make a bare yes ambiguous for either", async () => {
    const r = fresh();
    await announceAsk({ registry: r, ask: ASK(1), channelId: CH, send: async () => ({ id: "m-1" }) });
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", userId: RAY }).kind, "none");
    await announceAsk({ registry: r, ask: ASK(2), channelId: CH, answerers: [COWORKER], send: async () => ({ id: "m-2" }) });
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", userId: COWORKER }).binding.cardIdentifier, "T-2");
    assert.deepStrictEqual(idsIn("<@9000000000000001> <@!9000000000000002>"), [RAY, COWORKER]);
    assert.deepStrictEqual(idsIn(""), []);
  });

  await check("S2: the gate admits only the asked person's answer in the announcement channel, even unmonitored and without a mention", () => {
    const gate = bot.indexOf("const isAskAnswer");
    assert.ok(gate > 0, "bot.js computes isAskAnswer");
    const block = bot.slice(gate, gate + 600);
    assert.match(block, /!msg\.author\.bot && RAY_ASKS/);
    assert.match(block, /userId: msg\.author\.id/);
    assert.match(block, /kind !== "none"/);
    assert.match(bot, /!isDM && !isMentioned && !isMonitored && !isAskAnswer\) return/);
    // what it admits: routeReply says "none" for everything but the asked person's answer or reply
    const r = fresh();
    return post(r, 1, "m-1").then(() => {
      const kind = (o) => routeReply({ registry: r, channelId: CH, ...o }).kind;
      assert.strictEqual(kind({ text: "yes", userId: RAY }), "resolve");
      assert.strictEqual(kind({ text: "so what do you think?", referenceId: "m-1", userId: RAY }), "context");
      assert.strictEqual(kind({ text: "yes", userId: COWORKER }), "none");
      assert.strictEqual(kind({ text: "hello there", userId: RAY }), "none");
      assert.strictEqual(routeReply({ registry: r, channelId: "2234567890123456", text: "yes", userId: RAY }).kind, "none");
    });
  });

  await check("S2: a reply routed to a connected agent carries the replied-to words and the bound-ask context", () => {
    const src = bot.match(/function routeToAgents\([\s\S]*?\n\}\n/)[0];
    const sentWs = [];
    const connectedAgents = new Map([["a1", { channels: { listen: [CH] }, ws: { send: (m) => sentWs.push(JSON.parse(m)) } }]]);
    const routeToAgents = new Function("connectedAgents", "log", `${src}; return routeToAgents;`)(connectedAgents, silent);
    const msg = { channel: { id: CH }, author: { id: RAY, username: "ray" }, id: "d1", attachments: { map: () => [] } };
    const runPrompt = `${replyContext({ author: "bot", content: "Please approve the rollout", binding: { cardIdentifier: "T-1", decision: "Approve?", yesAction: "ship" } })}\n\nyes`;
    assert.strictEqual(routeToAgents(msg, runPrompt, { messageId: "m-1", author: "bot", content: "Please approve the rollout" }), true);
    assert.match(sentWs[0].text, /Please approve the rollout/);
    assert.match(sentWs[0].text, /open ask for a decision on T-1/);
    assert.strictEqual(sentWs[0].replyTo.content, "Please approve the rollout");
    assert.match(bot, /routeToAgents\(msg, runPrompt, replied \?/);
  });

  await check("S3: an ask that could not be announced is tried again after RAY_SCAN_MS, not cached for the life of the process", async () => {
    const b = board(); let now = 1e6; const calls = [];
    const p = poller(b, { clock: () => now, onRayAsk: async (a) => { calls.push(a.rayCardId); return calls.length > 1; } });
    await p.tick(); assert.strictEqual(calls.length, 1);
    await p.tick(); assert.strictEqual(calls.length, 1, "not retried within the window");
    now += 301000;
    await p.tick(); assert.strictEqual(calls.length, 2, "retried once the window passed");
    now += 301000;
    await p.tick(); assert.strictEqual(calls.length, 2, "accepted, so never announced again");
  });

  await check("section parser and wiring", () => {
    assert.strictEqual(sectionOf(rayDescription, "Decision"), "Approve the rollout?");
    assert.strictEqual(sectionOf(rayDescription, "Evidence"), "");
    assert.match(bot, /onRayAsk: RAY_ASKS/);
    assert.match(bot, /RAY_RELAYS\[board\.id \?\? "default"\] = poller\.relayRayAnswer/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
