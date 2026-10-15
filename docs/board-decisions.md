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
f758a984b and the Foreman at 45bd393.

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
- **The Foreman hands a card on with a move, then a note** (`src/paperclip/mirror.ts`):
  - **`onBlocked`** sets the card's unblock step to the note text, calls
    `move()`, then calls `note()` with that same text.
  - **`move()`** is one uncommented PATCH: status, holder, unblock step
    (`action` = the note text, unredacted) and labels. It is sent even when
    nothing changes (a re-move).
  - **`note()`** is used on a blocked card. It sends `{comment, status}`, which
    is a commented restatement. The comment is `finishComment(text)`
    (`comments.ts`): trimmed, redacted (`[REDACTED]`, `[REDACTED:NAME]`, some
    patterns keep a prefix), then capped at 3000 characters, a cut one ending
    `\n\n… (truncated)`.
  - **Under a session hold**, `move()` writes nothing and `note()` is deferred.
    When the session ends (`onSession`), the Foreman writes the real move, then
    a commented restatement carrying the session summary, whose text starts
    with a bold header (`**Review finished** — PR #12`), then the deferred
    note.
- **How long a record is** (measured, GET only, 2026-10-15): on the slashbin
  board's 1000 cards, activity entries p50 7, p99 131, max 301; comments p50
  0, p99 54, max 141; one agent's updates on a card at most 14. The jerky
  board's longest record is 16 entries.

## (a) Status decisions

Read oldest first, once per record (`decisionKind(record, i, botId)` and
`lastDecision` share one cached pass). `personSince(record, mark, botId)`
returns someone else's write after `mark` whose kind is `decision` or `waits`:
a person's or another agent's, never this bot's or Paperclip's.

**The expectation rule (the `note` kind).** This is how a Foreman note is told
from a hold made under the same identity. It does not use time.

1. **A move opens an expectation.** A move is an uncommented update by
   identity X (not this bot, not Paperclip) whose request or changes touch the
   status, the holder or the waits. It expects one note from X: the unblock
   step in force once it landed. A move that clears the step expects nothing.
   A newer move by X replaces the expectation.
2. **A commented update is paired with its own comment.** The comment is the
   first later `issue.comment_added` with the same actor and the same run that
   is not paired yet. The search stops at X's next update under that run;
   other identities' entries in between are passed over. The text is the
   comment's whole body when the poller read it from the thread, else its
   120-character snippet; a snippet that is cut is never matched.
3. **A note is X's commented restatement whose comment is the step as the
   Foreman posts it.** The comment, trimmed, must equal the step, trimmed,
   with each redaction token standing for any text, and with a trailing
   `… (truncated)` standing for the rest of the step. It must change nothing
   but the status: no holder, no waits. A note consumes the expectation.
4. **A bold summary waits for the note.** A non-matching restatement by X that
   starts with a `**…**` header is held pending. If X's note follows, it was
   the session summary, and it is a note too (a5b). If anything else ends the
   expectation, or the record ends first, it is X's decision.
5. **Anything else by X is X's own decision**, and so a hold: a bare
   restatement (which is also a new move), a different comment, the step
   repeated after the note was consumed. X's other writes that decide nothing
   (a title or label edit) end the expectation.

A note that carries a real status change (the wake's checkout landed between
the move and the note) is not a decision of its own: the status it sets is
credited to the move it belongs to (a29).

| id | write | writer vs the previous decision | kind | status decision? | someone else's change since a mark? | grounding |
|---|---|---|---|---|---|---|
| a1 | status move | any | decision | yes | yes | `changes.status` |
| a2 | status move that also hands the card on, one entry | any | decision | yes | yes | Foreman `move()`; read with `handedWith` |
| a3 | bare restatement of blocked (statusVersion, no comment) | same identity | decision | yes | yes | services/issues.ts:10958; round 4 #1 |
| a4 | bare restatement of blocked | different identity | decision | yes | yes | services/issues.ts:10958 |
| a5 | commented restatement whose comment is the move's unblock step | same identity | note | no | no | mirror.ts `onBlocked` |
| a5b | session release: a bold summary restatement, then the matching note | same identity | note | no | no | mirror.ts `onSession` |
| a6 | commented restatement, other text, after the writer's note | same identity | decision | yes | yes | rule 5: the note consumed the expectation |
| a7 | bare restatement between the move and the note | same identity | decision | yes | yes | rule 5: a bare restatement is a decision |
| a8 | matching text, written by an identity that made no move | different identity | decision | yes | yes | rule 1: nothing expected from it |
| a9 | commented restatement with no comment record of its own | same identity | decision | yes | yes | rule 2: nothing to match |
| a10 | waits or unblock-step rewrite on a blocked card | any | decision | yes | yes | services/issues.ts:10960 |
| a11 | waits change on a card that is not blocked | any | waits | no | yes | no statusVersion bump |
| a12 | hand-off alone (holder, statusVersion) | any | hand-off | no | no | services/issues.ts:10950; `heldElsewhere` reads the holder |
| a13 | hand-off away and back (A→B→A) | any | hand-off | no | no | services/issues.ts:10950 |
| a14 | this bot's restatement or waits trim over a block | this bot | keep | no | no | the block keeps whoever decided it |
| a15 | Paperclip settles a lost run over a stop no one chose | Paperclip | settle | yes | no | `issue.execution_recovery_settled` |
| a16 | Paperclip settles a lost run over a person's stop | Paperclip | settle | no | no | the person's stop stands |
| a17 | comment, title or description edit, label change | any | none | no | no | no statusVersion bump |
| a18 | commented hold, other text, between the move and its deferred note | same identity | decision | yes | yes | rule 5; R2 |
| a19 | another identity's comment between the note's update and its comment | same identity | note | no | no | rule 2: pairing passes over other identities; R27 |
| a20 | another identity's edit between the note's update and its comment | same identity | note | no | no | rule 2; R28 |
| a21 | Paperclip's recovery between the note's update and its comment | same identity | note | no | no | rule 2; R29 |
| a22 | a matching comment from another run before the hold's own comment | same identity | decision | yes | yes | rule 2: pairing keeps to the run; R112 |
| a23 | note whose step the Foreman redacted before posting | same identity | note | no | no | rule 3, `redactComment`; R24 |
| a24 | note the Foreman capped, read whole from the thread | same identity | note | no | no | rule 3, `capComment`; R68 |
| a25 | hold sharing the step's first 120 characters, snippet only | same identity | decision | yes | yes | rule 2: a cut snippet never matches; R21 |
| a26 | note long after its move | same identity | note | no | no | no time window; R13, R67 |
| a27 | the step repeated after the writer's newer move cleared it | same identity | decision | yes | yes | rule 1: nothing expected; R36 |
| a28 | note after an unchanged re-move | same identity | note | no | no | rule 1: the re-move expects its note; R37 |
| a29 | note that lands after the wake's checkout | same identity | note | no | no | the status is credited to the move; R69 |
| a30 | restatement of blocked that also assigns the card to this bot | any | decision | yes | yes | an explicit block, not a plain hand-off; R40, R71 |
| a31 | waits request on a blocked card that changes nothing but statusVersion | any | decision | yes | yes | services/issues.ts:10960; R44, R72, R94 |
| a32 | several holds between the move and its note, the latest | same identity | decision | yes | yes | rule 5; R55 |
| a33 | another agent's hold after its own move and note | same identity | decision | yes | yes | rule 5; an agent's hold counts; R18, R70 |
| a34 | the step, after a bold summary and the writer's own title edit | same identity | decision | yes | yes | rule 5: the edit ended the expectation; R17 |
| a35 | the step repeated after the writer's note | same identity | decision | yes | yes | rule 5; the Foreman never posts a note twice in a row; R20 |
| a36 | another agent reasserts the block | different identity | decision | yes | yes | an agent's change counts; R97 |
| a37 | a person's hold in the same millisecond as a mark saved as a time alone | different identity | decision | yes | yes | `after`: a legacy mark reads its own millisecond as after; R107 |
| a38 | a bold summary the note never followed | same identity | decision | yes | yes | rule 4: fails closed |

In the columns:

- **"status decision?"** asks whether `lastDecision` returns this write. If it
  says no, the earlier decision stands. A write it returns carries the status
  the card is in.
- **"someone else's change since a mark?"** asks whether `personSince` counts
  this write when it is made after the bot's mark. A hand-off is read from the
  holder instead (`heldElsewhere`).

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

## (c) Wakes and hand-offs: what the card says now wins

Every write the poller makes is decided from a read, and the card can change
between that read and the write. These rows are the invariants that keep a
newer decision on the board from being overwritten. Each reads the card's
holder and its record again at the point named; nothing is fetched from the
network between that read and the write it guards, except the write itself.

| id | while | the card | what the bot does | invariant |
|---|---|---|---|---|
| w1 | the inbox listed the card, before the task is read | is handed to another agent, a person, or nobody | runs nothing; an owed answer is posted as a comment only; a live run ends with `HANDED_AWAY` | the holder is read with the task, and only this bot's card is worked (R40–R42) |
| w2 | an answer is made | is unassigned | posts the answer as a comment only; status and holder stay | nobody holding a card is "away" too (`heldElsewhere`) (R2, R3, R5–R7) |
| w3 | an answer is made | is handed away and back | posts the answer as a comment only | a change of holder after the mark is a newer decision (`decidedSince`) (R4, R10, R11) |
| w4 | the tasks an answer linked finish one at a time, with trims and restarts between | — | resumes once, when the last is done | each done link is remembered in the state file (`linkDone`), not read from the card's trimmed waits (R1, R12, R14, R16, R18) |
| w5 | a link write lands and its response is lost; the bot restarts | — | records the links from the card, and resumes when they are done | recovery reads the links back from the board (R24) |
| w6 | an answered ask is revised A→B→A | — | works A again as new | an ask is answered only while it is the task's latest answered ask (`lastAnswered`) (R26–R33) |
| w7 | an escalation is routed by a seat reference | names a seat whose id is another seat's name | hands it to the seat with that id | an exact id is matched before a name (R34–R36) |
| w8 | a blocked answer goes on (r7) | is taken away | runs nothing more; the answer is posted | holder and record are re-read before the go-on runs (R37–R39) |
| w9 | the seats are listed for a hand-on | is unassigned, cycled, moved, re-waited, retitled, asked anew, or unlabelled | sees the change and does not hand it on | the seats are read before the card is validated (R43–R49) |
| w10 | right before the answer's own write | is taken away or cycled | posts the answer as a comment only | the record is read last, just before the write; a change inside the write itself is a residual (R50, R51) |
| w11 | a comment's snippet is cut at 120 characters | — | reads the comment whole before matching it | `activityOf` fills each cut comment's body from the thread |

## Known limits

Each of these errs toward reading a write as a hold, except where it says
otherwise. The ones marked *needs provenance* need the Foreman to write with
its own key, or to mark its comments, before the record can separate it from
Ray: a Foreman follow-up.

- **Another identity's edit between a summary and a note, or a hold that is
  word for word the step and is the only comment after the move** reads as a
  note when it comes from the Foreman's identity. *Needs provenance*; it errs
  toward working the card.
- **A same-identity hold that starts with a bold header, between the move and
  its note**, reads as the session's summary. *Needs provenance*; it errs
  toward working the card.
- **A session release whose summary no note follows** reads the summary as a
  hold until something else moves the card.
- **A person who makes the Foreman's exact move** (blocked, handed to this
  bot) on a mirrored card is read as a hand-off. *Needs provenance.*
- **A write that lands inside the bot's own final write** (w10) is overwritten;
  no Paperclip write can be made conditional. The window is one request.
