// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  writeAuditLog: vi.fn(),
  getAdminFromRequest: vi.fn(),
  hasValidAdminCookieCsrf: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    platformSetting: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
      create: mocks.create,
    },
  })),
}));
vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdminFromRequest,
  hasValidAdminCookieCsrf: mocks.hasValidAdminCookieCsrf,
}));
vi.mock("@/lib/admin-api", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

import { PUT } from "@/app/api/admin-panel/pricing/route";
import { DEFAULT_PRICING_RATE_CARD, PRICING_RATE_CARD_KEY } from "@/lib/pricing-rate-card";

const session = { adminId: "admin-1", username: "admin", role: "SUPER_ADMIN" };
const originalValue = JSON.stringify({ current: DEFAULT_PRICING_RATE_CARD, history: [] });
const concurrentValue = JSON.stringify({
  current: { ...DEFAULT_PRICING_RATE_CARD, version: 2, updatedBy: "admin-2" },
  history: [DEFAULT_PRICING_RATE_CARD],
});

describe("admin pricing rate-card compare-and-set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminFromRequest.mockResolvedValue(session);
    mocks.hasValidAdminCookieCsrf.mockReturnValue(true);
    mocks.writeAuditLog.mockResolvedValue(undefined);
    mocks.findUnique
      .mockResolvedValueOnce({ value: originalValue })
      .mockResolvedValueOnce({ value: concurrentValue });
    mocks.updateMany.mockResolvedValue({ count: 0 });
  });

  it("uses the original row as the CAS predicate and rejects a concurrent update", async () => {
    const request = new Request("http://localhost/api/admin-panel/pricing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rateCard: DEFAULT_PRICING_RATE_CARD,
        expectedVersion: 1,
      }),
    });

    const response = await PUT(request);

    expect(response.status).toBe(409);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: PRICING_RATE_CARD_KEY, value: originalValue },
    }));
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
