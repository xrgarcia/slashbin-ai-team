/**
 * Paperclip live events — a board seat checks its inbox the moment one of its
 * runs opens, instead of on the next poll.
 *
 * Paperclip publishes every event of a company on a WebSocket
 * (`/api/companies/:companyId/events/ws`) that takes the agent's own key. A run
 * queued or started for an agent is announced there, tagged with its agent id.
 * The socket only decides WHEN the poller's tick runs; what a tick does — read
 * the inbox, skip what is already handled, answer what is open — is unchanged,
 * so a repeated event, a reconnect or an event racing a poll runs nothing twice.
 *
 * The stream keeps no backlog: an event sent while the socket was down is gone,
 * and its ids restart with the server. So every open, the first included, runs a
 * tick before the stream is trusted, and polling stays on as the recovery path —
 * slower while the socket is live, at the full rate while it is not. A board or
 * proxy without WebSockets just keeps polling; nothing here can stop a board.
 *
 * The network and the clock are injected, so tests drive a fake socket.
 */

/** The events that mean a run of this agent's was queued or changed. */
const RUN_EVENTS = new Set(["heartbeat.run.queued", "heartbeat.run.status"]);

/** Event states, as the surfaces file and logs report them. */
const LIVE = "live", RECONNECTING = "reconnecting", OFF = "off";

/** The company event socket for a board origin. */
function eventsUrl(url, companyId) {
  const origin = String(url).replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${origin}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
}

/** Does this event wake the seat? Only a run event for its own agent does — the stream is company-wide. */
function wakesFor(event, agentId) {
  return Boolean(event && agentId) && RUN_EVENTS.has(event.type) && event.payload?.agentId === agentId;
}

/** Jittered exponential backoff: half the step fixed, half random, capped. */
function backoffMs(attempt, { baseMs = 1000, maxMs = 60000, random = Math.random } = {}) {
  const step = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(step / 2 + random() * (step / 2));
}

/**
 * `PAPERCLIP_EVENTS`: on unless it says off. An unrecognised value keeps events
 * on — the safe direction, since polling runs either way — and is reported.
 */
function eventsSetting(raw) {
  if (raw === undefined || raw === "") return { on: true, problem: null };
  const v = String(raw).trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return { on: true, problem: null };
  if (["off", "0", "false", "no"].includes(v)) return { on: false, problem: null };
  return { on: true, problem: `PAPERCLIP_EVENTS=${JSON.stringify(raw)} is not on or off; events stay on` };
}

/**
 * One seat's socket. `whoami` resolves `{ id, companyId }` (GET /agents/me);
 * `onWake(reason)` runs the poller's tick; `onState(state)` reports live or
 * reconnecting. A socket that goes `staleMs` without the server's ping (sent
 * every 30 s) is treated as dead and replaced.
 */
function createLiveEvents({ url, apiKey, whoami, onWake, onState = null, log, WebSocket,
  setTimer = setTimeout, clearTimer = clearTimeout, staleMs = 75000, baseMs = 1000, maxMs = 60000, random = Math.random }) {
  let socket = null, attempt = 0, retry = null, watchdog = null, stopped = false, state = null;

  const setState = (next) => {
    if (next === state) return;
    state = next;
    try { onState?.(next); } catch { /* a report never stops the socket */ }
  };
  const wake = (reason) => {
    try { onWake(reason); } catch (err) { log.warn({ err: err.message }, "Paperclip event wake failed"); }
  };
  const arm = (ws) => {
    clearTimer(watchdog);
    watchdog = setTimer(() => {
      log.warn({ staleMs }, "Paperclip events: no ping from the board — replacing the socket");
      ws.terminate();
    }, staleMs);
  };
  const reconnect = () => {
    if (stopped || retry) return;
    setState(RECONNECTING);
    const ms = backoffMs(attempt++, { baseMs, maxMs, random });
    retry = setTimer(() => { retry = null; connect(); }, ms);
  };

  async function connect() {
    if (stopped) return;
    let me;
    try {
      me = await whoami();
    } catch (err) {
      log.warn({ err: err.message }, "Paperclip events: who-am-I failed — retrying, polling carries the board");
      return reconnect();
    }
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocket(eventsUrl(url, me.companyId), { headers: { authorization: `Bearer ${apiKey}` } });
    } catch (err) {
      log.warn({ err: err.message }, "Paperclip events: socket not opened — retrying, polling carries the board");
      return reconnect();
    }
    socket = ws;
    ws.on("open", () => {
      attempt = 0;
      arm(ws);
      setState(LIVE);
      log.info({ agentId: me.id }, "Paperclip events live");
      // Nothing sent while the socket was down is replayed: reconcile first.
      wake("connected");
    });
    ws.on("ping", () => arm(ws));
    ws.on("message", (data) => {
      let event;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (wakesFor(event, me.id)) wake(event.type);
    });
    // A refused upgrade (bad key, wrong company, a proxy without WebSockets)
    // arrives here as "Unexpected server response: <status>", then a close.
    ws.on("error", (err) => log.warn({ err: err.message }, "Paperclip events socket error — polling carries the board"));
    ws.on("close", (code) => {
      clearTimer(watchdog);
      if (socket === ws) socket = null;
      if (stopped) return;
      if (state === LIVE) log.warn({ code }, "Paperclip events dropped — reconnecting");
      reconnect();
    });
  }

  return {
    start() { connect(); },
    stop() {
      stopped = true;
      clearTimer(retry); clearTimer(watchdog);
      retry = null;
      try { socket?.close(); } catch { /* already closing */ }
      setState(OFF);
    },
    state: () => state,
  };
}

/**
 * Drive one board: poll at `pollMs` while events are off or down, at
 * `reconcileMs` while they are live, and tick at once on every wake. A state
 * change reschedules the next poll, so a socket that drops falls back to the
 * fast rate now rather than after a long reconcile wait.
 */
function startBoard({ tick, events = null, pollMs, reconcileMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  const interval = () => (events?.state() === LIVE ? reconcileMs : pollMs);
  const schedule = () => {
    clearTimer(timer);
    timer = setTimer(async () => {
      await tick("poll");
      schedule();
    }, interval());
  };
  schedule();
  events?.start();
  return { reschedule: schedule, interval, stop() { clearTimer(timer); events?.stop(); } };
}

module.exports = { RUN_EVENTS, LIVE, RECONNECTING, OFF, eventsUrl, wakesFor, backoffMs, eventsSetting, createLiveEvents, startBoard };
