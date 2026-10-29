/**
 * Where the gitignored `.internal-names` is. A linked worktree is a fresh
 * checkout, so the file is not there: a gate that only looked locally passed
 * vacuously for whoever worked in one. Fall back to the main worktree, the
 * parent of the repository's common git dir. No file anywhere (an outside
 * contributor) is null, not an error.
 */
const { execFileSync } = require("child_process");
const { existsSync } = require("fs");
const { dirname, isAbsolute, join, resolve } = require("path");

const NAME = ".internal-names";

function internalNamesPath(repo) {
  const local = join(repo, NAME);
  if (existsSync(local)) return local;
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const main = join(dirname(isAbsolute(common) ? common : resolve(repo, common)), NAME);
    if (existsSync(main)) return main;
  } catch { /* not a git checkout: nothing to look in */ }
  return null;
}

module.exports = { internalNamesPath, NAME };
