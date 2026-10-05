// MEKANIX — k6 Load Test Script
// Tests the MEKANIX platform under load.
//
// Usage:
//   k6 run scripts/load-test.js --vus 50 --duration 60s
//
// Or install k6: https://k6.io/docs/getting-started/installation/

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

// Configuration
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

// Custom metrics
const otpSendCount = new Counter("otp_send_count");
const otpVerifyCount = new Counter("otp_verify_count");
const responseTime = new Trend("response_time_ms");

// Test options
export const options = {
  stages: [
    { duration: "30s", target: 10 },   // ramp up to 10 VUs
    { duration: "1m", target: 10 },     // stay at 10 for 1 min
    { duration: "30s", target: 50 },    // ramp up to 50
    { duration: "2m", target: 50 },     // stay at 50 for 2 min
    { duration: "30s", target: 100 },   // ramp up to 100
    { duration: "1m", target: 100 },    // stay at 100 for 1 min
    { duration: "30s", target: 0 },     // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],   // 95% of requests < 500ms
    http_req_failed: ["rate<0.01"],     // < 1% failure rate
    response_time_ms: ["p(99)<1000"],   // 99th percentile < 1s
  },
};

// Test scenario
export default function loadTest() {
  // 1. Test home page
  const homeRes = http.get(`${BASE_URL}/`);
  check(homeRes, { "home 200": (r) => r.status === 200 });
  responseTime.add(homeRes.timings.duration);
  sleep(1);

  // 2. Test health endpoint
  const healthRes = http.get(`${BASE_URL}/api/health`);
  check(healthRes, { "health 200": (r) => r.status === 200 });
  responseTime.add(healthRes.timings.duration);
  sleep(0.5);

  // 3. Test ready endpoint
  const readyRes = http.get(`${BASE_URL}/api/ready`);
  check(readyRes, { "ready 200/503": (r) => r.status === 200 || r.status === 503 });
  responseTime.add(readyRes.timings.duration);
  sleep(0.5);

  // 4. Test OTP send (rate-limited)
  const otpRes = http.post(
    `${BASE_URL}/api/auth/otp/send`,
    JSON.stringify({ phone: `+98912${Math.floor(1000000 + Math.random() * 8999999)}` }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(otpRes, {
    "otp send 200/429": (r) => r.status === 200 || r.status === 429,
  });
  if (otpRes.status === 200) otpSendCount.add(1);
  responseTime.add(otpRes.timings.duration);
  sleep(2);

  // 5. Test exchange rate (public API)
  const rateRes = http.get(`${BASE_URL}/api/exchange-rate`);
  check(rateRes, { "rate 200": (r) => r.status === 200 });
  responseTime.add(rateRes.timings.duration);
  sleep(1);
}
