// @vitest-environment node
// MEKANIX — SEC-7 VIP Subscribe Tests (Bundle 3)
// ============================================================================
// Verifies the SEC-7 fix in src/app/api/vip/subscribe/route.ts:
//   1. Production guard — returns 404 when NODE_ENV === "production"
//   2. requireAuth — returns 401 when no session
//   3. paymentId required — 400 when missing
//   4. paymentId must exist — 400 when not found
//   5. payment must belong to caller — 400 when userId mismatch
//   6. payment status must be SUCCEEDED — 400 otherwise
//   7. payment amount must cover plan price — 400 when insufficient
//   8. valid payment → 200 + subscription created
//
// Mocks `getDbForLib`, `requireAuth`. Uses the node environment because the
// route uses NextResponse and we want real Request/Response objects.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ──────────── Module-level mocks (hoisted by vitest) ────────────
const mockVipPlanFindUnique = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentGatewayLogFindUnique = vi.fn();
const mockUserVipSubscriptionUpdateMany = vi.fn();
const mockUserVipSubscriptionCreate = vi.fn();
const mockUserVipSubscriptionFindFirst = vi.fn();
const mockNotificationCreate = vi.fn();
const mockSubscriptionFindUnique = vi.fn();
const mockCreateVipSubscriptionAtomically = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    vipPlan: { findUnique: (...args: any[]) => mockVipPlanFindUnique(...args) },
    payment: { findUnique: (...args: any[]) => mockPaymentFindUnique(...args) },
    paymentGatewayLog: { findUnique: (...args: any[]) => mockPaymentGatewayLogFindUnique(...args) },
    userVipSubscription: {
      findFirst: (...args: any[]) => mockUserVipSubscriptionFindFirst(...args),
      findUnique: (...args: any[]) => mockSubscriptionFindUnique(...args),
      updateMany: (...args: any[]) => mockUserVipSubscriptionUpdateMany(...args),
      create: (...args: any[]) => mockUserVipSubscriptionCreate(...args),
    },
    notification: { create: (...args: any[]) => mockNotificationCreate(...args) },
  })),
}));

// Mock requireAuth — controllable per-test via mockRequireAuth
const mockRequireAuth = vi.fn();
vi.mock("@/lib/vip-subscription-atomic", () => ({
  createVipSubscriptionAtomically: (...args: any[]) => mockCreateVipSubscriptionAtomically(...args),
}));

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: (...args: any[]) => mockRequireAuth(...args),
}));

// ──────────── Import route handler (after mocks hoisted) ────────────
import { POST } from "@/app/api/vip/subscribe/route";
import { NextResponse } from "next/server";

// ──────────── Helpers ────────────
function makePostRequest(body: unknown): Request {
  return new Request("http://localhost/api/vip/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_ENV = process.env.NODE_ENV;

describe("SEC-7 — /api/vip/subscribe route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path mocks; tests can override.
    mockRequireAuth.mockResolvedValue({
      userId: "user-1",
      role: "CUSTOMER",
      phone: "+989120000000",
      isGuest: false,
    });
    mockVipPlanFindUnique.mockResolvedValue({
      id: "plan-1",
      name: "Gold",
      priceIrr: 100_000, // 100k IRR
      durationDays: 30,
      active: true,
      financialUnitStatus: "VERIFIED_IRR",
    });
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1",
      userId: "user-1",
      status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
      amount: 100_000, // exactly covers plan price
      currency: "IRR",
      gatewayLogId: "gateway-1",
    });
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "gateway-1",
      userId: "user-1",
      status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip",
      targetPlanId: "plan-1",
      targetPlanDurationDays: 30,
      paymentId: "pay-1",
      amount: 100_000,
      currency: "IRR",
    });
    mockUserVipSubscriptionUpdateMany.mockResolvedValue({ count: 0 });
    mockCreateVipSubscriptionAtomically.mockResolvedValue("sub-1");
    mockSubscriptionFindUnique.mockResolvedValue({
      id: "sub-1", userId: "user-1", planId: "plan-1", status: "ACTIVE",
      plan: { id: "plan-1", name: "Gold" },
    });
    mockUserVipSubscriptionFindFirst.mockResolvedValue(null); // no existing sub using this payment
    mockUserVipSubscriptionCreate.mockResolvedValue({
      id: "sub-1",
      userId: "user-1",
      planId: "plan-1",
      status: "ACTIVE",
      plan: { id: "plan-1", name: "Gold" },
    });
    mockNotificationCreate.mockResolvedValue({});
  });

  afterEach(() => {
    // Restore NODE_ENV so test isolation is preserved
    vi.stubEnv("NODE_ENV", ORIGINAL_ENV);
  });

  // ──────────── 1. Production guard ────────────
  it("returns 404 in production (production guard)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const req = makePostRequest({ planId: "plan-1", paymentId: "pay-1" });
    const res = await POST(req);
    expect(res.status).toBe(404);
    // And DB must never be touched
    expect(mockVipPlanFindUnique).not.toHaveBeenCalled();
    expect(mockPaymentFindUnique).not.toHaveBeenCalled();
  });

  // ──────────── 2. Auth required ────────────
  it("returns 401 when requireAuth returns a NextResponse (unauthenticated)", async () => {
    vi.stubEnv("NODE_ENV", "test"); // not production
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: "unauthorized" }, { status: 401 })
    );
    const req = makePostRequest({ planId: "plan-1", paymentId: "pay-1" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  // ──────────── 3. paymentId required ────────────
  it("returns 400 when paymentId is missing", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const req = makePostRequest({ planId: "plan-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockPaymentFindUnique).not.toHaveBeenCalled();
  });

  // ──────────── 4. paymentId must exist ────────────
  it("returns 400 when payment is not found (invalid paymentId)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentFindUnique.mockResolvedValue(null);
    const req = makePostRequest({ planId: "plan-1", paymentId: "nonexistent" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ──────────── 5. payment must belong to caller ────────────
  it("returns 400 when payment belongs to a different user", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1",
      userId: "other-user", // different from session.userId = "user-1"
      status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
      amount: 100_000,
    });
    const req = makePostRequest({ planId: "plan-1", paymentId: "pay-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ──────────── 6. payment status must be SUCCEEDED ────────────
  it("returns 400 when payment status is not SUCCEEDED", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1",
      userId: "user-1",
      status: "PENDING", // not SUCCEEDED
      amount: 100_000,
    });
    const req = makePostRequest({ planId: "plan-1", paymentId: "pay-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ──────────── 7. payment amount must cover plan price ────────────
  it("returns 400 when payment amount is insufficient (less than plan.priceIrr)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1",
      userId: "user-1",
      status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
      amount: 50_000, // less than plan.priceIrr (100_000)
    });
    const req = makePostRequest({ planId: "plan-1", paymentId: "pay-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ──────────── 8. Valid payment → 200 + subscription created ────────────
  it("returns 200 and creates subscription when payment is valid", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const req = makePostRequest({ planId: "plan-1", paymentId: "pay-1" });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // Subscription creation uses the server-authoritative session identity.
    expect(mockUserVipSubscriptionCreate).not.toHaveBeenCalled();
    // Replacement is delegated to the provider-aware atomic transaction helper.
    expect(mockCreateVipSubscriptionAtomically).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        userId: "user-1",
        planId: "plan-1",
        paymentId: "pay-1",
        startedAt: expect.any(Date),
        expiresAt: expect.any(Date),
      }),
    );
    expect(mockSubscriptionFindUnique).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      include: { plan: true },
    });

    // Body has ok:true and subscription
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.subscription.id).toBe("sub-1");
  });

  it("returns the existing subscription for an exact payment replay", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockUserVipSubscriptionFindFirst.mockResolvedValue({
      id: "sub-existing", userId: "user-1", planId: "plan-1", status: "ACTIVE",
      startedAt: new Date("2026-11-01T00:00:00.000Z"), expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      plan: { id: "plan-1", name: "Gold", priceIrr: 100_000 },
    });

    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyProcessed).toBe(true);
    expect(body.subscription.id).toBe("sub-existing");
    expect(mockCreateVipSubscriptionAtomically).not.toHaveBeenCalled();
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("recovers a concurrent payment-consumption race as an idempotent success", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockUserVipSubscriptionFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "sub-raced", userId: "user-1", planId: "plan-1", status: "ACTIVE",
        startedAt: new Date("2026-11-01T00:00:00.000Z"), expiresAt: new Date("2026-12-01T00:00:00.000Z"),
        plan: { id: "plan-1", name: "Gold", priceIrr: 100_000 },
      });
    mockCreateVipSubscriptionAtomically.mockRejectedValue(new Error("UNIQUE constraint failed"));

    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyProcessed).toBe(true);
    expect(body.subscription.id).toBe("sub-raced");
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("does not treat a payment consumed by another plan as an idempotent replay", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockUserVipSubscriptionFindFirst.mockResolvedValue({
      id: "sub-other-plan", userId: "user-1", planId: "different-plan", status: "ACTIVE",
      plan: { id: "different-plan", name: "Silver" },
    });

    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(409);
    expect(mockCreateVipSubscriptionAtomically).not.toHaveBeenCalled();
  });

  it("returns a conflict when the atomic replacement loses a uniqueness race", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockCreateVipSubscriptionAtomically.mockRejectedValue(new Error("UNIQUE constraint failed"));
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(409);
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("rejects a successful payment without a gateway attempt", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1", userId: "user-1", status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
      amount: 100_000, currency: "IRR", gatewayLogId: null,
    });
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(400);
    expect(mockPaymentGatewayLogFindUnique).not.toHaveBeenCalled();
    expect(mockUserVipSubscriptionCreate).not.toHaveBeenCalled();
  });

  it("rejects a payment not denominated in IRR", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1", userId: "user-1", status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
      amount: 100_000, currency: "USD", gatewayLogId: "gateway-1",
    });
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(400);
    expect(mockPaymentGatewayLogFindUnique).not.toHaveBeenCalled();
    expect(mockUserVipSubscriptionCreate).not.toHaveBeenCalled();
  });

  it("rejects a verified payment whose purpose is not VIP", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "gateway-1", userId: "user-1", status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "invoice", targetPlanId: "plan-1", paymentId: "pay-1", amount: 100_000, currency: "IRR",
    });
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(400);
    expect(mockUserVipSubscriptionCreate).not.toHaveBeenCalled();
  });

  it("rejects a verified payment bound to a different VIP plan", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "gateway-1", userId: "user-1", status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip", targetPlanId: "another-plan", paymentId: "pay-1",
      amount: 100_000, currency: "IRR",
    });
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(400);
    expect(mockCreateVipSubscriptionAtomically).not.toHaveBeenCalled();
  });

  it("rejects a Payment amount that does not match its immutable gateway attempt", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1", userId: "user-1", status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
      amount: 150_000, currency: "IRR", gatewayLogId: "gateway-1",
    });
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "gateway-1", userId: "user-1", status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip", targetPlanId: "plan-1", paymentId: "pay-1",
      amount: 100_000, currency: "IRR",
    });
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(400);
    expect(mockCreateVipSubscriptionAtomically).not.toHaveBeenCalled();
  });

  it("uses the persisted amount snapshot if the plan price changes after initiation", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockVipPlanFindUnique.mockResolvedValue({
      id: "plan-1",
      name: "Gold",
      priceIrr: 150_000, // price changed after the attempt was initiated
      durationDays: 365, // mutable catalog value differs from purchase snapshot
      active: false, // a paid attempt remains entitled after the plan is deactivated
      financialUnitStatus: "VERIFIED_IRR",
    });
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(200);
    expect(mockCreateVipSubscriptionAtomically).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ expiresAt: expect.any(Date) }),
    );
    const input = mockCreateVipSubscriptionAtomically.mock.calls[0][1];
    expect(input.expiresAt.getTime() - input.startedAt.getTime()).toBe(30 * 86400000);
  });

  it("rejects a gateway attempt not linked back to the selected payment", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "gateway-1", userId: "user-1", status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip", targetPlanId: "plan-1", paymentId: "different-payment", amount: 100_000, currency: "IRR",
    });
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(400);
    expect(mockUserVipSubscriptionCreate).not.toHaveBeenCalled();
  });

  it("rejects a gateway amount or currency that differs from the payment row", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "gateway-1", userId: "user-1", status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip", targetPlanId: "plan-1", paymentId: "pay-1", amount: 120_000, currency: "USD",
    });
    const res = await POST(makePostRequest({ planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(400);
    expect(mockUserVipSubscriptionCreate).not.toHaveBeenCalled();
  });

  // ──────────── Extra: planId required ────────────
  it("returns 400 when planId is missing", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const req = makePostRequest({ paymentId: "pay-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockVipPlanFindUnique).not.toHaveBeenCalled();
  });

  // ──────────── Extra: plan must be active ────────────
  it("returns 404 when plan is not found or inactive", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockVipPlanFindUnique.mockResolvedValue(null);
    const req = makePostRequest({ planId: "missing", paymentId: "pay-1" });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  // ──────────── Extra: subscription creation never uses body.userId ────────────
  it("never reads userId from the request body (server-authoritative)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    // Body tries to spoof a different userId — must be IGNORED.
    const req = makePostRequest({
      planId: "plan-1",
      paymentId: "pay-1",
      userId: "attacker-user", // spoof attempt
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    // The atomic writer receives session.userId, never the spoofed body.userId.
    expect(mockCreateVipSubscriptionAtomically).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ userId: "user-1", planId: "plan-1", paymentId: "pay-1" }),
    );
  });
});
