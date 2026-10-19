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
 * BOT_LAND_PATHS. Refused, before anything is pushed:
 *   - BOT_LAND_PATHS unset (landing is off by default)
 *   - a path outside the repo, or one that matches no pattern, or matches a `!` pattern
 *   - a folder or pattern that would carry ANY file failing that check: every
 *     concrete file the commit would change is checked, not just the string given
 *   - a path with no change to land
 *   - a checkout behind its upstream that cannot fast-forward
 * A checkout holding commits not yet on its upstream (another session's) still
 * lands: the commit is built from the upstream tip, so theirs cannot ride along,
 * and HEAD is left on their commit for them to rebase. Refused then, per path:
 *   - a path one of those local commits changed (its content would publish them)
 *   - a path the upstream changed since they branched, unless the upstream's copy
 *     is exactly what this worktree itself last landed there (else the edit would
 *     undo someone's push)
 * A path is compared by its whole tree entry — mode, type and content — and the
 * commit is built from the files as they were checked, on the upstream commit
 * they were checked against. The model and its case matrix are docs/landing.md.
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
import { lstatSync, mkdtempSync, readlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { pathToFileURL } from "url";

/**
 * Where this worktree records what it landed, per upstream branch. refs/worktree/*
 * is private to the worktree that writes it, so a linked worktree's or another
 * clone's landing grants nothing here. (refs/land/beside-local, the shared
 * whole-commit ref an earlier version wrote, is no longer read.)
 */
const RECORD_PREFIX = "refs/worktree/land/";
/** The record commit's author: fixed, so the bot's identity is never needed for it. */
const RECORD_ID = { GIT_AUTHOR_NAME: "land", GIT_AUTHOR_EMAIL: "land@localhost", GIT_COMMITTER_NAME: "land", GIT_COMMITTER_EMAIL: "land@localhost" };

function fail(msg) {
  process.stderr.write(`[land] REFUSED: ${msg}. Nothing was pushed.\n`);
  process.exit(1);
}

function git(root, args, opts = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts,
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

/** Each listed path's entry in a commit's tree: "mode type oid", absent paths omitted. */
function treeEntries(root, rev, scope) {
  const out = {};
  if (!scope.length) return out;
  const raw = execFileSync("git", ["-C", root, "--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", rev, "--", ...scope],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  for (const line of raw.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    out[line.slice(tab + 1)] = line.slice(0, tab);
  }
  return out;
}

/** The files git knows in the working tree under a path: tracked, and untracked but not ignored. */
function workingFiles(root, rel) {
  return execFileSync("git", ["-C", root, "--literal-pathspecs", "ls-files", "-z", "-c", "-o", "--exclude-standard", "--", rel],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
}

const isGitlink = (entry) => entry.startsWith("160000 ");
const regularMode = (entry) => (/^100(644|755) /.test(entry || "") ? entry.slice(0, 6) : "");

/**
 * A path whose parent directory is a symlink reads, through the link, a file
 * that is not in this checkout; hashing it would publish that file's contents
 * under this path. Every ancestor between the root and the file must be a real
 * directory (or absent). The file itself may be a symlink: that is a literal entry.
 */
function refuseSymlinkedParent(root, rel) {
  const parts = rel.split("/").filter(Boolean);
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    let st;
    try { st = lstatSync(dir); } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return;
      throw e;
    }
    if (st.isSymbolicLink()) fail(`${rel} is behind a symlinked directory (${relative(root, dir)}), which leads outside this checkout's own files, so it is not landed`);
  }
}

/**
 * The working tree's entry for each file, hashed now, once: the commit is built
 * from these ids, so a file rewritten after this cannot change what is pushed.
 * Regular files go through git's filters as `git add` would; with
 * core.filemode=false the executable bit is not read, and the mode is the
 * upstream's (then HEAD's), as git would stage it.
 */
function workingEntries(root, files, modeFrom) {
  const filemode = tryGit(root, ["config", "--bool", "core.filemode"]).out !== "false";
  const out = {};
  const regular = [];
  for (const rel of files) {
    refuseSymlinkedParent(root, rel);
    let st;
    try { st = lstatSync(join(root, rel)); } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
      throw e;
    }
    if (st.isSymbolicLink()) {
      const oid = git(root, ["hash-object", "-w", "--no-filters", "--stdin"], { input: readlinkSync(join(root, rel)) });
      out[rel] = `120000 blob ${oid}`;
    } else if (st.isFile()) {
      const mode = filemode ? (st.mode & 0o100 ? "100755" : "100644") : modeFrom(rel) || "100644";
      regular.push([rel, mode]);
    } else if (!st.isDirectory()) fail(`${rel} is not a file git can commit`);
    // A directory where a file was is that file's absence; its files are paths of their own.
  }
  if (regular.length) {
    const oids = git(root, ["hash-object", "-w", "--stdin-paths"], { input: regular.map(([rel]) => `${rel}\n`).join("") }).split("\n");
    if (oids.length !== regular.length) fail("could not hash the files to land");
    regular.forEach(([rel, mode], i) => { out[rel] = `${mode} blob ${oids[i]}`; });
  }
  return out;
}

/** This worktree's landing record: { ref, old, paths: { path: { entry, commit } } }. Unreadable counts as empty. */
function readRecord(root, ref) {
  const old = tryGit(root, ["rev-parse", "--verify", "--quiet", ref]);
  const record = { ref, old: old.ok ? old.out : "", paths: {} };
  if (!old.ok) return record;
  try {
    const parsed = JSON.parse(git(root, ["cat-file", "blob", `${old.out}:record.json`]));
    for (const [rel, v] of Object.entries(parsed.paths || {})) {
      if (v && (v.entry === null || typeof v.entry === "string") && /^[0-9a-f]{40,64}$/.test(v.commit || "")) {
        record.paths[rel] = { entry: v.entry, commit: v.commit };
      }
    }
  } catch { /* an unreadable record grants nothing, and is replaced by the next write */ }
  return record;
}

/**
 * Change this worktree's record with `edit(paths)` and write it with a
 * compare-and-swap on the ref; a run that lost the race re-reads and edits again,
 * so overlapping landings each keep their own paths.
 */
function updateRecord(root, ref, edit) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = readRecord(root, ref);
    const paths = edit({ ...current.paths });
    const sorted = Object.fromEntries(Object.keys(paths).sort().map((k) => [k, paths[k]]));
    const json = `${JSON.stringify({ version: 1, paths: sorted }, null, 1)}\n`;
    const made = (() => {
      try {
        const blob = git(root, ["hash-object", "-w", "--stdin"], { input: json });
        const tree = git(root, ["mktree"], { input: `100644 blob ${blob}\trecord.json\n` });
        return git(root, ["commit-tree", tree, "-m", "land: what this worktree landed, per path"], { env: { ...process.env, ...RECORD_ID } });
      } catch { return ""; }
    })();
    if (!made) return false;
    const old = current.old || "0".repeat(made.length);
    if (tryGit(root, ["update-ref", "-m", "land: record", ref, made, old]).ok) return true;
    // Retry only when someone else moved the ref; a write that failed on its own is final.
    const now = tryGit(root, ["rev-parse", "--verify", "--quiet", ref]);
    if ((now.ok ? now.out : "") === current.old) return false;
  }
  return false;
}

/** Every staged rename in the checkout, as [from, to]: naming either side carries both. */
function stagedRenames(root) {
  const parts = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=no"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
  const pairs = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    if (code[0] === "R" || code[0] === "C") { pairs.push([parts[i + 1], parts[i].slice(3)]); i++; }
  }
  return pairs;
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

  const named = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(root, p);
    const rel = relative(root, abs).split(sep).join("/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail(`${p} is outside this bot's repo`);
    if (!named.includes(rel)) named.push(rel);
  }

  const upstream = tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) fail("the current branch has no upstream to push to");
  const [remote, ...branchParts] = upstream.out.split("/");
  const branch = branchParts.join("/");
  const fetched = tryGit(root, ["fetch", "--quiet", remote, branch]);
  if (!fetched.ok) fail(`could not fetch ${upstream.out}: ${fetched.out}`);

  // U is read once. Every check, the commit's base and the push are against this
  // id, so a fetch another session makes meanwhile cannot change what was checked.
  const U = git(root, ["rev-parse", "--verify", "@{u}^{commit}"]);
  let H = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const ahead = Number(git(root, ["rev-list", "--count", `${U}..${H}`]));
  const behind = Number(git(root, ["rev-list", "--count", `${H}..${U}`]));
  if (ahead === 0 && behind > 0) {
    const ff = tryGit(root, ["merge", "--ff-only", "--quiet", U]);
    if (!ff.ok) fail(`could not catch up with ${upstream.out}: ${ff.out}`);
    H = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (H !== U) fail(`another commit was made in this checkout while catching up with ${upstream.out}`);
  }
  const F = ahead === 0 ? H : git(root, ["merge-base", H, U]);

  // What each named path could carry: every file under it that git knows in the
  // working tree, in HEAD or upstream, and the other side of a staged rename.
  const under = (file, rel) => file === rel || file.startsWith(`${rel}/`);
  const renames = stagedRenames(root);
  const known = new Map(named.map((rel) => {
    const set = new Set([...workingFiles(root, rel), ...changedFiles(root, rel)]);
    for (const [from, to] of renames) if (under(from, rel) || under(to, rel)) set.add(from).add(to);
    return [rel, set];
  }));
  const scope = [...new Set([...named, ...[...known.values()].flatMap((set) => [...set])])];
  const atU = treeEntries(root, U, scope);
  const atH = treeEntries(root, H, scope);
  const atF = F === H ? atH : treeEntries(root, F, scope);
  for (const [rel, set] of known) for (const file of [...Object.keys(atU), ...Object.keys(atH)]) if (under(file, rel)) set.add(file);
  const files = [...new Set([...known.values()].flatMap((set) => [...set]))];
  const atW = workingEntries(root, files, (file) => regularMode(atU[file]) || regularMode(atH[file]));
  const entry = (at, file) => at[file] || "";

  // Provenance: this worktree landed the file as exactly what upstream now holds,
  // in a commit upstream contains.
  const recordRef = `${RECORD_PREFIX}${remote}/${branch}`;
  const record = readRecord(root, recordRef);
  const onUpstream = new Map();
  const own = (file) => {
    const r = record.paths[file];
    if (!r || (r.entry || "") !== entry(atU, file)) return false;
    if (!onUpstream.has(r.commit)) onUpstream.set(r.commit, tryGit(root, ["merge-base", "--is-ancestor", r.commit, U]).ok);
    return onUpstream.get(r.commit);
  };

  // A change differs from upstream and is this checkout's: edited here, or
  // landed here last (so a revert or a re-creation is a change, a stale copy not).
  const rels = [];
  for (const rel of named) {
    const carried = [...known.get(rel)].filter((file) => entry(atW, file) !== entry(atU, file)
      && (entry(atW, file) !== entry(atH, file) || own(file)));
    if (!carried.length) {
      if ([...known.get(rel)].some((file) => entry(atW, file) !== entry(atH, file))) fail(`${rel}: its changes already match ${upstream.out}, so there is no change to land`);
      fail(`${rel} has no change to land`);
    }
    for (const file of carried.sort()) {
      if (!allowed(file, patterns)) fail(`${file}${file === rel ? "" : ` (under ${rel})`} is not a file this bot may land (allowed: ${patterns.join(", ")})`);
      if (!rels.includes(file)) rels.push(file);
    }
  }
  for (const file of rels) {
    if ([atW, atU, atH, atF].some((at) => isGitlink(entry(at, file)))) fail(`${file} is a submodule, which this script does not land`);
    if (entry(atH, file) !== entry(atF, file)) fail(`${file} is changed by a commit in this checkout that is not on ${upstream.out}; landing it would publish that commit's content`);
    if (entry(atU, file) !== entry(atF, file) && !own(file)) {
      fail(`${upstream.out} changed ${file} since this checkout's local commit(s) branched from it; they must be rebased onto ${upstream.out} first`);
    }
  }

  // The commit is built beside the checkout, never in it: another session can
  // commit here at any moment, so HEAD is never trusted to be this commit. It is
  // U's tree with each checked entry written over it, in a private index, pushed
  // by its id, and only then does the checkout move to it. A rejected push
  // leaves nothing to undo, and no local commit hook can add to it.
  const scratch = mkdtempSync(join(tmpdir(), "land-"));
  let sha;
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    const step = (args, input) => {
      try { return git(root, args, { env, input }); }
      catch (e) { fail(`git ${args[0]} failed: ${`${e.stderr || ""}`.trim() || e.message}`); }
    };
    step(["read-tree", U]);
    const zero = "0".repeat(U.length);
    step(["update-index", "--index-info"], rels.map((file) => {
      const w = entry(atW, file);
      return w ? `${w.slice(0, 6)} ${w.split(" ")[2]}\t${file}\n` : `0 ${zero}\t${file}\n`;
    }).join(""));
    const tree = step(["write-tree"]);
    sha = step(["commit-tree", tree, "-p", U, "-m", message]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const short = sha.slice(0, 7);

  // What is pushed is the commit, not the list: it must change exactly the
  // checked paths, each to the entry that was checked.
  const inCommit = git(root, ["diff", "--name-only", "--no-renames", "-z", U, sha]).split("\0").filter(Boolean);
  const extra = inCommit.filter((f) => !rels.includes(f));
  if (extra.length) fail(`the commit would also carry ${extra.join(", ")}, which this bot was not asked to land`);
  const atSha = treeEntries(root, sha, rels);
  const wrong = rels.filter((file) => entry(atSha, file) !== entry(atW, file));
  if (wrong.length) fail(`the commit would not land ${wrong.join(", ")} as checked`);

  // Recorded before the push, so a run that dies after it still owns what it
  // landed; one that dies before leaves a commit upstream never contains, which
  // grants nothing.
  const prior = Object.fromEntries(rels.map((file) => [file, record.paths[file]]));
  if (!updateRecord(root, recordRef, (p) => {
    for (const file of rels) p[file] = { entry: entry(atW, file) || null, commit: sha };
    return p;
  })) fail(`could not record this landing in ${recordRef}, so a later landing could not tell it was this checkout's`);
  const unrecord = () => updateRecord(root, recordRef, (p) => {
    for (const file of rels) {
      if (p[file]?.commit !== sha) continue;
      if (prior[file]) p[file] = prior[file]; else delete p[file];
    }
    return p;
  });

  // A commit made in this checkout since the check may not have changed a landed path.
  const headNow = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headNow !== H) {
    const forkNow = git(root, ["merge-base", headNow, U]);
    const atHeadNow = treeEntries(root, headNow, rels), atForkNow = treeEntries(root, forkNow, rels);
    const taken = rels.filter((file) => entry(atHeadNow, file) !== entry(atForkNow, file));
    if (taken.length) {
      unrecord();
      fail(`${taken.join(", ")} was committed in this checkout while landing; whoever committed it must push or rebase it first`);
    }
  }

  const pushed = tryGit(root, ["push", "--quiet", remote, `${sha}:refs/heads/${branch}`]);
  if (!pushed.ok) {
    if (!unrecord()) process.stderr.write(`[land] could not take ${short} back out of ${recordRef}; it grants nothing, as it is not on ${upstream.out}.\n`);
    fail(`the push was rejected, and every edit is still in the working tree: ${pushed.out}`);
  }

  if (ahead > 0) {
    // HEAD stays on the other session's commit; the landed files stay edited in
    // the working tree.
    process.stderr.write(`[land] this checkout has ${ahead} commit(s) not on ${upstream.out}. They were not published, and the checkout was left on them; whoever made them must rebase onto ${upstream.out}.\n`);
    process.stdout.write(`landed ${short} on ${upstream.out}: ${rels.join(", ")}\n`);
    return;
  }

  // A compare-and-swap: the checkout moves to the landed commit only if no one
  // has committed in it since the check.
  const moved = tryGit(root, ["update-ref", "-m", `land: ${message.split("\n")[0]}`, "HEAD", sha, H]);
  if (moved.ok) tryGit(root, ["--literal-pathspecs", "reset", "--quiet", sha, "--", ...rels]);
  else process.stderr.write(`[land] ${short} is on ${upstream.out}, but another commit was made in this checkout meanwhile, so the checkout was left where it is; whoever made that commit must rebase it onto ${upstream.out}.\n`);
  process.stdout.write(`landed ${short} on ${upstream.out}: ${rels.join(", ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
