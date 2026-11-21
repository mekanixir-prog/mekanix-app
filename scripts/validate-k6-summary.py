#!/usr/bin/env python3
"""Validate k6 machine-readable summary values against MEKANIX performance gates.

The check independently evaluates measured values from summary-export JSON.
It does not trust per-metric threshold flags in the exported object.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


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

    metrics = payload.get("metrics")
    if not isinstance(metrics, dict):
        fail("top-level metrics object is missing")

    request_count = number(metrics, "http_reqs", "count")
    failed_rate = number(metrics, "http_req_failed", "value")
    http_p95_ms = number(metrics, "http_req_duration", "p(95)")
    response_p99_ms = number(metrics, "response_time_ms", "p(99)")
    check_passes = number(metrics, "checks", "passes")
    check_fails = number(metrics, "checks", "fails")

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

    print("k6 summary artifact validated")
    print(f"HTTP requests: {request_count:.0f}")
    print(f"HTTP failure rate: {failed_rate:.4%}")
    print(f"HTTP p95: {http_p95_ms:.2f} ms (gate < 500 ms)")
    print(f"response p99: {response_p99_ms:.2f} ms (gate < 1000 ms)")
    print(f"checks: {check_passes:.0f} passed / {check_fails:.0f} failed")


if __name__ == "__main__":
    main()
