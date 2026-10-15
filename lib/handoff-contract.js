/**
 * The shared handoff contract an operator publishes for its agents, and how a
 * run is pointed at it.
 *
 * A contract setting is one of:
 *   tool:<server>.<tool>   the run's own MCP tools include the contract; the
 *                          prompt names the call and forbids rebuilding it
 *   reader:<abs path>      the run has no such tool; the harness imports an ES
 *                          module that exports runnerBlock() → { ok, text } and
 *                          puts its text in the prompt (a revision-stamped copy,
 *                          or an explicit "unavailable" block the module wrote)
 *
 * A reader that cannot be loaded or answers in the wrong shape gives an
 * explicit CONTRACT UNAVAILABLE block, never silence: a run told nothing would
 * fall back on whatever it remembers, which is the copy this exists to retire.
 */
const { isAbsolute } = require("path");
const { pathToFileURL } = require("url");

const UNAVAILABLE = (reason) =>
  `CONTRACT UNAVAILABLE: ${reason}. Do not reconstruct the handoff contract; say it is unavailable and name this reason.`;

/** Parse one setting; returns { setting, problem }. Empty or unset is no contract. */
function parseContract(value, label = "contract") {
  if (value === undefined || value === null || String(value).trim() === "") return { setting: null, problem: null };
  if (typeof value !== "string") return { setting: null, problem: `${label} must be a string` };
  const v = value.trim();
  const tool = /^tool:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(v);
  if (tool) return { setting: { kind: "tool", server: tool[1], tool: tool[2] }, problem: null };
  if (v.startsWith("reader:")) {
    const path = v.slice("reader:".length);
    if (!isAbsolute(path)) return { setting: null, problem: `${label}: a reader path must be absolute` };
    return { setting: { kind: "reader", path }, problem: null };
  }
  return { setting: null, problem: `${label} must be tool:<server>.<tool> or reader:<absolute path>` };
}

/** The prompt line for a run whose tools include the contract. */
function toolLine({ server, tool }) {
  return `Shared handoff contract: before acting on a handoff, approval, escalation or question of who owns what, call the ${server} MCP tool ${tool} and cite the revision it returns. If the call fails, say so and name the error; never reconstruct the contract from memory or documents.`;
}

const firstLine = (v) => String(v ?? "").split("\n")[0].slice(0, 200);

/**
 * The contract text for one run, never throwing. `importer` is injectable so
 * tests need no module on disk.
 */
async function contractText(setting, { importer = (p) => import(pathToFileURL(p).href) } = {}) {
  if (!setting) return "";
  if (setting.kind === "tool") return toolLine(setting);
  let mod;
  try { mod = await importer(setting.path); } catch (err) {
    return UNAVAILABLE(`the contract reader ${setting.path} could not be loaded (${firstLine(err?.code ?? err?.message ?? err)})`);
  }
  if (typeof mod?.runnerBlock !== "function") return UNAVAILABLE(`the contract reader ${setting.path} exports no runnerBlock()`);
  let block;
  try { block = await mod.runnerBlock(); } catch (err) {
    return UNAVAILABLE(`the contract reader failed (${firstLine(err?.message ?? err)})`);
  }
  if (!block || typeof block.text !== "string" || !block.text.trim()) return UNAVAILABLE("the contract reader returned no text");
  if (block.ok !== true && !block.text.startsWith("CONTRACT UNAVAILABLE:")) return UNAVAILABLE(`the contract reader reported a failure: ${firstLine(block.text)}`);
  return block.text;
}

module.exports = { parseContract, contractText, toolLine, UNAVAILABLE };
