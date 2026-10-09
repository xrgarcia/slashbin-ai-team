---
name: land
description: Commit and push files you edited in your own repo, so the change is on its main branch. Use after you correct or add to your own notes, context or skills — an edit that is not landed is lost to everyone but this checkout.
---

# land

Your edit is not done until it is landed: committed, and pushed to the branch your
repo publishes. This is the only way you commit. There is no `git commit` or
`git push` for you to run, and you need none.

## Command

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/land.mjs --message "<what changed and why>" <file> [<file>...]
```

Write the command with the path exactly as it appears above, already filled in.
Name every file you changed, relative to your repo root. A folder lands every
changed file under it, and only if each one is a file you may land. The message is the
record: what changed and who it came from, e.g.
`company.md: ops is run by <name> (told by <who>, <date>)`.

## What it refuses

It lands only the files this bot may land (the host sets which), and only files
you name. It refuses, and pushes nothing, when:

- a file is outside the paths you may land: your instructions are not yours to change
- a file has no change
- the checkout holds someone else's commit that is not pushed yet
- the push is rejected: nothing was committed and your edit stays on disk

A refusal says why. Do not try another way to commit; tell whoever asked that
the change is saved on disk but not landed, and why.

## After landing

Say what changed in one line. The commit is the record; do not repeat it.
