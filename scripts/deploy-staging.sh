#!/bin/bash
# MEKANIX — Staging Deployment
# Deploys to staging environment (port 3001, separate DB)
#
# Required env vars (NO fallbacks — must be set explicitly):
#   DB_PASSWORD       — PostgreSQL password
#   REDIS_PASSWORD    — Redis password
#   JWT_SECRET        — user-session JWT signing secret (>=32 bytes)
#   ADMIN_JWT_SECRET  — dedicated admin JWT signing secret (>=32 bytes)
#   OTP_HASH_SECRET   — OTP verifier HMAC secret (>=32 bytes)
#
# Usage: bash scripts/deploy-staging.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load an optional protected staging-only environment file.
if [ -n "${STAGING_ENV_FILE:-}" ]; then
  if [ ! -f "$STAGING_ENV_FILE" ]; then
    echo "❌ STAGING_ENV_FILE does not exist"
    exit 1
  fi
  ENV_PERMS="$(stat -c '%a' "$STAGING_ENV_FILE")"
  if [ $((8#$ENV_PERMS & 077)) -ne 0 ]; then
    echo "❌ STAGING_ENV_FILE must not be group/world readable; use chmod 600"
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$STAGING_ENV_FILE"
  set +a
fi

# ─── Validate required env vars (NO defaults) ───
: "${DB_PASSWORD:?DB_PASSWORD is required for staging}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD is required for staging}"
: "${JWT_SECRET:?JWT_SECRET is required for staging}"
: "${ADMIN_JWT_SECRET:?ADMIN_JWT_SECRET is required for staging}"
: "${OTP_HASH_SECRET:?OTP_HASH_SECRET is required for staging}"
if [ "${#JWT_SECRET}" -lt 32 ] || [ "${#ADMIN_JWT_SECRET}" -lt 32 ] || [ "${#OTP_HASH_SECRET}" -lt 32 ]; then
  echo "❌ JWT_SECRET, ADMIN_JWT_SECRET and OTP_HASH_SECRET must each contain at least 32 bytes"
  exit 1
fi

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mekanix-staging}"

echo "🚀 MEKANIX Staging Deployment"
echo "   Compose project: $PROJECT_NAME"
echo "   Port: 3001"
echo "   DB: mekanix_staging"
echo "   Repo: $REPO_DIR"
echo ""

# ─── Create temporary build context ───
BUILD_CTX="$(mktemp -d /tmp/mekanix-staging.XXXXXX)"
trap 'rm -rf "$BUILD_CTX"' EXIT

rsync -a --exclude='node_modules' --exclude='.next' --exclude='.git' \
  --exclude='.env' --exclude='.env.*' --exclude='backups/' --exclude='zap-reports/' \
  --exclude='.wrangler/' --exclude='.open-next/' --exclude='coverage/' \
  --exclude='db/*.db' --exclude='*.log' \
  "$REPO_DIR/" "$BUILD_CTX/"

# PostgreSQL migrations — copy ALL (init + additive)
rm -rf "$BUILD_CTX/prisma/migrations"
cp -r "$REPO_DIR/prisma/migrations-postgresql" "$BUILD_CTX/prisma/migrations"
sed -i 's/provider = "sqlite"/provider = "postgresql"/' "$BUILD_CTX/prisma/schema.prisma"

cd "$BUILD_CTX"
docker compose -p "$PROJECT_NAME" -f docker-compose.staging.yml up -d --build

echo "⏳ Waiting for staging to be healthy..."
for i in $(seq 1 90); do
  if curl -s http://localhost:3001/api/health | grep -q '"ok":true'; then
    echo "✅ Staging health checks passed."
    READY_JSON="$(curl -s http://localhost:3001/api/ready 2>/dev/null || echo '{}')"
    if echo "$READY_JSON" | grep -q '"ok":true'; then
      echo "✅ Staging also satisfies production readiness gates."
    else
      echo "ℹ️  Staging is healthy but intentionally not production-ready while non-live providers/owner approvals are configured."
      echo "$READY_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print('\\n'.join(d.get('errors', [])))" 2>/dev/null || true
    fi
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
docker compose -p "$PROJECT_NAME" -f docker-compose.staging.yml logs
exit 1
