#!/bin/bash
# MEKANIX — isolated PostgreSQL backup/restore rehearsal
#
# This script intentionally refuses a production source. Use only CI test data
# or an isolated staging database. Staging data export requires an extra opt-in.
#
# Required:
#   SOURCE_ENV=test|staging
#   DATABASE_URL=<source PostgreSQL URL>
#   TEST_DB_URL=<separate disposable restore-test database URL>
#   ALLOW_TEST_DB_RESET=YES
#   ALLOW_STAGING_DATA_EXPORT=YES (staging only)

set -euo pipefail
umask 077

SOURCE_ENV="${SOURCE_ENV:-}"
SOURCE_URL="${DATABASE_URL:?DATABASE_URL is required}"
TEST_URL="${TEST_DB_URL:?TEST_DB_URL is required}"
BACKUP_FILE="$(mktemp /tmp/mekanix-backup-test.XXXXXX.sql.gz)"
KEEP_BACKUP=0

cleanup() {
  if [ "$KEEP_BACKUP" = "0" ]; then
    rm -f "$BACKUP_FILE"
  else
    echo "⚠️  Failed rehearsal archive retained at: $BACKUP_FILE"
  fi
}
trap cleanup EXIT

if [[ "$SOURCE_ENV" != "test" && "$SOURCE_ENV" != "staging" ]]; then
  echo "❌ SOURCE_ENV must be test or staging; production sources are forbidden"
  exit 1
fi
if [ "$SOURCE_URL" = "$TEST_URL" ]; then
  echo "❌ Source and restore-test database must be different"
  exit 1
fi
if [ "$SOURCE_ENV" = "staging" ] && [ "${ALLOW_STAGING_DATA_EXPORT:-}" != "YES" ]; then
  echo "❌ Staging data export requires ALLOW_STAGING_DATA_EXPORT=YES"
  exit 1
fi
if [ "${ALLOW_TEST_DB_RESET:-}" != "YES" ]; then
  echo "❌ Resetting the disposable restore-test database requires ALLOW_TEST_DB_RESET=YES"
  exit 1
fi
if ! command -v pg_dump >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "❌ pg_dump and psql are required; install postgresql-client"
  exit 1
fi

echo "🧪 MEKANIX — Backup/Restore Rehearsal ($SOURCE_ENV)"
echo "1. Creating compressed PostgreSQL backup (connection details hidden)..."
PGDATABASE="$SOURCE_URL" pg_dump --no-owner --no-acl | gzip -c > "$BACKUP_FILE"
gzip -t "$BACKUP_FILE"
[ -s "$BACKUP_FILE" ] || { echo "❌ Backup is empty"; exit 1; }

table_counts() {
  local url="$1"
  local table
  while IFS= read -r table; do
    [ -n "$table" ] || continue
    local count
    count="$(PGDATABASE="$url" psql -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM public.\"$table\"")"
    printf '%s:%s\n' "$table" "$count"
  done < <(PGDATABASE="$url" psql -v ON_ERROR_STOP=1 -Atqc \
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
}

echo "2. Capturing source table row counts..."
SOURCE_COUNTS="$(table_counts "$SOURCE_URL")"

echo "3. Resetting only the explicitly approved restore-test database..."
PGDATABASE="$TEST_URL" psql -v ON_ERROR_STOP=1 -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

echo "4. Restoring backup into the isolated test database..."
gzip -dc "$BACKUP_FILE" | PGDATABASE="$TEST_URL" psql -v ON_ERROR_STOP=1

echo "5. Comparing row counts for every public table..."
RESTORED_COUNTS="$(table_counts "$TEST_URL")"
if [ "$SOURCE_COUNTS" != "$RESTORED_COUNTS" ]; then
  KEEP_BACKUP=1
  echo "❌ Backup/restore mismatch"
  diff -u <(printf '%s\n' "$SOURCE_COUNTS") <(printf '%s\n' "$RESTORED_COUNTS") || true
  exit 1
fi

echo "6. Comparing index inventories..."
SOURCE_INDEXES="$(PGDATABASE="$SOURCE_URL" psql -v ON_ERROR_STOP=1 -Atqc \
  "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname")"
RESTORED_INDEXES="$(PGDATABASE="$TEST_URL" psql -v ON_ERROR_STOP=1 -Atqc \
  "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname")"
if [ "$SOURCE_INDEXES" != "$RESTORED_INDEXES" ]; then
  KEEP_BACKUP=1
  echo "❌ Restored index inventory does not match source"
  diff -u <(printf '%s\n' "$SOURCE_INDEXES") <(printf '%s\n' "$RESTORED_INDEXES") || true
  exit 1
fi

echo "✅ Backup/restore rehearsal passed: all public-table row counts and index inventories match"
