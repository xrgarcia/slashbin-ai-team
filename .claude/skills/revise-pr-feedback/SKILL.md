---
description: Revise PRs with pending review feedback — read reviewer comments, implement fixes, push, and signal ready for re-review
---

# Revise PR Feedback

When told "revise PRs with pending feedback" or "revise pr feedback".

## Phase 0: Inventory

1. Query GitHub for open PRs with the `pr pending actions` label:
   ```
   gh pr list --label "pr pending actions" --state open --json number,title,url,headRefName,body
   ```
2. If none found, report "No PRs pending revision" and stop.
3. For each PR, note the PR number and head branch name.

## Phase 1: Read Feedback

For each PR from Phase 0:

1. Read all review comments:
   ```
   gh pr view <number> --comments --json comments,reviews
   ```
2. Also read inline review comments (code-level feedback):
   ```
   gh api repos/{owner}/{repo}/pulls/<number>/comments --jq '.[] | {path, line, body}'
   ```
3. Also re-read the linked issue body and any comments added after the PR was opened — reviewers may reference an updated spec rather than restating it inline.
4. Categorize findings by severity (S1, S2, S3) from the reviewer's comments.
5. Build a checklist of all requested changes.

## Phase 2: Implement Fixes

For each PR, in priority order (S1 first, then S2, then S3):

1. Checkout the PR's head branch:
   ```
   git checkout <headRefName>
   git pull origin <headRefName>
   ```
2. If pull fails due to conflicts, STOP and report the conflict. Do not attempt to resolve merge conflicts automatically.
3. Implement each requested change from the reviewer's feedback.
4. **Smoke test — MUST PASS before committing:**

   This repo has no test suite. For each changed `.js` / `.mjs` file, run:

   ```bash
   node --check <path-to-file>
   ```

   All changed files must parse cleanly. **Never run `npm run start`** — it spawns live Discord bots.

   If the PR introduces a new `npm test` or `npm run lint` script, run it and require it to pass.

5. If smoke test passes:
   - Stage the specific changed files (never `git add .` or `git add -A`)
   - Commit: `fix: address review feedback (#<PR-number>)`
   - Multiple commits are fine if changes are logically separate.
6. If smoke test fails:
   - Attempt to fix the code.
   - Re-run the syntax check.
   - If still failing after 2 attempts, STOP and report which fixes were applied and which failed.

## Phase 3: Push & Signal

After all fixes are committed:

1. Push: `git push origin <headRefName>`
2. Update labels to signal ready for re-review:
   ```
   gh pr edit <number> --remove-label "pr pending actions" --add-label "pr under review"
   ```
3. Add a comment on the PR summarizing what was fixed:
   ```
   gh pr comment <number> --body "Addressed review feedback: <summary of changes>"
   ```

## Rules

- Never modify tests to make code pass. Tests define expected behavior.
- Address ALL reviewer findings — do not skip S2 or S3 items.
- If a fix requires changes outside this repo's scope, skip it and note it in the PR comment.
- Only revise PRs with the `pr pending actions` label — refuse without it.
- **Never run `npm run start`** during a smoke test in this repo.
- **Never edit `ecosystem.config.js`** or anything inside `bots/` — both are gitignored on purpose.
