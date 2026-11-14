#!/usr/bin/env bash
# Deterministic contract tests for scripts/zap-scan.sh; no Docker daemon/network required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
volume=""
html=""
json=""
xml=""
while (($#)); do
  case "$1" in
    -v) volume="$2"; shift 2 ;;
    -r) html="$2"; shift 2 ;;
    -J) json="$2"; shift 2 ;;
    -x) xml="$2"; shift 2 ;;
    *) shift ;;
  esac
done
report_dir="${volume%%:/zap/wrk}"
[[ -n "$report_dir" && "$report_dir" != "$volume" ]]
case "${FAKE_ZAP_CASE:-success}" in
  invalid-json)
    printf '{invalid' > "$report_dir/$json"
    ;;
  high-finding)
    printf '{"site":[{"alerts":[{"riskcode":"3","alert":"Test High","desc":"fixture"}]}]}' > "$report_dir/$json"
    ;;
  *)
    printf '{"site":[{"alerts":[]}]}' > "$report_dir/$json"
    ;;
esac
if [[ "${FAKE_ZAP_CASE:-success}" != "missing-html" ]]; then
  printf '<html>fixture</html>' > "$report_dir/$html"
fi
printf '<report>fixture</report>' > "$report_dir/$xml"
exit "${FAKE_ZAP_EXIT:-0}"
FAKE_DOCKER
chmod +x "$TMP/bin/docker"

run_case() {
  local name="$1" expected="$2" fake_case="${3:-success}" fake_exit="${4:-0}"
  local dir="$TMP/$name"
  mkdir -p "$dir"
  set +e
  PATH="$TMP/bin:$PATH" REPORT_DIR="$dir/reports" FAKE_ZAP_CASE="$fake_case" FAKE_ZAP_EXIT="$fake_exit" \
    bash "$ROOT/scripts/zap-scan.sh" http://127.0.0.1:3000 >"$dir/output.log" 2>&1
  local actual=$?
  set -e
  if [[ "$actual" -ne "$expected" ]]; then
    cat "$dir/output.log"
    echo "Expected exit $expected for $name, got $actual" >&2
    exit 1
  fi
  if [[ -d "$dir/reports" ]]; then
    local mode
    mode="$(stat -c '%a' "$dir/reports")"
    [[ "$mode" == "750" ]] || { echo "Unsafe report directory mode after $name: $mode" >&2; exit 1; }
    while IFS= read -r file; do
      mode="$(stat -c '%a' "$file")"
      [[ "$mode" == "640" ]] || { echo "Unsafe report file mode after $name: $mode" >&2; exit 1; }
    done < <(find "$dir/reports" -maxdepth 1 -type f)
  fi
}

run_case success 0 success 0
run_case high-finding 1 high-finding 0
run_case invalid-json 2 invalid-json 0
run_case missing-html 2 missing-html 0
run_case scanner-exit-3 3 success 3

echo "ZAP wrapper contract tests passed"
