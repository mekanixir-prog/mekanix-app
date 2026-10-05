#!/bin/bash
# MEKANIX — Production Deployment Script
#
# Builds and deploys MEKANIX via Docker Compose with PostgreSQL 16 + Redis 7.
# Does NOT mutate the developer's working tree — all PostgreSQL migration
# swapping happens inside a temporary build context.
#
# Usage:
#   bash scripts/deploy.sh
#
# Required env vars:
#   DB_PASSWORD     — PostgreSQL password
#   JWT_SECRET      — JWT signing secret

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

echo "🚀 MEKANIX Production Deployment"
echo "   Repo: $REPO_DIR"
echo ""

# ─── Validate required env vars ───
MISSING=0
if [ -z "${DB_PASSWORD:-}" ]; then
  echo "❌ DB_PASSWORD not set"
  MISSING=1
fi
if [ -z "${JWT_SECRET:-}" ]; then
  echo "❌ JWT_SECRET not set"
  MISSING=1
  echo "❌ JWT_SECRET not set"
  MISSING=1
fi
if [ "$MISSING" = "1" ]; then
  echo ""
  echo "Set required env vars:"
  echo "  export DB_PASSWORD=your_secure_password"
  echo "  export JWT_SECRET=your_secure_secret"
  exit 1
fi

# ─── Create temporary build context with PostgreSQL config ───
BUILD_CTX="$(mktemp -d /tmp/mekanix-build.XXXXXX)"
trap 'rm -rf "$BUILD_CTX"' EXIT

echo "📦 Preparing build context (PostgreSQL migrations)..."
rsync -a --exclude='node_modules' --exclude='.next' --exclude='.git' \
  --exclude='db/*.db' --exclude='*.log' \
  "$REPO_DIR/" "$BUILD_CTX/"

# Replace SQLite migrations with PostgreSQL migrations
rm -rf "$BUILD_CTX/prisma/migrations"
mkdir -p "$BUILD_CTX/prisma/migrations/20260925000000_init"
cp "$REPO_DIR/prisma/migrations-postgresql/20260925000000_init/migration.sql" \
   "$BUILD_CTX/prisma/migrations/20260925000000_init/"
cp "$REPO_DIR/prisma/migrations-postgresql/migration_lock.toml" \
   "$BUILD_CTX/prisma/migrations/"

# Switch schema.prisma to PostgreSQL (in build context only)
sed -i 's/provider = "sqlite"/provider = "postgresql"/' \
  "$BUILD_CTX/prisma/schema.prisma"

echo "   ✅ Build context ready (PostgreSQL provider + migrations)"
echo "   ✅ Developer working tree: UNCHANGED"
echo ""

# ─── Build and deploy ───
echo "🏗️  Building and deploying with docker compose..."
cd "$BUILD_CTX"
docker compose up -d --build

# ─── Wait for health ───
echo "⏳ Waiting for app to be healthy..."
HEALTH_URL="http://localhost:3000/api/health"
for i in $(seq 1 60); do
  HEALTH_JSON="$(curl -s "$HEALTH_URL" 2>/dev/null || echo '{}')"
  if echo "$HEALTH_JSON" | grep -q '"ok":true'; then
    echo "✅ App is healthy!"
    echo ""
    echo "$HEALTH_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'  Database: {d[\"services\"][\"database\"]}')
print(f'  Redis: {d[\"services\"][\"redis\"]}')
" 2>/dev/null || true
    break
  fi
  if [ "$i" = "60" ]; then
    echo "❌ App did not become healthy within 120s"
    echo "   Check logs: docker compose logs"
    exit 1
  fi
  echo "   Waiting... ($i/60)"
  sleep 2
done

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ Deployment complete!                                ║"
echo "║                                                          ║"
echo "║  App:    http://localhost:3000                           ║"
echo "║  Health: http://localhost:3000/api/health               ║"
echo "║  DB:     localhost:5432 (PostgreSQL 16)                ║"
echo "║  Redis:  localhost:6379 (Redis 7)                      ║"
echo "║                                                          ║"
echo "║  Logs:   docker compose logs -f                         ║"
echo "║  Stop:   docker compose down                            ║"
echo "╚══════════════════════════════════════════════════════════╝"
