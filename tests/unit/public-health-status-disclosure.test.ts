// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  smsStatus: vi.fn(),
  paymentStatus: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({ $queryRaw: mocks.queryRaw })),
}));
vi.mock("@/lib/sms-provider", () => ({
  getSmsProviderStatus: mocks.smsStatus,
}));
vi.mock("@/lib/payment-provider", () => ({
  getPaymentProviderStatus: mocks.paymentStatus,
}));

import { GET } from "@/app/api/health/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mocks.smsStatus.mockReturnValue({
    configured: true,
    provider: "kavenegar",
    liveReady: true,
    warnings: [],
  });
  mocks.paymentStatus.mockReturnValue({
    configured: true,
    provider: "zarinpal",
    integrationWired: false,
    liveReady: false,
    warnings: ["ZARINPAL_MERCHANT_ID is not configured"],
  });
});

describe("GET /api/health public information boundary", () => {
  it("returns coarse service states without provider or credential diagnostics", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.services).toMatchObject({
      database: "healthy",
      sms: "ready",
      payment: "not-ready",
    });
    expect(payload.services).not.toHaveProperty("smsConfigured");
    expect(payload.services).not.toHaveProperty("smsLiveReady");
    expect(payload.services.payment).not.toContain("zarinpal");
    expect(JSON.stringify(payload)).not.toContain("kavenegar");
    expect(JSON.stringify(payload)).not.toContain("ZARINPAL_MERCHANT_ID");
    expect(JSON.stringify(payload)).not.toContain("integrationWired");
    expect(JSON.stringify(payload)).not.toContain("warnings");
  });

  it("continues to report database outages with HTTP 503", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("private database diagnostic"));
    const response = await GET();
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.services.database).toBe("unhealthy");
    expect(JSON.stringify(payload)).not.toContain("private database diagnostic");
  });
});
