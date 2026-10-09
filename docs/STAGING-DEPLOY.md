# MEKANIX — Staging Deployment Guide

## Prerequisites
- VPS (Ubuntu 22.04+, 2GB+ RAM, 20GB disk)
- SSH access with sudo

## Step 1: Prepare VPS
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in
```

## Step 2: Clone + Checkout
```bash
git clone https://github.com/s6beheshti/mekanix.git
cd mekanix
git checkout v1.0.0
```

## Step 3: Set Secrets
```bash
export DB_PASSWORD=$(openssl rand -hex 16)
export JWT_SECRET=$(openssl rand -hex 32)
export REDIS_PASSWORD=$(openssl rand -hex 16)
echo "DB_PASSWORD=$DB_PASSWORD" > .env.staging
echo "JWT_SECRET=$JWT_SECRET" >> .env.staging
echo "REDIS_PASSWORD=$REDIS_PASSWORD" >> .env.staging
source .env.staging
```

## Step 4: Deploy
```bash
bash scripts/db-switch-provider.sh postgresql
rm -rf prisma/migrations
mkdir -p prisma/migrations/20260925000000_init
cp prisma/migrations-postgresql/20260925000000_init/migration.sql prisma/migrations/20260925000000_init/
cp prisma/migrations-postgresql/migration_lock.toml prisma/migrations/
bash scripts/deploy-staging.sh
```

## Step 5: Verify
```bash
curl http://127.0.0.1:3001/api/health  # ok:true
curl http://127.0.0.1:3001/api/ready  # 200
```

## Step 6: Load Test
```bash
# Install k6
sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3715BE89A919199FBC3E0E7E7A1C6
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update && sudo apt install k6

k6 run scripts/load-test.js --env BASE_URL=http://127.0.0.1:3001
```

## Step 7: ZAP Scan
```bash
bash scripts/zap-scan.sh http://127.0.0.1:3001
```

## Step 8: Backup/Restore Test
```bash
docker compose -f docker-compose.staging.yml exec db psql -U mekanix -c "CREATE DATABASE mekanix_test_restore;"
export TEST_DB_URL=postgresql://mekanix:$DB_PASSWORD@localhost:5432/mekanix_test_restore
bash scripts/test-backup-restore.sh
```

## Step 9: Rollback Drill
```bash
# Break it
echo "BROKEN" > src/app/page.tsx
docker compose -f docker-compose.staging.yml up -d --build
curl http://127.0.0.1:3001/api/health  # should fail

# Rollback
git checkout src/app/page.tsx
docker compose -f docker-compose.staging.yml up -d --build
curl http://127.0.0.1:3001/api/health  # should work
```

## Step 10: Monitoring
```bash
crontab -e
# Add: */1 * * * * bash /path/to/mekanix/scripts/monitor.sh --once http://127.0.0.1:3001 >> /var/log/mekanix-monitor.log 2>&1
```
