/**
 * Confinement (lib/confine.js): a confined run's process sees only what it was
 * given. Measured by running real commands inside bubblewrap, because the claim
 * is about what a process can open, not about the arguments we build. A host
 * without bubblewrap skips the live checks and says so; the argument checks run
 * everywhere.
 */
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require("fs");
const { join } = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const assert = require("assert");
const { resolveConfine, confineCommand, confineProblems } = require("../lib/confine");

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

  check("Node runs inside it (MCP servers and hooks start with it)", () => {
    const c = confineCommand({ bin: process.execPath, args: ["-e", "console.log(1+1)"], cwd, home: join(chanA, "home"), write: [chanA], hostHome });
    const r = spawnSync(c.bin, c.args, { encoding: "utf8", timeout: 20000 });
    assert.strictEqual(r.stdout.trim(), "2", r.stderr);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
