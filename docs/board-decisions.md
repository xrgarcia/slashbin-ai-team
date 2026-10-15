# Board decisions: who decided a card's status, and who owns an escalation

The Paperclip poller (`lib/paperclip.js`) makes two judgements on every wake:

1. **Whose decision is the card's status?** A stop the bot set itself, or one
   Paperclip set when it lost a run, is no one's choice, and the bot moves on
   from it. A stop a person or another agent chose stands. So does any change a
   person made to the status or its waits after the bot last read the card.
2. **Which attempt owns an escalation?** An escalation may be worked several
   times under one run, because the card is revised while it is worked. Only
   the latest validated attempt routes the card, sets the outcome, closes the
   transcript and tells the person.

Both judgements used to be inferred from the shape of the newest record:
`lastDecision`, `personSince` and `statusSetter`, plus the insertion order of a
`Map`. PR #91 review round 4 reproduced four failures of that inference (issue
#97). This file is the model that replaces it. The code implements these
tables; `test/paperclip-reconcile.test.js` parses the rows below and runs every
one. A row added here without a test builder fails the suite, and so does a
builder without a row.

## What the board records (the facts the model stands on)

These are read from the source, not inferred from behaviour. Paperclip is at
f758a984b and the Foreman at 157392d.

- **Every PATCH is one `issue.updated` entry.** Its `details` are the request
  fields, plus `changes` (from/to of every field that changed), and
  `source: "comment"` when the PATCH carried a comment. Source:
  `server/src/routes/issues.ts:13966-13990`.
- **A comment carried by a PATCH is a second entry, `issue.comment_added`.** It
  is logged after the update, by the same actor and run. Its `details` include
  `bodySnippet` (the first 120 characters of the body). Source:
  `routes/issues.ts:14283-14291` and `:14380`.
- **`statusVersion` is bumped without a status change in two cases** (source:
  `server/src/services/issues.ts:10948-10962`):
  - when the assignee changes, including a hand-off away and back (A→B→A);
  - when the card is already blocked, and the request either sets
    `status: "blocked"` or rewrites `blockedByIssueIds` or `unblockDescriptor`.
- **What does not bump it:** a comment alone, a title, description or label
  edit, and a waits change on a card that is not blocked.
- **When an unblock step is required:** only a write that *enters* blocked must
  carry an `unblockDescriptor`, and an agent may name only itself as its owner.
  A `{comment, blockedByIssueIds}` PATCH on a card that is already blocked needs
  none. Source: `routes/issues.ts:13256-13313`.
- **The log cannot tell a board API key from a browser session.** Nothing in
  the activity log does. The Foreman's sync writes with a board user's key, so
  the Foreman and Ray can be one identity.
- **The Foreman hands a card on in a burst** (`src/paperclip/mirror.ts`):
  - **`onBlocked`** (360-382) sets the card's unblock step to the note text,
    calls `move()`, then calls `note()` with that same text.
  - **`move()`** (930-958) is one PATCH: status, holder, unblock step
    (`action` = the note text) and labels.
  - **`note()`** (990-1012) is used on a blocked card. It sends
    `{comment, status}`, which is a commented restatement. The comment is
    `finishComment(text)`: trimmed, redacted, and capped at 3000 characters.
  - **Under a session hold**, `move()` writes nothing and `note()` is deferred.
    When the session ends (`onSession`, 766-777), the Foreman writes three
    things: the real move, then a commented restatement carrying the session
    summary (a different text), then the deferred note, whose text matches the
    unblock step.

## (a) Status decisions

Read newest first. `decisionKind(record, i, botId)` classifies each entry, then
`lastDecision` walks back past every entry that is not a decision.
`personSince(record, mark, botId)` returns a person's write after `mark` whose
kind is `decision` or `waits`.

**The burst rule (the `note` kind).** This is how a Foreman note is told from a
person's hold under the same identity. A commented restatement by identity X is
a note only when all of these hold:

1. Its own `issue.comment_added` is the next record after it.
2. Walking back to X's latest move, X wrote nothing in between except other
   commented restatements, each with its own comment. X's move is X's newest
   write that changed the status, the waits or the holder.
3. Each of those restatements came within 60 s of that move.
4. One comment in the burst is exactly the unblock step in force at the move
   (its first 120 characters). The unblock step is read from the move's request
   fields, else from the descriptor history.

The burst runs forward too: it is X's move and every commented restatement X
wrote after it within the 60 s, each with its own comment, up to X's first
write of any other shape. So a session's summary, written before its note, is in
the note's burst, and both are notes (a5b).

Anything else by X is X's own decision, and so a hold: a bare restatement, a
rewrite of the waits, a different comment after the burst, or any restatement
after 60 s. Other identities' writes inside a burst are their own decisions.

| id | write | writer vs the previous decision | kind | status decision? | person's change since a mark? | grounding |
|---|---|---|---|---|---|---|
| a1 | status move | any | decision | yes | yes | `changes.status` |
| a2 | status move that also hands the card on, one entry | any | decision | yes | yes | Foreman `move()`; read with `handedWith` |
| a3 | bare restatement of blocked (statusVersion, no comment) | same identity | decision | yes | yes | services/issues.ts:10958; round 4 #1 |
| a4 | bare restatement of blocked | different identity | decision | yes | yes | services/issues.ts:10958 |
| a5 | commented restatement in the writer's burst, its comment the move's unblock step | same identity | note | no | no | mirror.ts `onBlocked` 360-382 |
| a5b | session release: a summary restatement, then the matching note, both in the burst | same identity | note | no | no | mirror.ts `onSession` 766-777 |
| a6 | commented restatement, other text, after the burst window | same identity | decision | yes | yes | the burst rule, condition 3 |
| a7 | matching commented restatement after a bare restatement by the same writer | same identity | decision | yes | yes | the burst rule, condition 2 |
| a8 | matching text, written by an identity that made no move | different identity | decision | yes | yes | the burst rule, condition 2 |
| a9 | commented restatement with no comment record of its own | same identity | decision | yes | yes | the burst rule, condition 1 |
| a10 | waits or unblock-step rewrite on a blocked card | any | decision | yes | yes | services/issues.ts:10960 |
| a11 | waits change on a card that is not blocked | any | waits | no | yes | no statusVersion bump |
| a12 | hand-off alone (holder, statusVersion) | any | hand-off | no | no | services/issues.ts:10950; `heldElsewhere` reads the holder |
| a13 | hand-off away and back (A→B→A) | any | hand-off | no | no | services/issues.ts:10950 |
| a14 | this bot's restatement or waits trim over a block | this bot | keep | no | no | the block keeps whoever decided it |
| a15 | Paperclip settles a lost run over a stop no one chose | Paperclip | settle | yes | no | `issue.execution_recovery_settled` |
| a16 | Paperclip settles a lost run over a person's stop | Paperclip | settle | no | no | the person's stop stands |
| a17 | comment, title or description edit, label change | any | none | no | no | no statusVersion bump |

In the columns:

- **"status decision?"** asks whether `lastDecision` returns this write. If it
  says no, the earlier decision stands.
- **"person's change since a mark?"** asks whether `personSince` counts this
  write when a board user makes it after the bot's mark. A person's hand-off is
  read from the holder instead (`heldElsewhere`).

## (b) The escalation lifecycle

An escalation is a blocked card with an escalation label, held by this bot. It
is worked whoever blocked it, and the card stays blocked throughout.

**What an attempt is.** Each attempt is one run of the model, and it starts
with `begin(key)`. That saves the attempt as owed, and gives it the next number
from a **monotonic sequence**. The sequence lives in the state file and
survives restarts.

**When the same question comes back.** A question asked again (the same key,
as in A→B→A) is a new attempt with a new number. Its earlier answer is replaced.

**What the sequence decides.** Everything is read from the sequence, never from
insertion order:

- the transcript is posted in sequence order;
- the latest attempt's answer is the one that routes the card.

### Phases, in order

| id | phase | what happens | guarantee |
|---|---|---|---|
| p1 | restore | The wake's unrecorded checkout is put back to blocked before anything runs (`keepBlocked`). | The model never runs on a card that reads in progress. |
| p2 | choose the step | **settle** when the question was answered, the card is unchanged, and nothing is resuming. **resume** when a wait the bot linked is all done. **retry** when an answer is owed. Otherwise **work**. | Every live wake ends its run on one comment. |
| p3 | attempt | `begin(key)`, then run the model on the card as read. | Each attempt carries a sequence number greater than every earlier one. |
| p4 | validate | Re-read the card. If it was **decided anew** (by a person, another holder, or no longer an escalation), only the transcript is posted, with `CARD_CHANGED`. If it was **asked something newer**, there is another attempt under the same run (p3), told the transcript without the re-asked key. That happens at most `MAX_REWORK` times; after that the card is kept with `NEWER_ASK`. | A newer board decision stands. A stale answer is never handed on. |
| p5 | route | The **latest** attempt's outcome picks a row in the routing table below. | The latest validated attempt owns routing, the outcome, and the notification. |
| p6 | settle state | Each owed attempt is marked answered. A blocked attempt records its wait. A linked wait records the tasks it linked. | A restart routes the same way. Nothing is worked twice. |
| p7 | resume | When every linked task is done, the wake works the card again with a note saying so. That attempt's final write clears the done links, unless it links new ones. | A promised dependency wait is acted on. |

### Routing: the latest attempt's outcome decides the write

| id | latest outcome | write (one PATCH under the run) | holder after | told off the board |
|---|---|---|---|---|
| r1 | done | hand down: the configured return, else whoever handed it up | that holder | nobody |
| r2 | escalate, next holder a person | hand up | the person | the person, with the latest attempt's first line |
| r3 | escalate, next holder an agent | hand up | that agent | nobody |
| r4 | escalate, nobody configured | comment only | this bot | nobody |
| r5 | blocked | comment only | this bot, blocked | nobody |
| r6 | blocked on a task still open | `{comment, blockedByIssueIds}`, the unblock step left as it is | this bot, linked | nobody; resumes when the task is done (p7) |
| r7 | blocked on tasks all done already | goes on now, under the same run, once per attempt; it counts as a round. The go-on's own outcome routes. | per the go-on | per the go-on |
| r8 | blocked on a task the board does not know | comment only | this bot, blocked | nobody |

**Why r6 leaves the unblock step alone.** The Foreman reads the card's unblock
step back into its own state (`mirror.ts:874-879`). A link write that also
rewrote the step would change what the Foreman thinks the card waits for.

## Known limits

Each of these errs toward reading a write as a hold, except the last.

- **A Foreman re-move of a card it has not changed** (same status, holder and
  step) records nothing to anchor a burst, so its note reads as a hold.
- **A note whose text the Foreman redacts or caps** before posting no longer
  matches the unblock step, so it reads as a hold.
- **Ray, under the Foreman's identity, typing a commented restatement within
  60 s of a Foreman move** whose burst also carries the matching note reads as
  a note. Nothing in the record separates the two; telling them apart needs a
  separate key for the Foreman's sync.
