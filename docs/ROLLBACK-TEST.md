# MEKANIX — Rollback Test Procedure

## Prerequisites
- Current production deployment is running
- A previous Docker image or git tag is available
- Database backup script works (scripts/backup-db.sh)

## Test Steps

### 1. Simulate a Bad Deployment
```bash
# Deploy a "broken" version (e.g., with a typo in the code)
echo "BROKEN" > src/app/page.tsx
bash scripts/deploy.sh
# Verify: app returns error
curl http://localhost:3000/api/health
```

### 2. Initiate Rollback
```bash
# Option A: Rollback to previous git tag
git checkout v1.0.0
bash scripts/deploy.sh

# Option B: Rollback to previous Docker image
docker images mekanix-test
docker tag mekanix-test:previous mekanix-test:latest
docker compose down && docker compose up -d
```

### 3. Verify Recovery
```bash
# Health check
curl http://localhost:3000/api/health
# Expected: {"ok":true,...}

# Ready check
curl http://localhost:3000/api/ready
# Expected: 200 with all checks passing

# Manual smoke test
curl http://localhost:3000/api/care/packages
# Expected: 200 with package list
```

### 4. Database Rollback (if needed)
```bash
# Only if the bad deployment modified the database
bash scripts/restore-db.sh /backups/mekanix_YYYYMMDD_HHMMSS.sql.gz

# Verify
psql "$DATABASE_URL" -c "SELECT count(*) FROM \"User\";"
```

### 5. Document Results
- Rollback time: ___ seconds
- Data loss: ___ (should be 0 if using proper migrations)
- User impact: ___ (downtime duration)

## Pass Criteria
- [ ] App recovered within 60 seconds
- [ ] No data loss
- [ ] All API endpoints responding
- [ ] Health check returns ok=true
