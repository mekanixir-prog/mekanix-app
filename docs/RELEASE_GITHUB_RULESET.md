# GitHub main-branch release protection

**Status checked:** 2026-11-23  
**Repository:** `mekanixir-prog/mekanix-app`  
**Target branch:** `main`

## Verified live ruleset

The active repository ruleset is:

- Name: `main-production-protection`
- Ruleset ID: `27880389`
- Enforcement: `active`
- Target: `refs/heads/main` only
- Bypass actors: none

An older ruleset named `main` (ID `24984093`) remains present but disabled. It is not the active protection mechanism; do not confuse it with `main-production-protection`.

The live Rulesets API was re-read after the administrator saved the configuration. It reports:

- Pull requests required before merging.
- At least one approving review required.
- Stale approvals dismissed when new commits are pushed.
- Review-thread resolution required.
- Strict/up-to-date required status checks enabled.
- Branch deletion blocked.
- Non-fast-forward updates (force pushes) blocked.
- Empty bypass list.

## Required status checks

The active ruleset contains exactly these nine unique required contexts. Each is configured once with the source integration verified from the exact-head check-run records:

| Exact check-run context | Source | Integration ID |
|---|---|---:|
| `CodeQL` | GitHub Advanced Security | 57789 |
| `Scan repository history for exposed secrets` | GitHub Actions | 15368 |
| `Analyze JavaScript and TypeScript` | GitHub Actions | 15368 |
| `Lint + TypeCheck + Test` | GitHub Actions | 15368 |
| `PostgreSQL Migration + Build` | GitHub Actions | 15368 |
| `Audit the committed lockfile (no auto-fix)` | GitHub Actions | 15368 |
| `OpenNext → Cloudflare Worker` | GitHub Actions | 15368 |
| `Docker Build + Compose + Health` | GitHub Actions | 15368 |
| `quality` | GitHub Actions | 15368 |

The conditional `Prepare dependency remediation branch` job is intentionally not required. It is a separate trusted security-branch remediation job and is skipped on the pull-request candidate.

## Exact-head evidence at this audit

Candidate PR #186 head `b95aa00d24b82b7fc866d192cb949c7bae8dcd1f` has successful check runs for all nine required contexts. The check-runs API also shows repeated successful executions for two contexts; this does not create duplicate ruleset entries. The ruleset contains nine unique contexts only.

This evidence is tied to the exact SHA above. Any subsequent commit changes the candidate head and requires fresh exact-head workflow results.

## Separate repository security settings — not yet verified

The active branch ruleset does not prove that the following repository/account settings are enabled. Track them separately under Issue #121:

- Dependabot alerts and security updates.
- Dependency graph.
- Secret scanning and push protection (where available for this repository/plan).
- Repository Actions default `GITHUB_TOKEN` permissions set to read-only.
- Whether GitHub Actions is allowed to create and approve pull requests.

Workflow-level permissions are also distinct from the repository default. Current workflow files declare least-privilege permissions in most workflows; `dependency-review.yml` grants `contents: write` only to its conditional `dependency-remediation` job on the trusted security branch. Review that exception periodically.

## Administrator verification checklist

- [x] Active ruleset targets only `refs/heads/main`.
- [x] Enforcement is Active.
- [x] One approving review is required.
- [x] Stale approvals are dismissed after new commits.
- [x] Review conversations must be resolved.
- [x] All nine exact checks above are required with strict/up-to-date enforcement.
- [x] Bypass list is empty.
- [x] Deletion and force pushes are blocked.
- [ ] Verify separate repository security settings listed above.

## Release gate

Branch protection is now active, but this is only one governance control. PR #186 remains Draft and has no submitted human review. It must not be merged until an independent reviewer approves the exact final SHA and the financial, authorization, migration, staging, backup/restore, rollback, provider and owner Go/No-Go gates are evidenced.

**Decision: NO-GO for merge-to-main and public production.**