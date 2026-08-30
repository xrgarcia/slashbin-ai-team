/**
 * One-shot wake-ups — the self-paced follow-up.
 *
 * The scheduler could only ever answer "every day at 7". A bot that says "I'll
 * check back in 20 minutes" had to translate that into a wall-clock cron minute
 * in its own timezone and pair it with an `expires` — and if that expiry landed
 * a tick early the job was deleted BEFORE it fired, so the promise silently
 * evaporated. Every "let me watch that deploy" in Discord was either a cron
 * expression nobody could read or a background sleep that died with the run.
 *
 * A wake job is a cron job with `runAt` (an absolute instant) instead of `cron`.
 * It fires once and is gone. Nothing here recurs: a watch that needs to check
 * again re-arms itself from inside the run, which is what makes it self-paced
 * rather than fixed-cadence.
 */

/** A job the scheduler must fire at an instant, rather than on a cron. */
function isWakeJob(job) {
  return Boolean(job && typeof job.runAt === "string");
}

/**
 * The prompt a wake job actually runs.
 *
 * A scheduled run has no conversation around it, so everything the run needs to
 * behave correctly has to be IN the prompt: that it asked for this itself, how
 * many times it has already looked, what it carried forward, when to give up,
 * and — the part with no other route — the exact command that re-arms it. A
 * watch that cannot see how to schedule its next look simply stops watching,
 * and nobody finds out until they ask.
 */
function buildWakePrompt(job, { carried, now = new Date(), pluginRoot = "$CLAUDE_PLUGIN_ROOT" } = {}) {
  const attempt = Number(job.attempt) > 0 ? Number(job.attempt) : 1;
  const of = Number(job.maxAttempts) > 0 ? ` of at most ${job.maxAttempts}` : "";
  const lines = [
    `[Scheduled wake-up "${job.id}" — you set this yourself${job.createdAt ? ` at ${job.createdAt}` : ""}. It is now ${now.toISOString()}. This is look ${attempt}${of}.]`,
    "[Nobody asked for this and nobody is watching. It is not a conversation turn: if nothing has changed, produce NO output at all — an empty reply is the correct answer and costs no one a notification.]",
    carried
      ? "[The conversation that set this wake-up is attached — you are continuing it, and you can see what was already said.]"
      : "[The conversation that set this wake-up is NOT attached; it has since rotated. Work from the note below and the prompt — do not refer to things you cannot see.]",
  ];
  if (job.note) lines.push(`[What you carried forward: ${job.note}]`);
  if (job.deadline) lines.push(`[Deadline: ${job.deadline}. After that this watch stops firing whether or not it finished, so say something before then if it matters.]`);

  const reArm = [
    `node "${pluginRoot}/bin/schedule.mjs" wake --in <how long to wait, e.g. 15m>`,
    `--prompt "<what to check next time — it must stand alone>"`,
    `--note "<what you know right now that the next look needs>"`,
    `--attempt ${attempt + 1}`,
    `--chain-started ${job.chainStartedAt || job.createdAt || job.runAt}`,
    ...(job.maxAttempts ? [`--max-attempts ${job.maxAttempts}`] : []),
    ...(job.deadline ? [`--deadline ${job.deadline}`] : []),
    ...(job.carry ? ["--carry"] : []),
  ].join(" ");

  const footer = [
    "",
    "[This job has already been removed — it fires once. If the answer is not final yet, schedule the next look YOURSELF before you finish; nothing else will:",
    `  ${reArm}`,
    "To stop, simply do not schedule another one. Stop as soon as you have the answer, or as soon as you hit something a person needs to decide.]",
  ].join("\n");

  return `${lines.join("\n")}\n\n${job.prompt}\n${footer}`;
}

module.exports = { isWakeJob, buildWakePrompt };
