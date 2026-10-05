#!/bin/bash
# MEKANIX — Backup/Restore Test
#
# Tests that backup + restore actually works:
# 1. Backs up the production DB
# 2. Restores to a temporary test DB
# 3. Verifies record counts match
# 4. Cleans up the test DB
#
# Usage:
#   bash scripts/test-backup-restore.sh
#
# Environment:
#   DATABASE_URL — production PostgreSQL URL
#   TEST_DB_URL  — temporary test PostgreSQL URL (will be dropped)

set -euo pipefail

PROD_URL="${DATABASE_URL:?DATABASE_URL is required}"
TEST_URL="${TEST_DB_URL:?TEST_DB_URL is required for restore test}"
BACKUP_FILE="/tmp/mekanix-backup-test-$(date +%s).sql.gz"

echo "🧪 MEKANIX — Backup/Restore Test"
echo ""

# Step 1: Backup
echo "1️⃣  Backing up production DB..."
pg_dump "$PROD_URL" | gzip > "$BACKUP_FILE"
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "   ✅ Backup created: $BACKUP_SIZE"

if [ ! -s "$BACKUP_FILE" ]; then
  echo "   ❌ Backup is empty!"
  exit 1
fi

# Step 2: Count records in production
echo ""
echo "2️⃣  Counting records in production..."
PROD_USERS=$(psql "$PROD_URL" -t -c "SELECT count(*) FROM \"User\"" 2>/dev/null | xargs)
PROD_VEHICLES=$(psql "$PROD_URL" -t -c "SELECT count(*) FROM \"Vehicle\"" 2>/dev/null | xargs)
echo "   Users: $PROD_USERS"
echo "   Vehicles: $PROD_VEHICLES"

# Step 3: Restore to test DB
echo ""
echo "3️⃣  Restoring to test DB..."
# Drop and recreate the test database
psql "$TEST_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null || true
gunzip -c "$BACKUP_FILE" | psql "$TEST_URL" 2>/dev/null
echo "   ✅ Restore complete"

# Step 4: Verify record counts match
echo ""
echo "4️⃣  Verifying record counts..."
TEST_USERS=$(psql "$TEST_URL" -t -c "SELECT count(*) FROM \"User\"" 2>/dev/null | xargs)
TEST_VEHICLES=$(psql "$TEST_URL" -t -c "SELECT count(*) FROM \"Vehicle\"" 2>/dev/null | xargs)
echo "   Test DB Users: $TEST_USERS (expected: $PROD_USERS)"
echo "   Test DB Vehicles: $TEST_VEHICLES (expected: $PROD_VEHICLES)"

if [ "$PROD_USERS" = "$TEST_USERS" ] && [ "$PROD_VEHICLES" = "$TEST_VEHICLES" ]; then
  echo ""
  echo "✅ Backup/Restore test PASSED — record counts match!"
  # Clean up
  rm -f "$BACKUP_FILE"
  psql "$TEST_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null || true
  exit 0
else
  echo ""
  echo "❌ Backup/Restore test FAILED — record counts don't match!"
  echo "   Keeping backup at: $BACKUP_FILE for investigation"
  exit 1
fi
