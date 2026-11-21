import { test, expect } from "@playwright/test";

/**
 * MEKANIX — Public API health E2E tests
 *
 * Verifies the four operational endpoints that the load balancer, the
 * uptime monitor, and the onboarding splash all rely on:
 *   GET /api/health          → 200 with { ok: true, services, ... }
 *   GET /api/ready           → 200 (ready) or 503 (not ready)
 *   GET /api/care/packages    → 200 with JSON array
 *   GET /api/exchange-rate   → 200 with JSON object containing `rate`
 *
 * These tests don't require authentication or seeded data — they exercise
 * the same code path that production monitoring hits every 60 seconds.
 */

test.describe("API — health & operational endpoints", () => {
  test("GET /api/health returns 200 with ok:true", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.services).toBeDefined();
    expect(typeof body.uptime).toBe("number");
    expect(body.timestamp).toBeTruthy();
  });

  test("GET /api/ready returns 200 or 503", async ({ request }) => {
    const res = await request.get("/api/ready");
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty("checks");
    expect(body).toHaveProperty("errors");
    expect(Array.isArray(body.errors)).toBe(true);
  });

  test("GET /api/care/packages returns 200 with an array body", async ({ request }) => {
    const res = await request.get("/api/care/packages");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/exchange-rate returns 200 with a numeric rate", async ({ request }) => {
    const res = await request.get("/api/exchange-rate");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.rate).toBe("number");
    expect(body.rate).toBeGreaterThan(0);
    expect(body.source).toBeTruthy();
  });

  test("/api/ready body reports database check boolean", async ({ request }) => {
    const res = await request.get("/api/ready");
    const body = await res.json();
    expect(typeof body.checks.database).toBe("boolean");
  });

  test("/api/health body reports each service status as a string", async ({ request }) => {
    const res = await request.get("/api/health");
    const body = await res.json();
    for (const key of ["database", "redis", "sms", "eta"] as const) {
      expect(typeof body.services[key]).toBe("string");
    }
  });
});
