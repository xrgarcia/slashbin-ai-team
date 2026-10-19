/**
 * Durable board attempts (EM#626): the work outlives the bot.
 *
 * A board task's Claude or Codex run used to be the bot's child, so a pm2
 * restart, deploy or crash killed it and recovery meant a person or a re-run.
 * Now each accepted attempt gets a directory under `<stateDir>/attempts/<id>/`
 * and a worker (lib/worker-run.js) that is nobody's child. The bot only watches
 * the directory: a bot that restarts finds the same attempt and follows it on.
 *
 *   accepted.json  written before launch: the attempt exists
 *   launch.claim   created exclusively: at most one launch, ever
 *   started.json   the worker holds attempt.lock and has started the provider
 *   out.jsonl      the provider's stdout, as it comes (session id included)
 *   exit.json      how it ended: { code, signal, cause }
 *
 * Alive means attempt.lock is held (flock): a kernel lock dies with its holder,
 * so a reused pid cannot pass for a live worker. What a directory says:
 *   exit.json                      finished (or stopped, or hit its limit)
 *   lock held                      running
 *   started, lock free, no exit    died — never launched again (no re-run)
 *   claimed, never started, grace  never started — the one case launched again
 *
 * `spec.gate`, when given, is an async check every launch passes first — the
 * first, and the relaunch of a claim that never started alike (the poller's
 * preflight: the dependencies it resumes on, then the card). It throws to
 * refuse: nothing launches, and the attempt ends with that error, marked
 * `launchRefused`. A refused attempt is left as it was (none or unlaunched),
 * for the next look to launch, gated again.
 */
"use strict";
const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } = require("fs");
const { join } = require("path");

const WORKER = join(__dirname, "worker-run.js");
// How long a claimed launch may take to start before it counts as never started.
const LAUNCH_GRACE_MS = 30000;
const LOCK_HELD = 75;

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

function createAttempts(stateDir, { now = Date.now, pollMs = 1000, launchGraceMs = LAUNCH_GRACE_MS } = {}) {
  const root = join(stateDir, "attempts");
  const dirOf = (id) => {
    if (!/^[A-Za-z0-9-]+$/.test(String(id))) throw new Error(`bad attempt id ${id}`);
    return join(root, String(id));
  };

  /** Whether a worker holds the attempt's lock right now. */
  function locked(dir) {
    if (!existsSync(join(dir, "attempt.lock"))) return false;
    return spawnSync("flock", ["-n", "-E", String(LOCK_HELD), join(dir, "attempt.lock"), "true"]).status === LOCK_HELD;
  }

  /** What the attempt's directory says, read fresh. */
  function state(id) {
    const dir = dirOf(id);
    if (!existsSync(join(dir, "accepted.json"))) return { phase: "none" };
    // A provider killed by a signal nobody here sent (no stop, no limit) died
    // mid-work, though its worker lived to record it: it may have acted.
    const ended = (exit) => ({ phase: exit.signal && !exit.cause ? "died" : "finished", exit, started: readJson(join(dir, "started.json")) });
    const exit = readJson(join(dir, "exit.json"));
    if (exit) return ended(exit);
    if (locked(dir)) return { phase: "running", started: readJson(join(dir, "started.json")) };
    // The lock was free a moment ago; a worker may have finished since.
    const late = readJson(join(dir, "exit.json"));
    if (late) return ended(late);
    const started = readJson(join(dir, "started.json"));
    if (started) return { phase: "died", started };
    let claimed = null;
    try { claimed = statSync(join(dir, "launch.claim")).mtimeMs; } catch { /* never claimed */ }
    if (claimed !== null && now() - claimed < launchGraceMs) return { phase: "launching" };
    return { phase: "unlaunched", claimed: claimed !== null };
  }

  function launch(id, { bin, args, cwd, env, timeoutMs, ownTmp }) {
    const dir = dirOf(id);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "accepted.json"))) writeJson(join(dir, "accepted.json"), { id, bin, at: new Date(now()).toISOString() });
    // One claim per launch. A launch that never started (it died before the
    // worker took the lock) drops its stale claim first, and only that one.
    const claim = join(dir, "launch.claim");
    if (existsSync(claim) && state(id).phase === "unlaunched") rmSync(claim, { force: true });
    let fd;
    try { fd = openSync(claim, "wx"); } catch { return false; }
    closeSync(fd);
    // setsid -f: forks, and the fork leads a session of its own, then exits at
    // once from the bot's side — the worker belongs to no tree pm2 kills.
    const p = spawn("setsid", ["-f", "flock", "-n", "-E", String(LOCK_HELD), join(dir, "attempt.lock"),
      process.execPath, WORKER, dir, String(timeoutMs || 0), ownTmp || "-", "--", bin, ...args], { cwd, env, stdio: "ignore" });
    p.on("error", () => { /* surfaced as never started */ });
    p.unref();
    return true;
  }

  /**
   * The attempt now carrying an ask. The bot may fall back once to a fresh
   * session (`<id>-fresh`, bot.js runClaude); the poller keeps the ask's
   * first id, so stop, alive and current follow it to the one that runs.
   */
  function latest(id) {
    while (state(`${id}-fresh`).phase !== "none") id = `${id}-fresh`;
    return id;
  }

  /** Stop a running attempt (or its fresh successor): its whole process group. False when none runs. */
  function stop(id, signal = "SIGTERM") {
    const s = state(latest(id));
    if (s.phase !== "running" || !s.started?.pgid) return false;
    try { process.kill(-s.started.pgid, signal); return true; } catch { return false; }
  }

  /**
   * Launch the attempt if it has never been, or follow it if it has. Returns
   * what spawn returns, as far as the bot reads one: stdout `data` events
   * (replayed from the start), `close(code)` once it ends, and kill(). A
   * worker that died after it started closes with code null and `died`.
   */
  function run(id, spec) {
    // The one place an attempt is launched from (launch): every call passes spec.gate first.
    const dir = dirOf(id);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.attemptId = id;
    child.kill = (signal) => stop(id, signal);
    const first = state(id);
    // tmpHanded: this call gave spec.ownTmp to a worker, which now removes it.
    // Otherwise the folder is still the caller's to remove.
    let offset = 0, done = false, gating = false;
    const launchNow = () => { if (launch(id, spec)) child.tmpHanded = Boolean(spec.ownTmp); };
    const refuse = (err) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (err && typeof err === "object") err.launchRefused = true;
      child.emit("error", err);
    };
    const start = () => {
      if (typeof spec.gate !== "function") return launchNow();
      gating = true;
      Promise.resolve().then(() => spec.gate()).then(() => { gating = false; if (!done) launchNow(); }, (err) => { gating = false; refuse(err); });
    };
    const drain = () => {
      const file = join(dir, "out.jsonl");
      if (!existsSync(file)) return;
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        for (let n; (n = readSync(fd, buf, 0, buf.length, offset)) > 0; offset += n) child.stdout.emit("data", buf.subarray(0, n));
      } finally { closeSync(fd); }
    };
    const end = (code, extra) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      drain();
      Object.assign(child, extra);
      child.emit("close", code);
    };
    const look = () => {
      if (gating || done) return;
      try {
        drain();
        const s = state(id);
        if (s.phase === "finished") return end(s.exit.code ?? null, { exit: s.exit, started: s.started });
        if (s.phase === "died") {
          // A killed worker never reached its own cleanup: the folder it recorded as its own goes now.
          if (s.started?.tmp) rmSync(s.started.tmp, { recursive: true, force: true });
          return end(null, { died: true, started: s.started, exit: s.exit });
        }
        if (s.phase === "unlaunched") {
          // Claimed, never started within the grace: launched once more, as
          // nothing of it ran. A second failure is reported, not retried.
          if (s.claimed && !child.relaunched) { child.relaunched = true; start(); return; }
          if (s.claimed) return end(null, { neverStarted: true });
          start();
        }
      } catch (err) {
        if (!done) { done = true; clearInterval(timer); child.emit("error", err); }
      }
    };
    const timer = setInterval(look, pollMs);
    if (first.phase === "none" || first.phase === "unlaunched") start();
    else child.adopted = first.phase;
    setImmediate(look);
    return child;
  }

  return { dirOf, state, run, stop, latest, current: (id) => state(latest(id)), alive: (id) => state(latest(id)).phase === "running" };
}

module.exports = { createAttempts };
