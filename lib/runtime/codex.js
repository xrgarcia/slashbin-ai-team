/**
 * The Codex runtime: the command line for each kind of run, and a translator
 * from Codex's `--json` events to the stream-json events the harness already
 * consumes. Measured against Codex CLI 0.162.1 with synthetic fixtures; each
 * Claude control maps as below, and one that cannot be expressed refuses the
 * run rather than dropping silently.
 *
 *   Claude                            Codex
 *   --setting-sources ""              --ignore-user-config --ignore-rules. Required:
 *                                     a sandbox_mode in any loaded config layer
 *                                     makes Codex ignore the permission profile.
 *   sandbox denyRead / allowRead      a permission profile (default_permissions):
 *                                     ":minimal" read, the working directory read
 *                                     or write, private paths "deny". Enforced by
 *                                     bubblewrap; a host without it fails closed.
 *   --tools                           features off (apps, plugins, browser, …),
 *                                     web_search disabled, no MCP servers.
 *   plugin hooks                      the same hook scripts, passed inline
 *                                     (-c hooks.PreToolUse=…): the payload and the
 *                                     exit-2 contract match. A project hooks file
 *                                     is not read under --ignore-user-config.
 *   no sub-agents on a board run      a PreToolUse hook denies collaboration.*.
 *   --append-system-prompt            -c developer_instructions=…
 *   --plugin-dir skills               listed in the instructions with their files.
 *   CLAUDE.md                         project_doc_fallback_filenames, so one repo
 *                                     serves either runtime.
 *   --max-turns                       none; the harness timeout bounds a run.
 *   run_in_background (blocked)       features.unified_exec off on every run:
 *                                     its terminals outlive a call and die with the
 *                                     reply, as a background Bash job does.
 *
 * Not expressible, so refused for a board run: a shell host allow list (with a
 * profile's network on and a domain allowed, the shell still resolved no host).
 */
const { realpathSync, readFileSync, readdirSync, existsSync } = require("fs");
const { dirname, basename, join, resolve, relative, sep, isAbsolute } = require("path");
const { execFileSync } = require("child_process");
const { MAX_ARG_BYTES } = require("../argv-budget");

/** Versions the board profile was measured on. Another one runs no board task. */
const TESTED_VERSIONS = /^0\.162\./;

/** Features that add tools a restricted or board run must not have. */
const CLOSED_FEATURES = ["apps", "plugins", "browser_use", "computer_use", "image_generation",
  "multi_agent", "memories", "tool_suggest", "in_app_browser", "goals"];

/**
 * A TOML basic string. JSON's escapes are TOML's, except that TOML also wants
 * DEL escaped and has no lone-surrogate escape.
 *
 * @param {string} s
 * @returns {string}
 */
function tomlString(s) {
  return JSON.stringify(String(s).replace(/[\uD800-\uDFFF]/g, (c, i, all) => {
    const code = c.charCodeAt(0);
    const pair = code < 0xDC00 ? all.charCodeAt(i + 1) : all.charCodeAt(i - 1);
    const ok = code < 0xDC00 ? pair >= 0xDC00 && pair <= 0xDFFF : pair >= 0xD800 && pair < 0xDC00;
    return ok ? c : "�";
  })).replace(/\u007f/g, "\\u007F");
}

/** A TOML inline value: string, number, boolean, array or table. */
function toml(v) {
  if (Array.isArray(v)) return `[${v.map(toml).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${tomlString(k)}=${toml(x)}`).join(",")}}`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return tomlString(v);
}

const set = (key, value) => ["-c", `${key}=${toml(value)}`];

/**
 * The folder the Codex binary runs from. bubblewrap must be able to start it
 * inside the sandbox, so a profile grants it read; without that the sandbox
 * fails to start, which fails the run closed.
 *
 * @param {string} bin
 * @returns {string|null}
 */
function codexReleaseDir(bin) {
  let path = bin;
  if (!isAbsolute(bin)) {
    try { path = execFileSync("which", [bin], { encoding: "utf8" }).trim(); } catch { return null; }
  }
  try { path = realpathSync(path); } catch { return null; }
  const dir = dirname(path);
  return basename(dir) === "bin" ? dirname(dir) : dir;
}

/**
 * The installed version, or null when it cannot be run.
 *
 * @param {string} bin
 * @returns {string|null}
 */
function codexVersion(bin) {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    return (/(\d+\.\d+\.\d+)/.exec(out) || [])[1] || null;
  } catch { return null; }
}

/**
 * Why a Codex board run must not start, one sentence each; empty when it may.
 * Added to boardPolicyProblems. Codex has no shell-less board run — reading is
 * done through its shell — so a readonly run relies on the profile denying the
 * repo's git folder and the worktrees' copies of the memory (boardHistoryDenied).
 *
 * @param {{ network: string[] }} policy
 * @param {{ version: string|null, releaseDir: string|null }} o
 * @returns {string[]}
 */
function codexBoardProblems(policy, { version, releaseDir }) {
  const problems = [];
  if (!version) problems.push("BOT_RUNTIME=codex: the Codex CLI did not run (`codex --version`); install it or set CODEX_BIN");
  else if (!TESTED_VERSIONS.test(version)) problems.push(`BOT_RUNTIME=codex: board runs are tested on Codex ${TESTED_VERSIONS.source.replace(/\\|\^/g, "")}x, this host has ${version}; its permission profiles are beta, so a board run waits for a tested version`);
  if (!releaseDir) problems.push("BOT_RUNTIME=codex: cannot find the folder the Codex binary runs from, which the sandbox must be able to read");
  if (policy.network.length) problems.push("BOT_BOARD_NETWORK_ALLOW: a host allow list is not available on Codex (a profile with a domain allowed still resolved no host); unset it — a Codex board shell has no network");
  return problems;
}

/**
 * The filesystem profile for a board run. Only what is listed is reachable:
 * ":minimal" is the system folders a command needs. The working directory is
 * read in `readonly` and written in `engineering`; the Discord memory, state
 * and harness folders are denied by both spellings even where a listed folder
 * contains them.
 *
 * @param {{ cwd: string, denied: string[], policy: { execution: string, readPaths: string[], writePaths: string[] }, releaseDir: string, tmpDir?: string|null, expand: (p: string) => string }} o
 */
function boardFilesystem({ cwd, denied, policy, releaseDir, tmpDir = null, expand }) {
  const eng = policy.execution === "engineering";
  const fs = { ":minimal": "read", [releaseDir]: "read" };
  if (eng) {
    for (const p of policy.readPaths) fs[expand(p)] = "read";
    for (const p of policy.writePaths) fs[expand(p)] = "write";
    if (tmpDir) fs[expand(tmpDir)] = "write";
  }
  const root = expand(cwd);
  const roots = { ".": eng ? "write" : "read" };
  for (const d of new Set([...denied.map((p) => resolve(String(p))), ...denied.map(expand)])) {
    fs[d] = "deny";
    if (d.startsWith(root + sep)) roots[relative(root, d)] = "deny";
  }
  fs[":workspace_roots"] = roots;
  return fs;
}

/**
 * Hooks from each skill pack, as Codex config: the pack's hooks.json with
 * ${CLAUDE_PLUGIN_ROOT} replaced by the pack's folder, so the same scripts run.
 *
 * @param {string[]} packs skill pack folders that exist
 * @param {{ denyCollaboration?: boolean }} [o]
 * @returns {{ PreToolUse?: object[], PostToolUse?: object[] }}
 */
function packHooks(packs, { denyCollaboration = false } = {}) {
  const out = {};
  for (const dir of packs) {
    let spec;
    try { spec = JSON.parse(readFileSync(join(dir, "hooks", "hooks.json"), "utf8")).hooks || {}; } catch { continue; }
    for (const [event, groups] of Object.entries(spec)) {
      if (event !== "PreToolUse" && event !== "PostToolUse") continue;
      for (const g of groups) {
        (out[event] ||= []).push({
          matcher: g.matcher,
          hooks: (g.hooks || []).filter((h) => h.type === "command")
            .map((h) => ({ type: "command", command: h.command.split("${CLAUDE_PLUGIN_ROOT}").join(dir) })),
        });
      }
    }
  }
  // Sub-agents stay exposed with the multi_agent feature off, and whether one
  // inherits the sandbox is unproven, so a board run may not start one.
  if (denyCollaboration) {
    (out.PreToolUse ||= []).unshift({
      matcher: "^collaboration",
      hooks: [{ type: "command", command: "node -e \"process.stderr.write('sub-agents are not available on a board run');process.exit(2)\"" }],
    });
  }
  return out;
}

/**
 * The skills each pack ships, named in the instructions with the file to read:
 * Codex has no plugin folder to load them from.
 *
 * @param {string[]} packs
 * @returns {string}
 */
function skillsPrompt(packs) {
  const lines = [];
  for (const dir of packs) {
    let names = [];
    try { names = readdirSync(join(dir, "skills")); } catch { continue; }
    for (const name of names.sort()) {
      const file = join(dir, "skills", name, "SKILL.md");
      if (!existsSync(file)) continue;
      const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"));
      const desc = head && /^description:\s*(.+)$/m.exec(head[1]);
      lines.push(`- ${name} — read ${file} first. In it, $CLAUDE_PLUGIN_ROOT means ${dir}.${desc ? ` ${desc[1].trim()}` : ""}`);
    }
  }
  if (!lines.length) return "";
  return ["", "", "--- Skills ---", "When a request matches one of these, read its file and follow it.", ...lines, "--- End skills ---"].join("\n");
}

/**
 * Stdio MCP servers from a Claude-format config (`{ mcpServers: {…} }`), as
 * Codex servers. Values from `env` travel in the child's environment, named in
 * env_vars, so none of them reach the command line. A server Codex cannot run
 * the same way (http, sse, a claude.ai connector) is skipped and named.
 *
 * @param {object} config parsed JSON
 * @param {NodeJS.ProcessEnv} env where ${VAR} references resolve
 * @returns {{ servers: Record<string, object>, env: Record<string, string>, skipped: { name: string, reason: string }[] }}
 */
function mcpServers(config, env = process.env) {
  const servers = {}, childEnv = {}, skipped = [];
  const expand = (s) => String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => env[k] ?? d ?? "");
  for (const [name, s] of Object.entries(config?.mcpServers || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { skipped.push({ name, reason: "name is not a plain identifier" }); continue; }
    if ((s.type && s.type !== "stdio") || !s.command) { skipped.push({ name, reason: `type ${s.type || "unknown"} is not a local (stdio) server` }); continue; }
    const vars = {};
    for (const [k, v] of Object.entries(s.env || {})) vars[k] = expand(v);
    const clash = Object.keys(vars).find((k) => k in childEnv && childEnv[k] !== vars[k]);
    if (clash) { skipped.push({ name, reason: `its ${clash} differs from another server's` }); continue; }
    Object.assign(childEnv, vars);
    servers[name] = {
      command: expand(s.command),
      ...(s.args?.length ? { args: s.args.map(expand) } : {}),
      ...(Object.keys(vars).length ? { env_vars: Object.keys(vars) } : {}),
      ...(s.cwd ? { cwd: expand(s.cwd) } : {}),
    };
  }
  return { servers, env: childEnv, skipped };
}

/**
 * The developer instructions as one argument that fits the kernel's limit
 * once escaped: the tail is cut, as the context budget cuts, rather than the
 * TOML string being broken (Codex would then read it as literal text).
 */
function instructionsArg(text) {
  const limit = MAX_ARG_BYTES - 2048;
  let s = String(text);
  for (let arg = `developer_instructions=${tomlString(s)}`; Buffer.byteLength(arg) > limit; arg = `developer_instructions=${tomlString(s)}`) {
    s = s.slice(0, Math.floor(s.length * (limit / Buffer.byteLength(arg))) - 64);
  }
  return ["-c", `developer_instructions=${tomlString(s)}`];
}

/**
 * The command line for one run.
 *
 * kind     session (Discord, wakes, cron), board (a Paperclip task) or summarizer
 * mode     bypass or restricted (sessions only; the other kinds are always narrow)
 *
 * @param {object} o
 * @returns {string[]}
 */
function codexArgs({ kind, mode = "restricted", resumeId = null, model = null, instructions = "", prompt,
  releaseDir = null, readDirs = [], filesystem = null, packs = [], mcp = null, strictMcp = false }) {
  const narrow = kind !== "session" || mode !== "bypass";
  const args = [
    "exec", ...(resumeId ? ["resume"] : []),
    "--json", "--skip-git-repo-check",
    ...(narrow || strictMcp ? ["--ignore-user-config"] : []),
    ...(narrow ? ["--ignore-rules"] : []),
  ];
  if (kind === "summarizer") {
    // No project instructions either: the transcript is the whole input.
    args.push("--ephemeral", ...set("project_doc_max_bytes", 0));
  }
  // Every run is one process per reply, so a terminal left running in the
  // background dies with it; commands run to completion instead.
  args.push(...set("features.unified_exec", false));
  if (!narrow) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    // A board run's profile is built by boardFilesystem. A restricted session
    // reads its working directory and the folders named (its uploads); a
    // summary reads nothing but what a command needs — its transcript is the
    // prompt.
    const profile = kind === "board" ? filesystem
      : { ":minimal": "read", ...(releaseDir ? { [releaseDir]: "read" } : {}),
          ...(kind === "session" ? { ...Object.fromEntries(readDirs.map((d) => [d, "read"])), ":workspace_roots": { ".": "read" } } : {}) };
    args.push(
      ...set("approval_policy", "never"),
      ...set("default_permissions", "harness"),
      ...set("permissions.harness.filesystem", profile),
      ...set("permissions.harness.network", { enabled: false }),
      ...set("web_search", "disabled"),
      ...CLOSED_FEATURES.flatMap((f) => set(`features.${f}`, false)),
    );
  }
  if (kind !== "summarizer") {
    args.push(...set("project_doc_fallback_filenames", ["CLAUDE.md"]));
    if (!narrow && mcp) for (const [name, spec] of Object.entries(mcp)) args.push(...set(`mcp_servers.${name}`, spec));
    const hooks = packHooks(packs, { denyCollaboration: kind === "board" });
    if (Object.keys(hooks).length) {
      args.push("--dangerously-bypass-hook-trust");
      for (const [event, groups] of Object.entries(hooks)) args.push(...set(`hooks.${event}`, groups));
    }
  }
  if (model) args.push("-m", model);
  if (instructions) args.push(...instructionsArg(instructions));
  args.push("--", ...(resumeId ? [resumeId] : []), prompt);
  return args;
}

/**
 * A translator from Codex `--json` events to the Claude stream-json events the
 * harness handles: the thread id is the session id, an agent message is text,
 * a command, file change, MCP or web call is a tool use, and the end of the
 * turn is the result. Stateful only to separate consecutive messages.
 *
 * @returns {(event: object) => object[]}
 */
function createCodexTranslator() {
  let text = false;
  const tool = (name, input) => { text = false; return { type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }; };
  return (e) => {
    switch (e.type) {
      case "thread.started":
        return [{ type: "system", subtype: "init", session_id: e.thread_id }];
      case "turn.completed":
        return [{ type: "result", subtype: "success", is_error: false,
          total_input_tokens: e.usage?.input_tokens, total_output_tokens: e.usage?.output_tokens }];
      case "turn.failed":
        return [{ type: "result", subtype: "error", is_error: true, error: e.error?.message }];
      case "item.completed": {
        const it = e.item || {};
        if (it.type === "agent_message" && it.text) {
          const out = [{ type: "assistant", message: { content: [{ type: "text", text: (text ? "\n\n" : "") + it.text }] } }];
          text = true;
          return out;
        }
        if (it.type === "command_execution") return [tool("Bash", { command: it.command })];
        // A file it added counts as written, so the outbox and attach rules see it.
        if (it.type === "file_change") return (it.changes || []).map((c) => tool(c.kind === "add" ? "Write" : "Edit", { file_path: c.path }));
        if (it.type === "mcp_tool_call") return [tool(`mcp__${it.server}__${it.tool}`, it.arguments || {})];
        if (it.type === "web_search") return [tool("WebSearch", { query: it.query })];
        return [];
      }
      default:
        return [];
    }
  };
}

module.exports = { TESTED_VERSIONS, CLOSED_FEATURES, tomlString, toml, codexReleaseDir, codexVersion,
  codexBoardProblems, boardFilesystem, packHooks, skillsPrompt, mcpServers, codexArgs, createCodexTranslator };
