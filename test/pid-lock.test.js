/** A pid reused after a reboot must not lock a bot out (2026-11-14, PO bot down 3 h). */
const assert = require("assert");
const { processStartMs, startedAfterLock } = require("../lib/pid-lock");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

const BTIME = 1794658000; // boot, epoch seconds
// comm with spaces and a ")" inside, as /proc allows; starttime (field 22) = ticks
const statLine = (ticks) => `1979 (node (bot) x) S 1 1979 1979 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 11 0 ${ticks} 1000 100`;
const fake = (ticks) => (p) => (p === "/proc/stat" ? `cpu 1 2 3\nbtime ${BTIME}\n` : statLine(ticks));

check("start time = boot + ticks/100, comm with ')' parsed", () => {
  assert.strictEqual(processStartMs(1979, fake(2500)), BTIME * 1000 + 25000);
});
check("a process that started after the lock was written is a reuse", () => {
  const lockWritten = BTIME * 1000 - 3 * 3600 * 1000; // before the reboot
  assert.strictEqual(startedAfterLock(1979, lockWritten, fake(2500)), true);
});
check("the real owner started a moment before writing its lock: not a reuse", () => {
  const start = BTIME * 1000 + 25000;
  assert.strictEqual(startedAfterLock(1979, start + 1500, fake(2500)), false);
  assert.strictEqual(startedAfterLock(1979, start - 500, fake(2500)), false, "within the rounding slack");
});
check("unreadable /proc answers null and never calls the lock stale", () => {
  const boom = () => { throw new Error("ENOENT"); };
  assert.strictEqual(processStartMs(1979, boom), null);
  assert.strictEqual(startedAfterLock(1979, 0, boom), false);
});
check("bot.js consults startedAfterLock before refusing to start", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "bot.js"), "utf8");
  const guard = src.slice(src.indexOf("Duplicate instance guard"), src.indexOf("Readiness marker"));
  assert.ok(/startedAfterLock\(existingPid,\s*lockMtimeMs\)/.test(guard), "guard must check pid reuse");
});
check("this process, read from the real /proc, started before now", () => {
  if (process.platform !== "linux") return;
  const s = processStartMs(process.pid);
  assert.ok(s && s <= Date.now() && s > Date.now() - 3600_000, `start ${s}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
