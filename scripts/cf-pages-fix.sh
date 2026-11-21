#!/bin/bash
# MEKANIX — Fix OpenNext output for Cloudflare Pages
# OpenNext outputs worker.js, but Pages expects _worker.js
set -e

if [ -f ".open-next/worker.js" ]; then
  echo "📦 Renaming worker.js → _worker.js for Pages..."
  cp .open-next/worker.js .open-next/_worker.js
  echo "✅ Done"
fi

# Also ensure assets directory is at the right level
if [ -d ".open-next/assets" ]; then
  echo "📦 Copying assets to root..."
  cp -r .open-next/assets/* .open-next/ 2>/dev/null || true
fi
