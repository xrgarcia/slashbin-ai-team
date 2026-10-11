#!/usr/bin/env python3
"""
Bot Calendar Ledger — PostToolUse hook on the claude.ai Google Calendar connector's
create_event.

With BOT_CALENDAR_NO_ATTENDEES and BOT_CALENDAR_OWN_EVENTS set, the calendar gate
lets the bot update or delete only events it created. The gate cannot see an
event's title or creator, so this hook keeps the record it reads: the id of every
event the bot creates, appended to calendar-events under BOT_STATE_DIR, one per
line.

An id this hook cannot find is reported back to the bot, not guessed: the event
exists, but the gate will refuse to change it, so its owner has to.
Exit codes: 0 recorded or not applicable | 2 created but not recorded.
"""
import json
import os
import sys

TOOL = "mcp__claude_ai_Google_Calendar__create_event"


def on(value):
    return (value or "").strip().lower() in ("1", "true", "yes")


def event_id(response):
    """The created event's id, from the response as a dict, a JSON string, or MCP content blocks."""
    if isinstance(response, str):
        try:
            return event_id(json.loads(response))
        except Exception:
            return None
    if isinstance(response, list):
        for block in response:
            found = event_id(block.get("text") if isinstance(block, dict) and "text" in block else block)
            if found:
                return found
        return None
    if isinstance(response, dict):
        if isinstance(response.get("id"), str) and response["id"]:
            return response["id"]
        for key in ("event", "structuredContent", "content", "result"):
            if key in response:
                found = event_id(response[key])
                if found:
                    return found
    return None


def main():
    if not (on(os.environ.get("BOT_CALENDAR_NO_ATTENDEES")) and on(os.environ.get("BOT_CALENDAR_OWN_EVENTS"))):
        return 0
    data = json.load(sys.stdin)
    if data.get("tool_name") != TOOL:
        return 0
    eid = event_id(data.get("tool_response"))
    state = os.environ.get("BOT_STATE_DIR", "").strip()
    if not eid or not state:
        sys.stderr.write("[bot-calendar-ledger] The event was created, but its id was not recorded, "
                         "so you cannot change or delete it later. Tell the calendar's owner.\n")
        return 2
    os.makedirs(state, exist_ok=True)
    with open(os.path.join(state, "calendar-events"), "a", encoding="utf-8") as f:
        f.write(eid + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        sys.stderr.write(f"[bot-calendar-ledger] The event was created, but recording it failed ({e!r}), "
                         "so you cannot change or delete it later. Tell the calendar's owner.\n")
        sys.exit(2)
