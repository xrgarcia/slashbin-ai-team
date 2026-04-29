---
description: Implement all approved GitHub issues, commit each with a syntax-checked smoke test, create a single PR
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

## Phase 2: Analysis & Ordering

For each issue:
1. Read the full issue body and labels.
2. If the issue has the `blocked` label → skip: "Issue #N is blocked — skipping."
3. If acceptance criteria are unclear → skip: "Issue #N has unclear criteria — skipping."
4. Determine priority using labels:
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
   - Smaller scope first

## Phase 3: Implementation

**Implement ONE issue at a time.** After each issue, verify before moving to the next.

For each issue in order:
1. Implement the changes described in the issue.
2. **Smoke test — MUST PASS before committing:**

   This repo is a plain Node.js Discord-bot harness (PM2 + discord.js). It has **no test suite, no TypeScript, and no build step**. The `npm run start` script launches the live multi-bot process and connects to Discord — **never run it as a smoke test**.

   For each changed `.js` / `.mjs` file, run:

   ```bash
   node --check <path-to-file>
   ```

   All changed files must parse cleanly. If any file fails `node --check`, the implementation is broken — fix and re-check before committing.

   For changes that affect `bot.js`, `bot-manager.mjs`, `summarize.js`, or anything in `bots/`: in addition to `node --check`, manually trace the diff for obvious runtime errors (undefined references, async/await misuse, missing `await` on promises, env-var typos). This repo has no automated regression coverage — review carefully.

   If the issue introduces a new `npm test` or `npm run lint` script, run it and require it to pass.

3. If smoke test passes:
   - Stage the specific changed files (never `git add .` or `git add -A`)
   - Commit: `fix|feat|chore: <description> (#<issue-number>)`
   - **Push immediately:** `git push origin features`
   - **Create or update PR immediately** — do not batch multiple issues into one push
   - Continue to the next issue.

4. If smoke test fails:
   - Attempt to fix the code.
   - Re-run the smoke test.
   - If still failing after 2 attempts, revert this issue's changes.
   - If reverting restores a clean syntax check, skip this issue and continue.
   - If the working tree is broken beyond this issue's scope, STOP and report which issues were committed successfully.

## Phase 4: Pull Request

After each issue is committed and pushed (or after all issues are done):

1. Check if a PR from features → develop already exists:
   ```
   gh pr list --head features --base develop --state open --json number
   ```
2. If no PR exists → create one:
   - Title: summary of changes
   - Body: `Related to #N` for each implemented issue, summary of changes, any skipped issues with reasons
3. If PR already exists → it auto-updates with the new commits. Add a comment listing the new issue(s) implemented.

IMPORTANT: In PR descriptions, use "Related to #N" — NEVER use "Closes #N" or "Fixes #N". Issues are closed by the EM after production verification, not on dev merge.

## Rules

- Never modify tests to make code pass. Tests define expected behavior.
- One commit per issue.
- Branch: `features`. PR base: `develop`.
- Only implement issues with the `approved` label — refuse without it.
- If an issue references another repo or is meant for a different service → skip it.
- **Never run `npm run start`** during a smoke test in this repo — it spawns live Discord bots.
- **Never edit `ecosystem.config.js`** — it's gitignored on purpose; PM2 config is environment-specific.
- **Do not commit anything inside `bots/`** — per-bot personas are local-only.
