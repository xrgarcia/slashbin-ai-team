#!/usr/bin/env node
/**
 * Gather everything this bot remembers that bears on a query.
 *
 * Deliberately a SCRIPT rather than instructions in a skill file. A markdown
 * skill cannot guarantee the two properties that make recall trustworthy:
 *
 *   1. Every source is actually searched. An instruction to "check five places"
 *      is a suggestion; a loop is not.
 *   2. A source that is empty, missing or truncated SAYS SO. The failure this
 *      replaces is a bot that searched three dead paths, believed it had checked,
 *      and answered confidently from the fraction it happened to find.
 *
 * Reads only. Never writes, never deletes.
 *
 * Every path comes from the environment the harness publishes. Nothing here names
 * a file — that is the rule that keeps this alive when a bot is renamed.
 *
 * Usage: node recall.mjs "<query>"
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.log("Usage: recall.mjs <query>\n\nSearches this bot's summaries, conversation buffer, attachments, sessions and job history.");
  process.exit(0);
}

// The README has documented this for months while nothing read it. It does now.
const MAX_CHARS = Number.parseInt(process.env.RECENT_CONTEXT_MAX_CHARS, 10) > 0
  ? Number.parseInt(process.env.RECENT_CONTEXT_MAX_CHARS, 10)
  : 12000;

const STOP = new Set(["the","a","an","and","or","of","to","in","on","for","with","what","did","we","i","you","about","was","were","is","are","that","this","it","my","our","when","how","why"]);
const terms = query.toLowerCase().match(/[a-z0-9_.-]{3,}/g)?.filter((t) => !STOP.has(t)) ?? [];

function score(text) {
  if (!terms.length) return 0;
  const low = text.toLowerCase();
  let n = 0;
  for (const t of terms) if (low.includes(t)) n++;
  return n;
}

/** Source outcomes are reported, never inferred from silence. */
const report = [];
function note(source, status, detail) { report.push({ source, status, detail }); }

const out = [];
let budget = MAX_CHARS;
function emit(block) {
  if (budget <= 0) return false;
  const text = block.length > budget ? block.slice(0, budget) + "\n…[truncated to fit the context budget]" : block;
  out.push(text);
  budget -= text.length;
  return true;
}

// ---------------------------------------------------------------- summaries
// The whole point of this feature: reach PAST the 48h injection window.
const summariesDir = process.env.BOT_SUMMARIES_DIR;
if (!summariesDir) note("summaries", "UNAVAILABLE", "BOT_SUMMARIES_DIR is not set — older harness");
else if (!existsSync(summariesDir)) note("summaries", "MISSING", summariesDir);
else {
  let files = [];
  try {
    files = readdirSync(summariesDir).filter((f) => f.endsWith(".md")).sort().reverse();
  } catch (e) { note("summaries", "UNREADABLE", e.message); }
  if (!files.length) note("summaries", "EMPTY", "no summary files yet");
  else {
    const hits = [];
    for (const f of files) {
      let src = "";
      try { src = readFileSync(join(summariesDir, f), "utf8"); } catch { continue; }
      // Score per batch section so a busy day does not swamp the budget.
      for (const section of src.split(/^> .*messages summarized.*$/m)) {
        const s = score(section);
        if (s > 0) hits.push({ file: f, s, text: section.trim() });
      }
    }
    hits.sort((a, b) => b.s - a.s || b.file.localeCompare(a.file));
    if (!hits.length) note("summaries", "NO MATCH", `${files.length} file(s) searched, oldest ${files[files.length-1]}`);
    else {
      note("summaries", "OK", `${hits.length} matching section(s) across ${files.length} file(s)`);
      for (const h of hits.slice(0, 6)) {
        if (!emit(`### summary — ${h.file}\n${h.text.slice(0, 1200)}\n`)) break;
      }
    }
  }
}

// ------------------------------------------------------------------- buffer
// The verbatim record. Reached here even on a RESUMED session, where the harness
// does not re-inject it — which is why a resumed bot used to have less context
// than a fresh one.
const bufferFile = process.env.BOT_BUFFER_FILE;
if (!bufferFile) note("buffer", "UNAVAILABLE", "BOT_BUFFER_FILE is not set — older harness");
else if (!existsSync(bufferFile)) note("buffer", "MISSING", bufferFile);
else {
  try {
    const lines = readFileSync(bufferFile, "utf8").split("\n").filter(Boolean);
    const hits = lines.map((l, i) => ({ l, i, s: score(l) })).filter((h) => h.s > 0);
    if (!hits.length) note("buffer", "NO MATCH", `${lines.length} line(s) searched`);
    else {
      note("buffer", "OK", `${hits.length} matching line(s) of ${lines.length}`);
      const truncated = hits.filter((h) => /\[truncated, \d+ chars total\]/.test(h.l)).length;
      if (truncated) note("buffer", "PARTIAL", `${truncated} matching line(s) are themselves truncated — do not quote them as verbatim`);
      hits.sort((a, b) => b.s - a.s);
      for (const h of hits.slice(0, 25)) {
        // One line of surrounding context each side keeps an exchange readable.
        const ctx = [lines[h.i - 1], h.l, lines[h.i + 1]].filter(Boolean).join("\n");
        if (!emit(`### buffer — line ${h.i + 1}\n${ctx}\n`)) break;
      }
    }
  } catch (e) { note("buffer", "UNREADABLE", e.message); }
}

// -------------------------------------------------------------- attachments
const attachDir = process.env.BOT_ATTACHMENTS_DIR;
const TEXTY = /\.(txt|md|json|csv|tsv|log|ya?ml|xml|html|sql|diff|patch|ini|conf|sh|js|mjs|ts|py|rb|go|rs|java|css)$/i;
if (!attachDir) note("attachments", "UNAVAILABLE", "BOT_ATTACHMENTS_DIR is not set");
else if (!existsSync(attachDir)) note("attachments", "MISSING", attachDir);
else {
  try {
    const files = readdirSync(attachDir);
    if (!files.length) note("attachments", "EMPTY", "no files received yet");
    else {
      const hits = [];
      for (const f of files) {
        const p = join(attachDir, f);
        let st; try { st = statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        let s = score(f);
        let snippet = null;
        if (TEXTY.test(f) && st.size < 512 * 1024) {
          try {
            const body = readFileSync(p, "utf8");
            const bs = score(body);
            if (bs > s) {
              s = bs;
              const line = body.split("\n").find((l) => score(l) > 0);
              if (line) snippet = line.slice(0, 200);
            }
          } catch { /* binary or unreadable */ }
        }
        if (s > 0) hits.push({ f, p, s, snippet, size: st.size, mtime: st.mtime });
      }
      if (!hits.length) note("attachments", "NO MATCH", `${files.length} file(s) searched`);
      else {
        note("attachments", "OK", `${hits.length} of ${files.length} file(s) match`);
        hits.sort((a, b) => b.s - a.s);
        for (const h of hits.slice(0, 8)) {
          const when = h.mtime.toISOString().slice(0, 10);
          if (!emit(`### attachment — ${h.f} (${Math.round(h.size / 1024)}KB, received ${when})\npath: ${h.p}\n${h.snippet ? `match: ${h.snippet}\n` : ""}`)) break;
        }
      }
    }
  } catch (e) { note("attachments", "UNREADABLE", e.message); }
}

// ------------------------------------------------------------------ sessions
const sessionsFile = process.env.BOT_SESSIONS_FILE;
if (!sessionsFile) note("sessions", "UNAVAILABLE", "BOT_SESSIONS_FILE is not set");
else if (!existsSync(sessionsFile)) note("sessions", "EMPTY", "no live sessions");
else {
  try {
    const map = JSON.parse(readFileSync(sessionsFile, "utf8"));
    const rows = Object.entries(map).map(([ch, v]) => ({ ch, last: new Date(v.lastActivity) }));
    if (!rows.length) note("sessions", "EMPTY", "no live sessions");
    else {
      note("sessions", "OK", `${rows.length} channel(s) with a live session`);
      rows.sort((a, b) => b.last - a.last);
      const here = process.env.BOT_CHANNEL_ID;
      emit("### live sessions\n" + rows.map((r) =>
        `- channel ${r.ch}${r.ch === here ? " (this one)" : ""} — last active ${r.last.toISOString().slice(0, 16).replace("T", " ")}`
      ).join("\n") + "\n");
    }
  } catch (e) { note("sessions", "UNREADABLE", e.message); }
}

// --------------------------------------------------------------- job history
const jobFile = process.env.BOT_JOB_HISTORY_FILE;
if (!jobFile) note("jobs", "UNAVAILABLE", "BOT_JOB_HISTORY_FILE is not set");
else if (!existsSync(jobFile)) note("jobs", "EMPTY", "no scheduled runs yet");
else {
  try {
    const rows = readFileSync(jobFile, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const hits = rows.filter((r) => score(JSON.stringify(r)) > 0);
    if (!hits.length) note("jobs", "NO MATCH", `${rows.length} run(s) searched`);
    else {
      note("jobs", "OK", `${hits.length} of ${rows.length} run(s) match`);
      emit("### scheduled runs\n" + hits.slice(-8).map((r) =>
        `- ${r.id} fired ${r.firedAt} — ${r.success ? "ok" : `FAILED: ${r.error || "unknown"}`}`
      ).join("\n") + "\n");
    }
  } catch (e) { note("jobs", "UNREADABLE", e.message); }
}

// ----------------------------------------------------------------- output
console.log(`# Recall for: ${query}\n`);
console.log("## Sources searched\n");
console.log("| source | result | detail |\n|---|---|---|");
for (const r of report) console.log(`| ${r.source} | **${r.status}** | ${r.detail} |`);
console.log("");
if (budget <= 0) console.log("> Context budget reached — some matches were dropped. Narrow the query for more depth.\n");
if (!out.length) {
  console.log("## No matching material\n");
  console.log("Nothing in this bot's memory matched. Say so plainly rather than answering from general knowledge — and check the table above: a source reading MISSING or UNAVAILABLE was never searched, which is different from searching it and finding nothing.");
} else {
  console.log("## Material\n");
  console.log(out.join("\n"));
}
