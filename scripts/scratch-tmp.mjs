#!/usr/bin/env node
/**
 * Run a command with its own temp dir, and delete that dir when the command ends.
 *
 * WHY. The tests make a fresh temp dir per case (`mkdtempSync(join(tmpdir(), ...))`) and
 * none of them remove it. Agents run the suite many times a day, so on this host /tmp
 * collected ~80k such dirs in a week (2026-10-18: 67k `pc-*` from the bot's suite alone).
 * /tmp is a tmpfs capped at ~1M inodes; once it fills, no agent can run any command.
 *
 * Fixing each test is a promise every new test must keep. Pointing TMPDIR at one
 * per-run dir makes the leak impossible: os.tmpdir(), mktemp and Python's tempfile all
 * honour it, and the dir goes when the run does — pass, fail or Ctrl-C.
 *
 * Usage: node scripts/scratch-tmp.mjs <command> [args...]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: scratch-tmp.mjs <command> [args...]");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "test-run-"));
const cleanup = () => rmSync(dir, { recursive: true, force: true });

const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir } });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => { cleanup(); console.error(e.message); process.exit(127); });
child.on("exit", (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 128 : 1));
});
