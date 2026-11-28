import importlib.util
import math
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "validate-k6-summary.py"
SPEC = importlib.util.spec_from_file_location("validate_k6_summary", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def sample_payload():
    return {
        "metrics": {
            "http_req_failed": {
                "value": 0.0,
                "passes": 0,
                "fails": 37044,
                "thresholds": {"rate<0.01": False},
            },
            "http_req_duration": {
                "p(95)": 47.18,
                "thresholds": {"p(95)<500": False},
            },
            "response_time_ms": {
                "p(99)": 77.65,
                "thresholds": {"p(99)<1000": False},
            },
            "http_reqs": {"count": 37044},
            "checks": {"passes": 46305, "fails": 0},
        }
    }


class K6ThresholdNormalizationTests(unittest.TestCase):
    def test_passing_measurements_repair_stale_false_flags(self):
        payload = sample_payload()
        MODULE.normalize_threshold_metadata(payload)
        metrics = payload["metrics"]
        self.assertIs(metrics["http_req_failed"]["thresholds"]["rate<0.01"], True)
        self.assertIs(metrics["http_req_duration"]["thresholds"]["p(95)<500"], True)
        self.assertIs(metrics["response_time_ms"]["thresholds"]["p(99)<1000"], True)

    def test_failing_measurements_set_flags_false(self):
        payload = sample_payload()
        payload["metrics"]["http_req_failed"]["value"] = 0.02
        payload["metrics"]["http_req_duration"]["p(95)"] = 500
        payload["metrics"]["response_time_ms"]["p(99)"] = 1000
        MODULE.normalize_threshold_metadata(payload)
        metrics = payload["metrics"]
        self.assertIs(metrics["http_req_failed"]["thresholds"]["rate<0.01"], False)
        self.assertIs(metrics["http_req_duration"]["thresholds"]["p(95)<500"], False)
        self.assertIs(metrics["response_time_ms"]["thresholds"]["p(99)<1000"], False)

    def test_rate_sample_counters_and_unrelated_metadata_are_preserved(self):
        payload = sample_payload()
        payload["metrics"]["http_req_failed"]["custom"] = "preserve"
        MODULE.normalize_threshold_metadata(payload)
        rate = payload["metrics"]["http_req_failed"]
        self.assertEqual((rate["passes"], rate["fails"]), (0, 37044))
        self.assertEqual(rate["custom"], "preserve")

    def test_missing_or_non_finite_measurement_fails_closed(self):
        payload = sample_payload()
        payload["metrics"]["http_req_duration"]["p(95)"] = math.nan
        with self.assertRaises(SystemExit):
            MODULE.normalize_threshold_metadata(payload)

    def test_missing_threshold_object_is_created(self):
        payload = sample_payload()
        del payload["metrics"]["response_time_ms"]["thresholds"]
        MODULE.normalize_threshold_metadata(payload)
        self.assertTrue(payload["metrics"]["response_time_ms"]["thresholds"]["p(99)<1000"])


if __name__ == "__main__":
    unittest.main()
