#!/bin/bash
# Explicitly guarded synthetic fixture management for isolated Cloudflare D1 staging.
# This script is destructive only to the reserved fixture IDs in the staging DB.

set -euo pipefail

ACTION="${1:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_DIR/wrangler.wallet-release.toml"
EXPECTED_NAME="mekanix-wallet-escrow-staging"

case "$ACTION" in
  seed) SQL_FILE="$REPO_DIR/scripts/wallet-release-staging-seed.sql" ;;
  cleanup) SQL_FILE="$REPO_DIR/scripts/wallet-release-staging-cleanup.sql" ;;
  *)
    echo "Usage: bash scripts/wallet-release-staging-fixture.sh seed|cleanup"
    exit 2
    ;;
esac

if [ "${ALLOW_WALLET_RELEASE_STAGING_FIXTURE:-}" != "YES" ]; then
  echo "❌ Set ALLOW_WALLET_RELEASE_STAGING_FIXTURE=YES to confirm a staging-only fixture operation"
  exit 1
fi
if [ ! -f "$CONFIG" ] || [ ! -f "$SQL_FILE" ]; then
  echo "❌ Wrangler config or fixture SQL file is missing"
  exit 1
fi

DB_NAME="$(awk -F '"' '/^[[:space:]]*database_name[[:space:]]*=/ { print $2; exit }' "$CONFIG")"
DB_ID="$(awk -F '"' '/^[[:space:]]*database_id[[:space:]]*=/ { print $2; exit }' "$CONFIG")"
if [ "$DB_NAME" != "$EXPECTED_NAME" ]; then
  echo "❌ Refusing fixture operation: configured D1 database name is not the staging database"
  exit 1
fi
if [ -z "$DB_ID" ] || [ "$DB_ID" = "00000000-0000-0000-0000-000000000000" ]; then
  echo "❌ Configure the real isolated staging D1 database ID first"
  exit 1
fi
if [ "${WALLET_RELEASE_STAGING_DATABASE_ID:-}" != "$DB_ID" ]; then
  echo "❌ WALLET_RELEASE_STAGING_DATABASE_ID must exactly match the configured staging database ID"
  exit 1
fi

cd "$REPO_DIR"

echo "Target: $DB_NAME ($DB_ID)"
echo "Action: $ACTION"
echo "Verify the active Cloudflare account with 'bunx wrangler whoami' before continuing."
bunx wrangler d1 execute "$DB_NAME" --remote --config "$CONFIG" --file="$SQL_FILE" --yes
echo "✅ Staging escrow fixture $ACTION completed"
