#!/bin/bash
# MEKANIX — Cloudflare Worker Build Script
#
# Builds the Cloudflare Worker version of MEKANIX, completely separated from
# the normal Node.js/Docker build.
#
# What this script does:
#   1. Backs up prisma/schema.prisma + next.config.ts + src/lib/db.ts
#   2. Temporarily adds engineType="client" to schema (required for Workers)
#   3. Swaps next.config.ts → next.config.worker.ts (no standalone + serverExternalPackages)
#   4. Swaps src/lib/db.ts → src/lib/db.worker.ts (adapter-compatible for build)
#   5. Generates Prisma Client with engineType="client"
#   6. Applies PR #1356 patch to OpenNext (preview-props.json fix for Next.js 16.4)
#   7. Runs OpenNext build
#   8. Restores original files (guaranteed via trap, even on failure)
#   9. Regenerates Prisma Client with original schema
#
# Usage: bash scripts/build-cloudflare.sh
#
# Safety: Even if build fails, original files are restored via trap.

set -euo pipefail

SCHEMA="prisma/schema.prisma"
SCHEMA_BACKUP="prisma/schema.prisma.bak"
NEXT_CONFIG="next.config.ts"
NEXT_CONFIG_BACKUP="next.config.ts.bak"
NEXT_CONFIG_WORKER="next.config.worker.ts"
DB_FILE="src/lib/db.ts"
DB_BACKUP="src/lib/db.ts.bak"
DB_WORKER="src/lib/db.worker.ts"
LOAD_MANIFEST="node_modules/@opennextjs/cloudflare/dist/cli/build/patches/plugins/load-manifest.js"

# ─── Cleanup function (called on exit, even on error) ───
cleanup() {
  local exit_code=$?
  echo ""
  echo "── Cleanup ──"
  # Restore schema if backup exists
  if [ -f "$SCHEMA_BACKUP" ]; then
    mv "$SCHEMA_BACKUP" "$SCHEMA"
    echo "  ✅ Schema restored from backup"
  fi
  # Restore next.config.ts if backup exists
  if [ -f "$NEXT_CONFIG_BACKUP" ]; then
    mv "$NEXT_CONFIG_BACKUP" "$NEXT_CONFIG"
    echo "  ✅ next.config.ts restored from backup"
  fi
  # Restore db.ts if backup exists
  if [ -f "$DB_BACKUP" ]; then
    mv "$DB_BACKUP" "$DB_FILE"
    echo "  ✅ src/lib/db.ts restored from backup"
  fi
  # Re-generate Prisma Client with original schema
  if [ -f "$SCHEMA" ]; then
    DATABASE_URL="${DATABASE_URL:-file:./db/custom.db}" bunx prisma generate 2>/dev/null || true
    echo "  ✅ Prisma Client regenerated with original schema"
  fi
  echo ""
  if [ $exit_code -eq 0 ]; then
    echo "═══ Build complete! ═══"
    echo ""
    echo "Output: .open-next/worker.js"
    echo "Preview: bunx wrangler dev --local"
  else
    echo "═══ Build FAILED (exit $exit_code) — original files restored ═══"
  fi
  exit $exit_code
}

# Register cleanup to run on exit (normal or error)
trap cleanup EXIT

echo "═══ MEKANIX — Cloudflare Worker Build ═══"
echo ""

# 1. Backup original files
echo "── 1. Backup original files ──"
cp "$SCHEMA" "$SCHEMA_BACKUP"
echo "  ✅ Schema backed up"
cp "$NEXT_CONFIG" "$NEXT_CONFIG_BACKUP"
echo "  ✅ next.config.ts backed up"
cp "$DB_FILE" "$DB_BACKUP"
echo "  ✅ src/lib/db.ts backed up"
echo ""

# 2. Add engineType="client" to schema.prisma
echo "── 2. Add engineType = \"client\" to schema ──"
if grep -q "engineType" "$SCHEMA"; then
  echo "  ⚠️  engineType already present, skipping"
else
  sed -i '/binaryTargets/a\  engineType    = "client"   // Added by build-cloudflare.sh (required for Workers)' "$SCHEMA"
  echo "  ✅ Added engineType = \"client\""
fi
echo ""

# 3. Swap next.config.ts → next.config.worker.ts
echo "── 3. Swap next.config.ts → next.config.worker.ts ──"
if [ ! -f "$NEXT_CONFIG_WORKER" ]; then
  echo "  ❌ $NEXT_CONFIG_WORKER not found!"
  exit 1
fi
cp "$NEXT_CONFIG_WORKER" "$NEXT_CONFIG"
echo "  ✅ next.config.ts replaced with worker config"
echo ""

# 4. Swap src/lib/db.ts → src/lib/db.worker.ts
echo "── 4. Swap src/lib/db.ts → src/lib/db.worker.ts ──"
if [ ! -f "$DB_WORKER" ]; then
  echo "  ❌ $DB_WORKER not found!"
  exit 1
fi
cp "$DB_WORKER" "$DB_FILE"
echo "  ✅ src/lib/db.ts replaced with worker version"
echo ""

# 5. Generate Prisma Client with engineType="client"
echo "── 5. Generate Prisma Client ──"
DATABASE_URL="${DATABASE_URL:-file:./db/custom.db}" bunx prisma generate
echo "  ✅ Prisma Client generated"
echo ""

# 6. Apply PR #1356 patch to OpenNext (if not already applied)
echo "── 6. Apply PR #1356 patch to OpenNext ──"
if grep -q "preview-props" "$LOAD_MANIFEST" 2>/dev/null; then
  echo "  ⚠️  Patch already applied, skipping"
else
  sed -i 's/{\*-manifest,required-server-files,prefetch-hints}.json/{*-manifest,required-server-files,prefetch-hints,preview-props}.json/g' "$LOAD_MANIFEST"
  echo "  ✅ Patch applied (preview-props.json glob)"
fi
echo ""

# 7. Run OpenNext build
echo "── 7. OpenNext build ──"
bunx opennextjs-cloudflare build
echo "  ✅ OpenNext build complete"
echo ""

# 8 + 9 are handled by cleanup() via trap
echo "── 8. Restore original files ──"
echo "  (handled by cleanup trap)"
echo ""
