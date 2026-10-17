// Landing, tested from its specification: one scenario per row of the matrix in
// docs/landing.md, nothing written by hand here. Each row runs against a scratch
// checkout and a local bare remote; no network.
//
// A `hook` step puts a stand-in for git first on the landing's PATH: this same
// file, run as `git` (`--as-git`), which does the hook's steps once at the named git command
// and otherwise hands every call to the real git. That is how a row puts another
// writer between two of the landing's own git commands.
//
// Add a case by adding a row to the doc; a row this file cannot run is a failure.

const assert = require("assert");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");

const LAND = join(__dirname, "..", "skill-pack", "bin", "land.mjs");
const DOC = join(__dirname, "..", "docs", "landing.md");
const PATTERNS = "notes/**,skills/**,!skills/guarded/**";
const PATHS = { A: "notes/a.md", B: "notes/b.md", C: "notes/c.md", N: "notes" };
const RECORD = "refs/worktree/land/origin/main";
const ID = { GIT_AUTHOR_NAME: "bot", GIT_AUTHOR_EMAIL: "bot@example.com", GIT_COMMITTER_NAME: "bot", GIT_COMMITTER_EMAIL: "bot@example.com" };
const REAL_GIT = process.env.LAND_REAL_GIT || execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const g = (cwd, ...args) => execFileSync(REAL_GIT, args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...ID, GIT_CONFIG_NOSYSTEM: "1" },
}).trim();
const path = (name) => PATHS[name] || name;

/** Write an entry: `t` a file holding exactly t, `t+x` executable, `@t` a symlink to t, `-` absent. */
function setEntry(root, name, value) {
  const file = join(root, path(name));
  fs.rmSync(file, { force: true });
  if (value === "-") return;
  fs.mkdirSync(join(file, ".."), { recursive: true });
  if (value.startsWith("@")) return fs.symlinkSync(value.slice(1), file);
  const exec = value.endsWith("+x");
  fs.writeFileSync(file, exec ? value.slice(0, -2) : value);
  fs.chmodSync(file, exec ? 0o755 : 0o644);
}

/** The working tree's entry for a path, as git would stage it ("" when absent). */
function workingEntry(root, rel) {
  let st;
  try { st = fs.lstatSync(join(root, rel)); } catch { return ""; }
  if (st.isSymbolicLink()) {
    const oid = execFileSync(REAL_GIT, ["-C", root, "hash-object", "--no-filters", "--stdin"], { input: fs.readlinkSync(join(root, rel)), encoding: "utf8" }).trim();
    return `120000 blob ${oid}`;
  }
  return `${st.mode & 0o100 ? "100755" : "100644"} blob ${g(root, "hash-object", rel)}`;
}
const treeEntry = (repo, rev, rel) => {
  const line = g(repo, "ls-tree", rev, "--", rel);
  return line ? line.split("\t")[0] : "";
};

function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "landing-"));
  const origin = join(dir, "origin.git"), repo = join(dir, "repo");
  g(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  g(dir, "clone", "--quiet", origin, repo);
  setEntry(repo, "A", "a0"); setEntry(repo, "B", "b0");
  setEntry(repo, "RULES.md", "rules"); setEntry(repo, "skills/guarded/SKILL.md", "guard");
  g(repo, "add", "."); g(repo, "commit", "--quiet", "-m", "init"); g(repo, "push", "--quiet", "-u", "origin", "main");
  return { dir, origin, repo, runs: 0, peers: 0, hook: null };
}

const remoteTip = (ctx) => g(ctx.origin, "rev-parse", "main");

/** Run land in a checkout; returns { code, out, err, subject }. */
function runLand(ctx, names, { cwd = ctx.repo } = {}) {
  const subject = `run-${process.pid}-${++ctx.runs}-${Math.random().toString(36).slice(2, 8)}`;
  const env = { ...process.env, ...ID, CLAUDE_CWD: cwd, BOT_LAND_PATHS: PATTERNS };
  delete env.GIT_DIR; delete env.LAND_HOOK; delete env.LAND_CTX;
  if (ctx.hook) {
    const bin = join(ctx.dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(join(bin, "git"), `#!/bin/sh\nexec node ${JSON.stringify(__filename)} --as-git "$@"\n`, { mode: 0o755 });
    const mark = join(ctx.dir, `hook-${ctx.runs}`);
    fs.writeFileSync(mark, "");
    Object.assign(env, {
      PATH: `${bin}:${process.env.PATH}`, LAND_REAL_GIT: REAL_GIT,
      LAND_HOOK: JSON.stringify({ ...ctx.hook, mark }),
      LAND_CTX: JSON.stringify({ dir: ctx.dir, origin: ctx.origin, repo: ctx.repo, runs: ctx.runs + 100, peers: ctx.peers + 100 }),
    });
  }
  const hooked = Boolean(ctx.hook);
  ctx.hook = null;
  const ahead = Number(g(cwd, "rev-list", "--count", "@{u}..HEAD"));
  const head = g(cwd, "rev-parse", "HEAD");
  const r = spawnSync("node", [LAND, "-m", subject, ...names.map(path)], { cwd, env, encoding: "utf8" });
  // Whatever happened: nothing committed locally and unpushed reached the
  // upstream, and a checkout with such commits kept its HEAD.
  const published = g(ctx.origin, "log", "--format=%s", "main").split("\n").filter((s) => s.startsWith("local:"));
  assert.deepStrictEqual(published, [], `a local commit was published: ${published}`);
  if (ahead > 0 && !hooked) assert.strictEqual(g(cwd, "rev-parse", "HEAD"), head, "HEAD moved off the local commits");
  return { code: r.status, out: r.stdout, err: r.stderr, subject };
}

/** The commit a run landed, if the upstream holds it. */
function landedCommit(ctx, subject) {
  const line = g(ctx.origin, "log", "--format=%H %s", "main").split("\n").find((l) => l.endsWith(` ${subject}`));
  return line ? line.split(" ")[0] : "";
}

function commitHere(root, name, value, label) {
  setEntry(root, name, value);
  g(root, "add", "-A", "--", path(name));
  g(root, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", `local: ${label}`);
}

function step(ctx, text) {
  const [verb, ...args] = text.trim().split(/\s+/);
  const kv = (arg) => { const i = arg.indexOf("="); return [arg.slice(0, i), arg.slice(i + 1)]; };
  switch (verb) {
    case "ahead": return commitHere(ctx.repo, "RULES.md", `local ${++ctx.runs}`, "an unrelated change");
    case "local": return commitHere(ctx.repo, ...kv(args[0]), `${args[0]}`);
    case "commit": return commitHere(ctx.repo, ...kv(args[0]), `another session's ${args[0]}`);
    case "up": {
      const peer = join(ctx.dir, `peer-${++ctx.peers}`);
      g(ctx.dir, "clone", "--quiet", ctx.origin, peer);
      const [name, value] = kv(args[0]);
      setEntry(peer, name, value);
      g(peer, "add", "-A", "--", path(name)); g(peer, "commit", "--quiet", "-m", `elsewhere: ${args[0]}`); g(peer, "push", "--quiet");
      return;
    }
    case "rewrite": {
      const peer = join(ctx.dir, `peer-${++ctx.peers}`);
      g(ctx.dir, "clone", "--quiet", ctx.origin, peer);
      g(peer, "commit", "--quiet", "--amend", "--allow-empty", "-m", "rewritten");
      g(peer, "push", "--quiet", "--force");
      return;
    }
    case "edit": return setEntry(ctx.repo, ...kv(args[0]));
    case "mv": return g(ctx.repo, "mv", path(args[0]), path(args[1]));
    case "fetch": return g(ctx.repo, "fetch", "--quiet");
    case "land": {
      const r = runLand(ctx, args);
      assert.strictEqual(r.code, 0, `setup landing of ${args} refused: ${r.err}`);
      return;
    }
    case "land~": return runLand(ctx, args);
    case "wt": {
      const wt = join(ctx.dir, `wt-${++ctx.peers}`);
      g(ctx.repo, "worktree", "add", "--quiet", "-b", `wt-${ctx.peers}`, wt, "HEAD");
      g(wt, "branch", "--quiet", "--set-upstream-to=origin/main");
      const [name, value] = kv(args[0]);
      setEntry(wt, name, value);
      const r = runLand(ctx, [name], { cwd: wt });
      assert.strictEqual(r.code, 0, `the linked worktree's landing was refused: ${r.err}`);
      return;
    }
    case "filemode": return g(ctx.repo, "config", "core.filemode", args[0] === "off" ? "false" : "true");
    case "forget": return g(ctx.repo, "update-ref", "-d", RECORD);
    case "garble": {
      const blob = execFileSync(REAL_GIT, ["-C", ctx.repo, "hash-object", "-w", "--stdin"], { input: "not json{", encoding: "utf8" }).trim();
      const tree = execFileSync(REAL_GIT, ["-C", ctx.repo, "mktree"], { input: `100644 blob ${blob}\trecord.json\n`, encoding: "utf8" }).trim();
      return g(ctx.repo, "update-ref", RECORD, g(ctx.repo, "commit-tree", tree, "-m", "garbled"));
    }
    case "hook": {
      const m = text.trim().match(/^hook ([a-z-]+)(?::(\S+))? (before|after): (.+)$/);
      assert(m, `unreadable hook: ${text}`);
      ctx.hook = { cmd: m[1], ref: m[2] || "", when: m[3], steps: m[4].split(",").map((s) => s.trim()) };
      return;
    }
    default: throw new Error(`unknown step: ${text}`);
  }
}

/** Run as `git` by a hooked landing: do the hook's steps once, at its command. */
function asGit() {
  const args = process.argv.slice(3);
  const real = () => spawnSync(process.env.LAND_REAL_GIT, args, { stdio: "inherit" }).status;
  const hook = process.env.LAND_HOOK ? JSON.parse(process.env.LAND_HOOK) : null;
  if (!hook) process.exit(real());
  let i = 0;
  while (i < args.length && (args[i] === "-C" || args[i] === "-c" || args[i].startsWith("--"))) i += args[i].startsWith("--") ? 1 : 2;
  const fires = args[i] === hook.cmd && (!hook.ref || args.some((a) => a.startsWith(hook.ref))) && fs.existsSync(hook.mark);
  if (!fires) process.exit(real());
  fs.rmSync(hook.mark);
  const ctx = { ...JSON.parse(process.env.LAND_CTX), hook: null };
  const act = () => {
    for (const s of hook.steps) {
      if (s === "fail") { process.stderr.write("hook: failed\n"); process.exit(1); }
      if (s === "kill") process.kill(process.ppid, "SIGKILL");
      else step(ctx, s);
    }
  };
  if (hook.when === "before") act();
  const status = real();
  if (hook.when === "after") act();
  process.exit(status);
}

function cells(line) {
  return line.trim().slice(1, -1).split(" | ").map((c) => c.trim());
}

function runRow(row) {
  const ctx = fixture();
  try {
    for (const s of row.setup.split("; ")) step(ctx, s);
    const names = row.request.split(/\s+/);
    const r = runLand(ctx, names);
    const lands = row.expected.match(/^lands `(.+)`$/);
    const refused = row.expected.match(/^refused `\/(.+)\/`$/);
    if (lands) {
      assert.strictEqual(r.code, 0, `refused: ${r.err}`);
      const sha = landedCommit(ctx, r.subject);
      assert(sha, "the landed commit is not on the upstream");
      const want = lands[1].split(/\s+/).map(path).sort();
      assert.deepStrictEqual(g(ctx.origin, "diff-tree", "-r", "--no-renames", "--name-only", "--no-commit-id", `${sha}^`, sha).split("\n").sort(), want);
      for (const rel of want) assert.strictEqual(treeEntry(ctx.origin, sha, rel), workingEntry(ctx.repo, rel), `${rel} did not land as the working tree has it`);
    } else if (refused) {
      assert.strictEqual(r.code, 1, `landed: ${r.out}`);
      assert.match(r.err, new RegExp(refused[1]));
      assert.strictEqual(landedCommit(ctx, r.subject), "", "a refused landing reached the upstream");
    } else throw new Error(`unreadable expectation: ${row.expected}`);
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}

if (require.main === module && process.argv[2] === "--as-git") asGit();
else if (require.main === module) {
  let pass = 0, fail = 0;
  const rows = fs.readFileSync(DOC, "utf8").split("\n").filter((l) => /^\| [RL]\d+ \|/.test(l)).map((line) => {
    const [id, setup, request, expected, why] = cells(line);
    const code = (c) => c.replace(/^`|`$/g, "");
    return { id, setup: code(setup), request: code(request), expected, why };
  });
  console.log(`\nlanding (${rows.length} rows from docs/landing.md)`);
  assert(rows.length > 0, "no matrix rows found");
  for (const row of rows) {
    try { runRow(row); console.log(`  ok   ${row.id} ${row.why}`); pass++; }
    catch (e) { console.log(`  FAIL ${row.id} ${row.why}\n       ${e.message.split("\n").join("\n       ")}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
