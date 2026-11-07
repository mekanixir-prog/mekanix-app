# GitHub main-branch release protection

**Status checked:** 2026-11-07  
**Repository:** `mekanixir-prog/mekanix-app`  
**Target branch:** `main`

## Current repository state

A repository ruleset named `main` exists (ID `24984093`), but it is currently **disabled**. Its ref filter does not explicitly target `refs/heads/main`, its required status-check list is empty, required approvals are zero, stale approvals are not dismissed, and review-thread resolution is not required.

The GitHub integration available to this workflow can read the ruleset but does not have permission to activate or edit it. A repository administrator must apply the settings below in GitHub.

## Required configuration before merge to main

1. Open **Settings → Rules → Rulesets → main**.
2. Set enforcement to **Active**.
3. Set the branch target to include only `refs/heads/main`.
4. Keep deletion and non-fast-forward updates blocked.
5. Require a pull request before merging.
6. Require at least **1 approving review**.
7. Dismiss stale approvals when new commits are pushed.
8. Require all review conversations to be resolved.
9. Require status checks to pass before merging and enable strict up-to-date checks.
10. Keep bypass actors empty (no bypass).
11. Require linear history; use squash or rebase merge if the repository workflow requires it.

## Required GitHub Actions checks

Use the exact check-run names emitted by GitHub Actions:

- `Lint + TypeCheck + Test`
- `quality`
- `Docker Build + Compose + Health`
- `PostgreSQL Migration + Build`
- `OpenNext → Cloudflare Worker`
- `Analyze JavaScript and TypeScript`
- `Scan repository history for exposed secrets`

These are seven separate checks. Do not replace them with a single aggregate status or mark a check optional.

## Release gate

- [ ] Ruleset targets `refs/heads/main`.
- [ ] Enforcement is Active.
- [ ] One independent approval is required.
- [ ] Stale approvals are dismissed after new commits.
- [ ] Review threads must be resolved.
- [ ] All seven checks above are required and strict.
- [ ] Bypass list is empty.
- [ ] Final candidate head has all seven checks green after its last code change.

**Important:** A green CI run does not compensate for a disabled branch ruleset. Keep the release candidate in Draft and do not merge until this checklist is satisfied by a repository administrator.
