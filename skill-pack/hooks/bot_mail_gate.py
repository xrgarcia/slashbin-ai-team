#!/usr/bin/env python3
"""
Bot Mail Gate — PreToolUse hook on the claude.ai Gmail connector's send_message.

A permission rule can allow or deny a TOOL; it cannot look at the tool's
arguments. Allowing send_message therefore allows mail to anyone. This hook is
the argument check: a bot that sets BOT_MAIL_ALLOWED_RECIPIENTS may send a NEW
message only when every address in to, cc and bcc is on that list — for a bot
that may email its owner, and only its owner.

Refused, with the list set:
  - any recipient not on the list, in to, cc or bcc
  - no recipient at all
  - draftId (sends a stored draft as-is: its recipients are never seen here)
  - replyThreadId / replyToMessageId (a reply; replies are refused)
  - any argument this hook does not know, so a new connector field cannot
    carry a recipient past it
  - a subject without BOT_MAIL_SUBJECT_PREFIX, when that is set

Bots that do not set BOT_MAIL_ALLOWED_RECIPIENTS are untouched. With it set the
hook fails CLOSED: anything it cannot parse is refused.
Exit codes: 0 allow | 2 block.
"""
import json
import os
import re
import sys

TOOL = "mcp__claude_ai_Gmail__send_message"
KNOWN = {"to", "cc", "bcc", "subject", "body", "htmlBody", "attachments"}
REFUSED = {"draftId": "sending a stored draft", "replyThreadId": "a reply",
           "replyToMessageId": "a reply"}
ADDRESS = re.compile(r"^[^@\s<>,;]+@[^@\s<>,;]+$")


def addresses(value):
    """Plain addresses from a to/cc/bcc value; raises on anything else."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise ValueError("not a list")
    out = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("not a string")
        # "Name <a@b>" and "a@b, c@d" are not the schema's shape, but split
        # them rather than let one string smuggle a second address.
        for part in re.split(r"[,;]", item):
            part = part.strip()
            m = re.search(r"<([^<>]*)>\s*$", part)
            addr = (m.group(1) if m else part).strip().lower()
            if not addr:
                continue
            if not ADDRESS.match(addr):
                raise ValueError(f"unparseable address {part!r}")
            out.append(addr)
    return out


def refuse(reason):
    sys.stderr.write(f"[bot-mail-gate] REFUSED: {reason}. Nothing was sent.\n")
    return 2


def main():
    allowed_raw = os.environ.get("BOT_MAIL_ALLOWED_RECIPIENTS", "").strip()
    if not allowed_raw:
        return 0
    allowed = {a.strip().lower() for a in allowed_raw.split(",") if a.strip()}
    prefix = os.environ.get("BOT_MAIL_SUBJECT_PREFIX", "")
    try:
        data = json.load(sys.stdin)
    except Exception:
        return refuse("could not read the tool call")
    if data.get("tool_name") != TOOL:
        return 0
    args = data.get("tool_input")
    if not isinstance(args, dict):
        return refuse("could not read the tool input")
    for key, what in REFUSED.items():
        if args.get(key):
            return refuse(f"{key} is {what}; this bot may only send a new message")
    unknown = sorted(set(args) - KNOWN - set(REFUSED))
    if unknown:
        return refuse(f"unknown argument(s) {', '.join(unknown)}")
    try:
        rcpts = [a for k in ("to", "cc", "bcc") for a in addresses(args.get(k))]
    except ValueError as e:
        return refuse(str(e))
    if not rcpts:
        return refuse("no recipient")
    outside = sorted({a for a in rcpts if a not in allowed})
    if outside:
        return refuse(f"recipient(s) {', '.join(outside)} not in "
                      f"BOT_MAIL_ALLOWED_RECIPIENTS ({', '.join(sorted(allowed))})")
    if prefix and not str(args.get("subject") or "").startswith(prefix):
        return refuse(f"subject must start with {prefix!r}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # Closed, not open: this gate stands between a bot and real inboxes.
        if os.environ.get("BOT_MAIL_ALLOWED_RECIPIENTS", "").strip():
            sys.stderr.write(f"[bot-mail-gate] REFUSED: internal error {e!r}. Nothing was sent.\n")
            sys.exit(2)
        sys.exit(0)
