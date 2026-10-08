/**
 * land — a bot may commit and push only the files it names, and only those its
 * BOT_LAND_PATHS lets it land.
 *
 * A permission rule sees a git command's prefix, never which files it touches, so
 * allowing `git commit` would let a bot commit someone else's uncommitted edits
 * or the instructions that bound it. Every refusal below is a case the
 * permission system alone would have let through. Runs against a scratch
 * checkout and a local bare remote; no network.
 */
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { spawnSync, execFileSync } = require("child_process");
const assert = require("assert");

const LAND = join(__dirname, "..", "skill-pack", "bin", "land.mjs");
const PATTERNS = "notes/**,skills/**,!skills/guarded/**";

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

const ID = { GIT_AUTHOR_NAME: "bot", GIT_AUTHOR_EMAIL: "bot@example.com", GIT_COMMITTER_NAME: "bot", GIT_COMMITTER_EMAIL: "bot@example.com" };
const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...ID } }).trim();

/** A bare "origin" and a checkout of it with one commit, on main. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "land-"));
  const origin = join(dir, "origin.git"), repo = join(dir, "repo");
  g(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  g(dir, "clone", "--quiet", origin, repo);
  mkdirSync(join(repo, "notes")); mkdirSync(join(repo, "skills", "guarded"), { recursive: true });
  writeFileSync(join(repo, "notes", "company.md"), "v1\n");
  writeFileSync(join(repo, "RULES.md"), "rules\n");
  writeFileSync(join(repo, "skills", "guarded", "SKILL.md"), "guard\n");
  g(repo, "add", "."); g(repo, "commit", "--quiet", "-m", "init"); g(repo, "push", "--quiet", "-u", "origin", "main");
  return { dir, origin, repo };
}

function land(repo, args, env = {}) {
  const base = { ...process.env, ...ID, CLAUDE_CWD: repo, BOT_LAND_PATHS: PATTERNS };
  delete base.GIT_DIR;
  const r = spawnSync("node", [LAND, ...args], { cwd: repo, env: { ...base, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const remoteHead = (f) => g(f.repo, "ls-remote", f.origin, "refs/heads/main").split("\t")[0];
const refused = (r, re) => {
  assert.strictEqual(r.code, 1, `landed: ${r.out}`);
  assert.match(r.err, re);
};

console.log("\nland");

check("an allowed file lands on the upstream, and nothing else is committed", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  writeFileSync(join(f.repo, "RULES.md"), "someone else's edit\n");
  writeFileSync(join(f.repo, "notes", "draft.md"), "untracked, not named\n");
  const r = land(f.repo, ["--message", "correct the company", "notes/company.md"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(remoteHead(f), g(f.repo, "rev-parse", "HEAD"));
  assert.strictEqual(g(f.repo, "show", "--name-only", "--format=", "HEAD"), "notes/company.md");
  assert.match(g(f.repo, "status", "--porcelain"), /^M RULES\.md$/m);
  assert.match(g(f.repo, "status", "--porcelain"), /\?\? notes\/draft\.md/);
  rmSync(f.dir, { recursive: true, force: true });
});

check("a new file and a deletion both land", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "skills", "new.md"), "new\n");
  unlinkSync(join(f.repo, "notes", "company.md"));
  const r = land(f.repo, ["-m", "add and remove", "skills/new.md", "notes/company.md"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(g(f.repo, "show", "--name-status", "--format=", "HEAD").split("\n").sort(),
    ["A\tskills/new.md", "D\tnotes/company.md"]);
  rmSync(f.dir, { recursive: true, force: true });
});

check("someone else's staged edit stays staged and is not committed", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "RULES.md"), "staged by a person\n");
  g(f.repo, "add", "RULES.md");
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  const r = land(f.repo, ["-m", "x", "notes/company.md"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(g(f.repo, "show", "--name-only", "--format=", "HEAD"), "notes/company.md");
  assert.match(g(f.repo, "status", "--porcelain"), /^M  RULES\.md/m);
  rmSync(f.dir, { recursive: true, force: true });
});

check("landing is off without BOT_LAND_PATHS", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  refused(land(f.repo, ["-m", "x", "notes/company.md"], { BOT_LAND_PATHS: "" }), /landing is off/);
  refused(land(f.repo, ["-m", "x", "notes/company.md"], { BOT_LAND_PATHS: "!notes/**" }), /landing is off/);
  rmSync(f.dir, { recursive: true, force: true });
});

check("a file outside the patterns is refused, and nothing is committed", () => {
  const f = fixture();
  const before = remoteHead(f);
  writeFileSync(join(f.repo, "RULES.md"), "loosened\n");
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  refused(land(f.repo, ["-m", "x", "notes/company.md", "RULES.md"]), /RULES\.md is not a file this bot may land/);
  assert.strictEqual(remoteHead(f), before);
  assert.strictEqual(g(f.repo, "rev-parse", "HEAD"), before);
  rmSync(f.dir, { recursive: true, force: true });
});

check("a `!` pattern carves a file out of an allowed directory", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "skills", "guarded", "SKILL.md"), "unguarded\n");
  refused(land(f.repo, ["-m", "x", "skills/guarded/SKILL.md"]), /not a file this bot may land/);
  rmSync(f.dir, { recursive: true, force: true });
});

check("a path that climbs out of the repo is refused", () => {
  const f = fixture();
  refused(land(f.repo, ["-m", "x", "notes/../../origin.git/HEAD"]), /outside this bot's repo/);
  refused(land(f.repo, ["-m", "x", join(f.dir, "elsewhere.md")]), /outside this bot's repo/);
  rmSync(f.dir, { recursive: true, force: true });
});

check("the repo is CLAUDE_CWD, not the current directory", () => {
  const f = fixture(), other = fixture();
  writeFileSync(join(other.repo, "notes", "company.md"), "v2\n");
  const r = spawnSync("node", [LAND, "-m", "x", "notes/company.md"], {
    cwd: other.repo, env: { ...process.env, ...ID, CLAUDE_CWD: f.repo, BOT_LAND_PATHS: PATTERNS }, encoding: "utf8",
  });
  refused({ code: r.status, out: r.stdout, err: r.stderr }, /no change to land/);
  rmSync(f.dir, { recursive: true, force: true }); rmSync(other.dir, { recursive: true, force: true });
});

check("unpushed commits in the checkout block landing, so they are not published", () => {
  const f = fixture();
  const before = remoteHead(f);
  writeFileSync(join(f.repo, "RULES.md"), "local work\n");
  g(f.repo, "commit", "--quiet", "-am", "a person's local commit");
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  refused(land(f.repo, ["-m", "x", "notes/company.md"]), /1 commit\(s\) not on origin\/main/);
  assert.strictEqual(remoteHead(f), before);
  rmSync(f.dir, { recursive: true, force: true });
});

check("a checkout behind its upstream fast-forwards first, then lands", () => {
  const f = fixture();
  const peer = join(f.dir, "peer");
  g(f.dir, "clone", "--quiet", f.origin, peer);
  writeFileSync(join(peer, "RULES.md"), "pushed elsewhere\n");
  g(peer, "commit", "--quiet", "-am", "elsewhere"); g(peer, "push", "--quiet");
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  const r = land(f.repo, ["-m", "x", "notes/company.md"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(g(f.repo, "log", "--format=%s", "-2"), "x\nelsewhere");
  rmSync(f.dir, { recursive: true, force: true });
});

check("a rejected push undoes the commit and keeps the edit", () => {
  const f = fixture();
  const before = g(f.repo, "rev-parse", "HEAD");
  writeFileSync(join(f.origin, "hooks", "pre-receive"), "#!/bin/sh\necho refused by the server >&2\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  refused(land(f.repo, ["-m", "x", "notes/company.md"]), /push was rejected/);
  assert.strictEqual(g(f.repo, "rev-parse", "HEAD"), before);
  assert.strictEqual(g(f.repo, "status", "--porcelain"), "M notes/company.md");
  rmSync(f.dir, { recursive: true, force: true });
});

check("no message, no path, an unchanged path and an unknown option are refused", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  refused(land(f.repo, ["notes/company.md"]), /--message is required/);
  refused(land(f.repo, ["-m", "x"]), /name at least one file/);
  refused(land(f.repo, ["-m", "x", "skills/guarded/../new.md"]), /no change to land/);
  refused(land(f.repo, ["-m", "x", "--force", "notes/company.md"]), /unknown option --force/);
  rmSync(f.dir, { recursive: true, force: true });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
