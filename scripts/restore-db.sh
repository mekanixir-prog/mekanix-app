#!/bin/bash
# MEKANIX — Safe Database Restore
#
# Restores only into an EMPTY PostgreSQL database or atomically replaces a
# SQLite file. For PostgreSQL production recovery, use a separately reviewed
# break-glass runbook; this script deliberately refuses to overwrite tables.
#
# Usage:
#   RESTORE_CONFIRM=RESTORE DATABASE_URL=... bash scripts/restore-db.sh backup.sql.gz[.gpg]
#   Encrypted backups require BACKUP_PASSPHRASE_FILE.

set -euo pipefail
umask 077

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_DIR/scripts/lib/pg-service.sh"
BACKUP_FILE="${1:?Usage: bash scripts/restore-db.sh <backup-file>}"
DB_URL="${DATABASE_URL:-file:$REPO_DIR/db/custom.db}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"
DECRYPTED_TMP=""
RAW_TMP=""
SQLITE_TMP=""

cleanup() {
  [ -z "$DECRYPTED_TMP" ] || rm -f "$DECRYPTED_TMP"
  [ -z "$RAW_TMP" ] || rm -f "$RAW_TMP"
  [ -z "$SQLITE_TMP" ] || rm -f "$SQLITE_TMP"
}
trap cleanup EXIT

if [ ! -f "$BACKUP_FILE" ] || [ ! -s "$BACKUP_FILE" ]; then
  echo "❌ Backup file not found or empty"
  exit 1
fi

if [ "${RESTORE_CONFIRM:-}" != "RESTORE" ]; then
  echo "⚠️  Restore target type: ${DB_URL%%:*} (connection details hidden)"
  echo "This operation changes the target database. Type RESTORE to continue:"
  read -r CONFIRM
  if [ "$CONFIRM" != "RESTORE" ]; then
    echo "Aborted."
    exit 0
  fi
fi

ARCHIVE="$BACKUP_FILE"
if [[ "$BACKUP_FILE" == *.gpg ]]; then
  if [ -z "$PASSPHRASE_FILE" ] || [ ! -f "$PASSPHRASE_FILE" ] || [ ! -s "$PASSPHRASE_FILE" ]; then
    echo "❌ Encrypted backup requires BACKUP_PASSPHRASE_FILE"
    exit 1
  fi
  if ! command -v gpg >/dev/null 2>&1; then
    echo "❌ gpg is required to decrypt this backup"
    exit 1
  fi
  DECRYPTED_TMP="$(mktemp)"
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
    --decrypt --output "$DECRYPTED_TMP" "$BACKUP_FILE"
  ARCHIVE="$DECRYPTED_TMP"
fi

if ! gzip -t "$ARCHIVE"; then
  echo "❌ Backup archive failed gzip integrity validation"
  exit 1
fi
RAW_TMP="$(mktemp)"
gzip -dc "$ARCHIVE" > "$RAW_TMP"

case "$DB_URL" in
  postgresql://*|postgres://*)
    echo "📦 Restoring PostgreSQL backup into an empty database..."
    if ! command -v psql >/dev/null 2>&1; then
      echo "❌ psql not installed — install postgresql-client"
      exit 1
    fi
    TARGET_OBJECT_COUNT="$(pg_exec "$DB_URL" psql -v ON_ERROR_STOP=1 -Atqc \
      "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','i','I')) + (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public') AND nspname !~ '^pg_')")"
    if [ "$TARGET_OBJECT_COUNT" != "0" ]; then
      echo "❌ PostgreSQL target is not empty; refusing to overwrite existing tables"
      exit 1
    fi
    # pg_dump qualifies application objects with public but does not recreate
    # PostgreSQL's default schema. Recreate it after the empty-target guard.
    pg_exec "$DB_URL" psql -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public"
    pg_exec "$DB_URL" psql -v ON_ERROR_STOP=1 < "$RAW_TMP"
    USER_TABLE="$(pg_exec "$DB_URL" psql -v ON_ERROR_STOP=1 -Atqc \
      "SELECT CASE WHEN to_regclass('public.\"User\"') IS NULL THEN 0 ELSE 1 END")"
    if [ "$USER_TABLE" != "1" ]; then
      echo "❌ Restore completed but the expected User table is missing"
      exit 1
    fi
    ;;
  file:*)
    echo "📦 Restoring SQLite backup..."
    SQLITE_PATH="${DB_URL#file:}"
    mkdir -p "$(dirname "$SQLITE_PATH")"
    SQLITE_TMP="$(mktemp "${SQLITE_PATH}.restore.XXXXXX")"
    if head -c 128 "$RAW_TMP" | grep -aqE '^(PRAGMA|BEGIN TRANSACTION|CREATE TABLE|-- SQLite)' ; then
      if ! command -v sqlite3 >/dev/null 2>&1; then
        echo "❌ sqlite3 is required to restore a SQL dump"
        exit 1
      fi
      sqlite3 "$SQLITE_TMP" < "$RAW_TMP"
    else
      cp "$RAW_TMP" "$SQLITE_TMP"
    fi
    if ! command -v sqlite3 >/dev/null 2>&1; then
      echo "❌ sqlite3 is required to validate a SQLite restore"
      exit 1
    fi
    INTEGRITY="$(sqlite3 "$SQLITE_TMP" 'PRAGMA integrity_check;')"
    if [ "$INTEGRITY" != "ok" ]; then
      echo "❌ SQLite integrity check failed"
      exit 1
    fi
    mv -f "$SQLITE_TMP" "$SQLITE_PATH"
    SQLITE_TMP=""
    ;;
  *)
    echo "❌ Unsupported DATABASE_URL scheme; expected PostgreSQL or file: SQLite"
    exit 1
    ;;
esac

echo "✅ Restore completed and target validation passed"
