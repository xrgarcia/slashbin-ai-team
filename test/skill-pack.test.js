/**
 * The harness skill pack — skills that ship WITH the harness.
 *
 * Why it exists: skills operating on harness-owned data had to be copied into
 * every bot's repo, where they hardcoded harness internals and rotted. The
 * shipped per-repo `/remember` is the case study — checked 2026-08-09, ALL THREE
 * paths it read were dead: `history/` had been stale since May, and both buffer
 * filenames predated a bot rename.
 *
 * A pack alone does not fix that. It only turns three rotting copies into one.
 * The fix is the pack PLUS resolved paths in the environment — which is why the
 * hardcoded-path assertion below is the most important test in this file.
 */
const { readFileSync, readdirSync, existsSync, statSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const REPO = join(__dirname, "..");
const PACK = join(REPO, "skill-pack");
const bot = readFileSync(join(REPO, "bot.js"), "utf8");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

function skillFiles() {
  const dir = join(PACK, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => join(dir, n, "SKILL.md"))
    .filter((f) => existsSync(f));
}

console.log("\nHarness skill pack");

check("the pack is a loadable plugin", () => {
  const manifest = join(PACK, ".claude-plugin", "plugin.json");
  assert.ok(existsSync(manifest), "no .claude-plugin/plugin.json — the CLI will not load it");
  const m = JSON.parse(readFileSync(manifest, "utf8"));
  assert.ok(m.name, "the plugin needs a name — it namespaces every skill in the pack");
});

check("it ships at least one skill", () => {
  assert.ok(skillFiles().length > 0, "an empty pack proves nothing");
});

check("every skill declares name and description", () => {
  for (const f of skillFiles()) {
    const src = readFileSync(f, "utf8");
    assert.ok(/^---[\s\S]*?\bname:\s*\S/m.test(src), `${f} has no name in its frontmatter`);
    assert.ok(/^---[\s\S]*?\bdescription:\s*\S/m.test(src), `${f} has no description — it will never be selected`);
  }
});

check("NO pack skill hardcodes a state path", () => {
  // The whole point. A skill naming a file breaks the moment a bot is renamed or
  // a directory moves — exactly how the per-repo /remember came to read three
  // files that did not exist while reporting that it had checked them.
  const FORBIDDEN = [
    /conversation-buffer\.txt/,
    /\bsessions\.json\b/,
    /\bbuffer\.txt\b/,
    /\.bot-history\b/,
    /\bbot-history\//,
    /\bhistory\/\d{4}-/,
    /\/home\/[a-z]+\//i,
  ];
  for (const f of skillFiles()) {
    const src = readFileSync(f, "utf8");
    for (const re of FORBIDDEN) {
      assert.ok(!re.test(src),
        `${f} contains a hardcoded path (${re}). Read the published env var instead — see skill-pack/README.md.`);
    }
  }
});

check("every skill reaches harness state through the published variables", () => {
  // Either the skill reads $BOT_* itself, or it delegates to a script in the
  // pack's bin/ that does. What is NOT allowed is reaching harness state by any
  // third route — that route would be a hardcoded path.
  for (const f of skillFiles()) {
    const src = readFileSync(f, "utf8");
    const readsEnv = /\$BOT_[A-Z_]+/.test(src);
    const delegates = /\$CLAUDE_PLUGIN_ROOT\/bin\/[\w.-]+/.test(src) || /bin\/[\w.-]+\.mjs/.test(src);
    assert.ok(readsEnv || delegates,
      `${f} neither reads a BOT_* variable nor delegates to a pack script — how is it reaching harness state?`);

    if (delegates && !readsEnv) {
      // The script it delegates to must itself read the published variables,
      // or the delegation just moves the hardcoding one file along.
      const scripts = existsSync(join(PACK, "bin"))
        ? readdirSync(join(PACK, "bin")).map((n) => readFileSync(join(PACK, "bin", n), "utf8"))
        : [];
      assert.ok(scripts.some((sc) => /process\.env\.BOT_[A-Z_]+/.test(sc)),
        `${f} delegates to a script, but no script in bin/ reads a BOT_* variable`);
    }
  }
});

console.log("\nLoading");

check("every session spawn loads the pack", () => {
  assert.ok(/function skillPackArgs\(\)/.test(bot), "no skillPackArgs()");
  assert.ok(/\.\.\.skillPackArgs\(\)/.test(bot), "the pack is never passed to a spawn");
  assert.ok(/"--plugin-dir"/.test(bot), "must load via --plugin-dir");
});

check("a missing pack directory is skipped, not fatal", () => {
  const fn = /function skillPackArgs\(\)[\s\S]*?\n}/.exec(bot)[0];
  assert.ok(/existsSync\(d\)/.test(fn), "a deleted or unbuilt pack must not break every message");
});

check("BOT_SKILL_PACK= disables it", () => {
  assert.ok(/process\.env\.BOT_SKILL_PACK !== undefined/.test(bot),
    "an operator must be able to turn the pack off with an empty value");
});

check("extra packs can be added without touching the built-in one", () => {
  assert.ok(/BOT_EXTRA_SKILL_PACKS/.test(bot), "no way to load an additional pack");
});

console.log("\nThe contract the pack depends on");

check("the harness publishes resolved paths for skills to read", () => {
  for (const v of ["BOT_STATE_DIR", "BOT_SUMMARIES_DIR", "BOT_ATTACHMENTS_DIR",
                   "BOT_OUTBOX_DIR", "BOT_BUFFER_FILE", "BOT_SESSIONS_FILE"]) {
    assert.ok(new RegExp(`cleanEnv\\.${v} =`).test(bot),
      `${v} is not published — a pack skill would have to hardcode it, which is the bug this pack exists to end`);
  }
});

check("the pack documents the no-hardcoded-path rule", () => {
  const readme = join(PACK, "README.md");
  assert.ok(existsSync(readme), "the pack has no README");
  const src = readFileSync(readme, "utf8");
  assert.ok(/never name a file/i.test(src) || /Never hardcode a path/i.test(src),
    "the rule that keeps pack skills alive must be written down where skill authors will see it");
});

console.log("\n/remember — the contract that makes recall trustworthy");

check("recall is a script, not a list of instructions", () => {
  // A markdown skill cannot guarantee every source is searched, nor that an
  // absent source is reported rather than silently skipped.
  assert.ok(existsSync(join(PACK, "bin/recall.mjs")), "no gatherer script");
});

check("it distinguishes 'searched and found nothing' from 'never searched'", () => {
  const src = readFileSync(join(PACK, "bin/recall.mjs"), "utf8");
  for (const status of ["NO MATCH", "EMPTY", "MISSING", "UNAVAILABLE", "UNREADABLE"]) {
    assert.ok(src.includes(status), `no ${status} status — the whole failure mode is conflating these`);
  }
});

check("it searches all five stores", () => {
  const src = readFileSync(join(PACK, "bin/recall.mjs"), "utf8");
  for (const v of ["BOT_SUMMARIES_DIR", "BOT_BUFFER_FILE", "BOT_ATTACHMENTS_DIR",
                   "BOT_SESSIONS_FILE", "BOT_JOB_HISTORY_FILE"]) {
    assert.ok(src.includes(v), `${v} is never read — that store would be silently skipped`);
  }
});

check("it is read-only", () => {
  const src = readFileSync(join(PACK, "bin/recall.mjs"), "utf8");
  for (const w of ["writeFileSync", "appendFileSync", "unlinkSync", "renameSync", "rmSync"]) {
    assert.ok(!src.includes(w), `recall must never ${w} — it is a reader`);
  }
});

check("it respects a documented context budget", () => {
  const src = readFileSync(join(PACK, "bin/recall.mjs"), "utf8");
  assert.ok(/RECENT_CONTEXT_MAX_CHARS/.test(src),
    "no budget — this setting was documented for months while nothing read it");
  assert.ok(/budget/.test(src) && /truncated to fit/.test(src),
    "truncation must be visible, not silent");
});

check("the skill tells the bot never to pass a MISSING source off as checked", () => {
  const skill = readFileSync(join(PACK, "skills/remember/SKILL.md"), "utf8");
  assert.ok(/MISSING/.test(skill) && /never/i.test(skill),
    "the reading rule is the difference between recall and confident invention");
  assert.ok(/buffer is the source of truth/i.test(skill),
    "summaries are compressions; verbatim questions must go to the buffer");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
