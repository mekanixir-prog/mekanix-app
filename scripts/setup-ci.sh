#!/bin/bash
# MEKANIX — CI Setup Script
# 
# This script pushes the GitHub Actions workflow files to GitHub.
# It requires a Personal Access Token with the 'workflow' scope.
#
# Steps:
# 1. Go to: https://github.com/settings/tokens/new
# 2. Set note: "MEKANIX CI"
# 3. Select scopes: repo + workflow (IMPORTANT: both must be checked)
# 4. Generate token and copy it
# 5. Run this script and paste the token when prompted:
#
#    bash scripts/setup-ci.sh

set -e

REPO_DIR="/home/z/my-project"
cd "$REPO_DIR"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  MEKANIX — CI Workflow Setup                            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Check if workflow files exist
if [ ! -f .github/workflows/ci.yml ] || [ ! -f .github/workflows/production-readiness.yml ]; then
  echo "❌ Workflow files not found. They should be in .github/workflows/"
  exit 1
fi

echo "📄 Workflow files found:"
echo "   ✓ .github/workflows/ci.yml"
echo "   ✓ .github/workflows/production-readiness.yml"
echo ""

# Prompt for token
echo "🔑 You need a Personal Access Token with 'workflow' scope."
echo "   Create one at: https://github.com/settings/tokens/new"
echo "   Check: repo + workflow"
echo ""
read -s -p "Paste your GitHub token (with workflow scope): " GH_TOKEN
echo ""
echo ""

if [ -z "$GH_TOKEN" ]; then
  echo "❌ No token provided."
  exit 1
fi

GH_USER="s6beheshti"
REPO="$GH_USER/mekanix"

# Verify token
echo "🔍 Verifying token..."
SCOPES=$(curl -sI -H "Authorization: token $GH_TOKEN" https://api.github.com/user | grep -i "x-oauth-scopes" | tr -d '\r')
echo "   Scopes: $SCOPES"

if echo "$SCOPES" | grep -q "workflow"; then
  echo "   ✅ Token has 'workflow' scope"
else
  echo "   ❌ Token does NOT have 'workflow' scope!"
  echo "   Please create a new token with 'workflow' scope checked."
  exit 1
fi

echo ""
echo "📤 Pushing workflow files to GitHub..."

# Push ci.yml
CI_B64=$(base64 -w 0 .github/workflows/ci.yml)
curl -s -X PUT \
  -H "Authorization: token $GH_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/$REPO/contents/.github/workflows/ci.yml \
  -d "{\"message\":\"ci: add GitHub Actions workflow\",\"content\":\"$CI_B64\",\"branch\":\"main\"}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  ci.yml: {\"✅ pushed\" if \"content\" in d else \"❌ \" + d.get(\"message\",\"error\")}')" 2>&1

# Push production-readiness.yml
PR_B64=$(base64 -w 0 .github/workflows/production-readiness.yml)
curl -s -X PUT \
  -H "Authorization: token $GH_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/$REPO/contents/.github/workflows/production-readiness.yml \
  -d "{\"message\":\"ci: add production readiness workflow\",\"content\":\"$PR_B64\",\"branch\":\"main\"}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  production-readiness.yml: {\"✅ pushed\" if \"content\" in d else \"❌ \" + d.get(\"message\",\"error\")}')" 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅  CI workflows pushed to GitHub!                     ║"
echo "║                                                          ║"
echo "║  GitHub Actions will now run on every push/PR to main.  ║"
echo "║                                                          ║"
echo "║  View runs: https://github.com/$GH_USER/mekanix/actions ║"
echo "╚══════════════════════════════════════════════════════════╝"
