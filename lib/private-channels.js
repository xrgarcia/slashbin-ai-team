/**
 * Private channels: everything a channel contributes stays with that channel.
 * Opt-in per bot with BOT_PRIVATE_CHANNELS=true; off, nothing here is used.
 *
 * The internal bots remember across channels on purpose — a decision in one
 * channel informs the next. A bot that serves several people at one customer
 * must not: what one person says or uploads is theirs. A prompt line asking the
 * model to "focus on this channel" is not a boundary, so in this mode each
 * channel has a folder of its own under the bot's state (`channels/<id>`):
 *
 *   buffer.txt         the channel's own conversation buffer
 *   attachments/       files uploaded in the channel
 *   jobs/schedules.json the channel's scheduled jobs
 *   home/              the agent's home: its session transcripts live here
 *   view/              what recall reads, rebuilt before every run from the
 *                      bot's records and holding only this channel's part:
 *                      summaries/, sessions.json, job-history.jsonl
 *
 * A run is given that folder and nothing of another channel's. The guarantee is
 * the confinement (lib/confine.js), which binds only the run's own channel
 * folder; so a private bot must also be confined, and refuses to start if not.
 *
 * The folder is the bot's, not the run's: a run sees it read-only and may write
 * only home/ and jobs/. Everything else here the bot writes, so a run cannot
 * leave a link in it for the bot to follow. The one file the bot reads back from
 * a run's writable part, jobs/schedules.json, is opened without following links
 * and replaced by rename, never written through.
 */

const { join, dirname, basename } = require("path");
const { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync, openSync, closeSync, fstatSync, renameSync, lstatSync, constants } = require("fs");
const { randomBytes } = require("crypto");

/** A folder name for a channel or run scope: Discord ids, or a sanitized key. */
function scopeName(key) {
  const s = String(key || "").replace(/[^A-Za-z0-9_-]/g, "_");
  return s || "_";
}

function channelPaths(stateDir, key) {
  const dir = join(stateDir, "channels", scopeName(key));
  return {
    dir,
    buffer: join(dir, "buffer.txt"),
    attachments: join(dir, "attachments"),
    jobs: join(dir, "jobs"),
    schedules: join(dir, "jobs", "schedules.json"),
    home: join(dir, "home"),
    view: join(dir, "view"),
    summaries: join(dir, "view", "summaries"),
    sessions: join(dir, "view", "sessions.json"),
    jobHistory: join(dir, "view", "job-history.jsonl"),
  };
}

/** The channel a summary belongs to, from the header writeSummary stamps; null if none. */
function summaryChannel(content) {
  const m = /^<!-- channel: (\S+) -->$/m.exec(String(content));
  return m ? m[1] : null;
}

/**
 * Rebuild a channel's view from the bot's records. Only records that name this
 * channel are copied: a summary without a channel stamp belongs to no one and
 * is shown to no one.
 *
 * @param {object} o
 * @param {string} o.stateDir
 * @param {string} o.key           the channel id (or run scope)
 * @param {string} o.historyDir    where summaries are written
 * @param {object} o.sessions      the session map as an object keyed by channel
 * @param {string} o.jobHistoryFile
 */
function writeView({ stateDir, key, historyDir, sessions, jobHistoryFile }) {
  const p = channelPaths(stateDir, key);
  mkdirSync(p.attachments, { recursive: true });
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.jobs, { recursive: true });
  mkdirSync(p.view, { recursive: true });
  for (const d of [p.dir, p.home, p.jobs, p.attachments, p.view]) {
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Private channel folder refused: ${d} is not a plain folder`);
  }
  // rm removes a link in its place, never what it points to.
  rmSync(p.summaries, { recursive: true, force: true });
  mkdirSync(p.summaries);
  for (const f of safeList(historyDir)) {
    if (!f.endsWith(".md")) continue;
    let content;
    try { content = readFileSync(join(historyDir, f), "utf8"); } catch { continue; }
    if (summaryChannel(content) === String(key)) writeOwn(join(p.summaries, f), content);
  }
  const own = sessions && sessions[key] ? { [key]: sessions[key] } : {};
  writeOwn(p.sessions, JSON.stringify(own, null, 2));
  let rows = "";
  try {
    rows = readFileSync(jobHistoryFile, "utf8").split("\n").filter((l) => {
      try { return String(JSON.parse(l).channel) === String(key); } catch { return false; }
    }).map((l) => l + "\n").join("");
  } catch { /* none yet */ }
  writeOwn(p.jobHistory, rows);
  if (!lstatSync(p.buffer, { throwIfNoEntry: false })?.isFile()) writeOwn(p.buffer, "");
  return p;
}

/**
 * The bot's own files in a channel folder are read and written without ever
 * following a link: a link where one of them should be is the one thing that
 * could turn a write for this channel into a write to another's records.
 */
function readOwn(file) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return ""; }
  try { return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : ""; } finally { closeSync(fd); }
}

/** Append to one of the bot's own files; a link in its place is replaced, never followed. */
function appendOwn(file, text) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if (err.code !== "ELOOP") throw err;
    writeOwn(file, text);
    return;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${file} is not a plain file`);
    writeFileSync(fd, text);
  } finally { closeSync(fd); }
}

/** Replace one of the bot's own files whole: written to a fresh name, renamed over it. */
function writeOwn(file, text) {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
  renameSync(tmp, file);
}

/** Size of one of the bot's own files; a link counts as empty. */
function sizeOwn(file) {
  try { const st = lstatSync(file); return st.isFile() ? st.size : 0; } catch { return 0; }
}

/** A channel's recent summaries, for a fresh session's context. */
function channelSummaries(contents, key) {
  return contents.filter((c) => summaryChannel(c) === String(key));
}

/**
 * A channel's schedule file as the bot reads it back: never through a link, and
 * only a plain file. Anything else reads as no jobs, with the reason.
 *
 * @returns {{ list: any, problem: string | null }}
 */
function readOwnFile(file) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (err) {
    return { list: null, problem: err.code === "ENOENT" ? null : `not read (${err.code})` };
  }
  try {
    if (!fstatSync(fd).isFile()) return { list: null, problem: "not a plain file" };
    return { list: JSON.parse(readFileSync(fd, "utf8")), problem: null };
  } catch (err) {
    return { list: null, problem: `unreadable (${err.message})` };
  } finally {
    closeSync(fd);
  }
}

/**
 * Every channel's scheduled jobs. A job is kept only from its own channel's
 * file: a run in one channel cannot plant a job in another by naming it.
 *
 * @returns {{ jobs: object[], dropped: { file: string, id: string, channel: string }[], problems: { file: string, problem: string }[] }}
 */
function loadChannelSchedules(stateDir) {
  const root = join(stateDir, "channels");
  const jobs = [], dropped = [], problems = [];
  for (const name of safeList(root)) {
    const file = channelPaths(stateDir, name).schedules;
    const { list, problem } = readOwnFile(file);
    if (problem) problems.push({ file, problem });
    if (!Array.isArray(list)) continue;
    for (const j of list) {
      if (j && scopeName(j.channel) === name) jobs.push(j);
      else dropped.push({ file, id: j?.id, channel: j?.channel });
    }
  }
  return { jobs, dropped, problems };
}

/**
 * Write each channel's jobs back to its own file; channels left with none get [].
 * Written to a fresh name and renamed over the file: a link left where the file
 * was is replaced, never followed.
 */
function saveChannelSchedules(stateDir, jobs) {
  const by = new Map();
  for (const j of jobs) {
    const k = scopeName(j.channel);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(j);
  }
  const root = join(stateDir, "channels");
  for (const name of safeList(root)) if (!by.has(name) && existsSync(channelPaths(stateDir, name).jobs)) by.set(name, []);
  for (const [k, list] of by) {
    const p = channelPaths(stateDir, k);
    mkdirSync(p.jobs, { recursive: true });
    const tmp = join(p.jobs, `.schedules.${randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", { flag: "wx" });
    renameSync(tmp, p.schedules);
  }
}

function safeList(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * A private bot's runs never hold its Discord login, and that must stay true of
 * every file a run is handed, not only its environment: the bot's settings and
 * MCP configs are given to the CLI, so the run can read them. A private bot
 * whose configuration carries a Discord credential, by name or by value, does
 * not start.
 *
 * @param {{ name: string, text: string }[]} sources the configs' text
 * @param {Record<string,string>} vars the bot's environment
 * @param {(name: string) => boolean} isCredential  a Discord credential's name
 * @param {number} minChars  values shorter than this are not matched by value
 */
function configCredentialProblems(sources, vars, isCredential, minChars) {
  const values = Object.entries(vars).filter(([k, v]) => isCredential(k) && String(v || "").length >= minChars).map(([, v]) => String(v));
  const problems = [];
  for (const { name, text } of sources) {
    if (!text) continue;
    // The CLI reads these as JSON, so they are judged as it will read them:
    // every key and string decoded (an escape hides nothing), plus the raw text.
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      problems.push(`BOT_PRIVATE_CHANNELS=true: ${name} is not valid JSON, so it cannot be checked for a Discord credential`);
      continue;
    }
    const strings = [String(text)];
    (function walk(v) {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { strings.push(k); walk(x); }
    })(parsed);
    const named = [...new Set(strings.flatMap((s) => s.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter(isCredential))];
    if (named.length || values.some((v) => strings.some((s) => s.includes(v)))) {
      problems.push(`BOT_PRIVATE_CHANNELS=true: ${name} carries a Discord credential${named.length ? ` (${named.join(", ")})` : ""}, and every run is handed that file. Remove it from there: the bot takes its login from its own environment`);
    }
  }
  return problems;
}

/**
 * Why this bot cannot run private, or []. The guarantee is the confinement, and
 * a run sees its working directory whole: the bot's records may not sit in it.
 */
function privateProblems({ enabled, confined, cwd, historyDir, stateDir, attachmentsDir, within }) {
  if (!enabled) return [];
  const p = [];
  if (!confined) p.push("BOT_PRIVATE_CHANNELS=true needs BOT_CONFINE=true: without it a run's shell can read every channel's records");
  for (const [name, dir] of [["BOT_HISTORY_DIR", historyDir], ["BOT_STATE_DIR", stateDir], ["BOT_ATTACHMENTS_DIR", attachmentsDir]]) {
    if (within(dir, cwd) || within(cwd, dir)) p.push(`BOT_PRIVATE_CHANNELS=true needs ${name} (${dir}) outside CLAUDE_CWD (${cwd}): every run sees the working directory whole`);
  }
  return p;
}

module.exports = { scopeName, channelPaths, summaryChannel, writeView, channelSummaries, loadChannelSchedules, saveChannelSchedules, privateProblems, configCredentialProblems, readOwn, appendOwn, writeOwn, sizeOwn };
