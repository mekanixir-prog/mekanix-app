#!/bin/bash
# MEKANIX — Staging Deployment
# Deploys to staging environment (port 3001, separate DB)
#
# Required env vars (NO fallbacks — must be set explicitly):
#   DB_PASSWORD     — PostgreSQL password
#   JWT_SECRET      — JWT signing secret
#   REDIS_PASSWORD  — Redis password
#
# Usage: bash scripts/deploy-staging.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Validate required env vars (NO defaults) ───
: "${DB_PASSWORD:?DB_PASSWORD is required for staging}"
: "${JWT_SECRET:?JWT_SECRET is required for staging}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD is required for staging}"

echo "🚀 MEKANIX Staging Deployment"
echo "   Port: 3001"
echo "   DB: mekanix_staging"
echo "   Repo: $REPO_DIR"
echo ""

# ─── Create temporary build context ───
BUILD_CTX="$(mktemp -d /tmp/mekanix-staging.XXXXXX)"
trap 'rm -rf "$BUILD_CTX"' EXIT

rsync -a --exclude='node_modules' --exclude='.next' --exclude='.git' \
  --exclude='db/*.db' --exclude='*.log' \
  "$REPO_DIR/" "$BUILD_CTX/"

# PostgreSQL migrations
rm -rf "$BUILD_CTX/prisma/migrations"
mkdir -p "$BUILD_CTX/prisma/migrations/20260925000000_init"
cp "$REPO_DIR/prisma/migrations-postgresql/20260925000000_init/migration.sql" \
   "$BUILD_CTX/prisma/migrations/20260925000000_init/"
cp "$REPO_DIR/prisma/migrations-postgresql/migration_lock.toml" \
   "$BUILD_CTX/prisma/migrations/"
sed -i 's/provider = "sqlite"/provider = "postgresql"/' "$BUILD_CTX/prisma/schema.prisma"

cd "$BUILD_CTX"
docker compose -f docker-compose.staging.yml up -d --build

echo "⏳ Waiting for staging to be healthy..."
for i in $(seq 1 90); do
  if curl -s http://localhost:3001/api/health | grep -q '"ok":true'; then
    echo "✅ Staging is healthy!"
    echo ""
    echo "   URL:    http://localhost:3001"
    echo "   Health: http://localhost:3001/api/health"
    echo "   Ready:  http://localhost:3001/api/ready"
    exit 0
  fi
  echo "   Waiting... ($i/90)"
  sleep 2
done
echo "❌ Staging did not become healthy"
docker compose -f docker-compose.staging.yml logs
exit 1
