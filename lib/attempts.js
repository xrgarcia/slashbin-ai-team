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
    const exit = readJson(join(dir, "exit.json"));
    if (exit) return { phase: "finished", exit, started: readJson(join(dir, "started.json")) };
    if (locked(dir)) return { phase: "running", started: readJson(join(dir, "started.json")) };
    // The lock was free a moment ago; a worker may have finished since.
    const late = readJson(join(dir, "exit.json"));
    if (late) return { phase: "finished", exit: late, started: readJson(join(dir, "started.json")) };
    const started = readJson(join(dir, "started.json"));
    if (started) return { phase: "died", started };
    let claimed = null;
    try { claimed = statSync(join(dir, "launch.claim")).mtimeMs; } catch { /* never claimed */ }
    if (claimed !== null && now() - claimed < launchGraceMs) return { phase: "launching" };
    return { phase: "unlaunched", claimed: claimed !== null };
  }

  function launch(id, { bin, args, cwd, env, timeoutMs }) {
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
      process.execPath, WORKER, dir, String(timeoutMs || 0), "--", bin, ...args], { cwd, env, stdio: "ignore" });
    p.on("error", () => { /* surfaced as never started */ });
    p.unref();
    return true;
  }

  /** Stop a running attempt: its whole process group. False when none runs. */
  function stop(id, signal = "SIGTERM") {
    const s = state(id);
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
    const dir = dirOf(id);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.attemptId = id;
    child.kill = (signal) => stop(id, signal);
    const first = state(id);
    if (first.phase === "none" || first.phase === "unlaunched") launch(id, spec);
    else child.adopted = first.phase;
    let offset = 0, done = false;
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
      try {
        drain();
        const s = state(id);
        if (s.phase === "finished") return end(s.exit.code ?? null, { exit: s.exit, started: s.started });
        if (s.phase === "died") return end(null, { died: true, started: s.started });
        if (s.phase === "unlaunched") {
          // Claimed, never started within the grace: launched once more, as
          // nothing of it ran. A second failure is reported, not retried.
          if (s.claimed && !child.relaunched) { child.relaunched = true; launch(id, spec); return; }
          if (s.claimed) return end(null, { neverStarted: true });
          launch(id, spec);
        }
      } catch (err) {
        if (!done) { done = true; clearInterval(timer); child.emit("error", err); }
      }
    };
    const timer = setInterval(look, pollMs);
    setImmediate(look);
    return child;
  }

  return { dirOf, state, run, stop, alive: (id) => state(id).phase === "running" };
}

module.exports = { createAttempts };
