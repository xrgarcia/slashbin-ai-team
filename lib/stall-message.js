"use strict";
/**
 * The stall alert as Discord messages of at most `limit` characters each
 * (Discord refuses more). The diagnosis leads the first message, with the
 * mention; every card is one line and a line is never split across messages. A
 * line too long on its own loses title characters, never its link.
 */
function cardLine(c) {
  const kind = c.role === "blocking" ? "blocking (running on the board, not worked by this bot)" : "waiting";
  return { head: `- ${kind}, ${c.minutes} min: ${c.identifier ?? c.id}`, title: c.title ?? "", tail: c.link ? ` ${c.link}` : "" };
}

function stallMessages({ mention = "", head, cards = [], footer = "", limit = 2000 }) {
  const lead = mention ? `${mention} ` : "";
  const lines = cards.map((c) => {
    const { head: h, title, tail } = cardLine(c);
    const room = limit - h.length - tail.length - 1;   // the space before the title
    const t = !title ? "" : title.length <= room ? ` ${title}` : room > 1 ? ` ${title.slice(0, room - 1)}…` : "";
    return `${h}${t}${tail}`;
  });
  const out = [];
  let cur = `${lead}${head}`;
  for (const line of lines) {
    if (cur.length + 1 + line.length > limit) { out.push(cur); cur = line; } else cur += `\n${line}`;
  }
  if (footer) { if (cur.length + 1 + footer.length > limit) { out.push(cur); cur = footer; } else cur += `\n${footer}`; }
  out.push(cur);
  return out;
}
module.exports = { stallMessages };
