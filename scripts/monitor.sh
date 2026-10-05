#!/bin/bash
# MEKANIX — Simple Uptime Monitor
#
# Checks /api/health every 60 seconds.
# Alerts on: 503, timeout, or connection error.
#
# Usage:
#   bash scripts/monitor.sh
#   bash scripts/monitor.sh https://mekanix.ir
#   bash scripts/monitor.sh https://mekanix.ir --once
#
# For production, run via cron or systemd timer:
#   */1 * * * * bash /path/to/monitor.sh https://mekanix.ir --once >> /var/log/mekanix-monitor.log 2>&1

set -euo pipefail

# Parse args: positional <url> + optional --once flag
ONCE=0
BASE_URL=""
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=1 ;;
    *) BASE_URL="$arg" ;;
  esac
done
BASE_URL="${BASE_URL:-http://localhost:3000}"
URL="$BASE_URL/api/health"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"  # Slack/Discord webhook for alerts

check_health() {
  local response
  local status

  response=$(curl -s -w "\n%{http_code}" --connect-timeout 5 --max-time 10 "$URL" 2>&1) || {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ CRITICAL: Cannot connect to $URL"
    send_alert "CRITICAL: MEKANIX health check failed — cannot connect to $URL"
    return 1
  }

  status=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [ "$status" = "200" ]; then
    local ok
    ok=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")
    if [ "$ok" = "True" ]; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ HEALTHY: $URL"
      return 0
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️  WARNING: $URL returned 200 but ok=false"
      send_alert "WARNING: MEKANIX health check returned ok=false"
      return 1
    fi
  elif [ "$status" = "503" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ CRITICAL: $URL returned 503 (service unavailable)"
    send_alert "CRITICAL: MEKANIX is not ready (503) — check /api/ready"
    return 1
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ CRITICAL: $URL returned HTTP $status"
    send_alert "CRITICAL: MEKANIX returned HTTP $status"
    return 1
  fi
}

send_alert() {
  local message="$1"
  if [ -n "$ALERT_WEBHOOK" ]; then
    curl -s -X POST -H "Content-Type: application/json" \
      "$ALERT_WEBHOOK" \
      -d "{\"text\":\"🚨 MEKANIX Alert: $message\"}" > /dev/null 2>&1 || true
  fi
}

# Single check mode (for cron)
if [ "$ONCE" = "1" ]; then
  check_health
  exit $?
fi

# Continuous mode
echo "🔍 MEKANIX Monitor — checking $URL every 60s"
echo "   Press Ctrl+C to stop"
echo ""

while true; do
  check_health || true
  sleep 60
done
