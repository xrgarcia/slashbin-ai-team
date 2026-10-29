// The internal-names gate finds `.internal-names` in the main worktree when a
// linked worktree has none, and stays quiet when no copy exists anywhere.
const assert = require("assert");
const { execFileSync } = require("child_process");
const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { internalNamesPath, NAME } = require("./internal-names-path");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
const root = realpathSync(mkdtempSync(join(tmpdir(), "names-lookup-")));
const main = join(root, "main"), linked = join(root, "linked"), plain = join(root, "plain");
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok   ${name}`); };

try {
  mkdirSync(main); mkdirSync(plain);
  git(main, "init", "-q"); writeFileSync(join(main, "a.txt"), "x"); git(main, "add", "."); git(main, "commit", "-qm", "init");
  git(main, "worktree", "add", "-q", linked, "-b", "wt");

  t("no copy anywhere is null, not an error (an outside contributor)", () => {
    assert.strictEqual(internalNamesPath(main), null);
    assert.strictEqual(internalNamesPath(linked), null);
    assert.strictEqual(internalNamesPath(plain), null);
  });
  writeFileSync(join(main, NAME), "# none\n");
  t("a linked worktree with no copy finds the main worktree's", () => {
    assert.strictEqual(internalNamesPath(linked), join(main, NAME));
  });
  t("the main worktree finds its own", () => assert.strictEqual(internalNamesPath(main), join(main, NAME)));
  writeFileSync(join(linked, NAME), "# own\n");
  t("a local copy wins over the main worktree's", () => assert.strictEqual(internalNamesPath(linked), join(linked, NAME)));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed} passed, 0 failed`);
