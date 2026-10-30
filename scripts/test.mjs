#!/usr/bin/env node
/**
 * Run test files in order, each with TMPDIR pointed at one scratch directory that
 * this script removes when the run ends, pass or fail.
 *
 *   node scripts/test.mjs test/paperclip.test.js test/runtime.test.js
 *
 * The tests call mkdtempSync(join(tmpdir(), "pc-")) about 130 times and remove
 * almost none of it. On the bot host that was ~18,000 directories in /tmp in one
 * day, enough to hold the tmpfs above its inode limit (SLA-3046). Whatever fills
 * the temp folder is responsible for emptying it, so the runner owns the scratch
 * and every test, and every child process a test spawns, inherits it through
 * os.tmpdir(). No test has to remember to clean up for /tmp to stay clean.
 *
 * Stops at the first failing file and exits with its code, as the `&&` chain it
 * replaced did.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/test.mjs <test file>...");
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "slashbin-ai-team-test-"));
const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
const clean = () => rmSync(scratch, { recursive: true, force: true });

let code = 0;
try {
  for (const file of files) {
    const r = spawnSync(process.execPath, [file], { stdio: "inherit", env });
    code = r.status ?? 1;
    if (code !== 0) break;
  }
} finally {
  clean();
}
process.exit(code);
