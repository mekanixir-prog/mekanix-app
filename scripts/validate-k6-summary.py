#!/usr/bin/env python3
"""Validate k6 measured values and normalize exported threshold metadata.

k6's summary exporter can emit stale/inconsistent threshold booleans even when
its measured values pass. The measured values remain authoritative: this script
recomputes the three release-gate flags, writes the normalized artifact, and
then independently enforces the numeric gates.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


THRESHOLD_RULES = (
    ("http_req_failed", "value", "rate<0.01", 0.01),
    ("http_req_duration", "p(95)", "p(95)<500", 500.0),
    ("response_time_ms", "p(99)", "p(99)<1000", 1000.0),
)


def fail(message: str) -> None:
    print(f"k6 summary validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def number(metrics: dict[str, Any], metric_name: str, field: str) -> float:
    metric = metrics.get(metric_name)
    if not isinstance(metric, dict):
        fail(f"required metric {metric_name!r} is missing")
    value = metric.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail(f"{metric_name}.{field} is missing or not a finite number")
    return float(value)


def normalize_threshold_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    """Rebuild only the configured threshold booleans from measured values.

    For Rate metrics such as http_req_failed, k6's passes/fails counters count
    truthy/falsey samples; they are not threshold-pass/threshold-fail counts.
    Preserve those counters and all unrelated summary metadata unchanged.
    """
    metrics = payload.get("metrics")
    if not isinstance(metrics, dict):
        fail("top-level metrics object is missing")

    for metric_name, field, expression, limit in THRESHOLD_RULES:
        measured = number(metrics, metric_name, field)
        metric = metrics[metric_name]
        thresholds = metric.get("thresholds", {})
        if not isinstance(thresholds, dict):
            fail(f"{metric_name}.thresholds is not an object")
        thresholds[expression] = measured < limit
        metric["thresholds"] = thresholds

    return payload


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: python3 scripts/validate-k6-summary.py <summary.json>")
    path = Path(sys.argv[1])
    if not path.is_file() or path.stat().st_size == 0:
        fail(f"summary file is missing or empty: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"cannot parse JSON: {exc}")

    normalize_threshold_metadata(payload)
    metrics = payload["metrics"]

    request_count = number(metrics, "http_reqs", "count")
    failed_rate = number(metrics, "http_req_failed", "value")
    http_p95_ms = number(metrics, "http_req_duration", "p(95)")
    response_p99_ms = number(metrics, "response_time_ms", "p(99)")
    check_passes = number(metrics, "checks", "passes")
    check_fails = number(metrics, "checks", "fails")

    # Persist normalized metadata even when a numeric gate below fails, so the
    # uploaded artifact always reports threshold flags consistent with values.
    try:
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError as exc:
        fail(f"cannot write normalized summary: {exc}")

    if request_count <= 0:
        fail("no HTTP requests were measured")
    if failed_rate >= 0.01:
        fail(f"HTTP failure rate {failed_rate:.4%} is not below 1%")
    if http_p95_ms >= 500:
        fail(f"HTTP p95 {http_p95_ms:.2f} ms is not below 500 ms")
    if response_p99_ms >= 1000:
        fail(f"response p99 {response_p99_ms:.2f} ms is not below 1000 ms")
    if check_passes <= 0 or check_fails != 0:
        fail(f"checks are not clean: {check_passes:.0f} passed, {check_fails:.0f} failed")

    print("k6 summary artifact validated; threshold metadata normalized")
    print(f"HTTP requests: {request_count:.0f}")
    print(f"HTTP failure rate: {failed_rate:.4%}")
    print(f"HTTP p95: {http_p95_ms:.2f} ms (gate < 500 ms)")
    print(f"response p99: {response_p99_ms:.2f} ms (gate < 1000 ms)")
    print(f"checks: {check_passes:.0f} passed / {check_fails:.0f} failed")


if __name__ == "__main__":
    main()
