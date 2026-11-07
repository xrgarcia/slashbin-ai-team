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
 *   schedules.json     the channel's scheduled jobs
 *   home/              the agent's home: its session transcripts live here
 *   view/              what recall reads, rebuilt before every run from the
 *                      bot's records and holding only this channel's part:
 *                      summaries/, sessions.json, job-history.jsonl
 *
 * A run is given that folder and nothing of another channel's. The guarantee is
 * the confinement (lib/confine.js), which binds only the run's own channel
 * folder; so a private bot must also be confined, and refuses to start if not.
 */

const { join } = require("path");
const { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } = require("fs");

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
    schedules: join(dir, "schedules.json"),
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
  rmSync(p.summaries, { recursive: true, force: true });
  mkdirSync(p.summaries, { recursive: true });
  for (const f of safeList(historyDir)) {
    if (!f.endsWith(".md")) continue;
    let content;
    try { content = readFileSync(join(historyDir, f), "utf8"); } catch { continue; }
    if (summaryChannel(content) === String(key)) writeFileSync(join(p.summaries, f), content);
  }
  const own = sessions && sessions[key] ? { [key]: sessions[key] } : {};
  writeFileSync(p.sessions, JSON.stringify(own, null, 2));
  let rows = "";
  try {
    rows = readFileSync(jobHistoryFile, "utf8").split("\n").filter((l) => {
      try { return String(JSON.parse(l).channel) === String(key); } catch { return false; }
    }).map((l) => l + "\n").join("");
  } catch { /* none yet */ }
  writeFileSync(p.jobHistory, rows);
  if (!existsSync(p.buffer)) writeFileSync(p.buffer, "");
  return p;
}

/** A channel's recent summaries, for a fresh session's context. */
function channelSummaries(contents, key) {
  return contents.filter((c) => summaryChannel(c) === String(key));
}

/**
 * Every channel's scheduled jobs. A job is kept only from its own channel's
 * file: a run in one channel cannot plant a job in another by naming it.
 *
 * @returns {{ jobs: object[], dropped: { file: string, id: string, channel: string }[] }}
 */
function loadChannelSchedules(stateDir) {
  const root = join(stateDir, "channels");
  const jobs = [], dropped = [];
  for (const name of safeList(root)) {
    const file = join(root, name, "schedules.json");
    let list;
    try { list = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const j of list) {
      if (j && scopeName(j.channel) === name) jobs.push(j);
      else dropped.push({ file, id: j?.id, channel: j?.channel });
    }
  }
  return { jobs, dropped };
}

/** Write each channel's jobs back to its own file; channels left with none get []. */
function saveChannelSchedules(stateDir, jobs) {
  const by = new Map();
  for (const j of jobs) {
    const k = scopeName(j.channel);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(j);
  }
  const root = join(stateDir, "channels");
  for (const name of safeList(root)) if (!by.has(name) && existsSync(join(root, name, "schedules.json"))) by.set(name, []);
  for (const [k, list] of by) {
    mkdirSync(join(root, k), { recursive: true });
    writeFileSync(join(root, k, "schedules.json"), JSON.stringify(list, null, 2) + "\n");
  }
}

function safeList(dir) {
  try { return readdirSync(dir); } catch { return []; }
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

module.exports = { scopeName, channelPaths, summaryChannel, writeView, channelSummaries, loadChannelSchedules, saveChannelSchedules, privateProblems };
