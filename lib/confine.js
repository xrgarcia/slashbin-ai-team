/**
 * Confinement: every agent process a bot starts runs inside a bubblewrap mount
 * namespace that holds only the folders the bot was given. Opt-in per bot with
 * BOT_CONFINE=true; a bot that does not set it starts its runs exactly as before.
 *
 * Why the whole process and not only its shell. Claude Code's own sandbox wraps
 * the Bash tool. Its Read, Grep and Glob tools run in the CLI's own process, where
 * the only limit is a permission rule — and a bot in bypass mode has none. A
 * customer bot needs the guarantee to hold whatever the model is talked into, so
 * the boundary is drawn around the process: a file outside it does not exist,
 * for `cat` and for Read alike (measured 2026-11-07: both report the file missing).
 *
 * What a confined run sees:
 *   - the system folders commands run from, read-only (/usr, /etc, and /bin,
 *     /lib, /lib64, /sbin as the host has them);
 *   - a private /tmp, its own /proc and a minimal /dev;
 *   - a home folder of its own (`home`, under the bot's state), so the host
 *     user's home — other repos, other bots' state, SSH keys, cloud logins, the
 *     CLI's transcripts of every other session — is absent. The CLI's sign-in
 *     file is the one thing carried in from the real home;
 *   - the agent binary and the Node install, read-only;
 *   - `write`: the working directory and the bot's memory, writable;
 *   - `read`: anything else the bot was given (its skill pack, its MCP config,
 *     BOT_CONFINE_READ), read-only.
 * The network is shared: the run must reach the model and its MCP servers.
 *
 * A host without bubblewrap refuses the run rather than running it open.
 */

const { existsSync, realpathSync, statSync, lstatSync, mkdirSync } = require("fs");
const { resolve, dirname, join, sep } = require("path");
const os = require("os");

/** The folders a confined run reads system files from, as the host lays them out. */
const CONFINE_SYSTEM = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

const listOf = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);

function real(p) {
  const abs = resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));
  try { return realpathSync.native(abs); } catch { return abs; }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ enabled: boolean, read: string[], write: string[], bwrap: string, problems: string[] }}
 */
function resolveConfine(env = process.env) {
  const raw = String(env.BOT_CONFINE || "").trim().toLowerCase();
  const enabled = raw === "true";
  const problems = [];
  if (raw && !["true", "false"].includes(raw)) problems.push(`BOT_CONFINE must be true or false, got "${env.BOT_CONFINE}"`);
  const read = listOf(env.BOT_CONFINE_READ);
  const write = listOf(env.BOT_CONFINE_WRITE);
  for (const p of [...read, ...write]) {
    if (!p.startsWith("/") && !p.startsWith("~")) problems.push(`BOT_CONFINE_READ/BOT_CONFINE_WRITE entries must be absolute paths, got "${p}"`);
  }
  return { enabled, read, write, bwrap: env.BOT_CONFINE_BWRAP || "bwrap", problems };
}

/**
 * Whether `p` is `root` or lies inside it.
 */
function within(p, root) {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The bubblewrap command that starts `bin args` confined.
 *
 * @param {object} o
 * @param {string} o.bin        the agent binary as the bot would start it
 * @param {string[]} o.args     its arguments
 * @param {string} o.cwd        the run's working directory (writable)
 * @param {string} o.home       the bot's own home folder on the host (created if missing)
 * @param {string[]} [o.write]  further writable folders: the bot's memory
 * @param {string[]} [o.read]   further read-only files or folders
 * @param {string[]} [o.hide]   folders inside a bound one that must stay empty
 * @param {string} [o.tmpDir]   a host folder to serve as the run's /tmp (else a fresh tmpfs)
 * @param {string} [o.bwrap]    the bubblewrap binary
 * @param {string} [o.hostHome] the host user's real home (tests)
 * @param {string} [o.nodeBin]  the Node binary the run's tools start (tests)
 * @returns {{ bin: string, args: string[] }}
 */
function confineCommand({ bin, args, cwd, home, write = [], read = [], hide = [], tmpDir = null, bwrap = "bwrap", hostHome = os.homedir(), nodeBin = process.execPath }) {
  const out = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  // System folders, as the host has them: a merged-/usr host links /bin to
  // usr/bin, and a symlink is recreated as one rather than bound over.
  for (const p of CONFINE_SYSTEM) {
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) out.push("--symlink", require("fs").readlinkSync(p), p);
    else out.push("--ro-bind", p, p);
  }
  out.push("--proc", "/proc", "--dev", "/dev");
  if (tmpDir) out.push("--bind", real(tmpDir), "/tmp");
  else out.push("--tmpfs", "/tmp");

  // The bot's own home, at the path the CLI expects its home to be. Created
  // here: a missing source is a refused run, and a first run has none yet.
  mkdirSync(join(home, ".claude"), { recursive: true });
  out.push("--bind", real(home), hostHome);
  // The sign-in, the one thing carried from the host user's home.
  const credentials = join(hostHome, ".claude", ".credentials.json");
  if (existsSync(credentials)) out.push("--bind", credentials, join(hostHome, ".claude", ".credentials.json"));

  // The agent binary, at the path it is started by and at its real path (a
  // versioned install is a symlink into a folder of releases), and Node, which
  // MCP servers and hook scripts start.
  const ro = new Set();
  const binPath = bin.includes("/") ? resolve(bin) : whichSync(bin);
  if (binPath) {
    const binReal = real(binPath);
    ro.add(dirname(binReal));
    if (binPath !== binReal) out.push("--ro-bind", binReal, binPath);
  }
  if (nodeBin) ro.add(dirname(dirname(real(nodeBin))));
  for (const p of read) ro.add(real(p));

  const rw = new Set([real(cwd), ...write.map(real)]);
  // A read-only path inside a writable one is already visible; one that holds a
  // writable path is bound first so the writable one lands on top of it.
  const roList = [...ro].filter((p) => existsSync(p) && ![...rw].some((w) => within(p, w)));
  const rwList = [...rw].filter((p) => existsSync(p));
  const depth = (p) => p.split(sep).length;
  for (const p of roList.sort((a, b) => depth(a) - depth(b))) out.push("--ro-bind", p, p);
  for (const p of rwList.sort((a, b) => depth(a) - depth(b))) out.push("--bind", p, p);
  for (const p of hide.map(real)) if (existsSync(p)) out.push("--tmpfs", p);

  out.push("--chdir", real(cwd), "--", binPath || bin, ...args);
  return { bin: bwrap, args: out };
}

/** `bin` as PATH resolves it, or null. */
function whichSync(bin) {
  for (const d of String(process.env.PATH || "").split(":").filter(Boolean)) {
    const p = join(d, bin);
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Why a confined bot cannot start, or [] when it can: bubblewrap must run here.
 */
function confineProblems(cfg) {
  if (!cfg.enabled) return [...cfg.problems];
  const problems = [...cfg.problems];
  const r = require("child_process").spawnSync(cfg.bwrap, ["--ro-bind", "/", "/", "--", "true"], { stdio: "ignore", timeout: 10000 });
  if (r.error || r.status !== 0) problems.push(`BOT_CONFINE=true but bubblewrap (${cfg.bwrap}) cannot start a sandbox on this host — install bwrap; a confined bot never runs open`);
  return problems;
}

module.exports = { resolveConfine, confineCommand, confineProblems, within, real, CONFINE_SYSTEM };
