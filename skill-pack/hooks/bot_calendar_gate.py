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


def main():
    if os.environ.get("BOT_CALENDAR_NO_ATTENDEES", "").strip().lower() not in ("1", "true", "yes"):
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
