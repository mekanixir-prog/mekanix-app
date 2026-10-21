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
const mockUserVipSubscriptionUpdateMany = vi.fn();
const mockUserVipSubscriptionCreate = vi.fn();
const mockUserVipSubscriptionFindFirst = vi.fn();
const mockNotificationCreate = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    vipPlan: { findUnique: (...args: any[]) => mockVipPlanFindUnique(...args) },
    payment: { findUnique: (...args: any[]) => mockPaymentFindUnique(...args) },
    userVipSubscription: {
      findFirst: (...args: any[]) => mockUserVipSubscriptionFindFirst(...args),
      updateMany: (...args: any[]) => mockUserVipSubscriptionUpdateMany(...args),
      create: (...args: any[]) => mockUserVipSubscriptionCreate(...args),
    },
    notification: { create: (...args: any[]) => mockNotificationCreate(...args) },
  })),
}));

// Mock requireAuth — controllable per-test via mockRequireAuth
const mockRequireAuth = vi.fn();
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
    });
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1",
      userId: "user-1",
      status: "SUCCEEDED",
      amount: 100_000, // exactly covers plan price
    });
    mockUserVipSubscriptionUpdateMany.mockResolvedValue({ count: 0 });
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

    // Subscription was created with the session.userId (NOT from body)
    expect(mockUserVipSubscriptionCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockUserVipSubscriptionCreate.mock.calls[0][0];
    expect(createArgs.data.userId).toBe("user-1"); // from session, not body
    expect(createArgs.data.planId).toBe("plan-1");
    expect(createArgs.data.status).toBe("ACTIVE");
    expect(createArgs.data.paymentId).toBe("pay-1");

    // Existing ACTIVE subscriptions were cancelled (idempotent cancel)
    expect(mockUserVipSubscriptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", status: "ACTIVE" },
        data: { status: "CANCELLED" },
      })
    );

    // Body has ok:true and subscription
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.subscription.id).toBe("sub-1");
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
    const createArgs = mockUserVipSubscriptionCreate.mock.calls[0][0];
    // Must use session.userId (user-1), NOT the spoofed body.userId
    expect(createArgs.data.userId).toBe("user-1");
  });
});
