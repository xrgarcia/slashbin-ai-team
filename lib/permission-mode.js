/**
 * One resolution of the tool-permission mode, for every process that needs it.
 *
 * Two processes decide this — bot.js for a session, summarize.js for a standalone
 * summarization run — and they used to decide it separately, each reading
 * `process.env.BOT_PERMISSION_MODE` with its own inline fallback. That is the same
 * duplication documented at the top of summarize-core.js, where adding this very
 * setting once needed three identical edits. A second resolution site is how a
 * fleet default gets honoured in one process and silently ignored in the other.
 *
 * ## Precedence
 *
 *   1. `BOT_PERMISSION_MODE`          — this bot. Always wins.
 *   2. `BOT_PERMISSION_MODE_DEFAULT`  — every bot on this host that sets no mode.
 *   3. `"restricted"`                 — the built-in default.
 *
 * The fleet variable exists because the per-bot one is the only control there was,
 * and on a multi-bot host that means writing the same line into every app entry.
 * Measured on a real fleet: 8 bots, 8 identical edits, and the failure mode of
 * missing one is a bot that still answers questions and has quietly lost the
 * ability to write a file — nothing errors, so nobody notices.
 *
 * Two variables rather than one because by the time a bot is running, a per-bot
 * value and a host value are both just environment. Only distinct names can tell
 * "this bot chose restricted" apart from "nobody said anything."
 *
 * Nothing here changes an existing install: with neither variable set the answer
 * is still `restricted`, and a bot that sets `BOT_PERMISSION_MODE` is unaffected
 * by any host default.
 */

/** The only two answers. An unrecognised mode is a startup failure, never a guess. */
const VALID_MODES = ["bypass", "restricted"];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mode: string, source: string }} `source` names where the value came
 *   from, so the startup log can distinguish an explicit `restricted` from an
 *   unset one — the question a fleet operator asks when one bot behaves
 *   differently from its siblings.
 */
function resolvePermissionMode(env = process.env) {
  const perBot = (env.BOT_PERMISSION_MODE || "").trim();
  if (perBot) return { mode: perBot, source: "BOT_PERMISSION_MODE" };

  const fleet = (env.BOT_PERMISSION_MODE_DEFAULT || "").trim();
  if (fleet) return { mode: fleet, source: "BOT_PERMISSION_MODE_DEFAULT (host default)" };

  return { mode: "restricted", source: "built-in default" };
}

/**
 * The rule that lets a restricted session read the files people upload to it.
 * Attachments are saved under BOT_ATTACHMENTS_DIR, which is normally outside
 * CLAUDE_CWD, and dontAsk denies a Read outside the working directory unless a
 * rule names it — so without this an uploaded file is unreadable. `//` marks an
 * absolute path in a permission rule. Read only: nothing else is granted there.
 *
 * @param {string} dir the attachments directory
 * @returns {string}
 */
function attachmentReadRule(dir) {
  const abs = require("path").resolve(dir).replace(/\/+$/, "");
  return `Read(/${abs}/**)`;
}

/**
 * What a run whose reply leaves Discord (a Paperclip board task) must not reach.
 * Everything here is Discord conversation memory: the buffer and summaries, the
 * files people uploaded, which channels are live, and what scheduled jobs said
 * and will say. Keeping it out of the prompt is not enough — the recall skill
 * finds these stores through the environment, and the read tools reach them by
 * path. So a board run gets none of the variables, and a deny rule on each path,
 * which holds in every mode (deny beats allow, and bypass keeps deny rules).
 * Read rules do not bind the shell, so any shell a board run is allowed runs in
 * Claude Code's sandbox with the same paths unreadable (boardSettings).
 */
const PRIVATE_MEMORY_ENV = ["BOT_SUMMARIES_DIR", "BOT_BUFFER_FILE", "BOT_ATTACHMENTS_DIR",
  "BOT_SESSIONS_FILE", "BOT_JOB_HISTORY_FILE", "BOT_SCHEDULES_FILE"];

/**
 * The bot's own Discord credentials. A board run has no Discord channel to
 * answer in, and anything its shell can print can land in a reply every board
 * reader sees: with the bot token a reader could log in as the bot and read its
 * private channels; with the bridge token, post as it. The sandbox guards files,
 * not an inherited environment, so these are withheld from the run.
 */
const DISCORD_CREDENTIAL_ENV = ["DISCORD_TOKEN", "BRIDGE_TOKEN"];

/**
 * The bot variables a board run keeps: the ones the skill pack's hooks and
 * scripts read, minus the private stores. The mail and calendar gates are off
 * when their variable is unset, so these must reach the run.
 */
const BOARD_BOT_ENV = ["BOT_STATE_DIR", "BOT_OUTBOX_DIR", "BOT_CHANNEL_ID", "BOT_NAME",
  "BOT_TIMEZONE", "BOT_MAIL_ALLOWED_RECIPIENTS", "BOT_MAIL_SUBJECT_PREFIX",
  "BOT_CALENDAR_NO_ATTENDEES", "BOT_CALENDAR_OWN_EVENTS", "BOT_CALENDAR_TITLE_PREFIX",
  "BOT_LAND_PATHS", "BOT_MAX_WAKE_ATTEMPTS", "BOT_MAX_SCHEDULED_JOBS"];

/**
 * Whether a variable is withheld from a board run. The run gets everything it
 * needs from the bot as arguments, and the bot's own configuration can carry a
 * credential: an inline BOT_SETTINGS with an `env` block, an inline
 * MCP_CONFIG_EXTRA with a server's token, a Paperclip key. A board shell can
 * print its environment into a reply every board reader sees, and the sandbox
 * guards files, not the environment. So every BOT_* variable outside
 * BOARD_BOT_ENV is withheld, a new one included, along with the MCP config, the
 * Discord credentials and anything naming Paperclip.
 *
 * @param {string} name
 * @returns {boolean}
 */
function withheldFromBoard(name) {
  if (BOARD_BOT_ENV.includes(name)) return false;
  return /^BOT_/.test(name) || /^MCP_CONFIG/.test(name) || /PAPERCLIP/.test(name) || DISCORD_CREDENTIAL_ENV.includes(name);
}

/**
 * Whether a variable is withheld from a `parity` board run. Such a run has
 * everything the bot's Discord session has — its MCP servers and their keys,
 * Doppler, the BOT_* paths — except the harness's own identity: the Discord
 * credentials, which would let a reply log in or post as the bot. (The
 * Paperclip connector keys are removed from every run, Discord's included.)
 *
 * @param {string} name
 * @returns {boolean}
 */
function withheldFromParityBoard(name) {
  return DISCORD_CREDENTIAL_ENV.includes(name);
}

/**
 * The part of the MCP servers' environment a parity board run gets. A
 * server's env can name a withheld variable, or carry its value under another
 * name (`TOKEN: "${DISCORD_TOKEN}"`); either would put back what the parity
 * scrub took out. Both are left out, and that server goes without them.
 *
 * @param {Record<string, string>} mcpEnv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
function parityMcpEnv(mcpEnv, env = process.env) {
  const values = Object.keys(env).filter(withheldFromParityBoard).map((k) => env[k]).filter(Boolean);
  return Object.fromEntries(Object.entries(mcpEnv || {})
    .filter(([k, v]) => !withheldFromParityBoard(k) && !values.some((w) => String(v).includes(w))));
}

/**
 * The kind of run a Paperclip task gets: `board` (least privilege, the
 * readonly and engineering policies) or, under `parity`, `session` — the same
 * argv, settings, MCP servers, filesystem and network as the bot's Discord
 * session, in whatever BOT_PERMISSION_MODE it runs. What a parity run still
 * does not get is named, not silent: other channels' conversation in its
 * prompt, and the Discord credentials (withheldFromParityBoard).
 *
 * @param {ReturnType<typeof resolveBoardPolicy>} policy
 * @returns {"board" | "session"}
 */
function boardRunKind(policy) {
  return policy.parity ? "session" : "board";
}

/**
 * Each path is denied as configured and as its symlinks resolve: a state folder
 * that is a link into the working directory is otherwise readable there by its
 * real path (second pass on 731cfbf).
 *
 * @param {string[]} paths the files and folders PRIVATE_MEMORY_ENV points at
 * @returns {string[]} Read deny rules covering each path and anything under it
 */
function privateMemoryDeny(paths, tools = ["Read"]) {
  const spellings = paths.flatMap((p) => [require("path").resolve(p), expand(p)].map((a) => a.replace(/\/+$/, "")));
  // Engineering mode adds Edit: a write path above the bot's state must not
  // let the edit tools into it.
  return tools.flatMap((t) => [...new Set(spellings)].flatMap((abs) => [`${t}(/${abs})`, `${t}(/${abs}/**)`]));
}

/**
 * The flags for a board run, in EVERY mode — bypass does not apply, as it does
 * not to a summary. A board is read by people who are not in the bot's Discord
 * channels, and a shell on a shared host can read far more than a list of
 * private paths can name (Claude's own transcripts, sibling bots' state). So a
 * board run gets least privilege: only `tools` (read-only built-ins by
 * default), dontAsk, which confines the read tools to the working directory,
 * and only what `allow` names on top. No settings file is read — user,
 * project or local: each can pre-approve tools (a repo's `mcp__github__*`, a
 * bare `Bash`) that dontAsk would then honor, so the board's approvals would no
 * longer be the only ones. The working directory's CLAUDE.md still loads,
 * through --add-dir with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD set in
 * the run's env. MCP servers come from --mcp-config, which this leaves alone.
 *
 * @param {{ tools: string, allow?: string, deny?: string[], cwd?: string }} o
 * @returns {string[]}
 */
function boardArgs({ tools, allow = "", deny = [], cwd = "" }) {
  const allowed = [allow].flat().filter(Boolean);
  return [
    "--tools", tools,
    "--permission-mode", "dontAsk",
    "--setting-sources", "",
    ...(cwd ? ["--add-dir", cwd] : []),
    ...(allowed.length ? ["--allowedTools", ...allowed] : []),
    ...(deny.length ? ["--disallowedTools", ...deny] : []),
  ];
}

// What a sandboxed board shell may read besides its working directory: the
// system folders commands run from. Not /tmp, /var, /srv, /opt or /home, where
// another bot's buffer or state may sit.
const SYSTEM_READ = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/proc", "/dev", "/sys"];

/**
 * A path as the sandbox will meet it: `~` expanded, made absolute, and with every
 * symlink resolved, so an alias of a denied folder is caught as that folder
 * (second pass on 0897d78: a CLAUDE_CWD symlinked into the harness folder passed).
 * A path that does not exist yet keeps its missing tail on its deepest existing
 * ancestor's real path.
 *
 * @param {string} p
 * @returns {string}
 */
function expand(p) {
  const { resolve, dirname, basename, join } = require("path");
  const abs = resolve(String(p).replace(/^~(?=\/|$)/, require("os").homedir()));
  try {
    return require("fs").realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(expand(parent), basename(abs));
  }
}

/**
 * Whether `dir` is one of the board-denied `paths` or lies inside one. Claude
 * Code's sandbox always binds the working directory writable, after the read
 * denials, so a working directory in this position is readable to a board
 * shell whatever the deny list says (measured 2026-10-09: a denied subfolder of
 * the working directory stays hidden; a denied working directory does not).
 *
 * @param {string[]} paths
 * @param {string} dir
 * @returns {boolean}
 */
function boardCwdDenied(paths, dir) {
  const d = expand(dir);
  return paths.map(expand).some((p) => d === p || d.startsWith(p + require("path").sep));
}

/**
 * The settings for a board run: the bot's own settings (BOT_SETTINGS, already
 * parsed) with the shell sandboxed to the working directory. A shell a board
 * run is allowed reads nothing outside it but the system folders (SYSTEM_READ):
 * not the home folder, /tmp, or another bot's state wherever it sits. Nor the
 * Discord memory paths even where they sit inside the working directory, nor
 * any of them when the working directory is one (an allowRead is mounted back
 * over a denyRead, so one is never given for a denied path). A command may not
 * leave the sandbox, and a host without it fails the run instead of running it
 * open. Measured 2026-10-09 on the bots' host: inside the working directory cat
 * works and git runs; a file in /tmp, /var/tmp or elsewhere in the home folder
 * reads as missing. A tool kept outside the system folders (node under nvm or
 * ~/.local, gh's login) needs an allowRead in the bot's own settings.
 *
 * @param {object|null} base the bot's settings, or null
 * @param {string[]} paths the paths PRIVATE_MEMORY_ENV points at
 * @param {string} cwd the run's working directory
 * @returns {object}
 */
function boardSettings(base, paths, cwd, policy = { execution: "readonly" }) {
  const b = base ?? {};
  const fs = b.sandbox?.filesystem ?? {};
  // An allowRead is mounted back over a denyRead, so one that is a denied path,
  // or lies inside one, would reopen it: a working directory that IS the
  // harness folder gets no allowRead, and neither does such an entry of the bot's.
  // (The sandbox still binds that working directory writable, which reopens it
  // anyway; boardCwdDenied keeps such a bot from running a board task at all.)
  const reopens = (p) => boardCwdDenied(paths, p);
  // Only what can tighten the sandbox is taken from the bot's settings; every
  // key that would loosen it is set here, so a bot's own settings cannot switch
  // a board shell's confinement off (second pass on c2da179: filesystem
  // disabled:true survived a spread). No allowWrite: a board shell writes only
  // where the sandbox's default lets it.
  // Nothing else of the bot's settings is carried: its permissions, hooks and
  // env are for Discord sessions, and an approval there would be honored here
  // (second pass on f2a7466). Only the model it runs on.
  const { network = {}, credentials, ripgrep } = b.sandbox ?? {};
  const eng = policy.execution === "engineering";
  // Engineering mode widens only what the operator named, and never over a
  // denied path: a read or write path that is, or lies inside, a denied one is
  // refused before any run starts (boardPolicyProblems), and is dropped here
  // too. One that CONTAINS a denied path keeps it hidden — a denyRead under an
  // allowRead stays denied, as one under the working directory does — and in
  // this mode every denied path is also denyWrite, so a write path above the
  // bot's state cannot overwrite its memory.
  // The run's private temp folder (engineering only) is where the CLI puts the
  // sockets its sandbox network proxy listens on; under the root read-deny the
  // shared /tmp is hidden, and so would they be (measured 2026-10-12: with no
  // reachable socket every request fails, allowed host or not).
  const tmp = eng && policy.tmpDir ? [expand(policy.tmpDir)] : [];
  const denied = [...new Set([...paths.map((p) => require("path").resolve(String(p))), ...paths.map(expand)])];
  const readPaths = eng ? [...(policy.readPaths ?? []), ...(policy.writePaths ?? [])].map(expand).concat(tmp) : [];
  const writePaths = eng ? [expand(cwd), ...(policy.writePaths ?? []).map(expand), ...tmp].filter((p) => !reopens(p)) : [];
  const denyWrite = [...(fs.denyWrite ?? []), ...(eng ? denied : [])];
  const domains = [...new Set([...(network.allowedDomains ?? []), ...(eng ? policy.network ?? [] : [])])];
  return {
    ...(b.model ? { model: b.model } : {}),
    // Project auto-memory holds what Discord sessions in this folder saved, and
    // the CLI loads it at startup, where no sandbox or deny rule reaches.
    autoMemoryEnabled: false,
    sandbox: {
      ...(credentials ? { credentials } : {}),
      ...(ripgrep ? { ripgrep } : {}),
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Engineering mode is a shell inside this sandbox without a rule per
      // command: what the sandbox confines runs, and nothing runs outside it.
      autoAllowBashIfSandboxed: eng,
      enableWeakerNestedSandbox: false,
      excludedCommands: [],
      network: { ...network, ...(eng && domains.length ? { allowedDomains: domains } : {}), allowAllUnixSockets: false },
      filesystem: {
        disabled: false,
        // Both spellings of each denied path: as given, and with symlinks resolved.
        denyRead: [...new Set([...(fs.denyRead ?? []), "/", ...denied])],
        allowRead: [...new Set([...SYSTEM_READ, ...(fs.allowRead ?? []), expand(cwd), ...readPaths])].filter((p) => !reopens(p)),
        ...(writePaths.length ? { allowWrite: writePaths } : {}),
        ...(denyWrite.length ? { denyWrite } : {}),
      },
    },
  };
}

/**
 * Files that hold credentials by convention, as file-name patterns: a board run
 * may not read them wherever they sit in the folders it can reach. A bot's
 * working directory is usually its repo, and the repo's MCP config and env file
 * carry the tokens of every server and service it talks to — a board run read
 * both when only the Discord memory was denied (measured 2026-10-12 on a fixture
 * with the readonly board argv: Read and Grep returned the canary tokens).
 * BOT_BOARD_DENY_FILES adds patterns; these always apply. A `!` pattern exempts
 * a name, so a template stays readable.
 */
const DEFAULT_BOARD_SECRET_FILES = [".mcp.json", ".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template",
  ".npmrc", ".netrc", ".git-credentials", ".pgpass", ".dev.vars", "*.pem", "*.key", "id_rsa", "id_ed25519", "id_ecdsa",
  "credentials.json", "service-account*.json"];

/** A file-name pattern (`*` and `?` only) as a RegExp over a base name. */
function namePattern(p) {
  return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/**
 * Every file under `roots` whose name matches a secret-file pattern, by real
 * path, plus every folder the walk did not finish. Found per run, so a file
 * added since start is caught. The walk is breadth-first, with dependency
 * folders last, and bounded: a folder it never reached is denied whole, so a
 * credential file the bound left unread is never readable (a board run that
 * needs one of those folders fails closed, not open). Only version-control
 * internals are skipped.
 *
 * @param {string[]} roots folders a board run can read
 * @param {string[]} patterns DEFAULT_BOARD_SECRET_FILES plus BOT_BOARD_DENY_FILES
 * @returns {string[]}
 */
function boardSecretFiles(roots, patterns, { maxEntries = 200000 } = {}) {
  const fs = require("fs"), { join } = require("path");
  const deny = patterns.filter((p) => !p.startsWith("!")).map(namePattern);
  const keep = patterns.filter((p) => p.startsWith("!")).map((p) => namePattern(p.slice(1)));
  const secret = (name) => deny.some((r) => r.test(name)) && !keep.some((r) => r.test(name));
  const found = new Set();
  const add = (p) => { found.add(p); found.add(expand(p)); };
  const queue = [], later = [];
  for (const r of new Set(roots.filter(Boolean).map(expand))) queue.push(r);
  let seen = 0;
  for (let dir; (dir = queue.shift() ?? later.shift()) !== undefined;) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    if ((seen += entries.length) > maxEntries) {
      // Out of budget: this folder and every one not yet walked stay closed.
      for (const d of [dir, ...queue, ...later]) add(d);
      break;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git") (e.name === "node_modules" ? later : queue).push(p);
      } else if (secret(e.name)) add(p);
    }
  }
  return [...found];
}

/**
 * The other copies of the private memory paths that a path denial misses, when
 * one lies inside a git repository: the repository's git folder (every committed
 * copy) and the same path in each of its worktrees (a checked-out copy). A
 * worktree inside the working directory is ordinary files to a board run —
 * measured 2026-10-12: a readonly run's Read and Grep returned a summary from
 * `.claude/worktrees/<name>/bot-history`. Found per run, so a worktree added
 * since start is caught.
 *
 * @param {string[]} paths the private memory paths
 * @returns {string[]}
 */
function boardHistoryDenied(paths) {
  const fs = require("fs"), { join, dirname, relative, resolve, basename } = require("path");
  const found = new Set();
  const add = (p) => { found.add(p); found.add(expand(p)); };
  const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } };
  for (const p of paths.filter(Boolean)) {
    const abs = resolve(expand(p));
    let top = abs;
    while (!fs.existsSync(join(top, ".git")) && dirname(top) !== top) top = dirname(top);
    const dotGit = join(top, ".git");
    if (!fs.existsSync(dotGit)) continue;
    const rel = relative(top, abs);
    // A worktree's .git is a file naming its git folder, which names the common one.
    let gitDir = dotGit;
    if (!fs.statSync(dotGit).isDirectory()) {
      const named = /^gitdir:\s*(.+)$/m.exec(read(dotGit) || "");
      gitDir = named ? resolve(top, named[1]) : dotGit;
    }
    const common = resolve(gitDir, read(join(gitDir, "commondir")) || ".");
    add(dotGit);
    add(gitDir);
    add(common);
    const roots = new Set([top]);
    if (basename(common) === ".git") roots.add(dirname(common));
    let names = [];
    try { names = fs.readdirSync(join(common, "worktrees")); } catch { /* no other worktrees */ }
    for (const n of names) {
      const wt = read(join(common, "worktrees", n, "gitdir"));
      if (wt) roots.add(dirname(resolve(common, "worktrees", n, wt)));
    }
    // A worktree whose folder is gone (git calls it prunable) holds no copy.
    for (const r of roots) if (rel && fs.existsSync(join(r, rel))) add(join(r, rel));
  }
  return [...found];
}

/** How a Paperclip board run executes. An unrecognised one is refused, never guessed. */
const BOARD_EXECUTION_MODES = ["readonly", "engineering", "parity"];
const DEFAULT_BOARD_TOOLS = "Read,Glob,Grep";
const DEFAULT_BOARD_ENGINEERING_TOOLS = "Read,Glob,Grep,Edit,Write,Bash";

const listOf = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * What a Paperclip board run may do. `readonly`, the default, is the board run
 * as it always was: read-only built-ins confined to the working directory.
 * `engineering` is for a bot whose board assigns it real work — editing a
 * repo, running git or gh. It is the same board run with more tools, never a
 * different trust level: dontAsk still decides, no settings file is read, the
 * Discord memory stays denied at the sandbox, the bot's credentials stay out
 * of the environment, and a host without the sandbox runs nothing. What it
 * adds is only what the operator names: the tools, the folders it may read
 * and write besides the working directory, and the hosts its shell may reach.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveBoardPolicy(env = process.env) {
  const raw = (env.BOT_BOARD_EXECUTION || "").trim();
  const execution = raw || "readonly";
  const eng = execution === "engineering";
  return {
    execution,
    // `parity`: the run is built as the bot's Discord session (boardRunKind).
    parity: execution === "parity",
    source: raw ? "BOT_BOARD_EXECUTION" : "built-in default",
    tools: eng ? (env.BOT_BOARD_ENGINEERING_TOOLS || DEFAULT_BOARD_ENGINEERING_TOOLS) : (env.BOT_BOARD_TOOLS || DEFAULT_BOARD_TOOLS),
    allow: (env.BOT_BOARD_PERMISSION_ALLOW || "").trim(),
    readPaths: eng ? listOf(env.BOT_BOARD_READ_PATHS) : [],
    writePaths: eng ? listOf(env.BOT_BOARD_WRITE_PATHS) : [],
    network: eng ? listOf(env.BOT_BOARD_NETWORK_ALLOW) : [],
    // In every mode: a readonly run reads too.
    secretFiles: [...DEFAULT_BOARD_SECRET_FILES, ...listOf(env.BOT_BOARD_DENY_FILES)],
  };
}

/**
 * The permission rules engineering mode adds to a board run: edits in the
 * working directory and the write paths, reads in the read paths. dontAsk
 * refuses the Write and Edit tools even in the working directory without a
 * rule (measured 2026-10-12). The extra folders are rules, not --add-dir: a
 * folder added that way is bound writable to the shell, so a read path would
 * become a write path (measured the same day).
 *
 * @param {string} cwd
 * @param {ReturnType<typeof resolveBoardPolicy>} policy
 * @returns {string[]}
 */
function boardEngineeringRules(cwd, policy) {
  if (policy.execution !== "engineering") return [];
  const rule = (tool, p) => `${tool}(/${expand(p).replace(/\/+$/, "")}/**)`;
  return [cwd, ...policy.writePaths].map((p) => rule("Edit", p))
    .concat(policy.readPaths.map((p) => rule("Read", p)));
}

/**
 * Why a board policy must not run, one sentence each; empty when it may. Any
 * of these turns board pickup off, and only board pickup: Discord is unaffected.
 *
 * A read path may not contain the working directory or a write path: the
 * sandbox mounts it read-only over them and then cannot start at all
 * (measured 2026-10-12: every command failed with "Read-only file system").
 * Name the sibling folders one by one instead.
 *
 * @param {ReturnType<typeof resolveBoardPolicy>} policy
 * @param {string[]} denied the board-denied paths (boardDeniedPaths in bot.js)
 * @param {string} cwd the run's working directory
 * @returns {string[]}
 */
function boardPolicyProblems(policy, denied, cwd) {
  if (!BOARD_EXECUTION_MODES.includes(policy.execution)) {
    return [`BOT_BOARD_EXECUTION="${policy.execution}" is not one of ${BOARD_EXECUTION_MODES.join(", ")}`];
  }
  // A parity run is the Discord session: no sandbox paths or hosts to check.
  if (policy.parity) return [];
  const problems = [];
  const home = expand(require("os").homedir());
  const within = (inner, outer) => inner === outer || inner.startsWith(outer + require("path").sep);
  for (const [name, list] of [["BOT_BOARD_READ_PATHS", policy.readPaths], ["BOT_BOARD_WRITE_PATHS", policy.writePaths]]) {
    for (const p of list) {
      const abs = expand(p);
      if (!/^(~\/|\/)/.test(p)) problems.push(`${name}: "${p}" is not an absolute path`);
      else if (boardCwdDenied(denied, p)) problems.push(`${name}: "${p}" is, or lies inside, the bot's private Discord memory or the harness folder`);
      else if (abs === "/" || abs === home) problems.push(`${name}: "${p}" would open the whole ${abs === "/" ? "filesystem" : "home folder"}`);
      else if (name === "BOT_BOARD_READ_PATHS") {
        const shadowed = [cwd, ...policy.writePaths].filter((w) => w && within(expand(w), abs));
        if (shadowed.length) problems.push(`${name}: "${p}" contains ${shadowed.join(", ")}, which a board run must write; list the folders beside it instead`);
      }
    }
  }
  for (const d of policy.network) {
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d)) problems.push(`BOT_BOARD_NETWORK_ALLOW: "${d}" is not a host name`);
  }
  // The sandbox hides a private folder by path, and every run is denied the
  // repo's git folder and the worktrees' copies (boardHistoryDenied), which a
  // readonly run — a Codex one has a shell — never needs. Engineering does need
  // git, and its shell sees the hidden folder as deleted, so "commit everything"
  // would remove it from the repo: engineering needs both folders apart.
  if (policy.execution === "engineering" && cwd) {
    const root = expand(cwd);
    const nested = new Set(denied.map(expand).filter((d) => d !== root && within(d, root)));
    for (const d of nested) problems.push(`BOT_BOARD_EXECUTION=engineering: "${d}" is the bot's Discord memory and lies inside CLAUDE_CWD, where a board shell can read it through version control — move it out of CLAUDE_CWD (and out of the repo's history, if it was ever committed), or keep board runs readonly`);
  }
  return problems;
}

/**
 * The flags for a summarization run, in EVERY mode. A summary is written from a
 * transcript already in its prompt, and that transcript is Discord text from
 * anyone in the channel. It never needs to write, execute or reach a server, so
 * bypass does not apply here: only the reading tools, nothing that prompts, no
 * MCP servers, and the bot's own deny rules and settings (BOT_SETTINGS) on top.
 *
 * @param {{ tools?: string, deny?: string, settings?: string }} [o]
 * @returns {string[]}
 */
function summarizerArgs({ tools = "Read", deny = "", settings = "" } = {}) {
  return [
    "--tools", tools,
    "--permission-mode", "dontAsk",
    "--strict-mcp-config",
    ...(deny ? ["--disallowedTools", deny] : []),
    ...(settings ? ["--settings", settings] : []),
  ];
}

module.exports = { boardRunKind, withheldFromParityBoard, parityMcpEnv, DEFAULT_BOARD_SECRET_FILES, boardSecretFiles, boardHistoryDenied, resolveBoardPolicy, boardPolicyProblems, boardEngineeringRules, BOARD_EXECUTION_MODES, DEFAULT_BOARD_TOOLS, DEFAULT_BOARD_ENGINEERING_TOOLS, resolvePermissionMode, VALID_MODES, attachmentReadRule, summarizerArgs, PRIVATE_MEMORY_ENV, DISCORD_CREDENTIAL_ENV, BOARD_BOT_ENV, withheldFromBoard, privateMemoryDeny, boardArgs, boardSettings, boardCwdDenied, SYSTEM_READ, expand };
