#!/bin/bash
# MEKANIX — Database Backup Script (SQLite dev + PostgreSQL staging/prod)
#
# PostgreSQL backups are created with pg_dump; SQLite uses .dump when sqlite3
# is available, otherwise a consistent binary copy. Set BACKUP_PASSPHRASE_FILE
# to encrypt the compressed archive with GPG AES-256.
#
# Usage: DATABASE_URL=... BACKUP_PASSPHRASE_FILE=/secure/path/key bash scripts/backup-db.sh

set -euo pipefail
umask 077

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_DIR/scripts/lib/pg-service.sh"
BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DB_URL="${DATABASE_URL:-file:$REPO_DIR/db/custom.db}"
BACKUP_FILE="$BACKUP_DIR/mekanix_${TIMESTAMP}.sql.gz"
COMPRESSED_TMP=""

cleanup() {
  [ -z "$COMPRESSED_TMP" ] || rm -f "$COMPRESSED_TMP"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
COMPRESSED_TMP="$(mktemp "$BACKUP_DIR/.mekanix-backup.XXXXXX")"

echo "📦 Creating database backup..."
case "$DB_URL" in
  postgresql://*|postgres://*)
    echo "   Type: PostgreSQL (connection details hidden)"
    if ! command -v pg_dump >/dev/null 2>&1; then
      echo "❌ pg_dump not installed — install postgresql-client"
      exit 1
    fi
    # Keep credentials out of process arguments and logs.
    pg_exec "$DB_URL" pg_dump --no-owner --no-acl | gzip -c > "$COMPRESSED_TMP"
    ;;
  file:*)
    echo "   Type: SQLite"
    SQLITE_PATH="${DB_URL#file:}"
    if [ ! -f "$SQLITE_PATH" ]; then
      echo "❌ SQLite file not found"
      exit 1
    fi
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$SQLITE_PATH" .dump | gzip -c > "$COMPRESSED_TMP"
    else
      gzip -c "$SQLITE_PATH" > "$COMPRESSED_TMP"
    fi
    ;;
  *)
    echo "❌ Unsupported DATABASE_URL scheme; expected PostgreSQL or file: SQLite"
    exit 1
    ;;
esac

if [ ! -s "$COMPRESSED_TMP" ]; then
  echo "❌ Backup archive is empty"
  exit 1
fi

PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"
ENCRYPTION_REQUIRED="${BACKUP_ENCRYPTION_REQUIRED:-false}"
if [ "${NODE_ENV:-}" = "production" ]; then
  ENCRYPTION_REQUIRED="true"
fi

if [ -n "$PASSPHRASE_FILE" ]; then
  if [ ! -f "$PASSPHRASE_FILE" ] || [ ! -s "$PASSPHRASE_FILE" ]; then
    echo "❌ BACKUP_PASSPHRASE_FILE must point to a non-empty secret file"
    exit 1
  fi
  if ! command -v gpg >/dev/null 2>&1; then
    echo "❌ gpg is required when backup encryption is enabled"
    exit 1
  fi
  PERMS="$(stat -c '%a' "$PASSPHRASE_FILE")"
  if [ $((8#$PERMS & 077)) -ne 0 ]; then
    echo "❌ Backup passphrase file permissions are too broad; use chmod 600"
    exit 1
  fi
  BACKUP_FILE="$BACKUP_FILE.gpg"
  gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 \
    --passphrase-file "$PASSPHRASE_FILE" --output "$BACKUP_FILE" "$COMPRESSED_TMP"
  echo "   Encryption: GPG AES-256"
elif [ "$ENCRYPTION_REQUIRED" = "true" ]; then
  echo "❌ Encrypted backup required; set BACKUP_PASSPHRASE_FILE"
  exit 1
else
  mv "$COMPRESSED_TMP" "$BACKUP_FILE"
  COMPRESSED_TMP=""
  echo "⚠️  Backup is not encrypted (acceptable only for isolated test data)"
fi

if [ ! -s "$BACKUP_FILE" ]; then
  echo "❌ Backup file is empty"
  exit 1
fi

SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
echo "✅ Backup created: $BACKUP_FILE ($SIZE)"

find "$BACKUP_DIR" -name "mekanix_*.sql.gz*" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "mekanix_db_*.db" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

echo "Recent backups:"
ls -lh "$BACKUP_DIR"/mekanix_*.sql.gz* 2>/dev/null | tail -5 || true
echo "✅ Backup archive verified as non-empty"
