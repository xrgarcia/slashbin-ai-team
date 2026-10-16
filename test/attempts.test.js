// Board attempts outlive the bot (EM#626): lib/attempts.js and lib/worker-run.js,
// with real processes. Run: node test/attempts.test.js
"use strict";
const assert = require("assert");
const { spawnSync } = require("child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { createAttempts } = require("../lib/attempts");

let passes = 0, failures = 0;
const queue = [];
const check = (label, fn) => queue.push([label, fn]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (; Date.now() < end; await sleep(50)) if (fn()) return true;
  return false;
};
const closed = (child) => new Promise((resolve, reject) => {
  const data = [];
  child.stdout.on("data", (d) => data.push(d));
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, out: Buffer.concat(data).toString(), child }));
});

const root = mkdtempSync(join(tmpdir(), "attempts-test-"));
// A provider that counts its own launches, prints a session line, sleeps, then prints its answer.
const provider = join(root, "provider.sh");
writeFileSync(provider, `#!/bin/sh
echo run >> "$COUNT"
echo '{"type":"system","session_id":"s-1"}'
sleep "$SLEEP"
echo '{"type":"result","result":"done"}'
exit "\${CODE:-0}"
`, { mode: 0o755 });
const spec = (count, sleepS, extra = {}) => ({ bin: provider, args: [], cwd: root, timeoutMs: 0,
  env: { PATH: process.env.PATH, COUNT: count, SLEEP: String(sleepS), ...extra } });
const launches = (count) => (existsSync(count) ? readFileSync(count, "utf8").trim().split("\n").length : 0);
const fresh = () => createAttempts(mkdtempSync(join(root, "state-")), { pollMs: 50, launchGraceMs: 500 });

check("an attempt runs once, its output replayed whole and its end recorded", async () => {
  const a = fresh(), count = join(root, "c1");
  const r = await closed(a.run("a1", spec(count, 0)));
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /"session_id":"s-1"/);
  assert.match(r.out, /"result":"done"/);
  assert.strictEqual(a.state("a1").phase, "finished");
  assert.strictEqual(launches(count), 1);
});

check("a second bot following a running attempt never starts it again, and sees the same output", async () => {
  const dir = mkdtempSync(join(root, "state-"));
  const first = createAttempts(dir, { pollMs: 50 }), second = createAttempts(dir, { pollMs: 50 });
  const count = join(root, "c2");
  const one = closed(first.run("a2", spec(count, 1)));
  assert.ok(await until(() => first.state("a2").phase === "running"), "the worker holds its lock");
  const followed = second.run("a2", spec(count, 1));
  assert.strictEqual(followed.adopted, "running");
  const [r1, r2] = await Promise.all([one, closed(followed)]);
  assert.strictEqual(launches(count), 1, "launched once");
  assert.strictEqual(r1.out, r2.out, "the follower read what the worker wrote, from the start");
});

check("the worker survives the process that launched it (a bot restart)", async () => {
  const dir = mkdtempSync(join(root, "state-")), count = join(root, "c3");
  // A short-lived "bot" launches the attempt and exits at once.
  const bot = spawnSync(process.execPath, ["-e", `
    const { createAttempts } = require(${JSON.stringify(join(__dirname, "..", "lib", "attempts"))});
    const a = createAttempts(${JSON.stringify(dir)}, { pollMs: 50 });
    a.run("a3", ${JSON.stringify(spec(count, 1))});
    setTimeout(() => process.exit(0), 300);`], { stdio: "ignore", timeout: 10000 });
  assert.strictEqual(bot.status, 0);
  const a = createAttempts(dir, { pollMs: 50 });
  assert.strictEqual(a.state("a3").phase, "running", "still running after its launcher exited");
  const r = await closed(a.run("a3", spec(count, 1)));
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /"result":"done"/);
  assert.strictEqual(launches(count), 1);
});

check("a stop ends the worker and its provider, recorded as stopped", async () => {
  const a = fresh(), count = join(root, "c4");
  const p = closed(a.run("a4", spec(count, 30)));
  assert.ok(await until(() => a.state("a4").phase === "running" && launches(count) === 1));
  assert.strictEqual(a.stop("a4"), true);
  const r = await p;
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.child.exit.cause, "stopped");
  assert.strictEqual(a.alive("a4"), false);
  assert.strictEqual(a.stop("a4"), false, "nothing left to stop");
});

check("a worker killed outright is died: reported, never launched again", async () => {
  const a = fresh(), count = join(root, "c5");
  const p = closed(a.run("a5", spec(count, 30)));
  assert.ok(await until(() => a.state("a5").phase === "running" && launches(count) === 1));
  process.kill(-a.state("a5").started.pgid, "SIGKILL");
  const r = await p;
  assert.strictEqual(r.code, null);
  assert.strictEqual(r.child.died, true);
  assert.strictEqual(a.state("a5").phase, "died");
  const again = await closed(a.run("a5", spec(count, 0)));
  assert.strictEqual(again.child.died, true, "following it again still reports it died");
  assert.strictEqual(launches(count), 1, "never re-run");
});

check("accepted but never launched (the bot died first) is launched once", async () => {
  const dir = mkdtempSync(join(root, "state-")), count = join(root, "c6");
  const a = createAttempts(dir, { pollMs: 50, launchGraceMs: 500 });
  mkdirSync(join(dir, "attempts", "a6"), { recursive: true });
  writeFileSync(join(dir, "attempts", "a6", "accepted.json"), "{}");
  assert.strictEqual(a.state("a6").phase, "unlaunched");
  const r = await closed(a.run("a6", spec(count, 0)));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(launches(count), 1);
});

check("a claimed launch that never started is launched once more after the grace, then reported", async () => {
  const dir = mkdtempSync(join(root, "state-")), count = join(root, "c7");
  const a = createAttempts(dir, { pollMs: 50, launchGraceMs: 300 });
  const d = join(dir, "attempts", "a7");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "accepted.json"), "{}");
  writeFileSync(join(d, "launch.claim"), "");
  const old = (Date.now() - 5000) / 1000;
  utimesSync(join(d, "launch.claim"), old, old);
  assert.strictEqual(a.state("a7").phase, "unlaunched");
  const r = await closed(a.run("a7", spec(count, 0)));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(launches(count), 1);
});

check("the worker's own limit ends a run that outlasts it", async () => {
  const a = fresh(), count = join(root, "c8");
  const r = await closed(a.run("a8", { ...spec(count, 30), timeoutMs: 300 }));
  assert.strictEqual(r.child.exit.cause, "limit");
});

check("the provider gets exactly the environment it was given", async () => {
  const a = fresh(), count = join(root, "c9");
  const envDump = join(root, "env.sh");
  writeFileSync(envDump, "#!/bin/sh\necho \"{\\\"marker\\\":\\\"$ATTEMPT_MARK\\\",\\\"home\\\":\\\"$HOME\\\"}\"\n", { mode: 0o755 });
  const r = await closed(a.run("a9", { bin: envDump, args: [], cwd: root, timeoutMs: 0, env: { PATH: process.env.PATH, ATTEMPT_MARK: "m-9" } }));
  assert.match(r.out, /"marker":"m-9","home":""/);
  assert.ok(!existsSync(join(a.dirOf("a9"), "env.json")), "no environment is written to disk");
  void count;
});

check("an attempt id cannot name a path outside the attempts folder", () => {
  assert.throws(() => fresh().dirOf("../x"), /bad attempt id/);
});

(async () => {
  for (const [label, fn] of queue) {
    try { await fn(); console.log(`  ok   ${label}`); passes++; }
    catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); failures++; }
  }
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed\n`);
  if (failures) process.exit(1);
})();
