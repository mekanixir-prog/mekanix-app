#!/usr/bin/env bash
# Guarded production deployment for the scheduled escrow release Worker.
# This script deploys code only. It does not apply D1 migrations or mutate rows.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_DIR/wrangler.wallet-release.production.toml"
EXPECTED_NAME="mekanix"
EXPECTED_WORKER="mekanix-wallet-escrow-release-prod"

if [[ "${ALLOW_WALLET_RELEASE_PRODUCTION_DEPLOY:-}" != "YES" ]]; then
  echo "Refusing production deployment. Set ALLOW_WALLET_RELEASE_PRODUCTION_DEPLOY=YES after reviewing the release."
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "Production Wrangler config is missing: $CONFIG"
  exit 1
fi

if [[ -z "${WALLET_RELEASE_PRODUCTION_DATABASE_ID:-}" ]]; then
  echo "Set WALLET_RELEASE_PRODUCTION_DATABASE_ID to the production D1 ID independently verified in Cloudflare."
  exit 1
fi

if [[ -z "${WALLET_RELEASE_PRODUCTION_ACCOUNT_ID:-}" ]] || \
   ! [[ "$WALLET_RELEASE_PRODUCTION_ACCOUNT_ID" =~ ^[a-fA-F0-9]{32}$ ]]; then
  echo "Set WALLET_RELEASE_PRODUCTION_ACCOUNT_ID to the 32-character Cloudflare account ID verified in the dashboard."
  exit 1
fi

CONFIG_NAME="$(awk -F '"' '/^[[:space:]]*database_name[[:space:]]*=/ { print $2; exit }' "$CONFIG")"
CONFIG_ID="$(awk -F '"' '/^[[:space:]]*database_id[[:space:]]*=/ { print $2; exit }' "$CONFIG")"
WORKER_NAME="$(awk -F '"' '/^[[:space:]]*name[[:space:]]*=/ { print $2; exit }' "$CONFIG")"

APP_CONFIG="$REPO_DIR/wrangler.toml"
APP_CONFIG_ID="$(awk -F '"' '/^[[:space:]]*database_id[[:space:]]*=/ { print $2; exit }' "$APP_CONFIG")"

if [[ -z "$APP_CONFIG_ID" || "$CONFIG_ID" != "$APP_CONFIG_ID" ]]; then
  echo "Refusing deployment: escrow Worker D1 ID does not match the application production D1 binding."
  exit 1
fi

if grep -Eq '^[[:space:]]*(migrations_dir|migrations_pattern)[[:space:]]*=' "$CONFIG"; then
  echo "Refusing deployment: production Worker config must not apply D1 migrations."
  exit 1
fi

if [[ "$CONFIG_NAME" != "$EXPECTED_NAME" || "$WORKER_NAME" != "$EXPECTED_WORKER" ]]; then
  echo "Refusing deployment: unexpected D1 database or Worker name in production config."
  exit 1
fi

if [[ "$CONFIG_ID" != "$WALLET_RELEASE_PRODUCTION_DATABASE_ID" ]]; then
  echo "Refusing deployment: production D1 ID does not match the independently supplied confirmation."
  exit 1
fi

if [[ -z "$CONFIG_ID" || "$CONFIG_ID" == "00000000-0000-0000-0000-000000000000" ]]; then
  echo "Refusing deployment: production D1 ID is empty or a placeholder."
  exit 1
fi

cd "$REPO_DIR"

echo "Checking active Cloudflare account..."
WHOAMI_OUTPUT="$(bunx wrangler whoami 2>&1)" || {
  echo "$WHOAMI_OUTPUT"
  echo "Unable to verify Cloudflare identity; deployment cancelled."
  exit 1
}
echo "$WHOAMI_OUTPUT"

if ! grep -Fq -- "$WALLET_RELEASE_PRODUCTION_ACCOUNT_ID" <<< "$WHOAMI_OUTPUT"; then
  echo "Refusing deployment: active Cloudflare account does not match WALLET_RELEASE_PRODUCTION_ACCOUNT_ID."
  exit 1
fi

echo "Target Worker: $WORKER_NAME"
echo "Target D1: $CONFIG_NAME ($CONFIG_ID)"
echo "No migrations will be applied by this script."
echo "Deploying scheduled Worker..."
bunx wrangler deploy --config "$CONFIG"
