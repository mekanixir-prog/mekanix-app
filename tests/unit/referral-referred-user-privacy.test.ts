// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  referralFindMany: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({ referral: { findMany: mocks.referralFindMany } })),
}));
vi.mock("@/lib/money/financial-read-mask", () => ({
  isSafeStoredIrrAmount: vi.fn(() => true),
  maskFinancialFields: vi.fn((value) => value),
  sumVerifiedPositiveIrrAmounts: vi.fn(() => 100),
}));

import { GET } from "@/app/api/referral/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: "referrer-1", role: "CUSTOMER" });
  mocks.referralFindMany.mockResolvedValue([{
    id: "referral-1",
    referrerId: "referrer-1",
    referredUserId: "referred-1",
    status: "first_job",
    rewardClaimed: true,
    rewardAmount: 100,
    financialUnitStatus: "VERIFIED_IRR",
    referredUser: {
      id: "referred-1",
      name: "Referred Customer",
      avatar: "avatar.png",
      phone: "+989121234567",
      email: "private@example.test",
      password: "password-hash",
      taxId: "private-tax-id",
    },
  }]);
});

describe("GET /api/referral privacy", () => {
  it("selects and serializes only public referred-user fields", async () => {
    const response = await GET(new Request("https://mekanix.test/api/referral"));
    expect(response.status).toBe(200);
    expect(mocks.referralFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { referrerId: "referrer-1" },
      include: { referredUser: { select: { name: true, avatar: true } } },
    }));
    const payload = await response.json();
    expect(payload.referrals[0].referredUser).toEqual({
      name: "Referred Customer",
      avatar: "avatar.png",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("+989121234567");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("password-hash");
    expect(serialized).not.toContain("private-tax-id");
  });
});
