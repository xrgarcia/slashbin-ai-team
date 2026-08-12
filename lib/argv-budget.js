/**
 * Why this file exists: `Error: spawn E2BIG`.
 *
 * The harness hands Claude its context on the command line — the whole buffer and
 * every recent daily summary ride in one `--append-system-prompt` argument. Linux
 * caps a SINGLE argv string at MAX_ARG_STRLEN (32 pages = 131072 bytes), separately
 * from the much larger total ARG_MAX. Nothing in the harness watched that ceiling,
 * and nothing in the config could: BUFFER_MAX_BYTES capped the buffer at 32KB, but
 * summaries were injected whole, all of them, for the full lookback window. Two
 * busy days took the engineering-manager bot to 137KB and every fresh session died
 * at spawn with an error naming nothing that would let you find the cause.
 *
 * It read as "breaks after I restart my machine" because a warm session RESUMES,
 * and resume skips context injection entirely. Only a fresh session — the first
 * message after SESSION_TIMEOUT_MS, which a reboot guarantees — paid the cost.
 *
 * So: two layers, both here.
 *   1. budgetContext() — fit the context to a declared byte budget, dropping the
 *      oldest history first and SAYING SO in the prompt, so the model knows to go
 *      read the files rather than assume that is all there was.
 *   2. clampArgs() — the backstop at the spawn boundary. Even with a misconfigured
 *      budget, a pathological attachment list, or a future caller that forgets all
 *      of this, no argument leaves here above the kernel limit. E2BIG becomes
 *      structurally unreachable instead of merely unlikely.
 */

// MAX_ARG_STRLEN is 32 * PAGE_SIZE. The kernel needs room for the terminating NUL,
// so the largest string that actually passes is one byte under. Measured on this
// host by bisecting spawn(): 131071.
const MAX_ARG_BYTES = 32 * 4096 - 1;

// Leave the ceiling itself alone as headroom — clamping to exactly the limit is a
// coin flip on a host with a different page size.
const DEFAULT_ARG_LIMIT = MAX_ARG_BYTES - 1024;

// What one fresh session may spend on remembered context. Generous next to a
// typical day, small next to the limit: the gap is where attachment lines, the
// channel preamble and a future prompt section live.
const DEFAULT_CONTEXT_MAX_BYTES = 64 * 1024;

const byteLength = (s) => Buffer.byteLength(s, "utf8");

/**
 * Cut a string to a byte budget without splitting a UTF-8 character.
 * `keep: "tail"` preserves the END — the right choice for anything ordered oldest
 * to newest, which is everything here.
 */
function truncateToBytes(str, maxBytes, { keep = "tail" } = {}) {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;

  const slice = keep === "tail"
    ? buf.subarray(buf.length - maxBytes)
    : buf.subarray(0, maxBytes);

  // A byte-slice can land mid-character; Node renders the orphaned bytes as U+FFFD.
  // Drop those rather than hand Claude a mojibake edge.
  let out = slice.toString("utf8");
  if (keep === "tail") out = out.replace(/^�+/, "");
  else out = out.replace(/�+$/, "");

  // Prefer a line boundary — half a log line reads as corruption.
  const nl = keep === "tail" ? out.indexOf("\n") : out.lastIndexOf("\n");
  if (nl !== -1 && nl < out.length - 1) {
    out = keep === "tail" ? out.slice(nl + 1) : out.slice(0, nl);
  }
  return out;
}

/**
 * Assemble the remembered-context block within a byte budget.
 *
 * Priority is recency: the conversation buffer is the freshest thing the bot has,
 * so it is placed first, then summaries newest-first until the budget runs out.
 * Output order stays chronological — oldest summary first, buffer last — because
 * that is how the prompt reads.
 *
 * Everything dropped is ANNOUNCED. Silent truncation is how a bot ends up
 * confidently telling you nothing happened on a day it simply never saw.
 */
function budgetContext({ summaries = [], buffer = "", maxBytes = DEFAULT_CONTEXT_MAX_BYTES } = {}) {
  // The omission notices are themselves prompt text, and their size is not known
  // until we know what was omitted. Rather than reserve a guessed allowance on
  // every call — which would tax the common case where nothing is dropped — fit
  // once, measure, and refit against the real overshoot. `maxBytes` is a ceiling
  // this function must not exceed, so the third step enforces it outright.
  let result = fitContext(summaries, buffer, maxBytes);
  if (result.bytes > maxBytes) {
    result = fitContext(summaries, buffer, maxBytes - (result.bytes - maxBytes) - 64);
  }
  if (result.bytes > maxBytes) {
    result.text = truncateToBytes(result.text, maxBytes, { keep: "head" });
    result.bytes = byteLength(result.text);
  }
  return result;
}

function fitContext(summaries, buffer, maxBytes) {
  const report = { droppedSummaries: 0, truncatedSummaries: 0, bufferTruncated: false, bytes: 0 };

  const SUMMARY_HEAD = "--- Conversation history (summaries from prior sessions) ---";
  const SUMMARY_FOOT = "--- End summaries ---";
  const BUFFER_HEAD = "--- Conversation buffer (recent activity across all channels) ---";
  const BUFFER_FOOT = "--- End conversation buffer ---";

  let remaining = maxBytes;

  // 1. The buffer, capped at what is left of the budget.
  let keptBuffer = "";
  const trimmedBuffer = String(buffer || "").trim();
  if (trimmedBuffer) {
    const overhead = byteLength(`${BUFFER_HEAD}\n\n\n\n${BUFFER_FOOT}\n\n`);
    const room = remaining - overhead;
    if (room > 0) {
      if (byteLength(trimmedBuffer) <= room) {
        keptBuffer = trimmedBuffer;
      } else {
        keptBuffer = truncateToBytes(trimmedBuffer, room, { keep: "tail" });
        report.bufferTruncated = true;
      }
      remaining -= byteLength(keptBuffer) + overhead;
    }
  }

  // 2. Summaries, newest first, while they fit.
  const kept = [];
  const ordered = summaries.filter((s) => s && s.trim());
  if (ordered.length > 0) {
    const overhead = byteLength(`${SUMMARY_HEAD}\n\n\n\n${SUMMARY_FOOT}\n\n`);
    remaining -= overhead;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const text = ordered[i].trim();
      const cost = byteLength(text) + 2; // the blank line joining sections
      if (cost <= remaining) {
        kept.unshift(text);
        remaining -= cost;
      } else if (remaining > 2048) {
        // Enough room left to be worth a partial day rather than none of it.
        kept.unshift(truncateToBytes(text, remaining - 2, { keep: "tail" }));
        report.truncatedSummaries++;
        report.droppedSummaries += i;
        remaining = 0;
        break;
      } else {
        report.droppedSummaries += i + 1;
        break;
      }
    }
  }

  const sections = [];
  if (kept.length > 0 || report.droppedSummaries > 0) {
    sections.push(SUMMARY_HEAD);
    if (report.droppedSummaries > 0) {
      sections.push(
        `[${report.droppedSummaries} older daily ${report.droppedSummaries === 1 ? "summary was" : "summaries were"} omitted here to fit this bot's context budget. They still exist on disk in $BOT_SUMMARIES_DIR — read them if the user asks about anything you cannot see below. Do NOT tell the user nothing happened then.]`
      );
    }
    if (report.truncatedSummaries > 0) {
      sections.push("[The oldest summary shown below starts mid-file; its earlier part is on disk.]");
    }
    sections.push(...kept, SUMMARY_FOOT);
  }
  if (keptBuffer) {
    sections.push(BUFFER_HEAD);
    if (report.bufferTruncated) {
      sections.push("[Older buffer lines were dropped to fit the context budget. The full buffer is at $BOT_BUFFER_FILE.]");
    }
    sections.push(keptBuffer, BUFFER_FOOT);
  }

  const text = sections.join("\n\n");
  report.bytes = byteLength(text);
  return { text, ...report };
}

/**
 * The spawn boundary. Nothing gets past here oversized.
 * Returns a new array; reports each clamp so the caller can log it loudly rather
 * than quietly shipping a half prompt.
 */
function clampArgs(args, { maxBytes = DEFAULT_ARG_LIMIT } = {}) {
  const clamped = [];
  const out = args.map((arg, index) => {
    const value = String(arg);
    const bytes = byteLength(value);
    if (bytes <= maxBytes) return value;
    // Keep the head: an oversized argument is a prompt, and its instructions are at
    // the top. Say what happened INSIDE the argument — this is the only place the
    // model could learn it was cut.
    const notice = "\n\n[TRUNCATED: this prompt exceeded the operating system's argument size limit and was cut here.]";
    const body = truncateToBytes(value, maxBytes - byteLength(notice), { keep: "head" });
    clamped.push({ index, bytes, limit: maxBytes, preview: value.slice(0, 40) });
    return body + notice;
  });
  return { args: out, clamped };
}

module.exports = {
  MAX_ARG_BYTES,
  DEFAULT_ARG_LIMIT,
  DEFAULT_CONTEXT_MAX_BYTES,
  byteLength,
  truncateToBytes,
  budgetContext,
  clampArgs,
};
