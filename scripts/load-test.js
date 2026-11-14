// MEKANIX — k6 staging performance smoke test
//
// Usage:
//   k6 run scripts/load-test.js --vus 50 --duration 3m --env BASE_URL=http://127.0.0.1:3001
//
// Staging intentionally uses console SMS and the payment simulator. OTP 503 is
// therefore a successful fail-closed outcome, not a test failure. No real SMS
// or payment is sent by this script.

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const otpAcceptedCount = new Counter("otp_accepted_count");
const otpFailClosedCount = new Counter("otp_fail_closed_count");
const responseTime = new Trend("response_time_ms");

// Health/readiness/OTP have intentional staging 503 responses. Other 4xx/5xx
// statuses remain failures and are caught by the global failure threshold.
http.setResponseCallback(http.expectedStatuses(200, 429, 503));

const fullLoadStages = [
  { duration: "30s", target: 10 },
  { duration: "1m", target: 10 },
  { duration: "30s", target: 50 },
  { duration: "1m", target: 50 },
  { duration: "30s", target: 100 },
  { duration: "1m", target: 100 },
  { duration: "30s", target: 0 },
];

const smokeStages = [
  { duration: "10s", target: 5 },
  { duration: "20s", target: 5 },
  { duration: "10s", target: 0 },
];

export const options = {
  // Include p(99) in summary-export JSON so the artifact can be validated offline.
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  stages: __ENV.K6_SMOKE === "true" ? smokeStages : fullLoadStages,
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
    response_time_ms: ["p(99)<1000"],
  },
};

export default function loadTest() {
  const homeRes = http.get(`${BASE_URL}/`);
  check(homeRes, { "home returns 200": (r) => r.status === 200 });
  responseTime.add(homeRes.timings.duration);
  sleep(0.5);

  const healthRes = http.get(`${BASE_URL}/api/health`);
  check(healthRes, {
    "health is reachable": (r) => r.status === 200 && r.json("ok") === true,
  });
  responseTime.add(healthRes.timings.duration);
  sleep(0.25);

  const readyRes = http.get(`${BASE_URL}/api/ready`);
  check(readyRes, {
    "readiness reports its gate state": (r) =>
      (r.status === 200 || r.status === 503) && typeof r.json("ok") === "boolean",
  });
  responseTime.add(readyRes.timings.duration);
  sleep(0.25);

  const otpRes = http.post(
    `${BASE_URL}/api/auth/otp/send`,
    JSON.stringify({ phone: `+98912${Math.floor(1000000 + Math.random() * 8999999)}` }),
    { headers: { "Content-Type": "application/json" } }
  );
  const otpAccepted = check(otpRes, {
    "OTP is delivered only by a configured provider or rate-limited": (r) =>
      r.status === 200 || r.status === 429 || r.status === 503,
    "OTP never returns a plaintext code": (r) => {
      try {
        const body = r.json();
        if (r.status === 503) return body.ok !== true && !("code" in body);
        return !("code" in body);
      } catch {
        return false;
      }
    },
  });
  if (otpRes.status === 200) otpAcceptedCount.add(1);
  if (otpRes.status === 503) otpFailClosedCount.add(1);
  responseTime.add(otpRes.timings.duration);
  if (!otpAccepted) console.error(`Unexpected OTP response status: ${otpRes.status}`);
  sleep(0.5);
}
