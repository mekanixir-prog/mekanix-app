// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    referral: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    notification: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db-access", () => ({ getDbForLib: async () => db }));
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: async () => ({ userId: "referrer-1", role: "CUSTOMER" }),
}));

import { PATCH } from "@/app/api/referral/route";

function request(body: Record<string, unknown>) {
  return new Request("https://mekanix.test/api/referral", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const eligibleReferral = {
  id: "referral-1",
  referrerId: "referrer-1",
  referredUserId: "referred-1",
  status: "first_job",
  rewardClaimed: false,
  rewardAmount: 100_000,
  financialUnitStatus: "VERIFIED_IRR",
  code: "MEK-1234",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.referral.findUnique.mockResolvedValue(eligibleReferral);
});

describe("referral reward settlement gate", () => {
  it("does not mark a reward claimed before atomic wallet settlement exists", async () => {
    const response = await PATCH(request({ referralId: "referral-1", action: "claim" }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("REFERRAL_REWARD_SETTLEMENT_NOT_IMPLEMENTED");
    expect(db.referral.updateMany).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("preserves referral ownership checks before exposing settlement state", async () => {
    db.referral.findUnique.mockResolvedValue({ ...eligibleReferral, referrerId: "another-user" });

    const response = await PATCH(request({ referralId: "referral-1", action: "claim" }));

    expect(response.status).toBe(403);
    expect(db.referral.updateMany).not.toHaveBeenCalled();
  });

  it("keeps unverified reward amounts blocked by provenance validation", async () => {
    db.referral.findUnique.mockResolvedValue({ ...eligibleReferral, financialUnitStatus: "UNVERIFIED" });

    const response = await PATCH(request({ referralId: "referral-1", action: "claim" }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("REFERRAL_REWARD_PROVENANCE_UNVERIFIED");
    expect(db.referral.updateMany).not.toHaveBeenCalled();
  });
});
