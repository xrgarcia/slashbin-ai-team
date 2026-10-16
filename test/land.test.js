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
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } = require("fs");
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

check("naming a folder cannot carry an excluded file out with it", () => {
  // Second-pass review of 2.7.0: `skills/guarded` matched `skills/**`, and git
  // then committed skills/guarded/SKILL.md, which `!skills/guarded/**` excludes.
  const f = fixture();
  const before = remoteHead(f);
  writeFileSync(join(f.repo, "skills", "guarded", "SKILL.md"), "unguarded\n");
  writeFileSync(join(f.repo, "skills", "guarded", "new.md"), "new, also excluded\n");
  refused(land(f.repo, ["-m", "x", "skills/guarded"]), /skills\/guarded\/(SKILL|new)\.md \(under skills\/guarded\) is not a file/);
  refused(land(f.repo, ["-m", "x", "skills"]), /\(under skills\) is not a file/);
  refused(land(f.repo, ["-m", "x", "skills/"]), /is not a file/);
  assert.strictEqual(remoteHead(f), before);
  assert.strictEqual(g(f.repo, "rev-parse", "HEAD"), before);
  rmSync(f.dir, { recursive: true, force: true });
});

check("a wildcard is a literal name, never a pattern git expands", () => {
  const f = fixture();
  const before = remoteHead(f);
  writeFileSync(join(f.repo, "skills", "guarded", "SKILL.md"), "unguarded\n");
  refused(land(f.repo, ["-m", "x", "skills/*"]), /no change to land/);
  refused(land(f.repo, ["-m", "x", "skills/**"]), /no change to land/);
  refused(land(f.repo, ["-m", "x", ":(glob)skills/**"]), /no change to land|not a file/);
  assert.strictEqual(remoteHead(f), before);
  rmSync(f.dir, { recursive: true, force: true });
});

check("a folder whose changes are all allowed lands every one of them", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  writeFileSync(join(f.repo, "notes", "people.md"), "new\n");
  writeFileSync(join(f.repo, "RULES.md"), "someone else's edit\n");
  const r = land(f.repo, ["-m", "notes", "notes"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(g(f.repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort(),
    ["notes/company.md", "notes/people.md"]);
  assert.match(g(f.repo, "status", "--porcelain"), /^M RULES\.md$/m);
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

/** The fixture with a person's unpushed commit to RULES.md in the checkout. */
function aheadFixture() {
  const f = fixture();
  writeFileSync(join(f.repo, "RULES.md"), "local work\n");
  g(f.repo, "commit", "--quiet", "-am", "a person's local commit");
  return { ...f, local: g(f.repo, "rev-parse", "HEAD") };
}
/** Push a commit to origin from a second clone. */
function pushElsewhere(f, file, body) {
  const peer = join(f.dir, `peer-${Math.random().toString(36).slice(2)}`);
  g(f.dir, "clone", "--quiet", f.origin, peer);
  writeFileSync(join(peer, file), body);
  g(peer, "add", file); g(peer, "commit", "--quiet", "-m", `elsewhere: ${file}`); g(peer, "push", "--quiet");
}

check("an unpushed commit in the checkout is not published, and the named file still lands", () => {
  // SLA-1497: a person's unpushed doc commit in the PO checkout refused the
  // daily roadmap publish, though the commit is built from the upstream tip.
  const f = aheadFixture();
  const before = remoteHead(f);
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  const r = land(f.repo, ["-m", "x", "notes/company.md"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /1 commit\(s\) not on origin\/main\. They were not published.*must rebase/);
  assert.strictEqual(g(f.repo, "rev-parse", `${remoteHead(f)}~1`), before, "the landed commit is not on the old upstream tip");
  assert.strictEqual(g(f.repo, "diff", "--name-only", before, remoteHead(f)), "notes/company.md");
  assert.throws(() => g(f.repo, "merge-base", "--is-ancestor", f.local, remoteHead(f)), "the local commit was published");
  assert.strictEqual(g(f.repo, "rev-parse", "HEAD"), f.local, "HEAD moved off the local commit");
  rmSync(f.dir, { recursive: true, force: true });
});

check("beside an unpushed commit, it lands again the next day over its own earlier landing", () => {
  const f = aheadFixture();
  writeFileSync(join(f.repo, "notes", "company.md"), "day 1\n");
  assert.strictEqual(land(f.repo, ["-m", "day 1", "notes/company.md"]).code, 0);
  pushElsewhere(f, "notes/other.md", "someone's push\n");
  writeFileSync(join(f.repo, "notes", "company.md"), "day 2\n");
  const r = land(f.repo, ["-m", "day 2", "notes/company.md"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(g(f.repo, "show", `${remoteHead(f)}:notes/company.md`), "day 2");
  assert.strictEqual(g(f.repo, "show", `${remoteHead(f)}:notes/other.md`), "someone's push");
  assert.strictEqual(g(f.repo, "show", `${remoteHead(f)}:RULES.md`), "rules");
  assert.strictEqual(g(f.repo, "rev-parse", "HEAD"), f.local);
  rmSync(f.dir, { recursive: true, force: true });
});

check("beside an unpushed commit, a path that commit changed is refused", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "notes", "company.md"), "unpublished line\n");
  g(f.repo, "commit", "--quiet", "-am", "a person's local commit");
  const before = remoteHead(f);
  writeFileSync(join(f.repo, "notes", "company.md"), "unpublished line\nbot line\n");
  refused(land(f.repo, ["-m", "x", "notes/company.md"]), /changed by a commit in this checkout that is not on origin\/main/);
  assert.strictEqual(remoteHead(f), before);
  rmSync(f.dir, { recursive: true, force: true });
});

check("beside an unpushed commit, a path someone else pushed meanwhile is refused, not overwritten", () => {
  const f = aheadFixture();
  pushElsewhere(f, "notes/company.md", "pushed elsewhere\n");
  const before = remoteHead(f);
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  refused(land(f.repo, ["-m", "x", "notes/company.md"]), /changed notes\/company\.md since .*rebased/);
  assert.strictEqual(remoteHead(f), before);
  rmSync(f.dir, { recursive: true, force: true });
});

check("beside an unpushed commit, someone's push over its own earlier landing is refused", () => {
  const f = aheadFixture();
  writeFileSync(join(f.repo, "notes", "company.md"), "day 1\n");
  assert.strictEqual(land(f.repo, ["-m", "day 1", "notes/company.md"]).code, 0);
  pushElsewhere(f, "notes/company.md", "a person's correction\n");
  const before = remoteHead(f);
  writeFileSync(join(f.repo, "notes", "company.md"), "day 2\n");
  refused(land(f.repo, ["-m", "day 2", "notes/company.md"]), /changed notes\/company\.md since/);
  assert.strictEqual(remoteHead(f), before);
  rmSync(f.dir, { recursive: true, force: true });
});

check("beside an unpushed commit, a path already matching the upstream has nothing to land", () => {
  const f = aheadFixture();
  writeFileSync(join(f.repo, "notes", "company.md"), "day 1\n");
  assert.strictEqual(land(f.repo, ["-m", "day 1", "notes/company.md"]).code, 0);
  const before = remoteHead(f);
  refused(land(f.repo, ["-m", "again", "notes/company.md"]), /already match origin\/main/);
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

check("a rejected push leaves no commit behind and keeps the edit", () => {
  const f = fixture();
  const before = g(f.repo, "rev-parse", "HEAD");
  writeFileSync(join(f.origin, "hooks", "pre-receive"), "#!/bin/sh\necho refused by the server >&2\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  refused(land(f.repo, ["-m", "x", "notes/company.md"]), /push was rejected/);
  assert.strictEqual(g(f.repo, "rev-parse", "HEAD"), before);
  assert.strictEqual(g(f.repo, "status", "--porcelain"), "M notes/company.md");
  rmSync(f.dir, { recursive: true, force: true });
});

check("a commit hook cannot add to what lands", () => {
  // Second-pass review of 2.7.0: a pre-commit `git add -A` put RULES.md in the
  // commit, and land pushed it while reporting only the named file. The commit
  // is now built outside the checkout, where no local hook runs.
  const f = fixture();
  writeFileSync(join(f.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\ngit add -A\n", { mode: 0o755 });
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  writeFileSync(join(f.repo, "RULES.md"), "someone else's edit\n");
  const r = land(f.repo, ["-m", "x", "notes/company.md"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(g(f.repo, "diff", "--name-only", "HEAD~1", remoteHead(f)), "notes/company.md", "more than the named file was pushed");
  assert.strictEqual(g(f.repo, "status", "--porcelain"), "M RULES.md");
  rmSync(f.dir, { recursive: true, force: true });
});

// Another session committing in the same checkout while land is pushing.
const RACE = "#!/bin/sh\nunset GIT_INDEX_FILE\necho other > RULES.md\ngit -c core.hooksPath=/dev/null commit --quiet -m other -- RULES.md\n";

check("a commit another session makes after land's is never published by it", () => {
  // Second-pass review of 2.7.0: land pushed HEAD, so a commit that landed on
  // top of its own went out unchecked.
  const f = fixture();
  writeFileSync(join(f.repo, ".git", "hooks", "pre-push"), RACE, { mode: 0o755 });
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  const r = land(f.repo, ["-m", "x", "notes/company.md"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /checkout was left where it is/);
  assert.strictEqual(g(f.repo, "log", "--format=%s", "-1"), "other", "the other session's commit was moved");
  assert.strictEqual(g(f.repo, "log", "--format=%s", "-1", remoteHead(f)), "x");
  assert.strictEqual(g(f.repo, "diff", "--name-only", "HEAD~1", remoteHead(f)), "notes/company.md", "the other session's commit was pushed");
  rmSync(f.dir, { recursive: true, force: true });
});

check("a failed push never undoes another session's commit", () => {
  // Second-pass review of 2.7.0: the undo was `reset --soft HEAD~1`, which took
  // back whichever commit was on top.
  const f = fixture();
  writeFileSync(join(f.origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(f.repo, ".git", "hooks", "pre-push"), RACE, { mode: 0o755 });
  writeFileSync(join(f.repo, "notes", "company.md"), "v2\n");
  refused(land(f.repo, ["-m", "x", "notes/company.md"]), /push was rejected/);
  assert.strictEqual(g(f.repo, "log", "--format=%s", "-2"), "other\ninit", "a commit was taken back");
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
