"use strict";

/**
 * Which surfaces a bot answers on: Discord, Paperclip, or both.
 *
 * Unset BOT_SURFACES, the bot answers wherever it is configured (issue #89):
 * on Discord when it has a DISCORD_TOKEN, and on every usable Paperclip board
 * it has. A bot with a board and no token is Paperclip-only — it never builds
 * a Discord client. A bot with neither has nowhere to answer and refuses to
 * start, naming both.
 *
 * BOT_SURFACES declares the surfaces outright, and a declared surface is a
 * prerequisite, not a wish: `discord` with no token, or `paperclip` with no
 * usable board, is a refusal, and every message says what to enable.
 */

const SURFACE_NAMES = ["discord", "paperclip"];

/** What a bot that names Paperclip must have, said the same way everywhere. */
const PAPERCLIP_PREREQUISITE = "the Paperclip connector must be enabled first: set PAPERCLIP_URL and PAPERCLIP_API_KEY (or PAPERCLIP_EXTRA_BOARDS) — see docs/INSTALL.md, \"Paperclip connector\"";

/** A bot with no surface at all, said the same way everywhere. */
const NO_SURFACE = `neither DISCORD_TOKEN nor a usable Paperclip board is configured, so this bot has nowhere to answer — set DISCORD_TOKEN for Discord, or for a Paperclip board ${PAPERCLIP_PREREQUISITE.replace(/^the Paperclip connector must be enabled first: /, "")}`;

/**
 * @param {object} env  the bot's environment
 * @param {number} boardCount  usable Paperclip boards (paperclipBoards(env).boards.length)
 * @returns {{ discord: boolean, paperclip: boolean, paperclipRequired: boolean, declared: boolean, errors: string[], notes: string[] }}
 *   `paperclip`: run the connector; `paperclipRequired`: the connector being off is a refusal to start
 *   (declared, or the bot's only surface).
 */
function botSurfaces(env, boardCount) {
  const raw = String(env.BOT_SURFACES ?? "").trim();
  const declared = raw !== "";
  const errors = [], notes = [];
  if (!declared) {
    const discord = Boolean(env.DISCORD_TOKEN);
    const paperclip = boardCount > 0;
    if (!discord && !paperclip) errors.push(NO_SURFACE);
    // Paperclip-only by configuration: the board is the bot's one surface, so
    // a connector that turns out off is as fatal as a declared one.
    return { discord, paperclip, paperclipRequired: !discord, declared, errors, notes };
  }
  const names = raw.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !SURFACE_NAMES.includes(n));
  if (unknown.length || !names.length) {
    errors.push(`BOT_SURFACES=${raw} is not a surface list — name discord, paperclip, or both (comma-separated)`);
  }
  const discord = names.includes("discord");
  const paperclipRequired = names.includes("paperclip");
  if (discord && !env.DISCORD_TOKEN) errors.push("BOT_SURFACES includes discord, so DISCORD_TOKEN is required");
  if (paperclipRequired && !boardCount) errors.push(`BOT_SURFACES includes paperclip, so ${PAPERCLIP_PREREQUISITE}`);
  if (!discord && env.DISCORD_TOKEN) notes.push("DISCORD_TOKEN is set, but BOT_SURFACES leaves Discord off — the token is not used");
  if (!paperclipRequired && boardCount) notes.push("a Paperclip board is configured, but BOT_SURFACES leaves Paperclip off — its tasks are not answered");
  return { discord, paperclip: paperclipRequired, paperclipRequired, declared, errors, notes };
}

/**
 * The line a Paperclip-only bot logs at startup (and doctor:fleet reports),
 * saying why Discord is off.
 *
 * @param {{ declared: boolean }} surfaces
 * @returns {string}
 */
function discordOffReason(surfaces) {
  return surfaces.declared
    ? "Discord off — Paperclip-only: BOT_SURFACES=paperclip, so this bot answers on its Paperclip board(s) alone"
    : "Discord off — Paperclip-only: no DISCORD_TOKEN and a Paperclip board configured, so this bot answers on its board(s) alone";
}

module.exports = { botSurfaces, discordOffReason, SURFACE_NAMES, PAPERCLIP_PREREQUISITE, NO_SURFACE };
