# MEKANIX — Production Deployment Runbook

**Status:** operational procedure; not evidence that deployment has happened.  
**Applies to:** Cloudflare Workers + OpenNext + D1 release path.  
**Current release decision:** blocked until the gates in [Release Readiness Audit](RELEASE_READINESS_AUDIT.md) are closed.

## 0. Non-negotiable safety rules

1. Never deploy from an unreviewed or dirty working tree.
2. Never run `prisma db push --accept-data-loss`, `prisma migrate reset`, or `bun run setup` against production.
3. Never apply a migration to production before testing it on a backup/staging copy and verifying recovery.
4. Never commit secrets. Use Wrangler/platform secret storage.
5. Never treat a successful build as a successful deployment.
6. Keep production and preview Worker/D1 IDs and credentials separate.
7. Do not enable real-money routes until the gateway, callback verification, idempotency, and reconciliation tests pass.

## 1. Preflight — identify exact release candidate

From a clean checkout:

```bash
git status --short
git fetch origin
git checkout feature/cloudflare-d1-validation
git pull --ff-only
git rev-parse HEAD
```

Record the SHA. Verify the PR targets `main`, review the full diff, check the migration files, and confirm no unrelated generated files or secrets are included.

Run the same checks used by CI:

```bash
bun install --frozen-lockfile
bunx prisma generate
bun run lint
bunx tsc --noEmit
bun run check:hygiene
bun run test
bun run build
bash scripts/build-cloudflare.sh
```

Run the commands in the supported CI/runtime environment. If the Cloudflare build script is shell-specific, use Linux/macOS or CI; do not infer Windows compatibility from the Node/Docker build.

Confirm GitHub Actions is green for the **same SHA** after the final code change. Record workflow run URLs in the release record.

## 2. Configuration and secrets

Review `wrangler.toml` and environment bindings before any deploy. At the time of the latest audit, it sets:
- `NODE_ENV = "production"`
- `SMS_PROVIDER = "console"`
- `PAYMENT_PROVIDER = "simulator"`
- D1 binding name `DB`

The SMS and payment settings are development placeholders and are not acceptable for a user-facing production release. The app's readiness endpoint should fail closed until required production settings are correct.

Before release:
- Select a supported SMS provider and set its credentials using secret storage.
- Select a supported payment gateway and configure merchant/callback credentials only after sandbox verification.
- Verify the Worker binds the intended production D1 database and that the database ID matches the approved environment.
- Generate strong, unique JWT secrets; configure a separate admin secret where supported.
- Confirm the application reads the right binding/secret names in the Workers runtime. Do not assume Node's `.env` behavior is identical to Workers bindings.
- Verify logs do not print OTPs, authorization tokens, gateway secrets, payment payload secrets, or personal data.

Do not put actual secret values in this document, commits, pull requests, or screenshots.

## 3. Database backup and migration

1. Confirm the target is the intended **preview/staging** database, not production.
2. Take/export a backup and verify that the export is readable.
3. Inspect the complete migration sequence and compare D1 migration files with PostgreSQL migration files; they are separate provider tracks.
4. Run duplicate preflight queries in [Release Readiness Audit](RELEASE_READINESS_AUDIT.md) against a disposable copy.
5. If duplicate payment IDs or multiple active VIP subscriptions exist, stop and prepare an explicit, reviewed reconciliation plan. Do not silently delete rows.
6. Apply the provider-appropriate migration to staging using the team's approved Wrangler/Prisma process. The repository does not currently provide proof that a remote production migration has run.
7. Verify migration history, table/index existence, representative reads/writes, foreign keys where supported, and expected row counts.
8. Exercise a restore rehearsal before approving the production migration.

Never substitute `prisma db push --accept-data-loss` for a reviewed production migration.

## 4. Preview deployment

Use the exact command supported by the pinned Wrangler/OpenNext versions and the team's configured Cloudflare account. The Worker build workflow only builds/uploads artifacts; it does not deploy.

Before deploying:
- Confirm Wrangler authentication belongs to the intended account.
- Confirm preview Worker name, D1 binding, and secrets.
- Confirm no production gateway credentials are present in preview unless explicitly approved for a controlled test.
- Record the SHA, build run URL, database migration version and deploy operator.

After deploying preview:
- `GET /api/health`: confirm the expected status and database result.
- `GET /api/ready`: expect 503 while required production gates are deliberately unset; for a release-like preview, configure preview providers and expect 200 only if all checks truly pass.
- Test OTP delivery using an authorized test number and provider sandbox.
- Test customer authentication and session revocation.
- Test the complete critical service journey, role/ownership checks, technician actions and admin workflows.
- Test payment sandbox flows, callback signature failures, duplicates/replays, and out-of-order events.
- Test concurrent VIP subscription attempts and duplicate payment submissions against the actual database engine.
- Verify error handling, timeouts, logs, alerting and browser/mobile behavior.

Save actual status codes, sanitized logs, timestamps and evidence URLs. Do not record secret values.

## 5. Production approval gate

Production deployment requires all of the following:
- [ ] PR approved and merged according to repository policy.
- [ ] All required CI checks green for the approved SHA.
- [ ] No unresolved blocker/high-risk audit item without written acceptance by the owner.
- [ ] Production SMS provider configured and verified.
- [ ] Payment gateway sandbox certification and production callback security completed, or payment functionality remains disabled by design.
- [ ] Production D1 backup and restore strategy verified.
- [ ] Migration preflight is clean and migration SQL reviewed.
- [ ] Domain/DNS/TLS and secure cookie behavior verified.
- [ ] Monitoring and rollback operator available.
- [ ] A release window and rollback decision threshold are agreed.

If any item is unchecked, do not call the release production-ready.

## 6. Deployment and smoke test

Only after approval:
1. Verify the target Worker, production D1 database and secrets one last time.
2. Capture current deployed version and database migration state.
3. Apply the approved migration using the approved production procedure.
4. Deploy the approved artifact/commit using the configured Wrangler/OpenNext release command.
5. Confirm the deploy command's success and record its deployment/version ID.
6. Check `/api/health` and `/api/ready`.
7. Test login/OTP, asset registration, service request creation, technician update, notification delivery, and admin authorization.
8. If payments are enabled, run only the approved minimal gateway smoke test and verify callback + reconciliation. Do not create uncontrolled real charges.
9. Monitor logs and metrics during the release window.

A successful command alone is insufficient; the application and business paths must pass smoke tests.

## 7. Rollback and incident response

- Stop or disable new traffic/feature exposure if a critical error, authorization leak, duplicate charge, lost write, or widespread OTP failure appears.
- Roll back the Worker to the last known-good deployment where supported.
- Do not assume database migrations are automatically reversible. If schema/data has changed, use the documented forward-fix or verified restore plan; coordinate before restoring because restore may discard writes created after the backup.
- For payment incidents, pause the affected flow, preserve gateway callback/event IDs, reconcile gateway records against internal Payment/Wallet records, and do not manually edit balances without an auditable procedure.
- For authentication incidents, rotate affected secrets, revoke sessions/tokens where possible, and inspect access logs.
- Record timeline, impact, affected users, actions, and follow-up tasks in an incident report.

## 8. Post-release

- Monitor 5xx rate, `/api/ready`, DB errors, OTP delivery latency/failure rate, payment callback success, idempotency conflicts, and service-request completion.
- Verify backups and restore access remain available.
- Confirm no secrets or sensitive user data appear in logs.
- Review incidents and user support reports after the initial release window.
- Update [Release Readiness Audit](RELEASE_READINESS_AUDIT.md) with the actual commit, deploy ID, migration evidence and remaining known issues.

## 9. Release record template

```text
Release date/time:
Operator:
Approved commit SHA:
PR URL:
CI run URLs:
Worker name/environment:
D1 database identifier (non-secret):
Migration version(s):
Backup/export reference:
Restore rehearsal evidence:
Domain/TLS verification:
SMS provider verification:
Payment gateway verification (or disabled):
Health result:
Readiness result:
Smoke-test evidence:
Rollback version:
Known risks accepted by:
```
