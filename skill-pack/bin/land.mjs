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
 *   - a path with no change to land
 *   - a checkout with commits not yet on its upstream (landing would publish them)
 *   - a checkout behind its upstream that cannot fast-forward
 * Other files, staged or not, are left exactly as they were. If the push is
 * rejected the commit is undone and the edits stay in the working tree.
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
import { isAbsolute, relative, resolve, sep } from "path";
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
    if (!allowed(rel, patterns)) fail(`${rel} is not a file this bot may land (allowed: ${patterns.join(", ")})`);
    if (!git(root, ["status", "--porcelain", "--", rel])) fail(`${rel} has no change to land`);
    rels.push(rel);
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

  const added = tryGit(root, ["add", "--", ...rels]);
  if (!added.ok) fail(`git add failed: ${added.out}`);
  const committed = tryGit(root, ["commit", "--quiet", "--only", "-m", message, "--", ...rels]);
  if (!committed.ok) fail(`git commit failed: ${committed.out}`);
  const sha = git(root, ["rev-parse", "--short", "HEAD"]);

  const pushed = tryGit(root, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`]);
  if (!pushed.ok) {
    tryGit(root, ["reset", "--soft", "HEAD~1"]);
    tryGit(root, ["restore", "--staged", "--", ...rels]);
    fail(`the push was rejected, so the commit was undone and the edits are still in the working tree: ${pushed.out}`);
  }
  process.stdout.write(`landed ${sha} on ${upstream.out}: ${rels.join(", ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
