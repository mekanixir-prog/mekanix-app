# MEKANIX — Isolated Staging Deployment & Release Rehearsal

This guide is for an isolated staging VPS only. It does not authorize production deployment, production migrations, live SMS, or live payment activation.

## 1. Prerequisites

- Ubuntu 22.04+ VPS with at least 2 vCPU, 4 GB RAM, and 30 GB disk for a realistic build/test run.
- SSH access with sudo.
- Docker Engine + Docker Compose plugin.
- Git, curl, rsync, OpenSSL, Python 3, and `postgresql-client` (`pg_dump`, `psql`).
- k6 for the performance smoke test.
- Docker for the OWASP ZAP baseline scan.

Install the basic packages:

```bash
sudo apt update
sudo apt install -y git curl rsync openssl python3 postgresql-client
```

## 2. Checkout the exact Release Candidate

Use the exact reviewed release-candidate commit; do not deploy a floating branch or an old tag.

```bash
git clone https://github.com/mekanixir-prog/mekanix-app.git
cd mekanix-app
git checkout <RELEASE_CANDIDATE_SHA>
```

Replace `<RELEASE_CANDIDATE_SHA>` with the exact SHA approved by the release owner.

## 3. Create staging-only secrets

Use unique credentials that are not reused in production. Do not commit these files or paste their values into logs/chat.

```bash
umask 077
export DB_PASSWORD="$(openssl rand -hex 32)"
export JWT_SECRET="$(openssl rand -hex 48)"
export REDIS_PASSWORD="$(openssl rand -hex 32)"
mkdir -p "$HOME/.config/mekanix"
openssl rand -hex 48 > "$HOME/.config/mekanix/backup-passphrase"
chmod 600 "$HOME/.config/mekanix/backup-passphrase"
export BACKUP_PASSPHRASE_FILE="$HOME/.config/mekanix/backup-passphrase"

cat > "$HOME/.config/mekanix/staging.env" <<EOF
DB_PASSWORD=$DB_PASSWORD
JWT_SECRET=$JWT_SECRET
REDIS_PASSWORD=$REDIS_PASSWORD
BACKUP_PASSPHRASE_FILE=$BACKUP_PASSPHRASE_FILE
EOF
chmod 600 "$HOME/.config/mekanix/staging.env"
export STAGING_ENV_FILE="$HOME/.config/mekanix/staging.env"
```

The deploy script loads `STAGING_ENV_FILE` only when it is a file with mode 600 (or stricter). After a reboot, set `STAGING_ENV_FILE` to this protected path before deploying. Do not copy the file into the repository or paste its values into logs/chat.

## 4. Deploy the isolated staging stack

The deployment script builds a temporary context, copies the complete PostgreSQL migration history, and uses a stable Compose project name (`mekanix-staging`). It does not use the production D1 database.

```bash
export COMPOSE_PROJECT_NAME=mekanix-staging
bash scripts/deploy-staging.sh
```

Staging services are isolated in their own volumes and network. PostgreSQL is published only on `127.0.0.1:5433` so host-side backup/restore rehearsal tools can connect; it is not exposed on a public interface.

## 5. Verify health and readiness separately

```bash
curl --fail http://127.0.0.1:3001/api/health
curl -i http://127.0.0.1:3001/api/ready
```

- `/api/health` should return HTTP 200 and `ok: true` when the application can reach its database.
- `/api/ready` is expected to return HTTP 503 in this staging profile while SMS is set to `console` and payments are set to `simulator`. Inspect the JSON gates; this is intentional fail-closed behavior, not a healthy production-readiness result.
- OTP delivery and payment initiation must remain unavailable in this profile. Do not replace the simulator/console values with live credentials during this rehearsal.

## 6. Performance smoke test

Install k6 from its official package repository, then run:

```bash
k6 run scripts/load-test.js --env BASE_URL=http://127.0.0.1:3001
```

The script exercises the public home, health, readiness, and OTP fail-closed paths. It treats the expected staging OTP HTTP 503 as a valid safety outcome while still requiring health to be 200. It does not generate real SMS or payments.

Record p95/p99 latency, request failure rate, CPU, memory, and database resource use. If the thresholds fail, do not proceed to Release Candidate approval; investigate and repeat the run.

## 7. OWASP ZAP baseline scan

The target must be reachable from the ZAP container. On Linux, the script adds the host-gateway mapping:

```bash
bash scripts/zap-scan.sh http://host.docker.internal:3001
```

A missing report or any High-risk finding is a hard failure. Medium-risk findings must be reviewed and documented before release.

## 8. Encrypted backup and restore rehearsal

Create a protected, encrypted staging backup:

```bash
export DATABASE_URL="postgresql://mekanix:$DB_PASSWORD@127.0.0.1:5433/mekanix_staging"
export BACKUP_PASSPHRASE_FILE="$HOME/.config/mekanix/backup-passphrase"
export BACKUP_DIR="$HOME/mekanix-backups"
export BACKUP_ENCRYPTION_REQUIRED=true
bash scripts/backup-db.sh
```

Create a separate disposable restore-test database:

```bash
docker compose -p mekanix-staging -f docker-compose.staging.yml exec -T db \
  psql -U mekanix -d postgres -c "CREATE DATABASE mekanix_restore_test;"
```

Then verify a full staging backup/restore to the separate test database. This copies staging data, so the extra export opt-in is deliberate:

```bash
export TEST_DB_URL="postgresql://mekanix:$DB_PASSWORD@127.0.0.1:5433/mekanix_restore_test"
export SOURCE_ENV=staging
export ALLOW_STAGING_DATA_EXPORT=YES
export ALLOW_TEST_DB_RESET=YES
bash scripts/test-backup-restore.sh
```

The rehearsal compares row counts for every public table and the complete public index inventory. The test script resets only the explicitly supplied restore-test database; it refuses production as a source.

To test the encrypted restore utility itself, create a fresh empty database, then run:

```bash
export DATABASE_URL="postgresql://mekanix:$DB_PASSWORD@127.0.0.1:5433/mekanix_restore_utility_test"
docker compose -p mekanix-staging -f docker-compose.staging.yml exec -T db \
  psql -U mekanix -d postgres -c "CREATE DATABASE mekanix_restore_utility_test;"
RESTORE_CONFIRM=RESTORE bash scripts/restore-db.sh "$BACKUP_DIR/<BACKUP_FILE>.sql.gz.gpg"
```

The restore utility refuses to overwrite a non-empty PostgreSQL target. Keep the passphrase file and encrypted backup in separate protected locations. A production disaster-recovery procedure requires its own reviewed, explicitly approved runbook.

## 9. Rollback rehearsal

Do not deliberately corrupt the source tree. Rehearse rollback by deploying the previous known-good Release Candidate SHA into the isolated staging stack:

```bash
git checkout <PREVIOUS_KNOWN_GOOD_SHA>
bash scripts/deploy-staging.sh
curl --fail http://127.0.0.1:3001/api/health
```

Record the deployed SHA, migration state, and observed health. Do not reverse database migrations automatically; use a forward-fix or a separately reviewed restore plan.

## 10. Monitoring

Run a one-shot health check from cron or a systemd timer. Configure an alert webhook only through a protected environment variable:

```bash
ALERT_WEBHOOK=<STAGING_ALERT_WEBHOOK> \
  bash scripts/monitor.sh http://127.0.0.1:3001 --once
```

For continuous monitoring:

```bash
bash scripts/monitor.sh http://127.0.0.1:3001
```

## 11. Release evidence to capture

Attach the following to the Release Candidate record:

- Exact deployed Git SHA and database migration inventory.
- `/api/health` response and the expected staging `/api/ready` gate details.
- k6 summary including p95/p99 and failure rate.
- ZAP HTML/JSON report, with all High findings resolved.
- Encrypted backup artifact location (never the passphrase) and successful restore-rehearsal output.
- Rollback SHA and health result.
- Cloudflare D1/Cron staging evidence as a separate operational record; Docker/PostgreSQL staging does not substitute for Cloudflare D1.

**Production remains blocked** until provider-specific SMS/payment sandbox tests, isolated Cloudflare D1/Cron validation, secrets, migration approval, restore rehearsal, and owner sign-off are complete.
