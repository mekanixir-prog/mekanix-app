// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/gateway/initiate/route";

const mockRequireAuth = vi.fn();
const mockVipPlanFindUnique = vi.fn();
const mockGatewayCreate = vi.fn();

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    vipPlan: { findUnique: (...args: unknown[]) => mockVipPlanFindUnique(...args) },
    paymentGatewayLog: { create: (...args: unknown[]) => mockGatewayCreate(...args) },
  })),
}));

function request(body: unknown): Request {
  return new Request("http://localhost/api/gateway/initiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("VIP gateway initiation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({ userId: "customer-1", role: "CUSTOMER" });
    mockVipPlanFindUnique.mockResolvedValue({
      id: "plan-gold",
      name: "Gold",
      priceIrr: 125_000,
      financialUnitStatus: "VERIFIED_IRR",
      active: true,
    });
    mockGatewayCreate.mockImplementation(async ({ data }: { data: { code: string } }) => ({
      code: data.code,
    }));
  });

  it("uses the server-owned plan price and ignores a client-supplied amount", async () => {
    const response = await POST(request({
      purpose: "vip",
      planId: "plan-gold",
      amount: 1,
      mobile: "09120000000",
      cardNumber: "6037991234567890",
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.amount).toBe(125_000);
    expect(body.currency).toBe("IRR");
    expect(body.planId).toBe("plan-gold");

    const createArgs = mockGatewayCreate.mock.calls[0][0];
    expect(createArgs.data.amount).toBe(125_000);
    expect(createArgs.data.targetPlanId).toBe("plan-gold");
    expect(createArgs.data.purpose).toBe("vip");
    expect(createArgs.data.financialUnitStatus).toBe("VERIFIED_IRR");
    expect(createArgs.data.cardNumber).toBe("**** **** **** 7890");
    expect(createArgs.data.cardNumber).not.toContain("603799");
  });

  it("rejects a plan whose financial unit provenance is not verified", async () => {
    mockVipPlanFindUnique.mockResolvedValue({
      id: "plan-gold",
      name: "Gold",
      priceIrr: 125_000,
      financialUnitStatus: "UNVERIFIED",
      active: true,
    });

    const response = await POST(request({ purpose: "vip", planId: "plan-gold" }));
    expect(response.status).toBe(409);
    expect(mockGatewayCreate).not.toHaveBeenCalled();
  });

  it("rejects an inactive or missing plan", async () => {
    mockVipPlanFindUnique.mockResolvedValue(null);
    const response = await POST(request({ purpose: "vip", planId: "missing" }));
    expect(response.status).toBe(404);
    expect(mockGatewayCreate).not.toHaveBeenCalled();
  });

  it("does not accept a generic purpose or an unbound request", async () => {
    const wrongPurpose = await POST(request({ purpose: "wallet_topup", planId: "plan-gold" }));
    const missingPlan = await POST(request({ purpose: "vip", amount: 125_000 }));

    expect(wrongPurpose.status).toBe(400);
    expect(missingPlan.status).toBe(400);
    expect(mockVipPlanFindUnique).not.toHaveBeenCalled();
    expect(mockGatewayCreate).not.toHaveBeenCalled();
  });
});
