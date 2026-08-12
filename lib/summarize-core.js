/**
 * The one implementation of summarization.
 *
 * This logic used to exist in FOUR places across two files:
 *
 *   bot.js:summarizeBufferLines   compresses the oldest slice of the buffer
 *   bot.js:summarizeWithClaude    the background summarizer
 *   summarize.js:summarizeWithClaude   the standalone `npm run summarize`
 *   writeSummary                  separately in bot.js AND summarize.js
 *
 * Each carried its own spawn, its own stream parser, its own env scrubbing, its
 * own timeout, and its own copy of the prompt. Every change had to be made two or
 * three times, and the record shows what that costs: adding BOT_PERMISSION_MODE
 * needed three identical edits, SUMMARIZE_TIMEOUT_MS needed three, and the
 * writeSummary overwrite bug — which destroyed a day of summaries on every run —
 * had to be fixed twice because both copies had it.
 *
 * One implementation, several callers. Changing the model, the prompt, the
 * timeout or the permission mode is now a one-file change.
 */
const { spawn } = require("child_process");
const { readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const { clampArgs } = require("./argv-budget");

/**
 * What a summary must contain. ONE copy — it was pasted in three places, and
 * pasted text drifts silently because nothing compares the copies.
 */
const SUMMARY_SECTIONS = [
  "Create a structured summary with:",
  "- **Topics discussed** — what subjects came up",
  "- **Decisions made** — any conclusions or agreements",
  "- **Action items** — tasks assigned or next steps identified",
  "- **Key context** — important facts, debugging results, or technical details worth remembering",
  "",
  "Be thorough but concise. Preserve specific details like error messages, file paths, issue numbers, and names.",
  "Do NOT add commentary — just summarize what happened.",
];

const SYSTEM_PROMPT =
  "You are a summarization assistant. Output only the summary, no preamble. Keep it under 2000 characters.";

/**
 * Two callers, two framings, one body.
 * `channel-day` summarises one channel on one date. `buffer-rotation` summarises
 * a mixed-channel slice being aged out of the rolling buffer.
 */
function buildSummaryPrompt({ kind, channelName, date, transcript }) {
  const opening =
    kind === "buffer-rotation"
      ? "Summarize this conversation buffer that is being rotated out."
      : `Summarize this Discord conversation from #${channelName} on ${date}.`;

  const trailer =
    kind === "buffer-rotation"
      ? ["Note which channels and participants were involved."]
      : [];

  return [opening, "", ...SUMMARY_SECTIONS, ...trailer, "", "```", transcript, "```"].join("\n");
}

/**
 * Run one summarization. Resolves with the summary text.
 *
 * `permissionArgs` is injected rather than resolved here: bot.js owns the
 * BOT_PERMISSION_MODE decision, and duplicating that resolution is how these
 * files drifted in the first place.
 */
function summarize({ transcript, kind, channelName, date, claudeBin, cwd, model, timeoutMs, permissionArgs, env }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--output-format", "stream-json",
      "--verbose",
      ...permissionArgs,
      ...(model ? ["--model", model] : []),
      "--append-system-prompt", SYSTEM_PROMPT,
      "-p", "--", buildSummaryPrompt({ kind, channelName, date, transcript }),
    ];

    // Claude must not think it is nested inside another Claude session.
    const cleanEnv = { ...(env || process.env) };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_AGENT_SDK_VERSION;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;

    // A transcript is SUMMARIZE_BATCH_SIZE messages of arbitrary length, handed
    // over as one argv string. Same 128KB kernel ceiling as the session prompt,
    // same `spawn E2BIG` if it is crossed — and here it would take the day's
    // summary down with it, which is the record recall depends on.
    const { args: safeArgs } = clampArgs(args);

    const child = spawn(claudeBin, safeArgs, {
      cwd,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],   // never wait for interactive consent
      timeout: timeoutMs,
    });

    let buf = "";
    let result = "";

    const absorb = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text") result += block.text;
          }
        }
      } catch { /* non-JSON line from the CLI */ }
    };

    child.stdout.on("data", (data) => {
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) absorb(line);
    });

    child.on("close", (code) => {
      if (buf.trim()) absorb(buf);
      if (code !== 0) return reject(new Error(`Claude exited with code ${code}`));
      resolve(result.trim());
    });

    child.on("error", (err) => reject(err));
  });
}

/**
 * Append one batch to a channel-day summary file.
 *
 * APPENDS. This used to writeFileSync in both copies, which silently destroyed
 * the day: the summarizer runs on an interval and its checkpoint means each run
 * only covers messages since the last one, so every run replaced a whole day with
 * a summary of the last few minutes. Measured 2026-08-09 — a day with 14
 * conversations had a summary reading "6 messages summarized".
 *
 * `channelId` disambiguates two Discord channels sharing a name (or sanitising to
 * the same one); without it their summaries interleave under one heading.
 */
function writeSummary({ historyDir, channelName, date, messageCount, summary, channelId = null, kind = "channel-day", timezone }) {
  mkdirSync(historyDir, { recursive: true });
  const stamp = new Date().toLocaleTimeString("en-US", {
    timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    hour12: false,
  });

  let filepath = join(historyDir, `${date}-${channelName}.md`);
  let existing = "";
  try { existing = readFileSync(filepath, "utf8"); } catch { /* first batch of the day */ }

  if (existing && channelId) {
    const owner = /^<!-- channel: (\S+) -->$/m.exec(existing);
    if (owner && owner[1] !== String(channelId)) {
      filepath = join(historyDir, `${date}-${channelName}-${channelId}.md`);
      try { existing = readFileSync(filepath, "utf8"); } catch { existing = ""; }
    }
  }

  const header = existing
    ? ""
    : [
        `# ${channelName} — ${date}`,
        `<!-- kind: ${kind} -->`,
        channelId ? `<!-- channel: ${channelId} -->` : null,
        "",
      ].filter((l) => l !== null).join("\n") + "\n";

  const section = [`> ${messageCount} messages summarized at ${stamp}`, "", summary, "", ""].join("\n");

  writeFileSync(filepath, existing ? existing + section : header + section);
  return filepath;
}

module.exports = { SUMMARY_SECTIONS, SYSTEM_PROMPT, buildSummaryPrompt, summarize, writeSummary };
