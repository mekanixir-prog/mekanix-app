#!/usr/bin/env bash
# Runs the actual scheduled escrow Worker against Wrangler's isolated local D1.
# Never uses a remote database or production credentials.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/wrangler.wallet-release.toml"
DB_NAME="mekanix-wallet-escrow-staging"
PORT="${WALLET_RELEASE_TEST_PORT:-8791}"
LOG_FILE="$(mktemp)"
WORKER_PID=""

cd "$ROOT"

cleanup() {
  if [ -n "$WORKER_PID" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  bunx wrangler d1 execute "$DB_NAME" --local --config "$CONFIG" \
    --file scripts/wallet-release-staging-cleanup.sql --yes >/dev/null 2>&1 || true
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

echo "Applying complete Prisma SQLite migration history to local D1..."
printf 'y\n' | bunx wrangler d1 migrations apply "$DB_NAME" --local --config "$CONFIG"

assert_sql() {
  local query="$1"
  local label="$2"
  local output
  output="$(bunx wrangler d1 execute "$DB_NAME" --local --config "$CONFIG" --command "$query")"
  echo "$output"
  if ! grep -q "$label" <<< "$output"; then
    echo "❌ D1 assertion failed: $label"
    exit 1
  fi
}

assert_sql "SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name='WalletReleaseWorkerState') THEN 'PASS' ELSE 'FAIL' END AS assertion;" "PASS"
assert_sql "SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name='WalletReleaseGuard') THEN 'PASS' ELSE 'FAIL' END AS assertion;" "PASS"
assert_sql "SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='index' AND name='WalletTransaction_status_holdUntil_id_idx') THEN 'PASS' ELSE 'FAIL' END AS assertion;" "PASS"

echo "Seeding one synthetic, matured escrow transaction..."
bunx wrangler d1 execute "$DB_NAME" --local --config "$CONFIG" \
  --file scripts/wallet-release-staging-seed.sql --yes

echo "Starting the real scheduled Worker against local D1..."
CI=1 bunx wrangler dev --local --test-scheduled --config "$CONFIG" \
  --port "$PORT" --ip 127.0.0.1 --log-level warn >"$LOG_FILE" 2>&1 &
WORKER_PID=$!

READY=0
for _ in $(seq 1 60); do
  if curl --silent --output /dev/null "http://127.0.0.1:$PORT/"; then
    READY=1
    break
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    cat "$LOG_FILE"
    echo "❌ Wrangler local Worker exited before becoming ready"
    exit 1
  fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  cat "$LOG_FILE"
  echo "❌ Wrangler local Worker did not become ready"
  exit 1
fi

trigger_scheduled() {
  local status
  status="$(curl --silent --show-error --output /tmp/wallet-release-scheduled.json \
    --write-out '%{http_code}' --get \
    --data-urlencode 'cron=*/15 * * * *' \
    "http://127.0.0.1:$PORT/__scheduled")"
  cat /tmp/wallet-release-scheduled.json
  test "$status" = "200"
}

echo "Triggering scheduled event..."
trigger_scheduled

assert_sql "SELECT CASE WHEN balance=10000 AND pendingBalance=0 THEN 'PASS' ELSE 'FAIL' END AS assertion FROM Wallet WHERE id='wallet-release-staging-wallet';" "PASS"
assert_sql "SELECT CASE WHEN status='AVAILABLE' THEN 'PASS' ELSE 'FAIL' END AS assertion FROM WalletTransaction WHERE id='wallet-release-staging-txn';" "PASS"
assert_sql "SELECT CASE WHEN COUNT(*)=1 THEN 'PASS' ELSE 'FAIL' END AS assertion FROM WalletLedger WHERE idempotencyKey='wallet-release:wallet-release-staging-txn:LEDGER';" "PASS"
assert_sql "SELECT CASE WHEN COUNT(*)=0 THEN 'PASS' ELSE 'FAIL' END AS assertion FROM WalletReleaseGuard;" "PASS"

echo "Triggering a second scheduled event to prove no duplicate RELEASE row..."
trigger_scheduled
assert_sql "SELECT CASE WHEN balance=10000 AND pendingBalance=0 THEN 'PASS' ELSE 'FAIL' END AS assertion FROM Wallet WHERE id='wallet-release-staging-wallet';" "PASS"
assert_sql "SELECT CASE WHEN COUNT(*)=1 THEN 'PASS' ELSE 'FAIL' END AS assertion FROM WalletLedger WHERE idempotencyKey='wallet-release:wallet-release-staging-txn:LEDGER';" "PASS"
assert_sql "SELECT CASE WHEN COUNT(*)=0 THEN 'PASS' ELSE 'FAIL' END AS assertion FROM WalletReleaseGuard;" "PASS"

echo "✅ Actual scheduled Worker released one escrow transaction in local D1; replay created no duplicate ledger row."
