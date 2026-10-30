# Model-work triggers

[README](../README.md) · [All documentation](../README.md#documentation-table-of-contents)

## Contents

- [What this covers](#what-this-covers)
- [The settings](#the-settings)
- [Recommended setup: quiet waiting](#recommended-setup-quiet-waiting)
- [Alternatives](#alternatives)
- [Settings versus agent instructions](#settings-versus-agent-instructions)
- [Reading the log](#reading-the-log)
- [Upgrading from 2.x](#upgrading-from-2x)

## What this covers

A Paperclip board wakes the agent's seat for many reasons: a new card, a comment,
a card it waits on finishing, the board's own retries. Each wake can start a model
run, and a model run costs tokens. The harness lets you decide which wakes may
start the model. What the agent does once a run starts is up to the agent and its
instructions, not the harness.

Two settings control this. Both have quiet defaults, so a wake that would only
repeat old work does not start the model.

## The settings

| Setting | Default | What it controls |
|---|---|---|
| `PAPERCLIP_INTAKE` | every status but `backlog` | The card statuses in which a **new ask** starts the model |
| `PAPERCLIP_REWAKE` | `off` | How many times the model looks again at an ask it **answered as waiting** when the card wakes with nothing new |

**`PAPERCLIP_INTAKE`** takes a comma list of card statuses (`backlog`, `todo`,
`in_progress`, `in_review`, `done`, `blocked`, `cancelled`), or `all`. The status
is read as it was before the wake: Paperclip checks a card out to In Progress
when it wakes the seat, and the harness reads the card's record to find where it
was. A card outside the list gets one comment, for example *"Not started: this
card is in Backlog, and I start work only on cards in Todo, In Progress, …"*.
The card is put back in its status and the model does not run. Moving the card
into a listed status wakes it again, and then the model runs.

The intake check applies to new asks only. A card coming back because the cards
it waited on are done, and a re-look allowed by `PAPERCLIP_REWAKE`, are not
new asks.

**`PAPERCLIP_REWAKE`** is `off` or a whole number `N`. When the agent has
answered an ask by blocking, and the card wakes again with no new comment, the
harness posts a short mechanical note that repeats the answer and what it waits
on. With `N` set, the model looks again up to `N` times on that one ask. It is
told what it said and how each card it waits on stands now. The last look is
told to escalate. Any wake after that gets the note.

**`PAPERCLIP_RESOLVE_OWN`** is `on` or `off` (the default). A card the seat
itself left blocked is no one's hold: a scheduled job that failed ended it
blocked, or the board blocked it when a run was lost. With `on`, the model is
started on such a card, once per block, and must end it fixed, handed to its
owner through `process.escalate`, or put to the owner as a yes or no question.
A block the model's own answer set is that answer's wait. With `on`, a wake
on that wait which `PAPERCLIP_REWAKE` does not look at (it is off, or its looks
are used up) gets one look of its own, with the same three ways out: once per
answer, and only while nothing it waits on is an open card (a linked card, or
one the answer named), the seat still holds the card, and the card is not in
review. A look that ends blocked again is not a newer answer; an answer made
since (the card resumed, or was asked something new, and waits again) is, and
gets its own look. A wait on an open linked card is left as it is: it resumes
when that card is done. A block a person set, and a card in the board's legacy
reconciliation hold, stay untouched. The same setting makes an escalation the
model ruled would stand, with nothing done on the card since, get one more
look with the same three ways out, so a ruling of "hold stands" cannot be the
end of it.

The three ways out are enforced in code, not left to the prompt. When any of
these looks ends in a plain blocked reply, with no hand-off or ask made during the run
and the card not resumed, the code puts the model's reply to the owner as an ask
and announces it in that same wake (the scan skips an ask already announced);
without the ask channel it hands the card up the reporting line through
`process.escalate`; without a reporting line it escalates to
`PAPERCLIP_ESCALATE_TO`. The model's own choice, when it makes one, stands (an
ask it made is announced in that wake too).

An ask counts as made only when a chat message is bound to it. If it could
not be announced (no channel), the code hands the card up through
`process.escalate` in that same wake instead; if that cannot be done either, the
look is not used up, a warning says so, and the next wake looks again.
An ask an earlier answer made counts for nothing here. A hand-off or ask made
during the run is one the card did not carry when the run began. An answer
look's hand-offs are keyed to the answer it looks at, so a newer answer gets
its own ask, and a retry of the same look reuses the one it made, with the card
blocked on its owner card again. While the card is still blocked with the seat,
an ask that comes back as an owner card already closed asks no one: the card is
handed up instead. If it cannot be handed up, an error says so and the look is
used up, because every retry would get the same closed card back. A card the
look finished, or handed on, is left as it is.

Cards a different writer keeps in step (`PAPERCLIP_EXTERNAL_WRITER`, a mirror of
an issue tracker, say) have these routes too: a hand-up or an ask puts the card
with its owner and is not a second writer on its status. The pattern still
guards every other write to such a card: plain blocks to the creator,
hand-backs, person waits, done closes, and link and status repair.

With `on` and none of those routes (no escalate action, no
`PAPERCLIP_ESCALATE_TO`), the setting is refused: it is a startup problem (the
board connector stays off, and `npm run doctor` fails the check), and the
poller throws when built, so no wake can run in that state. A board with no
route of its own is left off while the others run.

An unreadable value in any of these settings turns the board connector off and logs the
reason. The harness does not guess.

## Recommended setup: quiet waiting

Leave both unset.

- Backlog is where people capture cards that are not ready yet. With the default,
  a card filed there is never started until someone moves it.
- A blocked answer stays answered. The board's re-wakes get the note, which costs
  nothing. The agent picks the card up again when what it waits on is done, or
  when someone comments.

This is the cheapest setup and keeps every model run tied to something a person
or a finished dependency did.

## Alternatives

- **Work everything assigned:** `PAPERCLIP_INTAKE=all`. Suits a seat whose
  board has no backlog of its own, for example a queue filled by another system.
- **Only cards someone promoted:** `PAPERCLIP_INTAKE=todo`. The agent touches
  nothing a person has not explicitly queued.
- **Let the agent chase its waits:** `PAPERCLIP_REWAKE=3`. Use this when cards
  often wait on something the board cannot see finishing, such as a person or an
  outside event, and the agent's instructions say how to chase it. Each look is a
  model run, so pick the smallest number that works. Version 2.x behaved like
  `4`.

## Settings versus agent instructions

The settings decide **whether** a model run starts. The agent's `CLAUDE.md` or
`AGENTS.md` decides **what the run does**. Keep each concern in its own place:

- To stop the agent working a status, use `PAPERCLIP_INTAKE`. An instruction
  such as "ignore backlog cards" still pays for a run to read it.
- To change how the agent handles a wait, such as who it escalates to or what
  counts as stuck, write it in the agent's instructions. The harness does not
  judge the content of an answer.

## Reading the log

At start the harness logs `Paperclip model-work triggers`, with the effective
`intake` and `rewake` and whether each came from its setting or the default.

Each wake that does not start the model says which setting decided it:

- `Paperclip task not started — its status is outside PAPERCLIP_INTAKE`, with
  `status` and `intake`.
- `Paperclip task woke again on an answered ask — re-wakes are off …` or
  `… its looks are used up …`, with `setting`, `rewake` and `looks`.

Each wake that does start it logs `Paperclip task waiting — running the bot`
with a `why` field.

## Upgrading from 2.x

3.0.0 changes two defaults:

- **Backlog cards are no longer started.** Set `PAPERCLIP_INTAKE=all` to keep the
  old behaviour.
- **Answered waits are no longer looked at again.** 2.x re-ran the model on every
  such wake and forced an escalation after the fourth. Set `PAPERCLIP_REWAKE=4`
  to keep that.
