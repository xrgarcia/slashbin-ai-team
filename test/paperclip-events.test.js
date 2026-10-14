/**
 * Paperclip live events — a seat checks its inbox the moment one of its runs
 * opens; the socket decides only when, never what, so nothing runs twice.
 */
const assert = require("assert");
const { EventEmitter } = require("events");
const { createServer } = require("http");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { WebSocket, WebSocketServer } = require("ws");
const { eventsUrl, wakesFor, backoffMs, eventsSetting, createLiveEvents, startBoard, LIVE, RECONNECTING, OFF } = require("../lib/paperclip-events");
const { createPaperclipPoller, paperclipBoards } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const ME = { id: "agent-1", companyId: "co-1" };
const tickOf = () => new Promise((r) => setImmediate(r));

/** A clock whose timers fire only when the test says so. */
function clock() {
  let next = 1;
  const timers = new Map();
  return {
    timers,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fire(pred = () => true) {
      for (const [id, t] of [...timers]) if (pred(t)) { timers.delete(id); t.fn(); return t; }
      throw new Error("no timer to fire");
    },
  };
}

/** A socket the test drives: open, message, ping, error, close. */
function fakeSockets() {
  const made = [];
  class FakeSocket extends EventEmitter {
    constructor(url, opts) { super(); this.url = url; this.opts = opts; this.terminated = false; made.push(this); }
    terminate() { this.terminated = true; this.emit("close", 1006); }
    close() { this.emit("close", 1000); }
  }
  return { made, FakeSocket };
}

function seat({ c = clock(), whoami = async () => ME } = {}) {
  const { made, FakeSocket } = fakeSockets();
  const wakes = [], states = [];
  const ev = createLiveEvents({
    url: "https://board.example.com/", apiKey: "k", whoami, log: silent, WebSocket: FakeSocket,
    onWake: (r) => wakes.push(r), onState: (s) => states.push(s),
    setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0.5,
  });
  return { ev, made, wakes, states, c };
}

(async () => {
  console.log("paperclip-events");

  await check("the socket URL is the company's events path on the board's origin, ws for http", () => {
    assert.strictEqual(eventsUrl("https://board.example.com/", "co 1"), "wss://board.example.com/api/companies/co%201/events/ws");
    assert.strictEqual(eventsUrl("http://127.0.0.1:3100", "c"), "ws://127.0.0.1:3100/api/companies/c/events/ws");
  });

  await check("only a run event for this agent wakes the seat", () => {
    assert.ok(wakesFor({ type: "heartbeat.run.queued", payload: { agentId: "agent-1" } }, "agent-1"));
    assert.ok(wakesFor({ type: "heartbeat.run.status", payload: { agentId: "agent-1", status: "running" } }, "agent-1"));
    assert.ok(!wakesFor({ type: "heartbeat.run.queued", payload: { agentId: "agent-2" } }, "agent-1"));
    assert.ok(!wakesFor({ type: "activity.logged", payload: { agentId: "agent-1" } }, "agent-1"));
    assert.ok(!wakesFor({ type: "heartbeat.run.queued" }, "agent-1"));
    assert.ok(!wakesFor(null, "agent-1"));
  });

  await check("backoff doubles from 1 s and stops at 60 s, half of it jittered", () => {
    const mid = (a) => backoffMs(a, { random: () => 0.5 });
    assert.deepStrictEqual([0, 1, 2, 3].map(mid), [750, 1500, 3000, 6000]);
    assert.strictEqual(mid(20), 45000);
    assert.strictEqual(backoffMs(20, { random: () => 0 }), 30000);
    assert.strictEqual(backoffMs(20, { random: () => 1 }), 60000);
  });

  await check("PAPERCLIP_EVENTS is on unless it says off; a typo stays on and is reported", () => {
    for (const v of [undefined, "", "on", "1", "true", "YES"]) assert.deepStrictEqual(eventsSetting(v), { on: true, problem: null }, String(v));
    for (const v of ["off", "0", "false", "No"]) assert.strictEqual(eventsSetting(v).on, false, v);
    const typo = eventsSetting("of");
    assert.strictEqual(typo.on, true);
    assert.match(typo.problem, /PAPERCLIP_EVENTS/);
  });

  await check("an open is live and reconciles first; the seat's key goes as a bearer header", async () => {
    const { ev, made, wakes, states } = seat();
    ev.start(); await tickOf();
    assert.strictEqual(made.length, 1);
    assert.strictEqual(made[0].url, "wss://board.example.com/api/companies/co-1/events/ws");
    assert.strictEqual(made[0].opts.headers.authorization, "Bearer k");
    made[0].emit("open");
    assert.deepStrictEqual(states, [LIVE]);
    assert.deepStrictEqual(wakes, ["connected"]);
  });

  await check("an event for this agent wakes it; another agent's, another type, or junk does not", async () => {
    const { ev, made, wakes } = seat();
    ev.start(); await tickOf(); made[0].emit("open"); wakes.length = 0;
    const send = (e) => made[0].emit("message", Buffer.from(typeof e === "string" ? e : JSON.stringify(e)));
    send({ type: "heartbeat.run.queued", payload: { agentId: "agent-2", runId: "r2" } });
    send({ type: "activity.logged", payload: { agentId: "agent-1" } });
    send("not json");
    assert.deepStrictEqual(wakes, []);
    send({ type: "heartbeat.run.queued", payload: { agentId: "agent-1", runId: "r1" } });
    send({ type: "heartbeat.run.status", payload: { agentId: "agent-1", runId: "r1", status: "running" } });
    assert.deepStrictEqual(wakes, ["heartbeat.run.queued", "heartbeat.run.status"]);
  });

  await check("a drop reconnects after backoff, and the new open reconciles again", async () => {
    const { ev, made, wakes, states, c } = seat();
    ev.start(); await tickOf(); made[0].emit("open");
    made[0].emit("close", 1006);
    assert.strictEqual(ev.state(), RECONNECTING);
    const t = c.fire();
    assert.strictEqual(t.ms, 750);
    await tickOf();
    assert.strictEqual(made.length, 2);
    made[1].emit("open");
    assert.deepStrictEqual(states, [LIVE, RECONNECTING, LIVE]);
    assert.deepStrictEqual(wakes, ["connected", "connected"]);
  });

  await check("failed attempts back off further; a good open resets the backoff", async () => {
    const { ev, made, c } = seat();
    ev.start(); await tickOf();
    made[0].emit("close", 1006);
    assert.strictEqual(c.fire().ms, 750); await tickOf();
    made[1].emit("close", 1006);
    assert.strictEqual(c.fire().ms, 1500); await tickOf();
    made[2].emit("open"); made[2].emit("close", 1006);
    assert.strictEqual(c.fire((t) => t.ms !== 75000).ms, 750);
  });

  await check("a refused upgrade never wakes and keeps reconnecting", async () => {
    const { ev, made, wakes } = seat();
    ev.start(); await tickOf();
    made[0].emit("error", new Error("Unexpected server response: 401"));
    made[0].emit("close", 1006);
    assert.strictEqual(ev.state(), RECONNECTING);
    assert.deepStrictEqual(wakes, []);
  });

  await check("a who-am-I failure retries instead of opening a socket", async () => {
    const { ev, made } = seat({ whoami: async () => { throw new Error("503"); } });
    ev.start(); await tickOf();
    assert.strictEqual(made.length, 0);
    assert.strictEqual(ev.state(), RECONNECTING);
  });

  await check("a socket with no ping for 75 s is replaced; a ping keeps it", async () => {
    const { ev, made, c } = seat();
    ev.start(); await tickOf(); made[0].emit("open");
    made[0].emit("ping");
    assert.strictEqual([...c.timers.values()].filter((t) => t.ms === 75000).length, 1);
    c.fire((t) => t.ms === 75000);
    assert.ok(made[0].terminated);
    assert.strictEqual(ev.state(), RECONNECTING);
  });

  await check("stop closes the socket, cancels the retry, and never reconnects", async () => {
    const { ev, made, c } = seat();
    ev.start(); await tickOf(); made[0].emit("open");
    ev.stop();
    assert.strictEqual(ev.state(), OFF);
    assert.strictEqual(c.timers.size, 0);
  });

  await check("the board polls at POLL_MS without events, RECONCILE_MS while live, and reschedules on a change", async () => {
    const c = clock();
    const ticks = [];
    const off = startBoard({ tick: async (r) => ticks.push(r), pollMs: 15000, reconcileMs: 60000, setTimer: c.setTimer, clearTimer: c.clearTimer });
    assert.strictEqual([...c.timers.values()][0].ms, 15000);
    c.fire(); await tickOf();
    assert.deepStrictEqual(ticks, ["poll"]);
    assert.strictEqual([...c.timers.values()][0].ms, 15000);
    off.stop();

    let state = null;
    const events = { start() {}, stop() {}, state: () => state };
    const c2 = clock();
    const board = startBoard({ tick: async () => {}, events, pollMs: 15000, reconcileMs: 60000, setTimer: c2.setTimer, clearTimer: c2.clearTimer });
    assert.strictEqual([...c2.timers.values()][0].ms, 15000, "not yet live: the fast rate");
    state = LIVE; board.reschedule();
    assert.deepStrictEqual([...c2.timers.values()].map((t) => t.ms), [60000]);
    state = RECONNECTING; board.reschedule();
    assert.deepStrictEqual([...c2.timers.values()].map((t) => t.ms), [15000], "a drop falls back to the fast rate at once");
  });

  await check("a tick asked for while one runs is owed: exactly one more pass, under the newer reason", async () => {
    let release, inboxReads = 0;
    const gate = new Promise((r) => { release = r; });
    const fetch = async (url) => {
      const path = url.replace(/^.*\/api/, "");
      if (path === "/agents/me") return { ok: true, text: async () => JSON.stringify(ME) };
      if (path === "/agents/me/inbox-lite") {
        inboxReads++;
        if (inboxReads === 1) await gate;
        return { ok: true, text: async () => "[]" };
      }
      throw new Error(`unexpected ${path}`);
    };
    const dir = mkdtempSync(join(tmpdir(), "pc-events-"));
    const poller = createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile: join(dir, "s.json"), answer: async () => "", log: silent, fetch });
    const first = poller.tick("poll");
    await tickOf();
    await poller.tick("heartbeat.run.queued");
    await poller.tick("heartbeat.run.status");
    assert.strictEqual(inboxReads, 1, "nothing runs alongside the running tick");
    release();
    await first;
    assert.strictEqual(inboxReads, 2, "the owed tick ran once, not once per request");
    await poller.tick("poll");
    assert.strictEqual(inboxReads, 3);
    assert.deepStrictEqual(await poller.whoami(), ME);
  });

  await check("an extra board's events must be a boolean; false is kept, unset inherits", () => {
    const env = { PAPERCLIP_URL: "https://a.example.com", PAPERCLIP_API_KEY: "k", B_KEY: "k2", C_KEY: "k3", D_KEY: "k4",
      PAPERCLIP_EXTRA_BOARDS: JSON.stringify([
        { id: "b", url: "https://b.example.com", keyEnv: "B_KEY", events: false },
        { id: "c", url: "https://c.example.com", keyEnv: "C_KEY" },
        { id: "d", url: "https://d.example.com", keyEnv: "D_KEY", events: "no" },
      ]) };
    const { boards, problems } = paperclipBoards(env);
    assert.deepStrictEqual(boards.map((b) => [b.id, b.events]), [[null, undefined], ["b", false], ["c", undefined]]);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /events must be true or false/);
  });

  // The real ws library, against a local server shaped like Paperclip's.
  await check("against a real socket: the bearer key is accepted, run events wake, a refused key reconnects", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const seen = [];
    server.on("upgrade", (req, socket, head) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      if (req.headers.authorization !== "Bearer good") {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: "heartbeat.run.queued", payload: { agentId: "agent-2" } }));
        ws.send(JSON.stringify({ type: "heartbeat.run.queued", payload: { agentId: "agent-1", runId: "r1" } }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const run = (apiKey) => new Promise((resolve) => {
      const wakes = [], states = [];
      const ev = createLiveEvents({ url, apiKey, whoami: async () => ME, log: silent, WebSocket,
        onWake: (r) => { wakes.push(r); if (wakes.length === 2) { ev.stop(); resolve({ wakes, states }); } },
        onState: (s) => { states.push(s); if (s === RECONNECTING) { ev.stop(); resolve({ wakes, states }); } } });
      ev.start();
    });
    const good = await run("good");
    assert.deepStrictEqual(good.wakes, ["connected", "heartbeat.run.queued"]);
    assert.strictEqual(seen[0].url, "/api/companies/co-1/events/ws");
    const bad = await run("bad");
    assert.deepStrictEqual(bad.wakes, []);
    assert.strictEqual(bad.states[0], RECONNECTING);
    wss.close(); server.close();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
