# MEKANIX — Rollback Procedure

This document covers how to revert a production deployment of MEKANIX to a previous known-good version. The target rollback time budget is **15 minutes** from decision to verification.

---

## When to Rollback

Trigger a rollback if **any** of the following occur after a deploy:

- Critical bug affecting all users (e.g. blank page on app load, all API 5xx)
- Data corruption (e.g. migrations dropped columns, payment records lost)
- Security vulnerability actively exploited
- Payment gateway failures (>5% of transactions failing)
- SMS failures affecting all OTP send (customers cannot log in)
- Database connection exhaustion

**Rule of thumb:** if the issue can be hotfixed within 5 minutes (e.g. env var typo), patch forward. Otherwise rollback.

---

## Rollback Steps

### 1. Identify the Issue (1–2 min)

```bash
# Tail container logs for the last 5 minutes
docker compose logs --tail=200 app
docker compose logs --tail=200 db
docker compose logs --tail=200 redis

# Check health endpoint
curl -s https://mekanix.ir/api/health | jq
curl -s https://mekanix.ir/api/ready | jq

# Check CPU / memory / disk
docker stats
df -h
```

Capture the relevant log lines into a Slack thread / incident doc before rolling back — the post-mortem depends on it.

### 2. Decide: Rollback Code vs. Rollback Database

| Symptom | Action |
|---------|--------|
| App crash / API 5xx / wrong behavior | Rollback **code** only (Steps 3–4) |
| Migration corrupted data | Rollback **database** too (Steps 3–6) |
| Bad config (env var, JWT_SECRET) | Fix env var, restart container — no rollback needed |
| Dependency CVE | Rollback code + update dependency forward |

### 3. Stop Current Version (15 sec)

```bash
cd /opt/mekanix   # or wherever the production checkout lives
docker compose down
```

> **Note:** This causes ~30 sec downtime during the rollback. For zero-downtime, use blue/green (Phase 28.5 — future work).

### 4. Rollback to Previous Code Version (2–5 min)

**Option A — Rollback to previous Docker image tag:**

```bash
# List all images built for this app, newest first
docker images mekanix-test --format "table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}"

# Update docker-compose.yml to use the previous tag, then:
docker compose up -d --no-build
```

**Option B — Rollback to previous git tag:**

```bash
# List tags, newest first
git tag --sort=-creatordate | head -5

# Checkout the previous tag, then rebuild + redeploy
git checkout v1.0.0-prev
bash scripts/deploy.sh
```

### 5. Database Rollback (only if migrations corrupted data) (5–10 min)

⚠️ **Prisma migrations are forward-only.** There is no `prisma migrate rollback`. To undo a migration:

1. **Identify the offending migration:**
   ```bash
   docker compose exec db psql -U mekanix -c \
     'SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 5;'
   ```

2. **Restore from the most recent backup** (taken before the bad migration ran):
   ```bash
   # List recent backups
   ls -lh /backups/mekanix_*.sql.gz | tail -5

   # Restore (prompts for "RESTORE" to confirm)
   bash scripts/restore-db.sh /backups/mekanix_YYYYMMDD_HHMMSS.sql.gz
   ```

3. **If a backup isn't available** (last-resort only):
   - Write a **new forward migration** that reverses the bad one (e.g. recreates dropped columns, restores null constraints)
   - Commit it as `prisma/migrations/<timestamp>_rollback_<name>/migration.sql`
   - Run `prisma migrate deploy` to apply it

4. **Never** use `prisma migrate reset` in production — it drops all data.

### 6. Verify the Rollback (1–2 min)

```bash
# 1. Health endpoint (process alive + deps)
curl -s https://mekanix.ir/api/health | jq
# Expect: { "ok": true, "services": { "database": "healthy", ... } }

# 2. Readiness endpoint (migrations applied)
curl -s https://mekanix.ir/api/ready | jq
# Expect: { "ok": true, "checks": { "database": true, "migrationsApplied": true } }

# 3. Smoke test the critical paths
curl -s https://mekanix.ir/api/auth/demo   # anonymous demo login
curl -s https://mekanix.ir/api/dashboard   # authed dashboard
```

### 7. Notify Users + Stakeholders

- **Internal:** Post in `#incidents` Slack channel with the rollback summary
- **External (if user-visible):** Update status page (status.mekanix.ir) with brief note + ETTR
- **Affected users:** If data was lost, email affected users individually
- **Payments:** If payments were affected, contact payment provider (Zarinpal/IDPay) support with the affected `authority` IDs

---

## Common Rollback Scenarios

### Scenario A: New migration fails to apply on container boot

Symptom: container restart-loops, `prisma migrate deploy` errors in logs.

```bash
# 1. Stop the app container (db stays up)
docker compose stop app

# 2. Mark the bad migration as rolled-back in the migrations table
docker compose exec db psql -U mekanix -c \
  "DELETE FROM \"_prisma_migrations\" WHERE migration_name = 'YYYYMMDDHHMMSS_bad_migration';"

# 3. Rollback code to previous tag (Step 4 above)
# 4. Restart app — prisma migrate deploy will not re-apply the deleted migration
```

### Scenario B: Bad env var pushed (e.g. wrong JWT_SECRET)

Symptom: all sessions invalidated, or payment provider returns 401.

```bash
# 1. Edit .env on the VPS — fix the env var
sudo nano /opt/mekanix/.env

# 2. Restart the container (no image rollback needed)
docker compose up -d --force-recreate app
```

### Scenario C: Database disk full

Symptom: `psql` errors "could not extend file", backups fail.

```bash
# 1. Check disk usage
df -h
docker compose exec db du -sh /var/lib/postgresql/data

# 2. Delete old backups (keep last 3 days)
find /backups -name "mekanix_*.sql.gz" -mtime +3 -delete

# 3. Vacuum the database
docker compose exec db psql -U mekanix -c "VACUUM FULL ANALYZE;"

# 4. If still full, expand the disk volume (cloud-provider specific)
```

### Scenario D: SMS provider outage

Symptom: `/api/health` shows `services.sms = "unhealthy"`, customers can't receive OTP.

```bash
# Switch to fallback SMS provider (or console mode for emergency)
# Edit .env:
#   SMS_PROVIDER=console   # logs OTP to stdout — customers can read from /api/auth/otp/send response in dev mode
#   (or switch kavenegar → melipayamak)

docker compose up -d --force-recreate app
```

---

## Rollback Checklist

Before declaring the rollback complete:

- [ ] `curl /api/health` returns `"ok": true`
- [ ] `curl /api/ready` returns `"ok": true` with `migrationsApplied: true`
- [ ] Customer can log in via OTP (manual test)
- [ ] Admin can log in (manual test with `ADMIN_BOOTSTRAP_*`)
- [ ] Payment flow works end-to-end (sandbox test)
- [ ] No new error logs for 5 minutes (`docker compose logs --tail=50 app`)
- [ ] Incident doc created with timeline + root cause hypothesis
- [ ] Post-mortem scheduled within 48 h

---

## Emergency Contacts

| Role | Contact | Notes |
|------|---------|-------|
| Database admin | [TODO: fill before launch] | On-call for DB issues |
| DevOps | [TODO: fill before launch] | On-call for infra issues |
| Payment provider (Zarinpal) | https://zarinpal.com + support ticket | For payment trace requests |
| Payment provider (IDPay) | https://idpay.ir + 021-9100-2010 | For payment trace requests |
| SMS provider (Kavenegar) | https://kavenegar.com + 021-9100-0110 | For OTP delivery traces |
| Domain registrar | [TODO: fill before launch] | For DNS emergencies |
| Hosting provider | [TODO: fill before launch] | For VPS / network issues |

---

## Frequency

- **Rollback drill:** Run once per quarter (use staging environment + a real backup restore)
- **Backup restore drill:** Run monthly (verify backup integrity)
- **Document review:** Update this file after every rollback (real or drill)
