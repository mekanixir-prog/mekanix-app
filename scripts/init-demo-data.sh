#!/bin/bash
# MEKANIX — Initialize demo database
# Run this once after cloning to populate the SQLite DB with demo users,
# technicians, vehicles, and jobs so the app works in guest mode.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "📦 Pushing schema to DB..."
DATABASE_URL="file:$(pwd)/db/custom.db" bunx prisma db push --accept-data-loss
echo "🌱 Seeding demo data..."
DATABASE_URL="file:$(pwd)/db/custom.db" bunx tsx prisma/seed.ts
echo "✅ Done! Demo users, technicians, vehicles, and jobs created."
