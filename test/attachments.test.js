/**
 * File-transfer tests — inbound (Discord → Claude) and outbound (Claude → Discord).
 *
 * Run: npm test
 *
 * bot.js cannot be require()d: importing it logs a live bot into Discord. So the
 * functions under test are lifted out of the bot.js SOURCE and evaluated here —
 * the assertions run against the real shipped code, not a copy.
 */
const { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const assert = require("assert");

const REPO = join(__dirname, "..");
const SRC = readFileSync(join(REPO, "bot.js"), "utf8");

function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in bot.js`);
  // Skip the parameter list first — destructured params contain braces.
  let i = SRC.indexOf("(", start), paren = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "(") paren++;
    else if (SRC[i] === ")" && --paren === 0) break;
  }
  let depth = 0;
  i = SRC.indexOf("{", i);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

function extractConst(name) {
  const re = new RegExp(`^const ${name} = [\\s\\S]*?;$`, "m");
  const m = SRC.match(re);
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

const TMP = mkdtempSync(join(tmpdir(), "bot-outbox-test-"));

const ctx = {
  join, readdirSync: require("fs").readdirSync, statSync: require("fs").statSync,
  CLAUDE_CWD: REPO,
  OUTBOX_DIR: TMP,
};

const code = [
  extractConst("IMAGE_EXTENSIONS"),
  extractConst("TEXT_EXTENSIONS"),
  extractConst("ATTACH_MARKER"),
  extractConst("OUTBOX_MTIME_TOLERANCE_MS"),
  extractFn("isImageAttachment"),
  extractFn("isTextAttachment"),
  extractFn("buildAttachmentPrompt"),
  extractFn("stripAttachMarkers"),
  extractFn("collectMarkedFiles"),
  extractFn("collectOutboxFiles"),
  "return { isImageAttachment, isTextAttachment, buildAttachmentPrompt, stripAttachMarkers, collectMarkedFiles, collectOutboxFiles };",
].join("\n\n");

const F = new Function(...Object.keys(ctx), code)(...Object.values(ctx));

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}

console.log("\nClassification (the bug: contentType was thrown away)");
check("png by extension is an image", () =>
  assert.strictEqual(F.isImageAttachment({ name: "shot.png", contentType: "" }), true));
check("image/* with no usable extension is STILL an image", () =>
  assert.strictEqual(F.isImageAttachment({ name: "clipboard-0001", contentType: "image/png" }), true));
check("message.txt is text, not image", () => {
  assert.strictEqual(F.isImageAttachment({ name: "message.txt", contentType: "text/plain" }), false);
  assert.strictEqual(F.isTextAttachment({ name: "message.txt", contentType: "text/plain" }), true);
});
check("a zip is neither — must still be passed through", () => {
  const f = { name: "logs.zip", contentType: "application/zip" };
  assert.strictEqual(F.isImageAttachment(f), false);
  assert.strictEqual(F.isTextAttachment(f), false);
});

console.log("\nPrompt injection (Doug's exact case)");
check("message.txt is named to Claude with its path", () => {
  const lines = F.buildAttachmentPrompt(
    [{ name: "message.txt", size: 3072, contentType: "text/plain", path: "/att/1-message.txt", source: "message" }], []);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes("message.txt"), "filename missing");
  assert.ok(lines[0].includes("/att/1-message.txt"), "path missing");
  assert.ok(/Read tool/.test(lines[0]), "no instruction to open it");
});
check("unknown binary type still reaches the prompt", () => {
  const lines = F.buildAttachmentPrompt(
    [{ name: "dump.bin", size: 999, contentType: "application/octet-stream", path: "/att/2-dump.bin" }], []);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes("/att/2-dump.bin"));
});
check("reply-borne attachment is labelled as such", () => {
  const lines = F.buildAttachmentPrompt(
    [{ name: "a.csv", size: 10, contentType: "text/csv", path: "/att/a.csv", source: "reply" }], []);
  assert.ok(/replies to/.test(lines[0]), `not labelled: ${lines[0]}`);
});
check("a failed download is reported, never silently dropped", () => {
  const lines = F.buildAttachmentPrompt([], [{ name: "big.pdf", reason: "over the 25MB limit" }]);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes("FAILED"));
  assert.ok(lines[0].includes("over the 25MB limit"));
  assert.ok(/do NOT tell them nothing was attached/i.test(lines[0]));
});
check("no attachments produces no noise", () =>
  assert.deepStrictEqual(F.buildAttachmentPrompt([], []), []));

console.log("\nOutbound: [[attach:]] marker");
check("absolute path is picked up", () =>
  assert.deepStrictEqual(F.collectMarkedFiles("done [[attach: /tmp/report.md]] enjoy"), ["/tmp/report.md"]));
check("relative path resolves against CLAUDE_CWD", () =>
  assert.deepStrictEqual(F.collectMarkedFiles("[[attach: out/r.json]]"),
    [join(REPO, "out/r.json")]));
check("multiple markers, any extension", () =>
  assert.deepStrictEqual(F.collectMarkedFiles("[[attach: /a.zip]]\n[[attach: /b.sql]]"), ["/a.zip", "/b.sql"]));
check("marker is hidden from the user", () => {
  const out = F.stripAttachMarkers("Here is the report.\n\n[[attach: /tmp/report.md]]\n\nLet me know.");
  assert.ok(!out.includes("[[attach"), "marker leaked into the Discord message");
  assert.ok(out.includes("Here is the report."));
  assert.ok(out.includes("Let me know."));
});
check("prose mentioning a path is NOT attached (no accidental file leak)", () =>
  assert.deepStrictEqual(F.collectMarkedFiles("See docs/rule-origins.md and CLAUDE.md for details."), []));

console.log("\nOutbound: outbox directory");
check("a file written during the run is collected, any type", () => {
  const since = Date.now();
  writeFileSync(join(TMP, "notes.md"), "hi");
  writeFileSync(join(TMP, "data.sqlite"), "x");
  const got = F.collectOutboxFiles(since).sort();
  assert.deepStrictEqual(got, [join(TMP, "data.sqlite"), join(TMP, "notes.md")]);
});
check("a file predating the run is left alone", () => {
  const got = F.collectOutboxFiles(Date.now() + 60000);
  assert.deepStrictEqual(got, []);
});
check("a missing outbox does not throw", () => {
  const F2 = new Function(...Object.keys(ctx), code)(...Object.values(ctx).map((v, i) =>
    Object.keys(ctx)[i] === "OUTBOX_DIR" ? "/nonexistent/outbox/path" : v));
  assert.deepStrictEqual(F2.collectOutboxFiles(0), []);
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
