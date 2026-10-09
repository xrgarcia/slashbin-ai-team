#!/usr/bin/env node
/**
 * Commit named files of this bot's own repo and push them to its upstream branch.
 *
 * A restricted bot that keeps its own notes current needs to land what it edits,
 * but a raw `git add` / `git commit` / `git push` allow rule hands it the whole
 * working tree: anyone else's uncommitted edits, local commits nobody pushed yet,
 * and every file in the repo, including the instructions that bound it. Those
 * rules can see a command's prefix, never which files it touches. This script is
 * the file check, and the bot's only way to commit.
 *
 * It lands ONLY the paths it is given, and only when each one matches
 * BOT_LAND_PATHS. Refused, before anything is written:
 *   - BOT_LAND_PATHS unset (landing is off by default)
 *   - a path outside the repo, or one that matches no pattern, or matches a `!` pattern
 *   - a folder or pattern that would carry ANY file failing that check: every
 *     concrete file git would commit is checked, not just the string given
 *   - a path with no change to land
 *   - a checkout with commits not yet on its upstream (landing would publish them)
 *   - a checkout behind its upstream that cannot fast-forward
 * Other files, staged or not, are left exactly as they were. The commit is built
 * outside the checkout and pushed by its id, so a commit another session makes
 * meanwhile is never published or undone by it, a rejected push leaves nothing
 * behind, and local commit hooks do not run (the server's still do).
 *
 * The repo is the bot's project (CLAUDE_CWD), never the current directory, so a
 * `cd` elsewhere cannot point it at another checkout. Who the commit is by and
 * which credential pushes it come from the environment (GIT_AUTHOR_*,
 * GIT_COMMITTER_*, GIT_SSH_COMMAND, GIT_CONFIG_*): this script sets neither.
 *
 * Usage:
 *   land.mjs --message "<what changed and why>" <path> [<path>...]
 * Exit codes: 0 landed | 1 refused or failed (nothing pushed).
 */
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { pathToFileURL } from "url";

function fail(msg) {
  process.stderr.write(`[land] REFUSED: ${msg}. Nothing was pushed.\n`);
  process.exit(1);
}

function git(root, args, opts = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts,
  }).trim();
}

function tryGit(root, args) {
  try { return { ok: true, out: git(root, args) }; }
  catch (e) { return { ok: false, out: `${e.stderr || ""}${e.stdout || ""}`.trim() || e.message }; }
}

/** A glob as a whole-path regex: `**` crosses directories, `*` and `?` do not. */
export function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether a repo-relative path may be landed under the pattern list. */
export function allowed(rel, patterns) {
  const include = patterns.filter((p) => !p.startsWith("!"));
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  return include.some((p) => globToRegex(p).test(rel)) && !exclude.some((p) => globToRegex(p).test(rel));
}

/**
 * The concrete files a path would commit: a file, or every changed file under a
 * folder. Literal pathspecs, so `*` in a name is a character, never a wildcard.
 * A rename reports both sides; both must be landable.
 */
function changedFiles(root, rel) {
  const out = execFileSync("git", ["-C", root, "--literal-pathspecs", "status", "--porcelain=v1", "-z",
    "--untracked-files=all", "--", rel], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parts = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    files.push(parts[i].slice(3));
    if (code[0] === "R" || code[0] === "C") files.push(parts[++i]);
  }
  return files;
}

export function parsePatterns(raw) {
  return (raw || "").split(",").map((p) => p.trim()).filter(Boolean);
}

function parseArgs(argv) {
  let message = "";
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--message" || argv[i] === "-m") message = argv[++i] || "";
    else if (argv[i] === "--") paths.push(...argv.slice(i + 1)), (i = argv.length);
    else if (argv[i].startsWith("-")) fail(`unknown option ${argv[i]}`);
    else paths.push(argv[i]);
  }
  return { message: message.trim(), paths };
}

function main() {
  const patterns = parsePatterns(process.env.BOT_LAND_PATHS);
  if (!patterns.some((p) => !p.startsWith("!"))) fail("landing is off for this bot (BOT_LAND_PATHS is not set)");
  const { message, paths } = parseArgs(process.argv.slice(2));
  if (!message) fail("--message is required: say what changed and why");
  if (!paths.length) fail("name at least one file to land");

  const project = process.env.CLAUDE_CWD || process.cwd();
  const top = tryGit(project, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) fail(`${project} is not a git checkout`);
  const root = top.out;

  const rels = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(root, p);
    const rel = relative(root, abs).split(sep).join("/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail(`${p} is outside this bot's repo`);
    // The check is on what git would commit, not on the string: a folder lands
    // when every changed file under it is allowed, and is refused if any is not.
    const files = changedFiles(root, rel);
    if (!files.length) fail(`${rel} has no change to land`);
    for (const file of files) {
      if (!allowed(file, patterns)) fail(`${file}${file === rel ? "" : ` (under ${rel})`} is not a file this bot may land (allowed: ${patterns.join(", ")})`);
      if (!rels.includes(file)) rels.push(file);
    }
  }

  const upstream = tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) fail("the current branch has no upstream to push to");
  const [remote, ...branchParts] = upstream.out.split("/");
  const branch = branchParts.join("/");
  const fetched = tryGit(root, ["fetch", "--quiet", remote, branch]);
  if (!fetched.ok) fail(`could not fetch ${upstream.out}: ${fetched.out}`);

  const ahead = Number(git(root, ["rev-list", "--count", "@{u}..HEAD"]));
  if (ahead > 0) fail(`this checkout has ${ahead} commit(s) not on ${upstream.out}; landing would publish them too`);
  const behind = Number(git(root, ["rev-list", "--count", "HEAD..@{u}"]));
  if (behind > 0) {
    const ff = tryGit(root, ["merge", "--ff-only", "--quiet", "@{u}"]);
    if (!ff.ok) fail(`could not catch up with ${upstream.out}: ${ff.out}`);
  }

  // The commit is built beside the checkout, never in it: another session can
  // commit here at any moment, so HEAD is never trusted to be this commit. It is
  // made from the upstream tip plus the checked files in a private index, pushed
  // by its id, and only then does the checkout move to it. A rejected push
  // leaves nothing to undo, and no local commit hook can add to it.
  const base = git(root, ["rev-parse", "@{u}"]);
  const scratch = mkdtempSync(join(tmpdir(), "land-"));
  let sha;
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    const step = (args) => {
      try { return git(root, args, { env }); }
      catch (e) { fail(`git ${args[0] === "--literal-pathspecs" ? args[1] : args[0]} failed: ${`${e.stderr || ""}`.trim() || e.message}`); }
    };
    step(["read-tree", base]);
    step(["--literal-pathspecs", "add", "-A", "--", ...rels]);
    const tree = step(["write-tree"]);
    sha = step(["commit-tree", tree, "-p", base, "-m", message]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const short = sha.slice(0, 7);

  // What is pushed is the commit, not the list: every path it touches must be
  // one that was checked.
  const inCommit = git(root, ["diff", "--name-only", "--no-renames", "-z", base, sha]).split("\0").filter(Boolean);
  const extra = inCommit.filter((f) => !rels.includes(f));
  if (extra.length) fail(`the commit would also carry ${extra.join(", ")}, which this bot was not asked to land`);

  const pushed = tryGit(root, ["push", "--quiet", remote, `${sha}:refs/heads/${branch}`]);
  if (!pushed.ok) fail(`the push was rejected, and every edit is still in the working tree: ${pushed.out}`);

  // A compare-and-swap: the checkout moves to the landed commit only if no one
  // has committed in it since the check.
  const moved = tryGit(root, ["update-ref", "-m", `land: ${message.split("\n")[0]}`, "HEAD", sha, base]);
  if (moved.ok) tryGit(root, ["--literal-pathspecs", "reset", "--quiet", sha, "--", ...rels]);
  else process.stderr.write(`[land] ${short} is on ${upstream.out}, but another commit was made in this checkout meanwhile, so the checkout was left where it is; whoever made that commit must rebase it onto ${upstream.out}.\n`);
  process.stdout.write(`landed ${short} on ${upstream.out}: ${rels.join(", ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
