---
description: Implement ONE approved GitHub issue (highest priority) per invocation, with passing tests, in its own PR
---

# Implement Approved Issues

When told "implement approved issues" or "implement your approved issues".

## Phase 0: Sync

Before starting any work, ensure the local repo is up to date:

1. `git checkout features`
2. `git pull origin features`
3. If pull fails due to conflicts or network errors, STOP and report the conflict. Do not attempt to resolve merge conflicts automatically.

## Phase 1: Inventory

1. Query GitHub for open issues with the approved label:
   gh issue list --label approved --state open --json number,title,body,labels
2. If none found, report "No approved issues to implement" and stop.
3. Read the full body of each issue: gh issue view <number>.
4. Select exactly ONE issue using Phase 2 priority rules. Do not loop — the Foreman polls again on the next cycle to pick up the next issue.

## Phase 2: Analysis & Ordering

For the selected issue:
1. Read the full issue body and labels.
2. If the issue has the `blocked` label → skip: "Issue #N is blocked — skipping."
3. If acceptance criteria are unclear → skip: "Issue #N has unclear criteria — skipping."
4. Determine priority using labels and select the highest-priority issue:
   - **P1**: `S1` label (any type) — production broken
   - **P2**: `security` label (any severity)
   - **P3**: `S2` + `bug`
   - **P4**: `S2` + `enhancement`
   - **P5**: `S2` + `feature`
   - **P6**: `bug` (no severity label)
   - **P7**: `enhancement` (no severity label)
   - **P8**: `feature` (no severity label)
   - **P9**: `S3` label (any type)
   - **P10**: `chore`
5. Within the same priority tier:
   - Dependencies first (if issue B references issue A)
   - Schema/migration changes before code that uses them
   - Smaller scope first
6. Read the issue body sections explicitly:
   - **Acceptance criteria**: this is what to implement.
   - **Out of scope**: this is what NOT to implement, even if it's mentioned elsewhere in the body. Treat as a hard boundary.
   - **References**: informational only — links to related issues or specs. NEVER implement work cited here. References are not acceptance criteria.

## Phase 3: Implementation

**Build within the owning abstraction.** Read this repo's `CLAUDE.md` "Architecture & Invariant Ownership" and the issue's `## Owning abstraction & invariant impact` section. Implement every change to that domain's state **through the owning abstraction named there** — do NOT add a second mechanism for an operation the owner already performs, do NOT mutate the domain's state outside its owner, and do NOT create a transition that holds only because the call sites happen to line up (an emergent invariant is a latent S1; review will REQUEST_CHANGES it). If the issue's spec cannot be implemented this way — the named owner doesn't exist, the issue says "no owner — establish it" but the change you'd have to make is larger/ambiguous than the issue describes, or honoring single-ownership contradicts the spec — **STOP and surface it**: comment on the issue describing the conflict and do NOT ship a call-site patch as a substitute. A patch that "works" by bypassing the owner is a failed implementation, not a shortcut.

**Build to the established patterns — not to the nearest example in this repo.** The defaults below already run in production across multiple repos. Reach for them FIRST; this repo's own code is the *second* place to look, because a repo can be drifting. If the issue's `## Existing Patterns to Follow` names a different approach, follow the issue and say why in the PR body.

- **Async / background work → a Redis queue + worker.** Claim with `BLMOVE <queue> <queue>:processing LEFT RIGHT 0`; on boot, re-queue anything stranded in `:processing` from a previous run; ack with `LREM` only AFTER the handler succeeds; retry via an `attempts` counter + backoff; dead-letter after max attempts; make the handler **idempotent** (delivery is at-least-once); use a `redis.duplicate()` for the blocking client. Start it in-process from `server/index.ts` — do not create a separate service. NEVER use `setTimeout`, a table-polling cron, or the request path to do deferred work. `setInterval` is only for recovery/reconciliation sweeps, never for primary event-driven work.
- **A schema change → a GENERATED migration.** Run `drizzle-kit generate`, which writes both the `.sql` and its `migrations/meta/_journal.json` entry. A hand-written `.sql` with no journal entry is invisible to the migrator and will never run. Never use `drizzle-kit push` as a path to production.
- **A backfill / cleanup / recovery → a DATA migration.** Hand-written SQL is correct here, but it must be listed explicitly in the `DATA_MIGRATIONS` array in `server/migrate.ts` and guarded by the `data_migrations` table. A file sitting in `migrations/` that is not in that array does not run.
- **A new UI surface → the standard web stack.** React + Vite + TypeScript, Tailwind + shadcn/ui, wouter for routing, TanStack Query for server state, Express + Passport, Drizzle, Zod, Vitest.

If a default genuinely cannot be followed for this issue, **STOP and comment on the issue** explaining the conflict — do not silently substitute a different mechanism.

**Implement the single chosen issue.**

1. Implement the changes described in the issue.
2. **Smoke test — MUST PASS before committing:**
   - If `npm run build` exists → run it. Must succeed.
   - If `npm run start` exists → start the server, verify it responds, then stop it.
   - If `npm test` exists → run tests. Must pass.
   - If none exist → verify the code at least has no syntax errors: `npx tsc --noEmit` (for TypeScript repos)
3a. **Scope checkpoint — MUST PASS before committing:**
   - Run `git diff --staged` and review every changed file.
   - For each change, confirm it maps to an acceptance criterion in the issue.
   - If a change addresses something OUTSIDE the AC (even if "related"), revert that change and STOP. File a separate issue for that work; do not bundle it.
3b. **Blast-radius check on contract changes:**
   - If you changed a function's signature, return type, parameter list, or thrown-error shape, grep for callers in this repo.
   - For each caller, verify it handles the new contract.
   - If any caller would break, fix it in the same commit OR revert the contract change and find a backward-compatible approach.
3. If smoke test passes:
   - Stage the specific changed files (never git add . or git add -A)
   - Commit: fix|feat|chore: <description> (#<issue-number>)
   - **Push immediately:** `git push origin features`
   - **Create PR immediately** — one PR per issue
   - Stop. The Foreman will invoke again for the next issue.
4. If smoke test fails:
   - Attempt to fix the code (NEVER modify tests to make code pass).
   - Re-run the smoke test.
   - If still failing after 2 attempts, revert this issue's changes.
   - If reverting restores passing smoke tests, skip this issue and stop.
   - If the build is broken beyond this issue's scope, STOP and report.

## Phase 4: Pull Request

After the issue is committed and pushed:

1. Check if a PR from features → develop already exists:
   ```
   gh pr list --head features --base develop --state open --json number
   ```
2. Create a PR from features → develop:
   - Title: `<type>: <description> (#<issue-number>)` for the implemented issue.
   - Body: `Related to #<N>` for the implemented issue (only one — Phase 1 enforces single-issue scope), plus summary of changes and smoke-test results.
3. Never update an existing PR with changes for a different issue. If you find an existing open PR on `features → develop`, STOP and report — the previous cycle's PR didn't merge cleanly and the EM needs to resolve it before this cycle proceeds.

IMPORTANT: In PR descriptions, use "Related to #N" — NEVER use "Closes #N" or "Fixes #N". Issues are closed by the EM after production verification, not on dev merge.

## Rules

- Never modify tests to make code pass. Tests define expected behavior.
- One commit per issue. Each commit must leave tests passing (if tests exist).
- Branch: features. PR base: develop.
- Only implement issues with the approved label — refuse without it.
- If an issue references another repo or is meant for a different service → skip it.
