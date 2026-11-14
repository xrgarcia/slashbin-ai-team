"use strict";
/**
 * Is the pid named in a bot's lock file still that bot?
 *
 * Every bot runs the same bot.js from the same directory, so cmdline and cwd
 * cannot tell one bot from another. After a reboot a stale pid can belong to a
 * sibling bot and pass both checks: 2026-11-14 the product-owner's lock held
 * 1979 from before the 6:22 am reboot, nova came back as 1979, and the PO bot
 * refused to start 15 times and stayed down for three hours.
 *
 * The rule that cannot be fooled by reuse: the bot writes its lock right after
 * it starts, so the real owner started BEFORE the lock was written. A process
 * that started after the lock file's mtime is a reuse, and the lock is stale.
 */
const fs = require("fs");

const CLK_TCK = 100; // Linux USER_HZ; /proc/<pid>/stat starttime is in these ticks
const SLACK_MS = 2000; // start time is rounded to a tick; the lock is written seconds later

/** When `pid` started, in epoch ms, from /proc. Null when it cannot be read. */
function processStartMs(pid, read = (p) => fs.readFileSync(p, "utf8")) {
  try {
    const stat = read(`/proc/${pid}/stat`);
    // Fields after the ")" that closes comm: state is field 3, starttime is field 22.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(rest[22 - 3]);
    const btime = Number(/^btime\s+(\d+)/m.exec(read("/proc/stat"))?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    return btime * 1000 + (ticks * 1000) / CLK_TCK;
  } catch {
    return null;
  }
}

/** True when the process started after the lock was written: the pid was reused. */
function startedAfterLock(pid, lockMtimeMs, read) {
  const start = processStartMs(pid, read);
  return start !== null && start > lockMtimeMs + SLACK_MS;
}

module.exports = { processStartMs, startedAfterLock };
