"use strict";

/**
 * Which surfaces a bot answers on: Discord, Paperclip, or both.
 *
 * BOT_SURFACES declares them. Unset, a bot is on Discord, with any Paperclip
 * board it has as an addition — how every bot ran before Paperclip-only
 * existed. A bot is Paperclip-only only when it says so: a Discord bot that
 * loses its DISCORD_TOKEN refuses to start, rather than coming up on its board
 * alone and reporting ready while deaf on Discord.
 *
 * A declared surface is a prerequisite, not a wish: `paperclip` with no usable
 * board is a refusal, and every message says what to enable.
 */

const SURFACE_NAMES = ["discord", "paperclip"];

/** What a bot that names Paperclip must have, said the same way everywhere. */
const PAPERCLIP_PREREQUISITE = "the Paperclip connector must be enabled first: set PAPERCLIP_URL and PAPERCLIP_API_KEY (or PAPERCLIP_EXTRA_BOARDS) — see docs/INSTALL.md, \"Paperclip connector\"";

/**
 * @param {object} env  the bot's environment
 * @param {number} boardCount  usable Paperclip boards (paperclipBoards(env).boards.length)
 * @returns {{ discord: boolean, paperclip: boolean, paperclipRequired: boolean, declared: boolean, errors: string[], notes: string[] }}
 *   `paperclip`: run the connector; `paperclipRequired`: the connector being off is a refusal to start.
 */
function botSurfaces(env, boardCount) {
  const raw = String(env.BOT_SURFACES ?? "").trim();
  const declared = raw !== "";
  const names = declared ? raw.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean) : ["discord"];
  const errors = [], notes = [];
  const unknown = names.filter((n) => !SURFACE_NAMES.includes(n));
  if (unknown.length || !names.length) {
    errors.push(`BOT_SURFACES=${raw} is not a surface list — name discord, paperclip, or both (comma-separated)`);
  }
  const discord = names.includes("discord");
  const paperclipRequired = names.includes("paperclip");
  if (discord && !env.DISCORD_TOKEN) {
    errors.push(declared
      ? "BOT_SURFACES includes discord, so DISCORD_TOKEN is required"
      : `DISCORD_TOKEN is required — BOT_SURFACES is unset, so this bot answers on Discord. For a bot on Paperclip alone, set BOT_SURFACES=paperclip; ${PAPERCLIP_PREREQUISITE}`);
  }
  if (paperclipRequired && !boardCount) errors.push(`BOT_SURFACES includes paperclip, so ${PAPERCLIP_PREREQUISITE}`);
  if (declared && !discord && env.DISCORD_TOKEN) notes.push("DISCORD_TOKEN is set, but BOT_SURFACES leaves Discord off — the token is not used");
  if (declared && !paperclipRequired && boardCount) notes.push("a Paperclip board is configured, but BOT_SURFACES leaves Paperclip off — its tasks are not answered");
  return { discord, paperclip: declared ? paperclipRequired : boardCount > 0, paperclipRequired, declared, errors, notes };
}

module.exports = { botSurfaces, SURFACE_NAMES, PAPERCLIP_PREREQUISITE };
