#!/bin/bash
# MEKANIX — Git History Cleanup (MANUAL USE ONLY)
#
# ⚠️  WARNING: This script SQUASHES all commits into ONE.
#   • All previous commit messages are lost
#   • Code/files are NOT touched (only git history changes)
#   • Run this ONLY when you want to purge sensitive data from history
#
# USAGE (manual):
#   bash scripts/clean-git-history.sh
#
# DO NOT run this automatically on a schedule — it destroys development history.

set -e

REPO_DIR="/home/z/my-project"
cd "$REPO_DIR"

echo "⚠️  This will SQUASH all git history into a single commit."
echo "   Code/files stay intact. Only commit history is affected."
echo ""
read -p "Are you sure? (type YES to continue): " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Aborted."
  exit 0
fi

# ... (rest of the cleanup logic)
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
REMOTE_URL=$(git remote get-url origin 2>/dev/null)

if [ -z "$REMOTE_URL" ]; then
  echo "❌ No remote 'origin' configured."
  exit 1
fi

# Create orphan branch
git checkout --orphan temp-cleanup 2>/dev/null
git add -A
git commit -m "MEKANIX — snapshot $TIMESTAMP

History squashed manually. All previous commits collapsed into one."
git branch -D main 2>/dev/null || true
git branch -m main

echo "📤 Force-pushing to GitHub..."
git push --force origin main 2>/dev/null

git gc --prune=now --aggressive 2>/dev/null || true

echo "✅ Done. History squashed to 1 commit."
echo "📋 Total commits: $(git log --oneline | wc -l)"
