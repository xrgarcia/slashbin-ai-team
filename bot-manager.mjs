#!/usr/bin/env node
// bot.js loads .env via dotenv; this manager did not, so a BOT_NAME set in .env
// reached the bot but not the manager — they then scoped their state files to
// different names and the manager tracked an instance that did not exist.
import "dotenv/config";
import { spawn, execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Instance identity ---
// bot.js scopes its state files by BOT_NAME; this manager did not. The moment you
// ran a second named bot — the advertised use case — both wrote .bot.pid and
// bot.log, so `status` reported whichever started last and `stop` could kill the
// wrong one. Scope both the same way. BOT_NAME defaults to "bot", which
// reproduces the previous filenames byte-for-byte for single-bot installs.
const argv = process.argv.slice(2);
const command = argv[0];
const nameFlag = argv.indexOf("--name");
const BOT_NAME = (nameFlag !== -1 ? argv[nameFlag + 1] : process.env.BOT_NAME) || "bot";

const PID_FILE = join(__dirname, `.${BOT_NAME}.pid`);
const READY_FILE = join(__dirname, `.${BOT_NAME}.ready`);
const LOG_FILE = join(__dirname, `${BOT_NAME}.log`);
const BOT_SCRIPT = join(__dirname, "bot.js");
const isWindows = process.platform === "win32";

/** Last fatal/error line the bot logged — the cause, not just "it failed". */
function lastErrorLine() {
  try {
    const lines = readFileSync(LOG_FILE, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/FATAL|ERROR/.test(lines[i])) {
        // Strip pino-pretty ANSI so the cause is readable when re-printed.
        return lines[i].replace(/\[[0-9;]*m/g, "").trim();
      }
    }
  } catch { /* no log yet */ }
  return null;
}

function isReady() {
  return existsSync(READY_FILE);
}

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    if (isWindows) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf8" });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    // Verify it's actually our bot process, not a reused PID
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmdline.includes("bot.js")) return false;
    } catch {
      // /proc not available (macOS) — trust the PID
    }
    return true;
  } catch {
    return false;
  }
}

function cleanPid() {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function start() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`Bot is already running (PID ${pid})`);
    process.exit(1);
  }
  cleanPid();

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [BOT_SCRIPT], {
    cwd: __dirname,
    stdio: ["ignore", logFd, logFd],
    detached: !isWindows,
    // Pass the resolved name through so bot.js scopes its state files to the same
    // instance this manager is tracking — otherwise `--name` would desync them.
    env: { ...process.env, BOT_NAME },
  });

  writeFileSync(PID_FILE, String(child.pid));

  if (!isWindows) child.unref();

  // Wait briefly and confirm the process is still alive
  setTimeout(() => {
    if (isRunning(child.pid)) {
      // "Process alive" is not "connected to Discord" — a rejected login used to
      // leave a permanently deaf process reporting success. Say which one it is.
      if (isReady()) {
        console.log(`Bot '${BOT_NAME}' started and connected to Discord (PID ${child.pid})`);
      } else {
        console.log(`Bot '${BOT_NAME}' started (PID ${child.pid}) — not yet connected to Discord.`);
        console.log(`Run 'npm run status${BOT_NAME === "bot" ? "" : ` -- --name ${BOT_NAME}`}' in a few seconds to confirm it connected.`);
      }
      console.log(`Logs: ${LOG_FILE}`);
    } else {
      // Naming only the log file made the user go hunting for the cause of the
      // single most common first-run failure. Print the cause here.
      const cause = lastErrorLine();
      console.error(`Bot '${BOT_NAME}' failed to start.`);
      if (cause) console.error(`  Cause: ${cause}`);
      console.error(`  Full log: ${LOG_FILE}`);
      cleanPid();
      process.exit(1);
    }
    process.exit(0);
  }, 2000);
}

function stop() {
  const pid = readPid();
  if (!isRunning(pid)) {
    console.log("Bot is not running");
    cleanPid();
    return;
  }

  console.log(`Stopping bot (PID ${pid})...`);
  try {
    if (isWindows) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGINT");
    }
  } catch (err) {
    console.error(`Failed to stop: ${err.message}`);
    process.exit(1);
  }

  // Wait for graceful shutdown (up to 5s)
  const deadline = Date.now() + 5000;
  const poll = setInterval(() => {
    if (!isRunning(pid) || Date.now() > deadline) {
      clearInterval(poll);
      if (isRunning(pid)) {
        console.log("Graceful shutdown timed out, force killing...");
        try {
          if (isWindows) {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch { /* already dead */ }
      }
      cleanPid();
      console.log("Bot stopped");
    }
  }, 200);
}

function restart() {
  const pid = readPid();
  if (isRunning(pid)) {
    stop();
    // Wait for stop to complete before starting
    const deadline = Date.now() + 6000;
    const poll = setInterval(() => {
      if (!isRunning(pid) || Date.now() > deadline) {
        clearInterval(poll);
        start();
      }
    }, 200);
  } else {
    cleanPid();
    start();
  }
}

function status() {
  const pid = readPid();
  if (isRunning(pid)) {
    if (isReady()) {
      console.log(`Bot '${BOT_NAME}' is running and connected to Discord (PID ${pid})`);
    } else {
      // The distinction that matters: a process can be alive and permanently deaf.
      console.log(`Bot '${BOT_NAME}' process is alive (PID ${pid}) but is NOT connected to Discord.`);
      const cause = lastErrorLine();
      if (cause) console.log(`  Cause: ${cause}`);
    }

    // Show uptime on Unix
    if (!isWindows) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const startTicks = parseInt(stat.split(" ")[21], 10);
        const uptime = readFileSync("/proc/uptime", "utf8");
        const systemUptime = parseFloat(uptime.split(" ")[0]);
        const clkTck = 100; // standard on Linux
        const processUptime = systemUptime - startTicks / clkTck;
        const hours = Math.floor(processUptime / 3600);
        const mins = Math.floor((processUptime % 3600) / 60);
        console.log(`Uptime: ${hours}h ${mins}m`);
      } catch {
        // /proc not available (macOS) — skip uptime
      }
    }

    // Show last 3 log lines
    try {
      const log = readFileSync(LOG_FILE, "utf8").trim().split("\n");
      const tail = log.slice(-3);
      console.log("\nRecent logs:");
      tail.forEach((l) => console.log(`  ${l}`));
    } catch { /* no log file */ }
  } else {
    console.log("Bot is not running");
    if (pid) {
      console.log(`(stale PID file referenced ${pid})`);
      cleanPid();
    }
  }
}

/** Every instance this checkout has state for — what you want when running a team. */
function list() {
  const seen = readdirSync(__dirname)
    .filter((f) => /^\.[^.]+\.pid$/.test(f))
    .map((f) => f.slice(1, -4));
  if (!seen.length) {
    console.log("No bot instances found in this checkout.");
    return;
  }
  console.log("NAME                 PID        STATE");
  for (const name of seen.sort()) {
    let pid = null;
    try { pid = parseInt(readFileSync(join(__dirname, `.${name}.pid`), "utf8").trim(), 10); } catch { /* stale */ }
    const alive = isRunning(pid);
    const ready = existsSync(join(__dirname, `.${name}.ready`));
    const state = !alive ? "stopped" : ready ? "connected" : "ALIVE BUT NOT CONNECTED";
    console.log(`${name.padEnd(20)} ${String(pid ?? "-").padEnd(10)} ${state}`);
  }
}

function logs() {
  // With `--name x` present, the count is no longer argv[3]; take the first bare number.
  const lines = parseInt(argv.slice(1).find((a) => /^\d+$/.test(a)), 10) || 20;
  try {
    const log = readFileSync(LOG_FILE, "utf8").trim().split("\n");
    log.slice(-lines).forEach((l) => console.log(l));
  } catch {
    console.log("No log file found");
  }
}

switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    restart();
    break;
  case "status":
    status();
    break;
  case "logs":
    logs();
    break;
  case "list":
    list();
    break;
  default:
    console.log(`Usage: node bot-manager.mjs <command> [--name <bot>]

Commands:
  start     Start the bot in the background
  stop      Stop the running bot gracefully
  restart   Stop and start the bot
  status    Show whether the bot is running AND connected to Discord
  list      Show every bot instance this checkout has state for
  logs [N]  Show last N lines of the log (default: 20)

Instance selection:
  --name <bot>   Operate on a named instance (default: $BOT_NAME, else "bot")

  Each instance gets its own .<name>.pid and <name>.log, so several bots can be
  managed from one checkout. For production supervision of a team, prefer PM2 or
  systemd; this manager is for development and single-bot installs.`);
    process.exit(command ? 1 : 0);
}
