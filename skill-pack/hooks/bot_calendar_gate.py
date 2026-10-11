#!/usr/bin/env python3
"""
Bot Calendar Gate — PreToolUse hook on the claude.ai Google Calendar connector's
create_event, update_event and delete_event.

A permission rule can allow or deny a TOOL; it cannot look at the tool's
arguments. Allowing create_event therefore allows an event that invites anyone.
This hook is the argument check: a bot that sets BOT_CALENDAR_NO_ATTENDEES may
write only guest-free events to the primary calendar, and may not email anyone
while doing it — for a bot that puts dates on its owner's calendar and must
never invite anyone.

Refused, with BOT_CALENDAR_NO_ATTENDEES set:
  - attendees / attendeeEmails on create_event
  - addedAttendees / addedAttendeeEmails on update_event
  - a calendarId other than "primary"
  - notificationLevel other than "NONE" on update_event and delete_event. This
    hook cannot see the event an eventId names, so it cannot tell a guest-free
    bot-made event from one of the owner's meetings; with NONE, a change to the wrong
    event still emails nobody.
  - any argument this hook does not know, so a new connector field cannot carry
    a guest past it

Refused, with BOT_CALENDAR_OWN_EVENTS also set:
  - update_event and delete_event on an eventId the bot did not create. This hook
    cannot see an existing event's title or guests, so "only change your own
    events" cannot be checked from the arguments. bot_calendar_ledger.py records
    the id of every event the bot creates, in calendar-events under BOT_STATE_DIR,
    one per line; an id that is not there is not the bot's. A missing or
    unreadable ledger refuses every update and delete.

Refused, with BOT_CALENDAR_TITLE_PREFIX also set (e.g. "Bot:"):
  - a create_event whose summary does not start with it
  - an update_event that sets a summary not starting with it

Answering an invitation (respond_to_event) is not this hook's job: the bot's
permission list denies the tool outright.

Bots that do not set BOT_CALENDAR_NO_ATTENDEES are untouched. With it set the
hook fails CLOSED: anything it cannot parse is refused.
Exit codes: 0 allow | 2 block.
"""
import json
import os
import sys

PREFIX = "mcp__claude_ai_Google_Calendar__"
COMMON = {"calendarId", "notificationLevel"}
KNOWN = {
    "create_event": COMMON | {
        "summary", "description", "startTime", "endTime", "allDay", "timeZone", "location",
        "colorId", "availability", "visibility", "eventType", "recurrenceData",
        "useDefaultReminders", "overrideReminders", "attachments", "addGoogleMeetUrl",
        "googleMeetUrl", "guestPermissions", "workingLocationProperties",
    },
    "update_event": COMMON | {
        "eventId", "summary", "description", "startTime", "endTime", "allDay", "timeZone",
        "location", "colorId", "availability", "visibility", "useDefaultReminders",
        "overrideReminders", "addedAttachments", "removedAttachmentFileUrls",
        "addGoogleMeetUrl", "googleMeetUrl", "guestPermissions", "removedAttendeeEmails",
    },
    "delete_event": COMMON | {"eventId"},
}
GUESTS = {
    "create_event": ("attendees", "attendeeEmails"),
    "update_event": ("addedAttendees", "addedAttendeeEmails"),
    "delete_event": (),
}


def refuse(reason):
    sys.stderr.write(f"[bot-calendar-gate] REFUSED: {reason}. Nothing was changed.\n")
    return 2


def on(value):
    return (value or "").strip().lower() in ("1", "true", "yes")


def ledger_path():
    state = os.environ.get("BOT_STATE_DIR", "").strip()
    return os.path.join(state, "calendar-events") if state else None


def own_events():
    """The ids of the events this bot created, or None when the ledger cannot be read."""
    path = ledger_path()
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        return set()
    except Exception:
        return None


def main():
    if not on(os.environ.get("BOT_CALENDAR_NO_ATTENDEES")):
        return 0
    try:
        data = json.load(sys.stdin)
    except Exception:
        return refuse("could not read the tool call")
    name = str(data.get("tool_name") or "")
    if not name.startswith(PREFIX) or name[len(PREFIX):] not in KNOWN:
        return 0
    tool = name[len(PREFIX):]
    args = data.get("tool_input")
    if not isinstance(args, dict):
        return refuse("could not read the tool input")
    for key in GUESTS[tool]:
        if args.get(key):
            return refuse(f"{key} invites someone; this bot's events have no attendees")
    unknown = sorted(set(args) - KNOWN[tool] - set(GUESTS[tool]))
    if unknown:
        return refuse(f"unknown argument(s) {', '.join(unknown)}")
    cal = args.get("calendarId")
    if cal not in (None, "", "primary"):
        return refuse(f"calendarId {cal!r}; this bot writes only to the primary calendar")
    if tool != "create_event" and args.get("notificationLevel") != "NONE":
        return refuse('pass notificationLevel: "NONE", so no change emails anyone')
    prefix = os.environ.get("BOT_CALENDAR_TITLE_PREFIX", "").strip()
    if prefix and (tool == "create_event" or "summary" in args):
        if not str(args.get("summary") or "").startswith(prefix):
            return refuse(f"the title must start with {prefix!r}")
    if tool != "create_event" and on(os.environ.get("BOT_CALENDAR_OWN_EVENTS")):
        mine = own_events()
        if mine is None:
            return refuse("this bot's event ledger cannot be read, so no event can be shown to be its own")
        if str(args.get("eventId") or "") not in mine:
            return refuse("this bot did not create that event, so it may not change or delete it; "
                          "ask the calendar's owner instead")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # Closed, not open: this gate stands between a bot and other people's inboxes.
        if os.environ.get("BOT_CALENDAR_NO_ATTENDEES", "").strip():
            sys.stderr.write(f"[bot-calendar-gate] REFUSED: internal error {e!r}. Nothing was changed.\n")
            sys.exit(2)
        sys.exit(0)
