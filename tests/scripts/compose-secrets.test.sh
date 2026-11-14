#!/usr/bin/env bash
set -euo pipefail

export DB_PASSWORD="test-postgres-password"
export REDIS_PASSWORD="test-redis-password"
export JWT_SECRET="mekanix-test-user-jwt-secret-at-least-32-bytes"
export ADMIN_JWT_SECRET="mekanix-test-admin-jwt-secret-at-least-32-bytes"
export OTP_HASH_SECRET="mekanix-test-otp-hash-secret-at-least-32-bytes"

REQUIRED_VARS=(DB_PASSWORD REDIS_PASSWORD JWT_SECRET ADMIN_JWT_SECRET OTP_HASH_SECRET)
COMPOSE_FILES=(docker-compose.yml docker-compose.staging.yml)

for compose_file in "${COMPOSE_FILES[@]}"; do
  test -s "$compose_file"
  for variable in "${REQUIRED_VARS[@]}"; do
    if env -u "$variable" docker compose -f "$compose_file" config --quiet >/tmp/mekanix-compose-missing.out 2>&1; then
      echo "❌ $compose_file accepted missing required variable $variable"
      exit 1
    fi
    if ! grep -q "$variable is required" /tmp/mekanix-compose-missing.out; then
      echo "❌ $compose_file failed for an unexpected reason when $variable was unset"
      cat /tmp/mekanix-compose-missing.out
      exit 1
    fi
  done
  docker compose -f "$compose_file" config --quiet
  echo "✅ $compose_file fails closed for every required secret and validates when all are present"
done

if env -u DB_PASSWORD -u REDIS_PASSWORD -u JWT_SECRET -u ADMIN_JWT_SECRET -u OTP_HASH_SECRET \
  bash scripts/deploy.sh >/tmp/mekanix-deploy-missing.out 2>&1; then
  echo "❌ Production deploy script accepted missing secrets"
  exit 1
fi

if env -u DB_PASSWORD -u REDIS_PASSWORD -u JWT_SECRET -u ADMIN_JWT_SECRET -u OTP_HASH_SECRET \
  bash scripts/deploy-staging.sh >/tmp/mekanix-staging-missing.out 2>&1; then
  echo "❌ Staging deploy script accepted missing secrets"
  exit 1
fi

echo "✅ Production and staging deployment scripts fail closed when required secrets are absent"
