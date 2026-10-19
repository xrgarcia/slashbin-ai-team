# Landing

[README](../README.md) · [All documentation](../README.md#documentation-table-of-contents)

## Contents

- [Terms](#terms)
- [Provenance](#provenance)
- [Rules](#rules)
- [Scenario language](#scenario-language)
- [Matrix](#matrix)

`skill-pack/bin/land.mjs` is a bot's only way to commit: it commits the files the
bot names, only those `BOT_LAND_PATHS` allows, and pushes them to the checkout's
upstream branch. The checkout is shared — a person, or another session, may hold
commits in it that are not pushed yet — so a landing must publish exactly the
bot's own change, never theirs, and never undo someone else's push.

This page is the specification. `test/landing.test.js` reads the matrix below
and runs one scenario per row against a scratch checkout and a local bare
remote, so a row here is a test.

## Terms

For a path `p`, an **entry** is what a tree holds there: mode, type and object
id together (`100644 blob …`, `100755 blob …`, `120000 blob …`), or *absent*.
Two entries are equal only when all three are; content alone is not identity —
an executable bit or a symlink is a change.

| Name | What it is |
|---|---|
| `U` | The upstream commit, read **once** right after the fetch. Every check, the private index, the new commit's parent and the push are against this one id. |
| `H` | `HEAD` when the run starts. |
| `F` | The fork: `merge-base(H, U)`. Equal to `H` when nothing local is unpushed. |
| `W` | The working tree's entry, hashed **once** during validation. The commit is built from these hashes, so the file being rewritten afterwards cannot change what is pushed. With `core.filemode=false` a regular file's mode is the upstream entry's, as git itself would stage it. |
| own | This checkout's **provenance** for `p`: it landed `p` as entry `E` in commit `C`, `C` is an ancestor of `U`, and `U[p]` is still exactly `E` (absent, for a landed deletion). |

## Provenance

The record is **per path** and **per worktree**: the ref
`refs/worktree/land/<remote>/<branch>` points at a commit whose `record.json`
maps each landed path to `{ entry, commit }`. `refs/worktree/*` is private to the
worktree that wrote it, so a landing in a linked worktree or another clone grants
nothing here; landing one path grants nothing on another.

Every landing — beside local commits or not — merges its paths into the record
**before** it pushes, with a compare-and-swap on the ref (a run that lost the
race re-reads and merges again). A record that cannot be written refuses the
landing before anything is pushed. A rejected push restores the paths it added,
again by compare-and-swap. A run that dies after its push therefore leaves a
valid record behind, and one that dies before leaves an entry whose commit never
reaches `U`, which grants nothing. A record that is unreadable counts as empty.

The ref `refs/land/beside-local` written by the previous version is shared by
every worktree and records a whole commit; it is no longer read.

## Rules

1. **What a named path carries.** Every file under the named path that git knows
   in the working tree, in `H` or in `U`, plus the other side of a staged rename.
   Of those, a file is a **change** when `W ≠ U[p]` and either `W ≠ H[p]` (the
   checkout edited it) or `p` is own (the checkout's working copy, not upstream's,
   is the last landed truth — a revert or a re-creation is a change).
   A file whose `W` differs from `U` only because the checkout is stale, or only
   because an unpushed local commit changed it, is not the bot's change and is
   not carried.
2. A named path that carries no change is refused: `already match <upstream>`
   when the working tree differs from `H` there, else `has no change to land`.
3. Every change must match `BOT_LAND_PATHS`, or the landing is refused.
4. **Local commits.** A change where `H[p] ≠ F[p]` is refused: an unpushed
   commit changed `p`, so any working copy of it carries that commit's content.
5. **Upstream writers.** A change where `U[p] ≠ F[p]` is refused unless `p` is
   own: someone pushed `p` since the checkout branched, and landing the stale
   copy would undo it.
6. A submodule entry on any side of a change is refused.
7. The commit is `U`'s tree with every change's `W` written over it, parent `U`.
   It is refused unless it differs from `U` in exactly the changes, each equal to
   its `W`.
8. Before the push, if `HEAD` moved, every change is checked again against the new
   `HEAD` under rule 4; a commit another session made meanwhile on a landed path
   refuses the landing.
9. The push is by commit id and never forced, so an upstream that moved past `U`
   rejects it, and nothing is landed.
10. With nothing local unpushed, a checkout behind `U` fast-forwards to `U` first,
    and after the push `HEAD` moves to the landed commit only if it has not moved
    (compare-and-swap). With local commits unpushed, `HEAD`, the index and every
    working file are left exactly as they were.

## Scenario language

Paths: `A` = `notes/a.md`, `B` = `notes/b.md`, `C` = `notes/c.md` (absent at
first), `N` = the folder `notes`. `BOT_LAND_PATHS` is
`notes/**,skills/**,!skills/guarded/**`. The repo starts with `A=a0`, `B=b0`,
`RULES.md` and `skills/guarded/SKILL.md`, pushed.

An entry value is written exactly (no newline): `a1` a regular file, `a1+x`
executable, `@a1` a symlink whose target is `a1` (the same blob as the regular
file `a1`), `-` absent.

| Step | Meaning |
|---|---|
| `ahead` | someone commits an unrelated change to `RULES.md` in the checkout and does not push it |
| `local P=v` | someone commits `P=v` in the checkout and does not push it |
| `up P=v` | someone pushes `P=v` to the upstream from another clone |
| `rewrite` | the upstream's tip is amended and force-pushed: same tree, new id |
| `edit P=v` | the bot writes `P=v` in the working tree |
| `mv P Q` | the bot stages a rename `git mv P Q` |
| `land X Y` | a landing of the named paths that must succeed |
| `land~ X` | a landing whose outcome is not checked (a hook kills or races it) |
| `wt P=v` | a linked worktree of this checkout, on its own branch at `HEAD` with the same upstream, writes `P=v` and lands it |
| `filemode off` | `core.filemode=false` |
| `forget` | the provenance ref is deleted |
| `garble` | the provenance ref points at a commit whose record is not JSON |
| `hook G[:ref] when: steps` | the **next** landing runs the comma-separated steps once, `before` or `after` its first `git G` (whose arguments include one starting with `ref`, if given): `fail` makes that git command fail, `kill` kills the landing, `fetch` fetches in the checkout, `commit P=v` is another session committing `P=v` in the checkout, and any step above |

A row's request is the final landing. `lands X Y` means it succeeds and the
landed commit changes exactly those paths, each to its working entry; `refused
/re/` means it exits 1 with that message and its commit reached the upstream
nowhere. After every landing, no unpushed local commit is on the upstream, and a
checkout that had local commits keeps its `HEAD`.

## Matrix

| Case | Setup | Request | Expected | Why |
|---|---|---|---|---|
| R1 | `ahead; up B=b1; edit A=a1; land A; edit B=b2` | `B` | refused `/origin\/main changed notes\/b\.md/` | landing A grants nothing on B |
| R2 | `ahead; edit C=c1` | `C` | lands `C` | a new file beside a local commit |
| R3 | `ahead; edit A=a1; land A; up A=a9; edit B=b1; land B; edit A=a2` | `A` | refused `/origin\/main changed notes\/a\.md/` | a later landing of B does not re-grant A after a correction |
| R4 | `local A=a0+x; edit A=a1+x` | `A` | refused `/changed by a commit in this checkout/` | a local mode-only change is still a change |
| R5 | `ahead; up A=a0+x; edit A=a1` | `A` | refused `/origin\/main changed notes\/a\.md/` | an upstream mode-only change is still a change |
| R6 | `ahead; up A=@a0; edit A=a1` | `A` | refused `/origin\/main changed notes\/a\.md/` | an upstream type change with the same blob |
| R7 | `local A=@a0; edit A=a1` | `A` | refused `/changed by a commit in this checkout/` | a local type change with the same blob |
| R8 | `ahead; edit A=-; land A; edit A=a5` | `A` | lands `A` | re-creating over the checkout's own deletion |
| R9 | `ahead; mv A C` | `C` | lands `A C` | both sides of a staged rename |
| R10 | `ahead; edit A=a1; hook update-ref:refs/worktree/land before: fail` | `A` | refused `/could not record/` | a provenance write that fails refuses before the push |
| R11 | `ahead; edit A=a1; hook push after: kill; land~ A; edit A=a2` | `A` | lands `A` | a landing killed after its push still owns A |
| R12 | `ahead; edit A=a1; edit B=b1; hook push after: land B; land A; edit A=a2; edit B=b2` | `A B` | lands `A B` | overlapping landings both keep their provenance |
| R13 | `edit A=a1; hook push before: commit RULES.md=other; land A; edit A=a2` | `A` | lands `A` | a no-local landing records provenance too |
| R14 | `ahead; edit A=a1; hook read-tree before: up A=a9, fetch` | `A` | refused `/push was rejected/` | a fetch after validation cannot change the base |
| R15 | `ahead; edit A=a1; hook update-index before: commit A=a7` | `A` | refused `/committed in this checkout while landing/` | another session's commit of A is never published |
| R16 | `ahead; wt A=a1; edit A=a2` | `A` | refused `/origin\/main changed notes\/a\.md/` | a linked worktree's landing grants nothing here |
| R17 | `ahead; edit A=a1` | `A` | lands `A` | an unrelated local commit does not block |
| R18 | `ahead; edit A=a1; land A; edit A=a2` | `A` | lands `A` | the next landing over its own |
| R19 | `ahead; edit A=a1; land A; up B=b1; edit A=a2` | `A` | lands `A` | someone else's unrelated push is kept |
| R20 | `ahead; edit A=a1; land A; up A=a9; edit A=a2` | `A` | refused `/origin\/main changed notes\/a\.md/` | a correction over its own landing |
| R21 | `ahead; up A=a9; edit A=a1` | `A` | refused `/origin\/main changed notes\/a\.md/` | someone else's push, no provenance |
| R22 | `local A=a5; edit A=a6` | `A` | refused `/changed by a commit in this checkout/` | content from a local commit |
| R23 | `local A=a5; local A=a0; edit A=a1` | `A` | lands `A` | local commits that restore A |
| R24 | `ahead; up A=a9; up A=a0; edit A=a1` | `A` | lands `A` | an upstream change since restored |
| R25 | `ahead; edit A=a1; land A; rewrite; edit A=a2` | `A` | refused `/origin\/main changed notes\/a\.md/` | provenance off the rewritten upstream grants nothing |
| R26 | `ahead; edit A=a1; land A; forget; edit A=a2` | `A` | refused `/origin\/main changed notes\/a\.md/` | no provenance, no grant |
| R27 | `ahead; edit A=a1; land A; edit B=b1; land B; edit A=a2; land A; edit A=a3; edit B=b2` | `A B` | lands `A B` | landings A, B, A keep both paths |
| R28 | `ahead; edit A=a1; land A` | `A` | refused `/already match origin\/main/` | nothing new to land |
| R29 | `ahead; edit A=-` | `A` | lands `A` | a deletion beside a local commit |
| R30 | `ahead; up A=-; edit B=b1; land B` | `A` | refused `/has no change to land/` | a stale copy is not a resurrection |
| R31 | `local A=-; edit A=a3` | `A` | refused `/changed by a commit in this checkout/` | re-creating a locally deleted file |
| R32 | `edit C=c1` | `C` | lands `C` | a new file, nothing local |
| R35 | `ahead; edit A=a1+x; land A; up A=a1; edit A=a2+x` | `A` | refused `/origin\/main changed notes\/a\.md/` | an upstream chmod over its own landing |
| R37 | `filemode off; ahead; up A=@a0; edit A=a1` | `A` | refused `/origin\/main changed notes\/a\.md/` | a type change with `core.filemode=false` |
| R65 | `ahead; edit A=a1; land A; edit A=a0` | `A` | lands `A` | reverting its own landing to the stale HEAD copy |
| R66 | `ahead; edit A=-; land A; edit A=a0` | `A` | lands `A` | re-creating its own deletion as the stale HEAD copy |
| R67 | `ahead; edit A=a1; land A; edit A=a0; edit B=b1` | `N` | lands `A B` | a folder carries a revert and an edit |
| R69 | `ahead; wt A=a1; edit B=b1; land B; edit A=a2` | `A` | refused `/origin\/main changed notes\/a\.md/` | its own landing of B does not adopt a peer's A |
| R75 | `ahead; up B=b1; edit A=a1; land A; edit B=-` | `B` | refused `/origin\/main changed notes\/b\.md/` | a stale deletion over a correction |
| R79 | `ahead; edit A=a1; edit C=c1` | `A C` | lands `A C` | a batch of an edit and a new file |
| L1 | `local A=a5; edit B=b1` | `N` | lands `B` | a folder leaves a local commit's file to its owner |
| L2 | `ahead; up B=b9; edit A=a1` | `N` | lands `A` | a folder does not carry a stale copy |
| L3 | `ahead; edit A=a0+x` | `A` | lands `A` | a mode-only edit lands |
| L4 | `ahead; edit A=@a0` | `A` | lands `A` | a type-only edit lands |
| L5 | `ahead; edit A=a1; land A; garble; edit A=a2` | `A` | refused `/origin\/main changed notes\/a\.md/` | an unreadable record grants nothing |
| L6 | `ahead; edit A=a1; land A; garble; edit B=b1` | `B` | lands `B` | an unreadable record is replaced, not fatal |
| L7 | `up B=b9; edit A=a1` | `A` | lands `A` | behind only: fast-forward, then land |
| L8 | `ahead; edit A=a1; hook push before: fail; land~ A; up A=a1; edit A=a2` | `A` | refused `/origin\/main changed notes\/a\.md/` | a rejected push takes back its provenance |
