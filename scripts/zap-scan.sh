#!/bin/bash
# MEKANIX — OWASP ZAP Baseline Security Scan
# Runs a baseline ZAP scan against the staging/production URL.
#
# Prerequisites:
#   - Docker installed
#   - Target URL must be running
#
# Usage:
#   bash scripts/zap-scan.sh http://localhost:3000
#   bash scripts/zap-scan.sh https://staging.mekanix.ir

set -euo pipefail

TARGET_URL="${1:?Usage: bash scripts/zap-scan.sh <target-url>}"
REPORT_DIR="${REPORT_DIR:-./zap-reports}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$REPORT_DIR"

echo "🔐 MEKANIX — OWASP ZAP Baseline Scan"
echo "   Target: $TARGET_URL"
echo "   Report: $REPORT_DIR/zap-report-$TIMESTAMP"
echo ""

# Run ZAP baseline scan via Docker
docker run -t --rm \
  -v "$REPORT_DIR:/zap/wrk" \
  owasp/zap2docker-stable \
  zap-baseline.py \
  -t "$TARGET_URL" \
  -g gen.conf \
  -r "zap-report-$TIMESTAMP.html" \
  -J "zap-report-$TIMESTAMP.json" \
  -x "zap-report-$TIMESTAMP.xml" \
  || true  # ZAP exits with non-zero on findings

echo ""
echo "=== Scan Results ==="
python3 -c "
import json, sys
try:
    with open('$REPORT_DIR/zap-report-$TIMESTAMP.json') as f:
        data = json.load(f)
    alerts = data.get('site', [{}])[0].get('alerts', [])
    high = [a for a in alerts if a.get('riskcode') == '3']
    medium = [a for a in alerts if a.get('riskcode') == '2']
    low = [a for a in alerts if a.get('riskcode') == '1']
    info = [a for a in alerts if a.get('riskcode') == '0']
    print(f'High: {len(high)}')
    print(f'Medium: {len(medium)}')
    print(f'Low: {len(low)}')
    print(f'Informational: {len(info)}')
    if high:
        print()
        print('❌ HIGH severity findings (BLOCKER for release):')
        for a in high:
            print(f'  - {a.get(\"alert\")}: {a.get(\"desc\", \"\")[:100]}')
    elif medium:
        print()
        print('⚠️  MEDIUM severity findings (review before release):')
        for a in medium:
            print(f'  - {a.get(\"alert\")}: {a.get(\"desc\", \"\")[:100]}')
    else:
        print()
        print('✅ No High/Medium findings')
except Exception as e:
    print(f'Report parsing: {e}')
"

echo ""
echo "Full report: $REPORT_DIR/zap-report-$TIMESTAMP.html"
