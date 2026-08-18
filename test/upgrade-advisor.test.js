// The advisor's whole value is that it runs against an install that has NOT
// upgraded yet, so these build a real old-version checkout on disk and run the
// script against it. Asserting on the source would prove nothing about that.

const assert = require("assert");
const { execFileSync } = require("child_process");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const SCRIPT = join(__dirname, "..", "scripts", "upgrade-advisor.mjs");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function git(dir, argv) {
  execFileSync("git", argv, {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

/** A checkout that looks like a real pre-2.0 multi-bot install. */
function makeInstall({ version = "1.1.1", cron = null, permissionMode = null, stopExitCodes = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "advisor-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "slashbin-ai-team", version }));
  writeFileSync(join(dir, "bot.js"), "// harness\n");
  const modeLine = permissionMode ? `        BOT_PERMISSION_MODE: '${permissionMode}',\n` : "";
  const stopLine = stopExitCodes ? "      stop_exit_codes: [78],\n" : "";
  writeFileSync(join(dir, "ecosystem.config.js"), `module.exports = {
  apps: [
    {
      name: 'ben',
${stopLine}      env: {
        BOT_NAME: 'ben',
        DISCORD_TOKEN: process.env.BEN_DISCORD_TOKEN,
${modeLine}      },
    },
  ],
};
`);
  if (cron) {
    mkdirSync(join(dir, ".bot-history"), { recursive: true });
    writeFileSync(join(dir, ".bot-history", "schedules.json"),
      JSON.stringify([{ id: "sync", cron, channel: "1", prompt: "x" }]));
  }
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function advise(dir) {
  let out;
  try {
    out = execFileSync("node", [SCRIPT, "--dir", dir, "--json"], { encoding: "utf8" });
  } catch (e) {
    out = e.stdout; // non-zero exit is expected when there are blockers
  }
  return JSON.parse(out);
}

const made = [];
const build = (opts) => { const d = makeInstall(opts); made.push(d); return d; };

console.log("\nAdvisor runs against an install that has not upgraded");

check("reads the version of the TARGET directory, not its own", () => {
  const r = advise(build({ version: "1.1.1" }));
  assert.strictEqual(r.harness.installed, "1.1.1");
  assert.notStrictEqual(r.harness.target, "1.1.1");
});

check("a pre-2.0 install is told tool exposure will flip", () => {
  const r = advise(build({ version: "1.1.1" }));
  const hit = r.recommendations.find((x) => /Tool exposure/.test(x.title));
  assert.ok(hit, "no tool-exposure finding on a 1.x install");
  assert.strictEqual(hit.severity, "blocker");
  assert.deepStrictEqual(hit.evidence.botsMissingMode, ["ben"]);
});

check("a bot that already sets the mode is not flagged", () => {
  const r = advise(build({ version: "1.1.1", permissionMode: "bypass" }));
  assert.ok(!r.recommendations.some((x) => /Tool exposure/.test(x.title)));
});

check("an up-to-date install is not told about 2.0 breaking changes", () => {
  const r = advise(build({ version: "2.3.0" }));
  assert.ok(!r.recommendations.some((x) => /Tool exposure/.test(x.title)));
});

console.log("\nThe cost bug, before and after the version that fixes it");

check("a 5-minute job on 1.x is a blocker", () => {
  const r = advise(build({ version: "1.1.1", cron: "0,5,10,15,20,25,30,35,40,45,50,55 * * * *" }));
  const hit = r.recommendations.find((x) => /tighter than the session timeout/.test(x.title));
  assert.ok(hit, "tight schedule not detected");
  assert.strictEqual(hit.severity, "blocker");
  assert.strictEqual(hit.evidence.jobs[0].every, 5);
});

check("the same job on a fixed version is only a warning", () => {
  const r = advise(build({ version: "2.2.1", cron: "0,5,10,15,20,25,30,35,40,45,50,55 * * * *" }));
  const hit = r.recommendations.find((x) => /tighter than the session timeout/.test(x.title));
  assert.ok(hit);
  assert.strictEqual(hit.severity, "warn", "2.2.1+ already makes scheduled runs ephemeral");
});

check("a daily job is never flagged", () => {
  const r = advise(build({ version: "1.1.1", cron: "30 8 * * *" }));
  assert.ok(!r.recommendations.some((x) => /tighter than the session timeout/.test(x.title)));
});

check("schedules produce a backup action naming the real file", () => {
  const dir = build({ version: "1.1.1", cron: "30 8 * * *" });
  const r = advise(dir);
  const hit = r.recommendations.find((x) => /Back up schedules/.test(x.title));
  assert.ok(hit, "no backup recommendation");
  assert.match(hit.action, /schedules\.json/);
  assert.ok(hit.evidence.file.startsWith(dir), "backup path must be inside the analysed install");
});

console.log("\nWork an upgrade would destroy");

check("uncommitted changes are a blocker", () => {
  const dir = build({ version: "2.3.0" });
  writeFileSync(join(dir, "bot.js"), "// edited in place\n");
  const r = advise(dir);
  const hit = r.recommendations.find((x) => /Uncommitted changes/.test(x.title));
  assert.ok(hit);
  assert.strictEqual(hit.severity, "blocker");
});

check("no remote means it says so rather than reporting all-clear", () => {
  const r = advise(build({ version: "2.3.0" }));
  assert.ok(r.recommendations.some((x) => /Cannot tell whether this install has local commits/.test(x.title)),
    "silence here is a false all-clear on the thing an upgrade discards");
});

console.log("\nContract the calling agent depends on");

check("every recommendation is actionable and identified", () => {
  const r = advise(build({ version: "1.1.1", cron: "* * * * *" }));
  assert.ok(r.recommendations.length > 0);
  for (const rec of r.recommendations) {
    assert.match(rec.id, /^R\d\d$/);
    assert.ok(["blocker", "warn", "info"].includes(rec.severity), `bad severity ${rec.severity}`);
    assert.ok(rec.title && rec.why && rec.action, `incomplete recommendation ${rec.id}`);
  }
});

check("blockers sort ahead of warnings and info", () => {
  const r = advise(build({ version: "1.1.1", cron: "* * * * *" }));
  const rank = { blocker: 0, warn: 1, info: 2 };
  const seq = r.recommendations.map((x) => rank[x.severity]);
  assert.deepStrictEqual(seq, [...seq].sort((a, b) => a - b), "ordering is the agent's priority signal");
});

check("token variable NAMES are reported, values never", () => {
  const dir = build({ version: "1.1.1" });
  // Non-zero exit is expected whenever there are blockers, so read stdout either way.
  let raw;
  try {
    raw = execFileSync("node", [SCRIPT, "--dir", dir, "--json"], {
      encoding: "utf8",
      env: { ...process.env, BEN_DISCORD_TOKEN: "SUPER-SECRET-VALUE" },
    });
  } catch (e) {
    raw = e.stdout;
  }
  assert.match(raw, /BEN_DISCORD_TOKEN/, "the variable name is useful and must appear");
  assert.ok(!raw.includes("SUPER-SECRET-VALUE"), "a token value reached the output");
});

check("a directory that is not a harness exits cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "advisor-empty-"));
  made.push(dir);
  let code = 0;
  try {
    execFileSync("node", [SCRIPT, "--dir", dir, "--json"], { encoding: "utf8", stdio: "pipe" });
  } catch (e) { code = e.status; }
  assert.strictEqual(code, 2, "should exit 2, not crash or claim success");
});

for (const d of made) rmSync(d, { recursive: true, force: true });

const total = 14;
console.log(`\n${total - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
