# Board decisions: who decided a card's status, and who owns an escalation

[README](../README.md) · [All documentation](../README.md#documentation-table-of-contents)

## Contents

- [What the board records (the facts the model stands on)](#what-the-board-records-the-facts-the-model-stands-on)
- [(a) Status decisions](#a-status-decisions)
- [(b) The escalation lifecycle](#b-the-escalation-lifecycle)
  - [Phases, in order](#phases-in-order)
  - [Routing: the latest attempt's outcome decides the write](#routing-the-latest-attempts-outcome-decides-the-write)
- [(c) Wakes and hand-offs: what the card says now wins](#c-wakes-and-hand-offs-what-the-card-says-now-wins)
- [Known limits](#known-limits)

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
#97). Rounds 5 and 6 then showed that telling the Foreman's note from a
person's hold by comparing comment text could not be made safe: redaction
tokens, cut marks, bold headers and shared keys each let one pass for the
other. Round 7 replaces it with the structural model below, which reads no
comment text at all. The code implements these tables;
`test/paperclip-reconcile.test.js` parses the rows below and runs every one. A
row added here without a test builder fails the suite, and so does a builder
without a row.

## What the board records (the facts the model stands on)

These are read from the source, not inferred from behaviour. Paperclip is at
042e68b7f and the Foreman at 281c2b9.

- **Every PATCH is one `issue.updated` entry.** Its `details` are the request
  fields, plus `changes` (from/to of every field that changed), and
  `source: "comment"` when the PATCH carried a comment. Source:
  `server/src/routes/issues.ts`.
- **A comment carried by a PATCH is a second entry, `issue.comment_added`.** It
  is logged after the update, by the same actor and run.
- **`statusVersion` is bumped without a status change in two cases** (source:
  `server/src/services/issues.ts`):
  - when the assignee changes, including a hand-off away and back (A→B→A);
  - when the card is already blocked, and the request either sets
    `status: "blocked"` or rewrites `blockedByIssueIds` or `unblockDescriptor`.
- **What does not bump it:** a comment alone, a title, description or label
  edit, and a waits change on a card that is not blocked.
- **When an unblock step is required:** only a write that *enters* blocked must
  carry an `unblockDescriptor`, and an agent may name only itself as its owner.
- **Paperclip's wake checks a stopped card out to `in_progress` and records
  nothing.** The next recorded write's `changes.status.from` is then
  `in_progress`, though the record's own last status is the stop.
- **A write made with a board user's key can name who it is for.** When the
  request carries a credited author, Paperclip saves the row with the key's
  user as its actor and adds `details.creditedActor` (`{ type: "agent" |
  "user", id }`). It sets the field on a user's rows only, and drops any value
  a caller supplies (`server/src/middleware/comment-author.ts`,
  `creditedActivityDetails`). Since 2026-10-18 the Foreman's sync credits every
  write it makes to its own agent (`src/paperclip/client.ts`). Its writes from
  before then, and any write the board refused to credit, carry no credit.
- **The Foreman hands a card on with a move, then a note** (`src/paperclip/mirror.ts`):
  - **`move()`** is one uncommented PATCH: status, holder, unblock step and
    labels.
  - **`note()`** reads the card first. On a blocked, done or cancelled card it
    sends `{comment, status}` with the status it read, which restates it; on
    any other card it posts a comment alone.
  - **Under a session hold**, the note is deferred. When the session ends, the
    Foreman writes the real move, then the session summary as a commented
    restatement, then the deferred note.
- **How long a record is** (measured, GET only, 2026-10-15): on the slashbin
  board's 1000 cards, activity entries p50 7, p99 131, max 301. The other
  board's longest record is 16 entries.

## (a) Status decisions

**Who wrote it.** A row's writer is `details.creditedActor` when the row
carries one, and otherwise the row's actor (`writerOf`). So the Foreman's
credited writes are its agent's, and a person's writes on the same key are theirs. A
sync write with no credit reads as the person whose key it used: that is
conservative, since it counts as a person's decision.

**What a decision is.** A decision is a write that changes the card's status,
its holder, or what it waits on (its linked tasks or its unblock step); or
Paperclip settling a run it lost. A write that changes none of these is not a
decision, whoever writes it: a comment, a title or label edit, and a write
that restates the status in force. No comment text is ever compared. A status
is changed only by a write that moves it off the status the record last
recorded, so a write that puts a stop back after the wake's unrecorded
checkout is a restatement.

**Which decision is in force.** The newest. This bot's own write never takes
over a decision someone else made: a person moving the card to todo is still
the decision after the bot blocks it, and putting the card back to blocked
after a checkout, closing over a hold, or trimming its waits leaves their stop
the decision. Over a choice that is not a stop, the bot's own newest write is
kept beside the decision (`own`), so a stop the bot put on the card is still
its own to lift (`statusSetter`, `decidedStatus`). Paperclip's settlement of a
lost run is read the way the bot's writes over a stop are. A decision carries the status in force after
it; `decidedStatus` reads a card that a write which decided nothing put in
`in_progress` or another stop as still in the decided stop.

**How it is read.** One pass, oldest first, over the record given
(`decisionKind(record, i, botId)`, `lastDecision(record, botId, from)`).
Nothing is cached between calls, and `from` reads the record from that entry
back. `personSince(record, mark, botId)` returns someone else's status or
waits decision after `mark` — a person's or another agent's, never this bot's
or Paperclip's; `handedSince` returns their change of holder.

**Out of scope** (PR #91 ruling, round 7):

- **A hold that exists only as prose** — a comment, or a restated status,
  that changes no status, holder or waits — is not a decision. To hold a card,
  change its status, holder or waits.
- **A Foreman write that lands after a person's decision** is the Foreman's
  newest decision. If that is wrong, it is a Foreman defect, not the bot's to
  adjudicate.

| id | write | writer | kind | decision in force? | someone else's change since a mark? | grounding |
|---|---|---|---|---|---|---|
| a1 | status move | a person | status | yes | yes | `changes.status` |
| a2 | the Foreman's move: blocked and handed to this bot in one write | the Foreman, credited | status | yes | yes | mirror.ts `move()`; `handedBack` reads the hand-off from the write |
| a3 | bare restatement of blocked (statusVersion, no comment) | the writer of the block | none | no | no | changes no status, holder or waits (R5, R36: out of scope) |
| a4 | the Foreman's note: a commented restatement after its move | the Foreman, credited | none | no | no | mirror.ts `note()` (R51–R53, R90) |
| a5 | session release: the summary restatement, then the note | the Foreman, credited | none | no | no | mirror.ts `onSession` (R51) |
| a6 | a commented restatement, any text, after the Foreman's hand-off | a person on the sync's key | none | no | no | a prose hold: out of scope (R1, R2, R15, R48–R50, R59, R60) |
| a7 | a person reasserts the block, naming who unblocks it | a person | waits | yes | yes | services/issues.ts: a new unblock step |
| a8 | waits or unblock-step rewrite on a blocked card | a person | waits | yes | yes | services/issues.ts |
| a9 | waits change on a card that is not blocked | a person | waits | yes | yes | no statusVersion bump, still a decision |
| a10 | hand-off alone (holder, statusVersion) | a person | holder | yes | no | services/issues.ts; read by `handedSince` and `heldElsewhere` |
| a11 | hand-off away, then back (A→B→A): the first | a person | holder | no | no | the hand-off back is newer |
| a12 | this bot restates a person's block | this bot | none | no | no | a restatement (R67) |
| a13 | this bot trims the waits of a person's block | this bot | waits | no | no | the bot never takes over someone else's stop |
| a14 | Paperclip settles a lost run over a stop no one chose | Paperclip | settle | yes | no | `issue.execution_recovery_settled` |
| a15 | Paperclip settles a lost run over a person's stop | Paperclip | settle | no | no | the person's stop stands |
| a16 | comment, title or description edit, label change | a person | none | no | no | no statusVersion bump |
| a17 | the Foreman's note recorded as blocked again after the wake's checkout | the Foreman, credited | none | no | no | the record's last status is blocked (R3, R65) |
| a18 | a person's hold between the Foreman's move and its note | a person | waits | yes | yes | the note after it decides nothing (R3) |
| a19 | a person cancels between the Foreman's move and its note, which restates cancelled | a person | status | yes | yes | mirror.ts `note()` restates the status it reads (R4) |
| a20 | the same writer cancels, then moves the card back to blocked | a person on the sync's key | status | yes | yes | the newest move wins; the cancel stays a decision (R95) |
| a21 | holder and waits rewrite on a card created blocked, no status recorded | a person | waits | yes | yes | the request's status is the status in force (R96) |
| a22 | a person's block that also hands the card to this bot | a person | status | yes | yes | a hold, not a hand-off (R61) |
| a23 | another agent reasserts the block after its own hand-off to this bot | another agent | waits | yes | yes | an agent's change counts (R102) |
| a24 | a person's hold in the same millisecond as a mark saved as a time alone | a person | waits | yes | yes | `after`: a legacy mark reads its own millisecond as after |
| a25 | this bot puts blocked back on a cancelled card Paperclip settled blocked | this bot | none | no | no | the cancel stands (R66) |
| a26 | this bot moves a cancelled card back to blocked after the wake's checkout | this bot | status | no | no | the cancel stands (R79) |
| a27 | the Foreman's move without the credit | the sync's key, uncredited | status | yes | yes | read as the person's: a hold |
| a28 | a waits request on a blocked card that changes nothing but statusVersion | a person | none | no | no | no waits changed |

In the columns:

- **"decision in force?"** asks whether `lastDecision` returns this write. If it
  says no, an earlier decision stands. A write it returns carries the status
  the card is in.
- **"someone else's change since a mark?"** asks whether `personSince` counts
  this write when it is made after the bot's mark. A change of holder is read
  by `handedSince` instead.

**Resuming an interrupted attempt** (`resumeInterrupted`) needs the board the
attempt was admitted from: if anyone else made a decision after the attempt's
mark (`decidedSince`: a status, waits or holder change), the attempt is not run
again and the card is left as they set it. This holds for an escalation too,
and the mark is never moved past their decision.

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
| w4 | the tasks an answer linked finish one at a time, with trims and restarts between | — | resumes once, when the last is done | every task the answer linked is read fresh at the wake, kept in the state file (`linked`) rather than read from the card's trimmed waits; one that reopened, or cannot be read, keeps the wait (d) (R1, R12, R14, R16, R18) |
| w5 | a link write lands and its response is lost; the bot restarts | — | records the links from the card, and resumes when they are done | recovery reads the links back from the board (R24) |
| w6 | an answered ask is revised A→B→A | — | works A again as new | an ask is answered only while it is the task's latest answered ask (`lastAnswered`, kept per task and never trimmed) (R26–R33) |
| w7 | an escalation is routed by a seat reference | names a seat whose id is another seat's name | hands it to the seat with that id | an exact id is matched before a name (R34–R36) |
| w8 | a blocked answer goes on (r7) | is taken away | runs nothing more; the answer is posted | holder and record are re-read before the go-on runs (R37–R39) |
| w9 | the seats are listed for a hand-on | is unassigned, cycled, moved, re-waited, retitled, asked anew, or unlabelled | sees the change and does not hand it on | the seats are read before the card is validated (R43–R49) |
| w10 | right before the answer's own write | is taken away or cycled | posts the answer as a comment only | the record is read last, just before the write; a change inside the write itself is a residual (R50, R51) |
| w11 | the Foreman's note follows its hand-off, whatever its text or length | — | works the card, once | a restatement decides nothing; no comment text is read (`decisionsOf`) |

## (d) The re-read rule: no act on a card that moved since its snapshot

The rows above guard single writes. This one is the rule they all follow,
and it covers the two acts that cost most when made on a stale card: running
the model, and routing the card to someone else.

- **Before the model runs**, the card is read again: status, holder, labels,
  title, description, the newest comment (whoever wrote it: a person, this
  bot's own seat, the board), and the record since the wake's own read. If
  any of it differs from the snapshot the run was built on, or the card is
  cancelled, nothing runs and nothing is written. The status expected is the
  one read, or one this attempt's own runs recorded since. "Own" means by run
  id, never by seat: a write by this bot's seat under another run (another
  instance, an earlier attempt) is a change, and so is a status Paperclip's
  recovery wrote. A bare restatement of the status is not. The record is read
  last, after the comments, so a comment or a board notice that lands between
  the two reads still shows as a change. The state the
  attempt began is put back, and the run is left open for the next look, which
  decides from the card as it reads then (`cardNow`, `CardMoved`).
- **Before every routing write** (a return, a hand-on, an unlink, a rewrite of
  what the card waits on), the card is read the same way. A change stops the
  write: the answer is posted as a comment with `CARD_CHANGED`, with status,
  links and unblock step left as the change made them, or an escalation is
  worked again from the card as it is. Every kind of routing (blocked, a
  return or transfer, review, an unlink or rewrite of what the card waits on,
  an escalation's hand-on) compares a fresh read against the card the answer
  was built on, never against a read taken after the answer came back, so a
  change that lands while the model works is never routed past. That card is
  saved with the answer in the state file (`builtOn`), together with the
  record mark of the read it came from and the attempt's run ids, so a bot
  restarted between the answer and its routing still checks it against the
  card that produced it: a change by another run of this seat before the
  restarted run's own checkout is still a change. A saved answer with no
  `builtOn` (written by an older version) has no card to check against and
  never routes: it is posted as a comment, or an escalation is worked again.
  Paperclip settling one of this attempt's own lost runs is not a change for
  routing (the replacement run carries the work on); before the model runs it
  still stops the run. A rewrite of what the card waits on reads the card again
  after the dependency lookup, and a fallback hand-up after a refused
  `process.escalate` reads it again after its unblock step: no other awaited
  call comes between the last read and the write it guards. Comments the
  attempt's own runs posted are its output, not a change. A routing write sends only the fields it changes (`holderWrite`):
  it clears the other kind of holder only when the card has one.
- **The snapshot is required, and only the producing one counts.** Every
  routing write takes the snapshot the answer was produced from: the card a
  saved answer was built on (`builtOn`), or, for a note written with no model
  run (a quiet re-wake's acknowledgement, a saved answer for an older ask),
  the wake's own read, taken before anything was decided, with its record
  mark and this attempt's run ids. A read taken while the write is prepared
  is only ever the "now" side of the comparison, so a change after the wake's
  read (a status, a label, a comment, a relink, a move off a finished card)
  stops a note's block or done close as it stops an answer's. A snapshot that
  is legacy, or lacks its card fields, its record mark or its run ids,
  authorizes nothing (`routableSnapshot`): the answer is said as a comment
  only, the card left as it is, and nothing runs again. A call that passes no
  snapshot throws (`reply`, `acknowledge`) or posts the answer only
  (`handOn`, `handOffVia`); a test scans every call site.
- **One gate for every routing write (`routeGate`).** Every write that
  changes status, holder, what the card waits on, its unblock step, or hands
  it on through `process.escalate` goes through one function: a close, a
  return or transfer, the block a quiet wake's note puts back, the fallback
  block after a refused hand-back or hand-off, `keepBlocked`, a link, an
  unlink, a checkout put back, a resume, and a put-back of a person's status.
  It reads the card again immediately before the write and compares it with
  the producing snapshot (above). Anything recorded since by anyone but this
  attempt's own runs (status, holder, waits, unblock step, labels, an edit,
  a newer comment or any other activity), or no routable snapshot, and
  nothing is routed: the comment goes alone, or nothing when a comment would
  end the run. A newer ask is a change like any other, never a reason to skip
  the comparison. The only other write is `say`, a comment and nothing else.
  A test scans the source: no other `PATCH` and no other `process.escalate`
  call. A snapshot read cancelled (a person's cancel put back) is not itself
  a change; a cancel since is.
- **A wait resumes** only when every task it waits on reads `done` on a fresh
  read. A task trimmed from the card, one that cannot be read, or one that
  reopened keeps the wait (`depsGate`, `allDone`). An escalation keeps every
  task its answer named, done or unknown when it answered, across restarts.
- **Every dependency resume passes one gate (`depsGate`)**, immediately
  before the model runs: the ordinary resume, an escalation's resume, going
  on from a block on tasks already done (`goOn`, r7), and an interrupted
  going-on run again. One dependency not done, unknown or unreadable, and
  nothing runs; the status, links and unblock step are left as they are, and
  the run ends as an unfinished-dependency recheck does. The prompt's
  "dependency done" note is made from that read only. The answer's routing
  writes carry the dependencies on the producing snapshot, and `routeGate`
  reads them again before a write that leaves the wait (a close, a hand-off,
  an escalation, a link cut). A test scans the source: one model call, gated,
  and no other place says a dependency is done.
- **One preflight, the card read last.** Before the model (`preflight`) and
  before a write that leaves a wait (`routeGate`), every dependency is read
  first and the card after them, so a cancel, a hand-off or a follow-up
  landing during a dependency read stops the act. The one gap left is the
  round trip between that last card read and its write.
- **A refusal because a dependency reopened keeps the wait durable.** The
  same single write that would have closed or handed the card on puts it back
  to blocked on the reopened tasks instead, with the answer and a note naming
  them (`waitKept`); settle keeps the ask owed with those waits, so the wake
  that reads them done again runs it and closes or hands it on.
  The refusal (`refused` in the state file: the tasks, the open ones, the
  asks owed) is saved before that write is sent — write-ahead — so a
  restart that finds the answer landed, by its text or its attempt marker,
  settles it as the same kept wait. It goes in settle, or when a later write
  reads the dependencies done.
- **Every recovery that runs the model is gated too.** A worker never
  launched (`none`/`unlaunched`) after a restart, and an interrupted resume
  run again (`resumeInterrupted`), go through the same preflight on the
  dependencies the resume was admitted on (`gates`, kept in the state file
  while the ask is owed). One open, and nothing runs, nothing is used up, the
  wait linked again. A going-on is saved unstarted with its mark in one write
  (`continuing`, `continued`); a restart inside its preflight puts both back
  (`unstarted`), so the next live wake runs it, never consumes it.
  The preflight is also the launcher's gate (`spec.gate` in
  `lib/attempts.js`): the first launch, a claim still launching at a
  restart, and the relaunch of a claim that never started all pass it, and
  a refusal launches nothing. A continuation after an escalation ruling
  has its own attempt id, so a restart follows it instead of re-running it.
- **An ask is deduplicated** only against that task's own latest answered ask,
  kept per task in the state file and never trimmed by other tasks' traffic
  (`lastAnswered`). A hand-in to the bot from another holder since that answer
  (`handedTo`) is a new ask, even with nothing else changed.

Paperclip has no compare-and-set. A change inside the one round trip between
the last read and the write is not seen (Known limits). The cases are in
`test/paperclip-reread.test.js`, one per review row.

## Known limits

Each of these errs toward reading a write as a hold, except where it says
otherwise.

- **A sync write without the credit** — the Foreman's from before 2026-10-18,
  or one the board refused to credit — reads as the person whose key it used,
  so a hand-off it made holds the card until someone moves it again.
- **A hold made only in prose** does not hold the card (out of scope above).
- **A write that lands inside the bot's own final write** (w10, (d)) is
  overwritten; no Paperclip write can be made conditional. The window is one
  round trip: from the response to the last re-read, through the write. A
  change there to a card being returned, handed on or unlinked is not seen.
