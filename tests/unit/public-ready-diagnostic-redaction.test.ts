// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  rateLimitCount: vi.fn(),
  adminCount: vi.fn(),
  smsStatus: vi.fn(),
  paymentStatus: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    $queryRaw: mocks.queryRaw,
    rateLimit: { count: mocks.rateLimitCount },
    adminUser: { count: mocks.adminCount },
  })),
}));
vi.mock("@/lib/sms-provider", () => ({
  getSmsProviderStatus: mocks.smsStatus,
}));
vi.mock("@/lib/payment-provider", () => ({
  getPaymentProviderStatus: mocks.paymentStatus,
}));

import { GET } from "@/app/api/ready/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mocks.rateLimitCount.mockResolvedValue(1);
  mocks.adminCount.mockResolvedValue(0);
  mocks.smsStatus.mockReturnValue({
    configured: false,
    provider: "kavenegar",
    liveReady: false,
    warnings: ["KAVENEGAR_API_KEY is not configured"],
  });
  mocks.paymentStatus.mockReturnValue({
    configured: false,
    provider: "zarinpal",
    integrationWired: false,
    liveReady: false,
    warnings: ["ZARINPAL_MERCHANT_ID is not configured"],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/ready production diagnostic boundary", () => {
  it("returns a generic public error instead of internal production gate details", async () => {
    const response = await GET();
    expect(response.status).toBe(503);
    const payload = await response.json();

    expect(payload.ok).toBe(false);
    expect(payload.errors).toEqual(["One or more readiness checks failed"]);
    expect(JSON.stringify(payload)).not.toContain("JWT_SECRET");
    expect(JSON.stringify(payload)).not.toContain("OTP_HASH_SECRET");
    expect(JSON.stringify(payload)).not.toContain("KAVENEGAR_API_KEY");
    expect(JSON.stringify(payload)).not.toContain("ZARINPAL_MERCHANT_ID");
    expect(JSON.stringify(payload)).not.toContain("ADMIN_BOOTSTRAP_PASSWORD");
    expect(JSON.stringify(payload)).not.toContain("DATABASE_URL");
  });

  it("preserves the database readiness signal for monitoring", async () => {
    const response = await GET();
    const payload = await response.json();
    expect(payload.checks.database).toBe(true);
  });
});
