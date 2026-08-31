// `npm run doctor` was permanently red on this 2-bot host with nothing wrong.
//
// Both failures were the same mistake: the single-bot checks read the AMBIENT
// process.env, but a host that launches its bots from ecosystem.config.js gives
// each one its own DISCORD_TOKEN, CLAUDE_CWD, ALLOWED_USERS and BOT_STATE_DIR.
// The ambient shell carries none of them, so the checks were asking about a bot
// that does not exist at that level — and reporting "no answer" as FAIL.
//
// A gate that is always red is a gate nobody reads, which is the actual risk:
// the day a token really is reset, the FAIL looks like the two that were always
// there. So these assert BOTH directions — the false failure is gone, and a
// genuinely broken single-bot install still fails.

const assert = require("assert");
const { mkdtempSync, writeFileSync, rmSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const ECOSYSTEM_TEMPLATE_LITERALS = `
const BOT_DATA = '/var/bot-data';
const EM_REPO = '/srv/em';
module.exports = {
  apps: [
    {
      env: {
        BOT_NAME: 'engineering-manager',
        DISCORD_TOKEN: process.env.EM_DISCORD_TOKEN,
        CLAUDE_CWD: EM_REPO,
        ALLOWED_USERS: '12345',
        BOT_STATE_DIR: \`\${BOT_DATA}/engineering-manager\`,
        BOT_HISTORY_DIR: \`\${EM_REPO}/bot-history\`,
      },
    },
  ],
};
`;

const ECOSYSTEM_PLAIN_STRINGS = `
module.exports = {
  apps: [
    {
      env: {
        BOT_NAME: 'product-owner',
        DISCORD_TOKEN: process.env.PO_DISCORD_TOKEN,
        ALLOWED_USERS: '999,888',
        BOT_STATE_DIR: '/var/bot-data/product-owner',
      },
    },
  ],
};
`;

(async () => {
  const { parseFleet, render, PASS, FAIL, WARN, SKIP } = await import("../scripts/lib/checks.mjs");

  const dir = mkdtempSync(join(tmpdir(), "doctor-fleet-"));
  const write = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  console.log("\nReading a real ecosystem.config.js, not a simplified one");

  check("a template-literal path resolves against its top-level const", () => {
    const [bot] = parseFleet(write("tmpl.js", ECOSYSTEM_TEMPLATE_LITERALS));
    // Before the fix this was null, so checkStateDir fell back to the harness
    // .bot-history and warned about a directory the bot never touches.
    assert.strictEqual(bot.stateDir, "/var/bot-data/engineering-manager");
    assert.strictEqual(bot.historyDir, "/srv/em/bot-history");
  });

  check("a bare const reference resolves too", () => {
    const [bot] = parseFleet(write("tmpl2.js", ECOSYSTEM_TEMPLATE_LITERALS));
    assert.strictEqual(bot.claudeCwd, "/srv/em");
  });

  check("plain quoted values still work", () => {
    const [bot] = parseFleet(write("plain.js", ECOSYSTEM_PLAIN_STRINGS));
    assert.strictEqual(bot.stateDir, "/var/bot-data/product-owner");
    assert.strictEqual(bot.name, "product-owner");
  });

  check("ALLOWED_USERS is read per bot, so the fleet check has a subject", () => {
    const [em] = parseFleet(write("a.js", ECOSYSTEM_TEMPLATE_LITERALS));
    const [po] = parseFleet(write("b.js", ECOSYSTEM_PLAIN_STRINGS));
    assert.strictEqual(em.allowedUsers, "12345");
    assert.strictEqual(po.allowedUsers, "999,888");
  });

  check("an unresolvable ${VAR} is left intact, never rendered as undefined", () => {
    const [bot] = parseFleet(write("unres.js", `
module.exports = { apps: [ { env: {
  BOT_NAME: 'x',
  BOT_STATE_DIR: \`\${NOT_DECLARED}/x\`,
} } ] };
`));
    // A path containing the literal "undefined" would be created on disk by the
    // write probe — silently wrong is worse than visibly unresolved.
    assert.ok(!String(bot.stateDir).includes("undefined"), bot.stateDir);
    assert.ok(String(bot.stateDir).includes("NOT_DECLARED"), bot.stateDir);
  });

  check("the token reference is still read as a variable NAME, never a value", () => {
    const [bot] = parseFleet(write("tok.js", ECOSYSTEM_TEMPLATE_LITERALS));
    assert.strictEqual(bot.tokenVar, "EM_DISCORD_TOKEN");
  });

  console.log("\nSKIP means 'no subject here' — it must not soften a real failure");

  const quiet = (fn) => {
    const real = console.log;
    console.log = () => {};
    try { return fn(); } finally { console.log = real; }
  };

  check("a skipped check does not count as failed", () => {
    const failed = quiet(() => render([
      { name: "a", status: PASS, detail: "" },
      { name: "b", status: SKIP, detail: "per-bot" },
    ]));
    assert.strictEqual(failed, 0);
  });

  check("a skipped check does not count as passed either", () => {
    let out = "";
    const real = console.log;
    console.log = (s) => { out += s + "\n"; };
    try {
      render([
        { name: "a", status: PASS, detail: "" },
        { name: "b", status: SKIP, detail: "per-bot" },
      ]);
    } finally { console.log = real; }
    assert.match(out, /1 passed, 0 warning\(s\), 0 failed, 1 skipped/);
  });

  check("a real failure still fails, alongside skips", () => {
    const failed = quiet(() => render([
      { name: "a", status: SKIP, detail: "per-bot" },
      { name: "b", status: FAIL, detail: "token rejected" },
    ]));
    assert.strictEqual(failed, 1);
  });

  check("warnings are still counted separately from skips", () => {
    let out = "";
    const real = console.log;
    console.log = (s) => { out += s + "\n"; };
    try {
      render([
        { name: "a", status: WARN, detail: "" },
        { name: "b", status: SKIP, detail: "" },
      ]);
    } finally { console.log = real; }
    assert.match(out, /0 passed, 1 warning\(s\), 0 failed, 1 skipped/);
  });

  check("with no skips the summary is unchanged for existing installs", () => {
    let out = "";
    const real = console.log;
    console.log = (s) => { out += s + "\n"; };
    try {
      render([{ name: "a", status: PASS, detail: "" }]);
    } finally { console.log = real; }
    assert.match(out, /1 passed, 0 warning\(s\), 0 failed\n/);
    assert.ok(!out.includes("skipped"), "no skips must not print a skipped count");
  });

  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${11 - failures} passed, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
})();
