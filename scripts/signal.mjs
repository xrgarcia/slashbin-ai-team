#!/usr/bin/env node
/**
 * Tell a bot that something happened.
 *
 *   node scripts/signal.mjs dev-deploy-done
 *   node scripts/signal.mjs ci:build --data "exit 0, 4m12s"
 *
 * A bot that booked a follow-up waiting on that name wakes immediately instead of
 * sitting out its timeout. That is the whole interface: a NAME, and optionally
 * some text. The prompt that runs was written by the bot itself, so nothing here
 * can tell it what to do — only that the thing it was waiting for has happened.
 *
 * Names mean nothing to the harness. `dev-deploy-done`, `nightly-etl`,
 * `invoice-run-finished` — whatever the sender and the bot agree on. Put this
 * line at the end of whatever already knows: a CI job, a git hook, a deploy
 * script, a systemd unit, another agent.
 *
 * Exits 0 when the bot accepted the signal (whether or not anything was waiting),
 * 1 when it was refused or the bot could not be reached — so it drops into a
 * script without becoming a new way for a pipeline to fail silently.
 */
import { WebSocket } from "ws";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};

// The first bare word, skipping any value that belongs to a preceding flag.
// Indexed rather than searched: two flags could carry the same value, and
// indexOf would then find the wrong one.
const VALUED_FLAGS = new Set(["--data", "--host", "--port", "--token", "--timeout"]);
let name = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    if (VALUED_FLAGS.has(argv[i])) i++;
    continue;
  }
  name = argv[i];
  break;
}

const askedForHelp = argv.includes("--help") || argv.includes("-h");
if (!name || askedForHelp) {
  console.log(`Usage: signal.mjs <name> [--data "<text>"] [--host <host>] [--port <n>] [--token <t>] [--timeout <ms>]

  <name>     what happened, e.g. dev-deploy-done. Agreed between you and the bot;
             the harness never interprets it.
  --data     optional text handed to the bot as untrusted evidence (build output,
             an error, a version). Long values are truncated, never rejected.
  --host     default 127.0.0.1        --port   default WS_PORT or 9800
  --token    required only when the bot's bridge is not on loopback (BRIDGE_TOKEN)
  --timeout  default 5000ms

Each bot has its own bridge port — signal the bot you want, not "the harness".`);
  process.exit(askedForHelp ? 0 : 1);
}

const host = flag("host") || "127.0.0.1";
const port = Number(flag("port") || process.env.WS_PORT || 9800);
const token = flag("token") || process.env.BRIDGE_TOKEN || undefined;
const timeoutMs = Number(flag("timeout") || 5000);
const data = flag("data") ?? undefined;

const ws = new WebSocket(`ws://${host}:${port}`);
let settled = false;

const done = (code, msg) => {
  if (settled) return;
  settled = true;
  if (msg) console[code ? "error" : "log"](msg);
  try { ws.close(); } catch { /* ignore */ }
  process.exit(code);
};

// A bot that is down must not hang a deploy script.
const timer = setTimeout(() => done(1, `No answer from the bot at ${host}:${port} within ${timeoutMs}ms — is it running?`), timeoutMs);
timer.unref?.();

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "signal", name, ...(data === undefined ? {} : { data }), ...(token ? { token } : {}) }));
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type !== "signal_ack") return;   // ping and handshake chatter are not ours
  done(msg.ok ? 0 : 1, msg.message || (msg.ok ? "delivered" : "refused"));
});

ws.on("error", (err) => done(1, `Could not reach the bot at ${host}:${port}: ${err.message}`));
ws.on("close", () => done(1, `The bot at ${host}:${port} closed the connection without answering.`));
