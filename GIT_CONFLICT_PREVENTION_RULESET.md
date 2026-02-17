# Git Conflict Prevention Ruleset

This is the workflow I will follow on this repository to avoid branch drift and merge conflicts.

## 1) Branching Rule
- Never commit directly to `main`.
- Start every task from fresh `origin/main`.
- One task = one short-lived branch.

## 2) Start-of-Task Sync
- Run:
  - `git fetch origin --prune`
  - `git switch main`
  - `git pull --ff-only`
  - `git switch -c <task-branch>`

## 3) Keep History Linear
- Rebase feature branches onto `origin/main` before push:
  - `git fetch origin --prune`
  - `git rebase origin/main`
- Do not merge `main` into feature branches.

## 4) Push Policy
- Normal push:
  - `git push -u origin <task-branch>`
- After rebase:
  - `git push --force-with-lease`

## 5) Branch Hygiene
- Keep only active branches locally.
- Prune deleted remote refs regularly:
  - `git fetch origin --prune`

## 6) Drift Check (Required Before PR)
- Verify branch contains only expected commits:
  - `git log --oneline origin/main..HEAD`
- If unrelated old commits appear, rebuild branch from `origin/main` and cherry-pick only required commits.

## 7) Conflict Recovery Standard
- If rebase conflicts come from old historical commits, do not resolve massive legacy conflicts.
- Instead:
  - abort rebase
  - rebase only the needed tip commits onto `origin/main` (or rebuild branch and cherry-pick)

