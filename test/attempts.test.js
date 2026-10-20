// Board attempts outlive the bot: lib/attempts.js and lib/worker-run.js,
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

check("a worker wrapper killed alone leaves its provider running, stoppable, and never called stopped while it runs", async () => {
  const a = fresh(), count = join(root, "c5w");
  const p = closed(a.run("a5w", spec(count, 30)));
  assert.ok(await until(() => a.state("a5w").phase === "running" && launches(count) === 1));
  const { pid, pgid } = a.state("a5w").started;
  process.kill(pid, "SIGKILL");
  await sleep(500);
  assert.doesNotThrow(() => process.kill(-pgid, 0), "the provider outlives its wrapper");
  assert.strictEqual(a.state("a5w").phase, "running", "the provider holds the lock: the attempt is not over");
  assert.strictEqual(a.stop("a5w"), true, "a stop still reaches it");
  const r = await p;
  assert.strictEqual(r.child.died, true);
  assert.ok(await until(() => { try { process.kill(-pgid, 0); return false; } catch { return true; } }), "nothing left in its group");
  assert.strictEqual(a.state("a5w").phase, "died");
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

check("the worker removes only the temp folder it was handed, never an inherited TMPDIR", async () => {
  const a = fresh(), count = join(root, "c10");
  const shared = mkdtempSync(join(root, "shared-board-")), own = mkdtempSync(join(root, "own-board-"));
  const child = a.run("a10", { ...spec(count, 0, { TMPDIR: shared }), ownTmp: own });
  assert.strictEqual(child.tmpHanded, true, "the folder is the worker's to remove now");
  await closed(child);
  assert.ok(existsSync(shared), "an inherited TMPDIR named like a board folder stays");
  assert.ok(!existsSync(own), "the folder it was handed goes when it ends");
  const none = a.run("a10b", spec(join(root, "c10b"), 0, { TMPDIR: shared }));
  assert.ok(!none.tmpHanded);
  await closed(none);
  assert.ok(existsSync(shared), "with none handed, nothing is removed");
});

check("a provider killed outright while its worker lives is died, named by its signal, never re-run", async () => {
  const a = fresh(), count = join(root, "c11");
  const p = closed(a.run("a11", spec(count, 30)));
  assert.ok(await until(() => a.state("a11").phase === "running" && launches(count) === 1));
  // Only the provider: the sleeping shell, not the worker's group.
  spawnSync("pkill", ["-KILL", "-f", `^/bin/sh ${provider}$`]);
  const r = await p;
  assert.strictEqual(r.child.died, true);
  assert.strictEqual(r.child.exit.signal, "SIGKILL");
  assert.strictEqual(a.state("a11").phase, "died");
  assert.strictEqual(launches(count), 1);
});

check("stop, alive and current follow an attempt to its fresh successor", async () => {
  const a = fresh(), count = join(root, "c12");
  await closed(a.run("a12", { ...spec(count, 0), env: { ...spec(count, 0).env, CODE: "1" } }));
  const p = closed(a.run("a12-fresh", spec(count, 30)));
  assert.ok(await until(() => a.state("a12-fresh").phase === "running"));
  assert.strictEqual(a.latest("a12"), "a12-fresh");
  assert.strictEqual(a.alive("a12"), true, "the ask's first id sees the fresh one running");
  assert.strictEqual(a.current("a12").phase, "running");
  assert.strictEqual(a.stop("a12"), true, "a stop by the first id reaches the fresh one");
  const r = await p;
  assert.strictEqual(r.child.exit.cause, "stopped");
});

check("a launch the gate refuses runs nothing and ends with that error, marked launchRefused; a passing gate launches once", async () => {
  const a = fresh(), count = join(root, "c13");
  let asked = 0;
  const refused = new Error("open again");
  const err = await closed(a.run("a13", { ...spec(count, 0), gate: async () => { asked++; throw refused; } })).then(() => null, (e) => e);
  assert.strictEqual(err, refused);
  assert.strictEqual(err.launchRefused, true);
  await sleep(200);
  assert.strictEqual(launches(count), 0, "a refused gate launched the worker");
  assert.strictEqual(asked, 1);
  assert.notStrictEqual(a.state("a13").phase, "running");
  // The same attempt, its gate passing now: launched once.
  const r = await closed(a.run("a13", { ...spec(count, 0), gate: async () => { asked++; } }));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(launches(count), 1);
  assert.strictEqual(asked, 2);
});

check("a claim that never started is relaunched only through the gate", async () => {
  const dir = mkdtempSync(join(root, "state-")), count = join(root, "c14");
  const a = createAttempts(dir, { pollMs: 50, launchGraceMs: 300 });
  const d = join(dir, "attempts", "a14");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "accepted.json"), "{}");
  writeFileSync(join(d, "launch.claim"), "");
  const old = (Date.now() - 5000) / 1000;
  utimesSync(join(d, "launch.claim"), old, old);
  const err = await closed(a.run("a14", { ...spec(count, 0), gate: () => Promise.reject(new Error("card moved")) })).then(() => null, (e) => e);
  assert.ok(err?.launchRefused, "the relaunch did not end refused");
  await sleep(200);
  assert.strictEqual(launches(count), 0, "the relaunch skipped the gate");
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
