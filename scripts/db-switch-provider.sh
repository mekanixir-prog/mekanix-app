#!/bin/bash
# MEKANIX — Database Provider Switch
# Usage: bash scripts/db-switch-provider.sh sqlite|postgresql

set -e
REPO_DIR="/home/z/my-project"
SCHEMA="$REPO_DIR/prisma/schema.prisma"

if [ "$1" = "" ]; then
  echo "Current provider:"
  grep "provider = " "$SCHEMA" | head -1
  echo "Usage: bash scripts/db-switch-provider.sh <sqlite|postgresql>"
  exit 0
fi

TARGET="$1"

if [ "$TARGET" = "sqlite" ]; then
  echo "🔄 Switching to SQLite (dev mode)..."
  sed -i 's/provider = "postgresql"/provider = "sqlite"/' "$SCHEMA"
  echo "✅ Schema provider set to sqlite"
  echo "Using migrations from: prisma/migrations/"
  
elif [ "$TARGET" = "postgresql" ]; then
  echo "🔄 Switching to PostgreSQL (production mode)..."
  sed -i 's/provider = "sqlite"/provider = "postgresql"/' "$SCHEMA"
  echo "✅ Schema provider set to postgresql"
  echo ""
  echo "To apply PostgreSQL migrations:"
  echo "  rm -rf prisma/migrations"
  echo "  mkdir -p prisma/migrations/20260925000000_init"
  echo "  cp prisma/migrations-postgresql/20260925000000_init/migration.sql prisma/migrations/20260925000000_init/"
  echo "  cp prisma/migrations-postgresql/migration_lock.toml prisma/migrations/"
  echo "  export DATABASE_URL=postgresql://user:pass@host:5432/mekanix"
  echo "  bunx prisma migrate deploy"

else
  echo "❌ Unknown provider: $TARGET"
  exit 1
fi
