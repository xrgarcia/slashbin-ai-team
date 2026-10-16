#!/usr/bin/env node
/**
 * One board attempt's worker (EM#626). Started by lib/attempts.js through
 * `setsid -f flock -n <dir>/attempt.lock`, so it is nobody's child: not the
 * bot's, not pm2's, and a bot restart, deploy or crash does not reach it. It
 * holds the attempt's lock for its whole life — the lock being held is what
 * "alive" means, so a reused pid can never pass for it.
 *
 *   node worker-run.js <dir> <timeoutMs> -- <bin> <args…>
 *
 * The provider runs with this process's own environment, working directory and
 * arguments, exactly as the bot built them: the worker adds nothing and takes
 * nothing away. Its stdout goes to `out.jsonl` as it comes, so the session id
 * is on disk from the first event, and its end goes to `exit.json`. The limit
 * (`timeoutMs`, 0 for none) is the worker's own; no communication process
 * shortens it. It never talks to Paperclip: delivering the result is the bot's.
 */
"use strict";
const { spawn } = require("child_process");
const { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } = require("fs");
const { join } = require("path");

const [dir, timeoutArg, sep, bin, ...args] = process.argv.slice(2);
if (!dir || sep !== "--" || !bin) {
  process.stderr.write("usage: worker-run.js <dir> <timeoutMs> -- <bin> <args…>\n");
  process.exit(2);
}

function writeJson(name, value) {
  const file = join(dir, name);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

// The process group the stop signal goes to: flock's, which setsid made a session leader.
const pgid = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[2]);
writeJson("started.json", { pid: process.pid, pgid, at: new Date().toISOString() });

const out = openSync(join(dir, "out.jsonl"), "a");
const err = openSync(join(dir, "err.log"), "a");
const child = spawn(bin, args, { stdio: ["ignore", out, err] });
closeSync(out);
closeSync(err);

let cause = null;
const timeoutMs = Number(timeoutArg) || 0;
const timer = timeoutMs > 0 ? setTimeout(() => { cause = "limit"; child.kill("SIGTERM"); }, timeoutMs) : null;
// A stop (lib/attempts.js stop) signals the whole group; the provider gets it
// too. Recorded, so the end says it was stopped rather than that it failed.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { cause ??= "stopped"; child.kill(sig); });

function finish(code, signal, error) {
  if (timer) clearTimeout(timer);
  writeJson("exit.json", { code, signal, cause, ...(error ? { error } : {}), at: new Date().toISOString() });
  // A board run's private temp folder dies with the run that made it.
  const tmp = process.env.TMPDIR;
  if (tmp && /-board-[^/]+$/.test(tmp)) rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
child.on("error", (e) => finish(null, null, e.message));
child.on("exit", (code, signal) => finish(code, signal));
