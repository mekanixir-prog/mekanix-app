#!/bin/bash
# MEKANIX — Security Audit Script
# Automated checks for common security issues.
#
# Usage:  bash scripts/security-audit.sh
# Exit:   0 = all checks passed; 1 = issues found
#
# Each check is non-fatal (set -e is OFF) — the script runs all checks
# and reports a summary at the end. This makes it useful both as a
# pre-commit hook and as a CI gate.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "🔐 MEKANIX Security Audit"
echo "========================"
echo "Repo: $REPO_DIR"
echo "Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

ISSUES=0
WARNINGS=0

# ─── 1. Secrets in tracked files ───
echo "1. Checking for secrets in tracked files..."
if git rev-parse --git-dir > /dev/null 2>&1; then
  SECRETS=$(git ls-files 2>/dev/null \
    | xargs grep -lE "(ghp_|sk_live_|sk_test_|AKIA|api_key|secret|password)\s*[:=]\s*['\"][a-zA-Z0-9]{20,}" 2>/dev/null \
    | grep -vE "\.env\.example|node_modules|\.next" \
    | head -10)
  if [ -n "$SECRETS" ]; then
    echo "❌ Potential secrets found in tracked files:"
    echo "$SECRETS"
    ISSUES=$((ISSUES + 1))
  else
    echo "✅ No secrets found in tracked files"
  fi
else
  echo "⚠️  Not a git repository — skipping secret scan"
  WARNINGS=$((WARNINGS + 1))
fi
echo ""

# ─── 2. .env is not tracked ───
echo "2. Checking .env is not tracked..."
if git rev-parse --git-dir > /dev/null 2>&1; then
  if git ls-files --error-unmatch .env 2>/dev/null; then
    echo "❌ .env is tracked by git!"
    ISSUES=$((ISSUES + 1))
  else
    echo "✅ .env is not tracked"
  fi
else
  echo "⚠️  Not a git repository — skipping"
  WARNINGS=$((WARNINGS + 1))
fi
echo ""

# ─── 3. Debug endpoints in production code ───
echo "3. Checking for debug endpoints..."
DEBUG_CHECKS=$(grep -rnE "debugger[[:space:]]*;|/api/debug|ENABLE_DEBUG_ENDPOINT|DEBUG_ROUTE" src/app/api/ 2>/dev/null | head -5 || true)
if [ -n "$DEBUG_CHECKS" ]; then
  echo "❌ Debug endpoint or debugger statement found:"
  echo "$DEBUG_CHECKS"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ No debug endpoints or debugger statements found"
fi
echo ""

# ─── 4. console.log with sensitive data ───
echo "4. Checking for console.log with sensitive data..."
SENSITIVE_LOGS=$(grep -rniE "console\.log.*(password|token|secret|api[_-]?key|otp|verification[_-]?code|jwt|bearer)" src/ 2>/dev/null | head -5 || true)
if [ -n "$SENSITIVE_LOGS" ]; then
  echo "❌ console.log with sensitive data found:"
  echo "$SENSITIVE_LOGS"
  ISSUES=$((ISSUES + 1))
else
  echo "✅ No sensitive console.log statements"
fi
echo ""

# ─── 5. Cookie security ───
echo "5. Checking cookie security..."
COOKIE_SECURE=$(grep -rn "secure:" src/app/api/ src/lib/auth.ts 2>/dev/null | head -3 || true)
if [ -n "$COOKIE_SECURE" ]; then
  echo "✅ Cookie secure flag found:"
  echo "$COOKIE_SECURE"
else
  echo "⚠️  No cookie secure flag found — verify cookies are secure in production"
  WARNINGS=$((WARNINGS + 1))
fi
echo ""

# ─── 6. Zod input validation coverage ───
echo "6. Checking Zod validation usage..."
ZOD_COUNT=$(grep -rn "validateBody\|z\.object\|safeParse" src/app/api/ src/lib/schemas/ 2>/dev/null | wc -l)
echo "   Zod validation calls: $ZOD_COUNT"
if [ "$ZOD_COUNT" -lt 5 ]; then
  echo "⚠️  Low Zod coverage — more API routes should use validation"
  WARNINGS=$((WARNINGS + 1))
else
  echo "✅ Zod validation in use"
fi
echo ""

# ─── 7. BOLA (Broken Object Level Authorization) protection ───
echo "7. Checking BOLA protection..."
BOLA_COUNT=$(grep -rn "requireBookingParticipant\|requireAssignedTechnician\|requireBookingOwner\|requireVehicleOwner\|requireJobParticipant\|requireSession" src/app/api/ src/lib/ 2>/dev/null | wc -l)
echo "   BOLA checks: $BOLA_COUNT"
if [ "$BOLA_COUNT" -lt 3 ]; then
  echo "❌ Insufficient BOLA protection — add owner checks to all owned-resource routes"
  ISSUES=$((ISSUES + 1))
else
  echo "✅ BOLA protection in place"
fi
echo ""

# ─── 8. Rate limiting ───
echo "8. Checking rate limiting..."
RATE_COUNT=$(grep -rn "rateLimit\|rateLimitAsync" src/app/api/ 2>/dev/null | wc -l)
echo "   Rate limit calls: $RATE_COUNT"
if [ "$RATE_COUNT" -lt 3 ]; then
  echo "❌ Insufficient rate limiting — add to auth + payment + write routes"
  ISSUES=$((ISSUES + 1))
else
  echo "✅ Rate limiting in place"
fi
echo ""

# ─── 9. SQL injection (raw queries audit) ───
echo "9. Checking for raw SQL queries..."
RAW_COUNT=$(grep -rn '\$queryRaw\|\$executeRaw' src/app/api/ src/lib/ 2>/dev/null | wc -l)
PARAM_COUNT=$(grep -rn '\$queryRaw`' src/app/api/ src/lib/ 2>/dev/null | wc -l)
UNSAFE_COUNT=$(grep -rnE '\$queryRaw\w*\(\s*["\x27`]' src/app/api/ src/lib/ 2>/dev/null | wc -l)
echo "   Raw queries: $RAW_COUNT (parameterized tagged templates: $PARAM_COUNT, unsafe string-form: $UNSAFE_COUNT)"
if [ "$UNSAFE_COUNT" -gt 0 ]; then
  echo "❌ Unsafe raw queries detected — use tagged template literals: db.\$queryRaw\`SELECT * FROM User WHERE id = \${userId}\`"
  ISSUES=$((ISSUES + 1))
else
  echo "✅ All raw queries use tagged templates (parameterized)"
fi
echo ""

# ─── 10. Dependency vulnerabilities ───
echo "10. Checking dependencies..."
if command -v bun &> /dev/null; then
  BUN_AUDIT=$(bun audit 2>&1 || true)
  if echo "$BUN_AUDIT" | grep -qi "vulnerabilit"; then
    echo "⚠️  Dependency vulnerabilities found:"
    echo "$BUN_AUDIT" | tail -15
    if echo "$BUN_AUDIT" | grep -Eqi '^[[:space:]]*(critical|high):'; then
      echo "❌ Critical/high dependency advisories block production readiness"
      ERRORS=$((ERRORS + 1))
    else
      echo "⚠️  No critical/high advisories detected; moderate/low findings require documented risk acceptance"
      WARNINGS=$((WARNINGS + 1))
    fi
  else
    echo "✅ No known dependency vulnerabilities"
  fi
else
  echo "❌ bun not available; dependency audit cannot be completed"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# ─── 11. Required env vars documented in .env.example ───
echo "11. Checking .env.example covers required vars..."
REQUIRED_VARS=(DATABASE_URL JWT_SECRET)
for var in "${REQUIRED_VARS[@]}"; do
  if grep -q "^$var\|^# $var" .env.example 2>/dev/null; then
    echo "   ✅ $var documented in .env.example"
  else
    echo "   ❌ $var NOT in .env.example"
    ISSUES=$((ISSUES + 1))
  fi
done
echo ""

# ─── 12. TypeScript errors ───
echo "12. Checking TypeScript compilation..."
if command -v bunx &> /dev/null; then
  if TSC_OUTPUT=$(bunx tsc --noEmit 2>&1); then
    echo "✅ TypeScript compiles cleanly"
  else
    echo "❌ TypeScript errors:"
    echo "$TSC_OUTPUT" | head -10
    ISSUES=$((ISSUES + 1))
  fi
else
  echo "⚠️  bunx not available, skipping tsc check"
  WARNINGS=$((WARNINGS + 1))
fi
echo ""

# ─── Summary ───
echo "========================"
echo "Audit complete."
echo "  ❌ Issues:    $ISSUES"
echo "  ⚠️  Warnings:  $WARNINGS"
echo ""

if [ "$ISSUES" -gt 0 ]; then
  echo "❌ Security issues need attention — fix before production deploy"
  exit 1
else
  echo "✅ All critical checks passed"
  if [ "$WARNINGS" -gt 0 ]; then
    echo "   ($WARNINGS warning(s) — review above)"
  fi
  exit 0
fi
