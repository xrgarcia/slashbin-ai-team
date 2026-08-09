---
name: remember
description: Recall what was actually said or decided earlier — across daily summaries, the conversation buffer, files people sent, live sessions and scheduled runs. Use whenever someone refers to prior context ("what did we decide", "last time", "as I said", "the file I sent you", "what did you tell me"), or for any synonym of remember — recall, recap, look back, refresh, what happened with.
---

# remember

Answer questions about what happened before, from this bot's own memory.

## Why this exists

Without it a bot can only see the last 48 hours of summaries, and on a **resumed**
session not even that — the harness does not re-inject context mid-conversation.
So the longer a conversation ran, the less the bot could remember about it. This
reaches the whole record instead.

## How to do it

Run the gatherer. It searches every store and reports what it found:

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/recall.mjs" "<the user's question, or the key terms from it>"
```

If `$CLAUDE_PLUGIN_ROOT` is not set, the script sits in `bin/recall.mjs` beside
this skill.

It prints a **Sources searched** table followed by cited material. It reads only —
it never writes, moves or deletes anything.

## Reading the results — this part matters

The table tells you what was actually searched. **These are not the same thing:**

| result | means |
|---|---|
| `NO MATCH` | searched, genuinely nothing relevant |
| `EMPTY` | the store exists but has nothing in it yet |
| `MISSING` / `UNAVAILABLE` | **never searched** — the path or variable is absent |
| `UNREADABLE` | exists, could not be read |
| `PARTIAL` | matches found, but some are themselves truncated |

**Never present a `MISSING` source as "I checked and found nothing."** That is the
exact failure this replaces: the previous per-repo version read three paths that
had been dead for months, reported that it had checked them, and answered
confidently from the fraction it happened to find.

If the answer would hinge on a source that came back `MISSING` or `UNREADABLE`,
say so.

## Answering

- **Lead with the answer**, then the evidence. Not a tour of the search.
- **Cite every claim** — the summary file and date, or the buffer line. The user
  should be able to go and look.
- **Quote the buffer for anything verbatim.** Summaries are compressions and they
  extrapolate: they invent specificity ("a ~50-line script", "5 test cases") and
  frame trailing-off threads as decisions. If the question is *"what did you say"*
  or *"what did I ask"*, the buffer is the source of truth and the summary is not.
- **A `PARTIAL` buffer line is truncated.** Say the message was cut off rather
  than reconstructing what it probably said.
- **If nothing matched, say nothing matched.** Do not fill the gap from general
  knowledge or from the current conversation — a confident wrong recollection is
  worse than "I don't have that."

## Widening a search that comes back thin

Try again with fewer, more distinctive terms — names, error strings, file names,
issue numbers. Common words are dropped, so `"what did we decide about retries"`
searches on `decide` and `retries`.

If the query is about a specific day, name it: dates appear in summary filenames.
