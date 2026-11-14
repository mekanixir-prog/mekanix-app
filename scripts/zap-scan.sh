#!/bin/bash
# MEKANIX — OWASP ZAP Baseline Security Scan
#
# Usage: bash scripts/zap-scan.sh <target-url>
# High-risk findings and missing/invalid reports fail the scan. Medium findings
# are reported for mandatory review. Run only against owned staging systems.

set -euo pipefail

TARGET_URL="${1:?Usage: bash scripts/zap-scan.sh <target-url>}"
REPORT_DIR="${REPORT_DIR:-./zap-reports}"
mkdir -p "$REPORT_DIR"
REPORT_DIR="$(cd "$REPORT_DIR" && pwd)"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$REPORT_DIR"

JSON_REPORT="$REPORT_DIR/zap-report-$TIMESTAMP.json"
HTML_REPORT="$REPORT_DIR/zap-report-$TIMESTAMP.html"
XML_REPORT="$REPORT_DIR/zap-report-$TIMESTAMP.xml"

echo "🔐 MEKANIX — OWASP ZAP Baseline Scan"
echo "   Target: $TARGET_URL"
echo "   Reports: $REPORT_DIR/zap-report-$TIMESTAMP.*"

ZAP_EXIT=0
DOCKER_ARGS=(run -t --rm)
if [ "${ZAP_DOCKER_NETWORK:-bridge}" = "host" ]; then
  DOCKER_ARGS+=(--network host)
else
  DOCKER_ARGS+=(--add-host=host.docker.internal:host-gateway)
fi
DOCKER_ARGS+=(-v "$REPORT_DIR:/zap/wrk" ghcr.io/zaproxy/zaproxy:stable)

# The official ZAP image runs as an unprivileged user. GitHub-host bind mounts
# are owned by the runner UID, so grant temporary write access only to this
# dedicated, artifact-only directory. Always restore restrictive permissions.
chmod 0777 "$REPORT_DIR"
restore_report_permissions() {
  chmod 0750 "$REPORT_DIR" 2>/dev/null || true
  find "$REPORT_DIR" -maxdepth 1 -type f -exec chmod 0640 {} + 2>/dev/null || true
}
trap restore_report_permissions EXIT

# Generate the default policy outside the mounted report directory. ZAP runs
# as an unprivileged user and cannot create /zap/wrk/gen.conf on CI bind mounts.
docker "${DOCKER_ARGS[@]}" \
  zap-baseline.py \
  -t "$TARGET_URL" \
  -g /tmp/zap-gen.conf \
  -r "zap-report-$TIMESTAMP.html" \
  -J "zap-report-$TIMESTAMP.json" \
  -x "zap-report-$TIMESTAMP.xml" || ZAP_EXIT=$?

restore_report_permissions
trap - EXIT

if [ ! -s "$JSON_REPORT" ]; then
  echo "❌ ZAP did not produce a valid JSON report (exit $ZAP_EXIT)"
  exit 2
fi

if python3 - "$JSON_REPORT" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    sites = data.get("site") or []
    alerts = [alert for site in sites for alert in site.get("alerts", [])]
except Exception as exc:
    print(f"❌ Cannot parse ZAP report: {exc}")
    sys.exit(2)

high = [a for a in alerts if str(a.get("riskcode", "0")) == "3"]
medium = [a for a in alerts if str(a.get("riskcode", "0")) == "2"]
low = [a for a in alerts if str(a.get("riskcode", "0")) == "1"]
info = [a for a in alerts if str(a.get("riskcode", "0")) == "0"]

print(f"High: {len(high)}")
print(f"Medium: {len(medium)}")
print(f"Low: {len(low)}")
print(f"Informational: {len(info)}")

if high:
    print("\n❌ HIGH severity findings — release blocker:")
    for alert in high:
        print(f"  - {alert.get('alert', 'Unknown')}: {str(alert.get('desc', ''))[:160]}")
    sys.exit(1)

if medium:
    print("\n⚠️ MEDIUM severity findings — security owner review required:")
    for alert in medium:
        print(f"  - {alert.get('alert', 'Unknown')}: {str(alert.get('desc', ''))[:160]}")
else:
    print("\n✅ No High/Medium findings")
PY
then
  :
else
  PARSE_EXIT=$?
  exit "$PARSE_EXIT"
fi

# ZAP baseline exit 1 means warnings; 2/3 indicate a failed/invalid scan.
if [ "$ZAP_EXIT" -ge 2 ]; then
  echo "❌ ZAP scan execution failed (exit $ZAP_EXIT)"
  exit "$ZAP_EXIT"
fi
if [ "$ZAP_EXIT" -eq 1 ]; then
  echo "⚠️ ZAP reported warnings; review the JSON/HTML reports before release"
fi

if [ ! -s "$HTML_REPORT" ]; then
  echo "❌ ZAP HTML report is missing"
  exit 2
fi
if [ ! -s "$XML_REPORT" ]; then
  echo "❌ ZAP XML report is missing"
  exit 2
fi

echo "✅ ZAP baseline scan completed; inspect medium-risk findings before release"
echo "HTML: $HTML_REPORT"
echo "JSON: $JSON_REPORT"
echo "XML:  $XML_REPORT"
