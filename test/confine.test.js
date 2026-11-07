/**
 * Confinement (lib/confine.js): a confined run's process sees only what it was
 * given. Measured by running real commands inside bubblewrap, because the claim
 * is about what a process can open, not about the arguments we build. A host
 * without bubblewrap skips the live checks and says so; the argument checks run
 * everywhere.
 */
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } = require("fs");
const { join } = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const assert = require("assert");
const { resolveConfine, confineCommand, confineProblems, readWithin } = require("../lib/confine");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed++; } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`); failed++;
  }
}

const REPO = join(__dirname, "..");
const bot = readFileSync(join(REPO, "bot.js"), "utf8");

console.log("\nConfinement — settings");

check("off unless BOT_CONFINE=true", () => {
  assert.strictEqual(resolveConfine({}).enabled, false);
  assert.strictEqual(resolveConfine({ BOT_CONFINE: "false" }).enabled, false);
  assert.strictEqual(resolveConfine({ BOT_CONFINE: "true" }).enabled, true);
});

check("a misspelt value or a relative path is a problem, not a guess", () => {
  assert.ok(resolveConfine({ BOT_CONFINE: "yes" }).problems.length);
  assert.ok(resolveConfine({ BOT_CONFINE: "true", BOT_CONFINE_READ: "relative/dir" }).problems.length);
  assert.deepStrictEqual(resolveConfine({ BOT_CONFINE: "true", BOT_CONFINE_READ: "/a, /b", BOT_CONFINE_WRITE: "/c" }).problems, []);
});

check("a missing bubblewrap refuses the bot rather than running it open", () => {
  const p = confineProblems({ enabled: true, problems: [], bwrap: "/nonexistent/bwrap" });
  assert.ok(p.some((x) => /bubblewrap/.test(x)), p.join("; "));
});

console.log("\nConfinement — every run the bot starts goes through it");

check("the agent run is started through launchCommand", () => {
  assert.ok(/const launch = launchCommand\(RUNTIME\.bin, safeArgs/.test(bot));
  assert.ok(/attempts\.run\(opts\.attempt, \{ bin: launch\.bin, args: launch\.args/.test(bot));
  assert.ok(/spawn\(launch\.bin, launch\.args/.test(bot));
});

check("both summarizers are started through it too", () => {
  assert.strictEqual((bot.match(/wrap: summarizerLaunch,/g) || []).length, 2);
  const core = readFileSync(join(REPO, "lib/summarize-core.js"), "utf8");
  assert.ok(/spawn\(launch\.bin, launch\.args/.test(core));
});

check("a confined bot refuses to start when bubblewrap cannot run", () => {
  assert.ok(/\.\.\.confineProblems\(CONFINE\)/.test(bot));
});

check("a session is resumed only from the home it was made in", () => {
  assert.ok(/\(existingSession\.home \|\| ""\) === runHome\(channelId, opts\)/.test(bot));
});

console.log("\nConfinement — a file handed back must be one the run could read");

{
  const root = mkdtempSync(join(os.tmpdir(), "deliver-"));
  const fence = join(root, "fence"), outside = join(root, "outside");
  mkdirSync(fence); mkdirSync(outside);
  writeFileSync(join(fence, "report.csv"), "ok");
  writeFileSync(join(outside, "secret.txt"), "OTHER-CHANNEL");
  symlinkSync(join(outside, "secret.txt"), join(fence, "looks-local.csv"));

  check("a file inside the fence is read and handed back as bytes", () => {
    const r = readWithin(join(fence, "report.csv"), [fence], 1000);
    assert.ok(r.ok && r.data.toString() === "ok");
  });
  check("a path outside the fence is refused, whatever the reply names", () => {
    assert.strictEqual(readWithin(join(outside, "secret.txt"), [fence], 1000).ok, false);
  });
  check("a link inside the fence pointing out of it is refused", () => {
    assert.strictEqual(readWithin(join(fence, "looks-local.csv"), [fence], 1000).ok, false);
  });
  check("a folder or an oversized file is not sent", () => {
    assert.strictEqual(readWithin(fence, [root], 1000).reason, "not a file");
    assert.strictEqual(readWithin(join(fence, "report.csv"), [fence], 1).reason, "too large");
  });
  check("the bot sends what it read, and only through the fence when confined", () => {
    assert.ok(/const r = readWithin\(f, fence, MAX_OUTBOUND_BYTES\)/.test(bot));
    assert.ok(/file: \{ attachment: r\.data, name: basename\(f\) \}/.test(bot));
    assert.ok(/activeProcesses\.size === 0 && !CONFINE\.enabled/.test(bot));
  });
}

const live = confineProblems({ enabled: true, problems: [], bwrap: "bwrap" }).length === 0;
console.log(`\nConfinement — measured inside bubblewrap${live ? "" : " (SKIPPED: bwrap cannot run on this host)"}`);

if (live) {
  const root = mkdtempSync(join(os.tmpdir(), "confine-"));
  const hostHome = join(root, "realhome");
  const cwd = join(root, "repo");
  const chanA = join(root, "state", "channels", "A");
  const chanB = join(root, "state", "channels", "B");
  for (const d of [hostHome, cwd, chanA, chanB, join(hostHome, ".claude")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(cwd, "role.md"), "role");
  writeFileSync(join(chanA, "buffer.txt"), "A-SECRET");
  writeFileSync(join(chanB, "buffer.txt"), "B-SECRET");
  writeFileSync(join(hostHome, "id_rsa"), "HOST-KEY");
  writeFileSync(join(hostHome, ".claude", ".credentials.json"), "{}");

  const run = (script) => {
    const c = confineCommand({
      bin: "/bin/sh", args: ["-c", script], cwd, home: join(chanA, "home"),
      write: [chanA], hostHome, nodeBin: process.execPath,
    });
    return spawnSync(c.bin, c.args, { encoding: "utf8", timeout: 20000 });
  };

  check("the run reads its working directory and its own channel", () => {
    const r = run(`cat ${cwd}/role.md && cat ${chanA}/buffer.txt`);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, "roleA-SECRET");
  });

  check("another channel's folder does not exist for it", () => {
    const r = run(`cat ${chanB}/buffer.txt; ls ${join(root, "state", "channels")}`);
    assert.ok(!/B-SECRET/.test(r.stdout), "read another channel's buffer");
    assert.ok(!/(^|\n)B(\n|$)/.test(r.stdout), "listed another channel's folder");
  });

  check("the host user's home is replaced by the bot's own; only the sign-in is carried in", () => {
    const r = run(`cat ${hostHome}/id_rsa; test -f ${hostHome}/.claude/.credentials.json && echo CREDS`);
    assert.ok(!/HOST-KEY/.test(r.stdout), "read a file in the host user's home");
    assert.ok(/CREDS/.test(r.stdout), "the sign-in was not carried in");
  });

  check("it can write its channel and working directory, nothing else", () => {
    const r = run(`echo x > ${chanA}/note && echo y > ${cwd}/out && echo z > ${root}/escape; echo done`);
    assert.ok(existsSync(join(chanA, "note")) && existsSync(join(cwd, "out")), r.stderr);
    assert.ok(!existsSync(join(root, "escape")), "wrote outside its fence");
  });

  check("a private channel's folder is read-only to the run except its jobs folder", () => {
    mkdirSync(join(chanA, "jobs"), { recursive: true });
    const c = confineCommand({
      bin: "/bin/sh", args: ["-c", `cat ${chanA}/buffer.txt; ln -s /etc/passwd ${chanA}/planted; echo j > ${chanA}/jobs/schedules.json; echo done`],
      cwd, home: join(chanA, "home"), read: [chanA], write: [join(chanA, "jobs")], hostHome,
    });
    const r = spawnSync(c.bin, c.args, { encoding: "utf8", timeout: 20000 });
    assert.ok(/A-SECRET/.test(r.stdout), r.stderr);
    assert.ok(!existsSync(join(chanA, "planted")), "planted a link in the bot's part of the channel");
    assert.ok(existsSync(join(chanA, "jobs", "schedules.json")), "could not write its jobs");
  });

  check("the shared sign-in cannot be changed from inside", () => {
    const r = run(`echo HACKED > ${hostHome}/.claude/.credentials.json; echo done`);
    assert.strictEqual(readFileSync(join(hostHome, ".claude", ".credentials.json"), "utf8"), "{}", r.stderr);
  });

  check("a home that has become a link is refused, not bound", () => {
    const linked = join(root, "linked-home");
    symlinkSync(hostHome, linked);
    assert.throws(() => confineCommand({ bin: "/bin/sh", args: [], cwd, home: linked, write: [], hostHome }), /not a plain folder/);
  });

  check("Node runs inside it (MCP servers and hooks start with it)", () => {
    const c = confineCommand({ bin: process.execPath, args: ["-e", "console.log(1+1)"], cwd, home: join(chanA, "home"), write: [chanA], hostHome });
    const r = spawnSync(c.bin, c.args, { encoding: "utf8", timeout: 20000 });
    assert.strictEqual(r.stdout.trim(), "2", r.stderr);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
