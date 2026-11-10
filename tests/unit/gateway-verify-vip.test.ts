// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/gateway/verify/route";

const mockRequireAuth = vi.fn();
const mockGatewayFindUnique = vi.fn();
const mockGatewayUpdate = vi.fn();
const mockPlanFindUnique = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentCreate = vi.fn();

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    paymentGatewayLog: {
      findUnique: (...args: unknown[]) => mockGatewayFindUnique(...args),
      update: (...args: unknown[]) => mockGatewayUpdate(...args),
    },
    vipPlan: { findUnique: (...args: unknown[]) => mockPlanFindUnique(...args) },
    payment: {
      findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args),
      create: (...args: unknown[]) => mockPaymentCreate(...args),
    },
  })),
}));

function request(body: unknown): Request {
  return new Request("http://localhost/api/gateway/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("VIP gateway simulator verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({ userId: "customer-1", role: "CUSTOMER" });
    mockGatewayFindUnique.mockResolvedValue({
      id: "gateway-1",
      code: "PG-test",
      userId: "customer-1",
      status: "REDIRECTED",
      amount: 100_000,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip",
      targetPlanId: "plan-1",
      paymentId: null,
      verifiedAt: null,
    });
    // Price may have changed after initiation; the gateway log amount is the
    // immutable server-owned snapshot for this in-flight attempt.
    mockPlanFindUnique.mockResolvedValue({
      id: "plan-1",
      active: true,
      priceIrr: 150_000,
      financialUnitStatus: "VERIFIED_IRR",
    });
    mockPaymentFindUnique.mockResolvedValue(null);
    mockPaymentCreate.mockResolvedValue({
      id: "payment-1",
      userId: "customer-1",
      amount: 100_000,
      currency: "IRR",
      status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
    });
    mockGatewayUpdate.mockResolvedValue({});
  });

  it("rejects any OTP other than the documented simulator test code", async () => {
    const response = await POST(request({ code: "PG-test", otp: "0000" }));
    expect(response.status).toBe(400);
    expect(mockGatewayFindUnique).not.toHaveBeenCalled();
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });

  it("creates a payment from the persisted server-owned attempt amount", async () => {
    const response = await POST(request({ code: "PG-test", otp: "1234", amount: 1, userId: "attacker" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.paymentId).toBe("payment-1");
    expect(body.amount).toBe(100_000);

    const createArgs = mockPaymentCreate.mock.calls[0][0];
    expect(createArgs.data.userId).toBe("customer-1");
    expect(createArgs.data.amount).toBe(100_000);
    expect(createArgs.data.gatewayLogId).toBe("gateway-1");
    expect(mockGatewayUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "gateway-1" },
      data: expect.objectContaining({ status: "VERIFIED", paymentId: "payment-1" }),
    }));
  });

  it("rejects a legacy/unbound gateway log without a target plan", async () => {
    mockGatewayFindUnique.mockResolvedValue({
      id: "gateway-legacy",
      userId: "customer-1",
      amount: 100_000,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip",
      targetPlanId: null,
      status: "REDIRECTED",
    });
    const response = await POST(request({ code: "PG-test", otp: "1234" }));
    expect(response.status).toBe(409);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });

  it("rejects an inactive or financially unverified target plan", async () => {
    mockPlanFindUnique.mockResolvedValue({
      id: "plan-1",
      active: false,
      priceIrr: 100_000,
      financialUnitStatus: "VERIFIED_IRR",
    });
    const response = await POST(request({ code: "PG-test", otp: "1234" }));
    expect(response.status).toBe(409);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });

  it("rejects an attempt owned by another user", async () => {
    mockGatewayFindUnique.mockResolvedValue({
      id: "gateway-1",
      userId: "other-user",
      amount: 100_000,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip",
      targetPlanId: "plan-1",
      status: "REDIRECTED",
    });
    const response = await POST(request({ code: "PG-test", otp: "1234" }));
    expect(response.status).toBe(403);
    expect(mockPlanFindUnique).not.toHaveBeenCalled();
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });

  it("does not create a second payment when the attempt is already linked", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1",
      userId: "customer-1",
      status: "SUCCEEDED",
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      amount: 100_000,
    });
    const response = await POST(request({ code: "PG-test", otp: "1234" }));
    expect(response.status).toBe(200);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockGatewayUpdate).toHaveBeenCalled();
  });
});
