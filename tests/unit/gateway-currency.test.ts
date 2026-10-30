// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  requireAuth: vi.fn(),
  getRate: vi.fn(),
  createLog: vi.fn(),
}));
vi.mock("@/lib/db-access", () => ({ getDbForLib: mocks.getDb }));
vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/exchange-rate", () => ({ getUsdToIrrRate: mocks.getRate }));

import { POST } from "@/app/api/gateway/initiate/route";

function request(body: unknown) {
  return new Request("https://mekanix.test/api/gateway/initiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  mocks.requireAuth.mockResolvedValue({ userId: "customer-1", role: "CUSTOMER" });
  mocks.getRate.mockResolvedValue({
    rate: 6_000_000,
    baseRate: 6_000_000,
    multiplier: 1,
    source: "test",
    fetchedAt: 1,
  });
  mocks.createLog.mockImplementation(async ({ data }: any) => ({ id: "log-1", ...data }));
  mocks.getDb.mockResolvedValue({
    paymentGatewayLog: { create: mocks.createLog },
  });
});

describe("gateway currency conversion", () => {
  it("stores the locked USD order amount and converted IRR gateway amount separately", async () => {
    const response = await POST(request({
      amount: 9,
      purpose: "vip",
      cardNumber: "1234 5678 9012 3456",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      amount: 9,
      amountIrr: 54_000_000,
      exchangeRate: 6_000_000,
    });
    expect(mocks.createLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "customer-1",
        amount: 54_000_000,
        currency: "IRR",
        baseAmountUsd: 9,
        exchangeRate: 6_000_000,
        purpose: "vip",
        cardNumber: "**** **** **** 3456",
      }),
    });
  });

  it("rejects non-finite, zero, negative and unreasonable USD amounts before creating a log", async () => {
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 100_001]) {
      const response = await POST(request({ amount }));
      expect(response.status).toBe(400);
    }
    expect(mocks.createLog).not.toHaveBeenCalled();
  });

  it("does not expose the simulator in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(request({ amount: 9 }));
    expect(response.status).toBe(404);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.createLog).not.toHaveBeenCalled();
  });
});
