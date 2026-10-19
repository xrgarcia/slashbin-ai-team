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

An unreadable value in either setting turns the board connector off and logs the
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
