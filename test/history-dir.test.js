/**
 * bot.js and summarize.js must resolve HISTORY_DIR identically.
 *
 * They are separate processes reading and writing the same summaries and
 * checkpoint file. summarize.js used to hardcode `.bot-history/` while bot.js
 * honoured BOT_HISTORY_DIR — so on any bot that sets it (both of ours do),
 * `npm run summarize` wrote into a directory the bot never read. It reported
 * success and reached nothing.
 *
 * This asserts the two resolvers agree, including the relative-path and
 * unset-env cases.
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const assert = require("assert");

const REPO = join(__dirname, "..");

/** Pull the `const HISTORY_DIR = ...;` declaration out of a file's source. */
function extractResolver(file) {
  const src = readFileSync(join(REPO, file), "utf8");
  const start = src.indexOf("const HISTORY_DIR =");
  assert.ok(start > -1, `HISTORY_DIR not declared in ${file}`);
  const end = src.indexOf(";", src.indexOf(": join(__dirname", start));
  assert.ok(end > -1, `could not find end of HISTORY_DIR declaration in ${file}`);
  const decl = src.slice(start, end + 1);
  return new Function("process", "join", "__dirname", `${decl} return HISTORY_DIR;`);
}

const botResolver = extractResolver("bot.js");
const summarizeResolver = extractResolver("summarize.js");

const DIRNAME = "/opt/bots";

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

function bothResolve(env) {
  const fakeProcess = { env };
  return [
    botResolver(fakeProcess, join, DIRNAME),
    summarizeResolver(fakeProcess, join, DIRNAME),
  ];
}

console.log("\nbot.js and summarize.js agree on HISTORY_DIR");

check("absolute BOT_HISTORY_DIR — the live config on this host", () => {
  const [bot, sum] = bothResolve({ BOT_HISTORY_DIR: "/home/x/code/slashbin-engineering-manager/bot-history" });
  assert.strictEqual(bot, "/home/x/code/slashbin-engineering-manager/bot-history");
  assert.strictEqual(sum, bot, "summarize.js would write where the bot never reads");
});

check("relative BOT_HISTORY_DIR resolves against the bot directory", () => {
  const [bot, sum] = bothResolve({ BOT_HISTORY_DIR: "history" });
  assert.strictEqual(bot, join(DIRNAME, "history"));
  assert.strictEqual(sum, bot);
});

check("unset BOT_HISTORY_DIR falls back to .bot-history", () => {
  const [bot, sum] = bothResolve({});
  assert.strictEqual(bot, join(DIRNAME, ".bot-history"));
  assert.strictEqual(sum, bot);
});

check("empty BOT_HISTORY_DIR is treated as unset, not as the bot directory", () => {
  const [bot, sum] = bothResolve({ BOT_HISTORY_DIR: "" });
  assert.strictEqual(bot, join(DIRNAME, ".bot-history"));
  assert.strictEqual(sum, bot);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
