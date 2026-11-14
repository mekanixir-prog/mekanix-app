#!/bin/bash
# MEKANIX — Production Deployment Script
#
# Builds and deploys MEKANIX via Docker Compose with PostgreSQL 16 + Redis 7.
# Does NOT mutate the developer's working tree — all PostgreSQL migration
# swapping happens inside a temporary build context.
#
# Usage:
#   cp .env.example .env && chmod 600 .env   # replace every placeholder first
#   bash scripts/deploy.sh
#
# Required env vars:
#   DB_PASSWORD       — PostgreSQL password
#   REDIS_PASSWORD    — Redis password
#   JWT_SECRET        — user-session JWT signing secret (>=32 bytes)
#   ADMIN_JWT_SECRET  — dedicated admin JWT signing secret (>=32 bytes)
#   OTP_HASH_SECRET   — OTP verifier HMAC secret (>=32 bytes)
#   ADMIN_BOOTSTRAP_PASSWORD — optional if a valid admin is already provisioned

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# Load an optional protected production .env file. Exported shell variables
# take precedence because the file is sourced before the caller's exports
# only when those values are absent.
if [ -f "$REPO_DIR/.env" ]; then
  ENV_PERMS="$(stat -c '%a' "$REPO_DIR/.env")"
  if [ $((8#$ENV_PERMS & 077)) -ne 0 ]; then
    echo "❌ .env must not be group/world readable; use chmod 600"
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  source "$REPO_DIR/.env"
  set +a
fi

echo "🚀 MEKANIX Production Deployment"
echo "   Repo: $REPO_DIR"
echo ""

# ─── Validate required env vars ───
MISSING=0
for VAR_NAME in DB_PASSWORD REDIS_PASSWORD JWT_SECRET ADMIN_JWT_SECRET OTP_HASH_SECRET; do
  case "$VAR_NAME" in
    DB_PASSWORD) VALUE="${DB_PASSWORD:-}" ;;
    REDIS_PASSWORD) VALUE="${REDIS_PASSWORD:-}" ;;
    JWT_SECRET) VALUE="${JWT_SECRET:-}" ;;
    ADMIN_JWT_SECRET) VALUE="${ADMIN_JWT_SECRET:-}" ;;
    OTP_HASH_SECRET) VALUE="${OTP_HASH_SECRET:-}" ;;
  esac
  if [ -z "$VALUE" ]; then
    echo "❌ $VAR_NAME not set"
    MISSING=1
  fi
done
if [ -n "${DB_PASSWORD:-}" ] && [ "${#DB_PASSWORD}" -lt 16 ]; then
  echo "❌ DB_PASSWORD must contain at least 16 bytes"
  MISSING=1
fi
if [ -n "${REDIS_PASSWORD:-}" ] && [ "${#REDIS_PASSWORD}" -lt 16 ]; then
  echo "❌ REDIS_PASSWORD must contain at least 16 bytes"
  MISSING=1
fi
if [ -n "${JWT_SECRET:-}" ] && [ "${#JWT_SECRET}" -lt 32 ]; then
  echo "❌ JWT_SECRET must contain at least 32 bytes"
  MISSING=1
fi
if [ -n "${ADMIN_JWT_SECRET:-}" ] && [ "${#ADMIN_JWT_SECRET}" -lt 32 ]; then
  echo "❌ ADMIN_JWT_SECRET must contain at least 32 bytes"
  MISSING=1
fi
if [ -n "${OTP_HASH_SECRET:-}" ] && [ "${#OTP_HASH_SECRET}" -lt 32 ]; then
  echo "❌ OTP_HASH_SECRET must contain at least 32 bytes"
  MISSING=1
fi
if [ "$MISSING" = "1" ]; then
  echo ""
  echo "Set the required environment variables before deploying."
  echo "If no ADMIN_BOOTSTRAP_PASSWORD is provided, a valid admin must already exist."
  exit 1
fi

# ─── Create temporary build context with PostgreSQL config ───
BUILD_CTX="$(mktemp -d /tmp/mekanix-build.XXXXXX)"
trap 'rm -rf "$BUILD_CTX"' EXIT

echo "📦 Preparing build context (PostgreSQL migrations)..."
rsync -a --exclude='node_modules' --exclude='.next' --exclude='.git' \
  --exclude='db/*.db' --exclude='*.log' \
  "$REPO_DIR/" "$BUILD_CTX/"

# Replace SQLite migrations with ALL PostgreSQL migrations (init + additive)
rm -rf "$BUILD_CTX/prisma/migrations"
cp -r "$REPO_DIR/prisma/migrations-postgresql" "$BUILD_CTX/prisma/migrations"

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
echo "⏳ Waiting for app health..."
HEALTH_URL="http://localhost:3000/api/health"
for i in $(seq 1 60); do
  HEALTH_JSON="$(curl -s "$HEALTH_URL" 2>/dev/null || echo '{}')"
  if echo "$HEALTH_JSON" | grep -q '"ok":true'; then
    echo "✅ App health checks passed."
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

# Health is not release readiness. Production deployment succeeds only when
# every owner/provider/financial/worker gate in /api/ready is green.
echo "⏳ Waiting for production readiness gates..."
READY_URL="http://localhost:3000/api/ready"
READY_JSON="{}"
for i in $(seq 1 60); do
  READY_JSON="$(curl -s "$READY_URL" 2>/dev/null || echo '{}')"
  if echo "$READY_JSON" | grep -q '"ok":true'; then
    echo "✅ Production readiness gates passed."
    break
  fi
  if [ "$i" = "60" ]; then
    echo "❌ App is healthy but NOT production-ready. Release is blocked."
    echo "$READY_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print('\\n'.join(d.get('errors', [])))" 2>/dev/null || echo "$READY_JSON"
    echo "   Check logs: docker compose logs"
    exit 1
  fi
  echo "   Readiness gates pending... ($i/60)"
  sleep 2
done

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ Deployment complete!                                ║"
echo "║                                                          ║"
echo "║  App:    http://localhost:3000                           ║"
echo "║  Health: http://localhost:3000/api/health               ║"
echo "║  DB:     internal Docker network (PostgreSQL 16)       ║"
echo "║  Redis:  internal Docker network (Redis 7)             ║"
echo "║  Public access: configured HTTPS reverse proxy only   ║"
echo "║                                                          ║"
echo "║  Logs:   docker compose logs -f                         ║"
echo "║  Stop:   docker compose down                            ║"
echo "╚══════════════════════════════════════════════════════════╝"
