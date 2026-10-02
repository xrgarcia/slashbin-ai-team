#!/usr/bin/env python3
"""
Bot Background Gate — PreToolUse hook on Bash.

Under the Discord harness (BOT_NAME set) every reply is one `claude -p`
process, and a `run_in_background` Bash job dies with it when the reply ends.
On 2026-10-02 a 30-minute comparison was started that way, the reply promised
to post its result, and the job was killed before it began: nothing came back.

The harness already has the TUI's task-notification equivalent: a wake booked
with --wait-for <signal> fires the moment a detached job runs signal.mjs. So
under the harness a background Bash call is BLOCKED and pointed at that.

Interactive sessions are untouched — there the session outlives the job.
Exit codes: 0 allow | 2 block. Fails OPEN on internal error.
"""
import json
import os
import sys


def main():
    if not os.environ.get("BOT_NAME"):
        return 0
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    if not (data.get("tool_input") or {}).get("run_in_background"):
        return 0
    root = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sched = os.path.join(root, "bin", "schedule.mjs")
    port = os.environ.get("WS_PORT", "9800")
    sig = os.path.normpath(os.path.join(root, "..", "scripts", "signal.mjs"))
    sys.stderr.write((
        "[bot-background-gate] BLOCKED: under the Discord harness this reply is one\n"
        "`claude -p` process; a run_in_background job is killed when the reply ends.\n\n"
        "Use the harness callback instead (the TUI's task notification, over Discord):\n"
        "  1. Book the wake FIRST (slashbin-harness:schedule skill):\n"
        "       node {sched} wake --in <timeout> --wait-for <name> --carry --prompt \"...\"\n"
        "  2. Detach the job and have its last step fire the signal:\n"
        "       setsid nohup sh -c '<cmd> > /tmp/<name>.out 2>&1; \\\n"
        "         node {sig} <name> --port {port} --data \"exit $?\"' \\\n"
        "         >/dev/null 2>&1 </dev/null &\n"
        "     (--port is this bot's bridge; a job outside the bot's env loses WS_PORT.)\n"
        "  3. Tell the person it reports back on completion, and the timeout time.\n"
    ).format(sched=sched, sig=sig, port=port))
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
