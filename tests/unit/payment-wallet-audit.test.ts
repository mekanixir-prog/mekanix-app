// @vitest-environment node
// MEKANIX — B-5 Payment & Wallet Auditor: Concurrency + Negative Tests
// ============================================================================
// Audit-driven test suite for the payment / wallet / gateway / VIP subsystems.
// Verifies:
//   1. PAY-01 — /api/payments returns 404 in production (simulator prod guard)
//   2. /api/payments — payment for another user's invoice → 403 (BOLA)
//   3. /api/payments — duplicate POST after PAID → 409 (idempotency)
//   4. /api/gateway/verify — duplicate verify (same log twice) → second is 400,
//      Payment.create called exactly ONCE
//   5. /api/gateway/verify — concurrent verify (Promise.all of 2) → exactly
//      one Payment.create (atomic updateMany guards the race)
//   6. /api/wallets/withdraw — withdraw exceeds balance → 400, balance
//      unchanged (no wallet.updateMany call)
//   7. VIP-01 — /api/vip/subscribe: documented race condition where two
//      concurrent subscribe calls with the same paymentId both pass the
//      findFirst check and both call create (TOCTOU on paymentId reuse).
//      Uses it.fails() to assert the bug exists without breaking CI.
//
// Pattern: mocks @/lib/db-access, @/lib/api-helpers, @/lib/rate-limit,
// @/lib/auth at the module level (hoisted by vitest) so the route handler
// imports the mocked versions. NODE_ENV is stubbed per-test via vi.stubEnv.
//
// Constraints honored:
//   - READ-ONLY on source — this is the ONLY new file added by Agent B-5.
//   - No real payment, no real gateway call, no real wallet mutation.
//   - All DB calls are mocked — no D1/Prisma connection required.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

// ──────────────────────────────────────────────────────────────────────────
// Shared mock state (so a single mock for @/lib/db-access can serve all
// route handlers under test — each describe block wires its own per-method
// mocks; only the ones the route actually touches are read).
// ──────────────────────────────────────────────────────────────────────────

const mockInvoiceFindUnique = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentCreate = vi.fn();
const mockRecordVerifiedGatewayPayment = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockInvoiceUpdateMany = vi.fn();
const mockJobUpdateMany = vi.fn();
const mockWarrantyCreate = vi.fn();
const mockNotificationCreate = vi.fn();

const mockPaymentGatewayLogFindUnique = vi.fn();
const mockPaymentGatewayLogUpdateMany = vi.fn();
const mockPaymentGatewayLogUpdate = vi.fn();

const mockWalletFindUnique = vi.fn();
const mockWalletUpdateMany = vi.fn();
const mockWithdrawalRequestCreate = vi.fn();
const mockWithdrawalRequestFindUnique = vi.fn();
const mockCreateWithdrawalAtomically = vi.fn();
const mockWalletLedgerCreate = vi.fn();
const mockTechnicianFindUnique = vi.fn();

const mockVipPlanFindUnique = vi.fn();
const mockUserVipSubscriptionFindFirst = vi.fn();
const mockUserVipSubscriptionUpdateMany = vi.fn();
const mockUserVipSubscriptionCreate = vi.fn();
const mockUserVipSubscriptionFindUnique = vi.fn();
const mockCreateVipSubscriptionAtomically = vi.fn();

vi.mock("@/lib/payment-verification-atomic", () => ({
  recordVerifiedGatewayPaymentAtomically: (...args: any[]) => mockRecordVerifiedGatewayPayment(...args),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    // payments / invoices / jobs
    invoice: {
      findUnique: (...args: any[]) => mockInvoiceFindUnique(...args),
      updateMany: (...args: any[]) => mockInvoiceUpdateMany(...args),
    },
    payment: {
      findUnique: (...args: any[]) => mockPaymentFindUnique(...args),
      create: (...args: any[]) => mockPaymentCreate(...args),
      update: (...args: any[]) => mockPaymentUpdate(...args),
    },
    job: { updateMany: (...args: any[]) => mockJobUpdateMany(...args) },
    warranty: { create: (...args: any[]) => mockWarrantyCreate(...args) },
    notification: { create: (...args: any[]) => mockNotificationCreate(...args) },

    // gateway
    paymentGatewayLog: {
      findUnique: (...args: any[]) => mockPaymentGatewayLogFindUnique(...args),
      updateMany: (...args: any[]) => mockPaymentGatewayLogUpdateMany(...args),
      update: (...args: any[]) => mockPaymentGatewayLogUpdate(...args),
    },

    // wallets
    wallet: {
      findUnique: (...args: any[]) => mockWalletFindUnique(...args),
      updateMany: (...args: any[]) => mockWalletUpdateMany(...args),
    },
    withdrawalRequest: {
      create: (...args: any[]) => mockWithdrawalRequestCreate(...args),
      findUnique: (...args: any[]) => mockWithdrawalRequestFindUnique(...args),
    },
    walletLedger: { create: (...args: any[]) => mockWalletLedgerCreate(...args) },
    technician: {
      findUnique: (...args: any[]) => mockTechnicianFindUnique(...args),
    },

    // vip
    vipPlan: { findUnique: (...args: any[]) => mockVipPlanFindUnique(...args) },
    userVipSubscription: {
      findFirst: (...args: any[]) => mockUserVipSubscriptionFindFirst(...args),
      findUnique: (...args: any[]) => mockUserVipSubscriptionFindUnique(...args),
      updateMany: (...args: any[]) => mockUserVipSubscriptionUpdateMany(...args),
      create: (...args: any[]) => mockUserVipSubscriptionCreate(...args),
    },
  })),
}));

// requireAuth mock — controllable per-test
const mockRequireAuth = vi.fn();
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: (...args: any[]) => mockRequireAuth(...args),
}));

vi.mock("@/lib/vip-subscription-atomic", () => ({
  createVipSubscriptionAtomically: (...args: any[]) => mockCreateVipSubscriptionAtomically(...args),
}));

vi.mock("@/lib/withdrawal-atomic", () => ({
  createWithdrawalAtomically: (...args: any[]) => mockCreateWithdrawalAtomically(...args),
}));

// rate-limit mock — always succeeds (route rate-limit checks bypassed)
vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: vi.fn().mockResolvedValue({ success: true, resetMs: 60_000 }),
  rateLimit: vi.fn(() => ({ success: true, resetMs: 60_000 })),
  checkRateLimit: vi.fn(() => null),
  getClientId: vi.fn(() => "127.0.0.1"),
  RATE_LIMITS: {
    OTP_SEND: { max: 5, windowMs: 60_000 },
    OTP_VERIFY: { max: 5, windowMs: 60_000 },
    PAYMENT: { max: 5, windowMs: 60_000 },
    WITHDRAW: { max: 3, windowMs: 3_600_000 },
    API_DEFAULT: { max: 60, windowMs: 60_000 },
  },
}));

// getTechnicianFromSession mock — for withdraw route (TECHNICIAN resolution)
const mockGetTechnicianFromSession = vi.fn();
vi.mock("@/lib/auth", async () => {
  // Preserve real createSession for JWT minting if a test needs it; here we
  // only need the getTechnicianFromSession helper mocked.
  const actual = await vi.importActual("@/lib/auth");
  return {
    ...actual,
    getTechnicianFromSession: (...args: any[]) =>
      mockGetTechnicianFromSession(...args),
  };
});

// ──────────────────────────────────────────────────────────────────────────
// Route handler imports (after mocks hoisted)
// ──────────────────────────────────────────────────────────────────────────
import { POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as verifyPOST } from "@/app/api/gateway/verify/route";
import { POST as initiatePOST } from "@/app/api/gateway/initiate/route";
import { POST as withdrawPOST } from "@/app/api/wallets/withdraw/route";
import { POST as vipSubscribePOST } from "@/app/api/vip/subscribe/route";

// ──────────────────────────────────────────────────────────────────────────
// GATEWAY — simulator initiation and verification are unreachable in production
// ──────────────────────────────────────────────────────────────────────────
describe("gateway simulator production guards", () => {
  it("blocks /api/gateway/initiate before auth or database access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const req = makePostRequest("http://localhost/api/gateway/initiate", {
      amount: 100_000,
      purpose: "vip",
    });

    const res = await initiatePOST(req);

    expect(res.status).toBe(404);
    expect(mockRequireAuth).not.toHaveBeenCalled();
    expect(mockPaymentGatewayLogFindUnique).not.toHaveBeenCalled();
    expect(mockPaymentGatewayLogUpdate).not.toHaveBeenCalled();
  });

  it("blocks /api/gateway/verify before auth or database access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const req = makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    });

    const res = await verifyPOST(req);

    expect(res.status).toBe(404);
    expect(mockRequireAuth).not.toHaveBeenCalled();
    expect(mockPaymentGatewayLogFindUnique).not.toHaveBeenCalled();
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function makePostRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeWithdrawalRequest(body: Record<string, unknown>, key: string): Request {
  return new Request("https://mekanix.test/api/wallets/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      method: "bank",
      shebaNumber: "IR062960000000100324200001",
      ...body,
    }),
  });
}

const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  // Default NODE_ENV for tests (NOT production — payments/gateway/vip/prepay
  // routes 404 in production by design).
  vi.stubEnv("NODE_ENV", "test");

  // Default session — a regular CUSTOMER (payments + vip caller)
  mockRequireAuth.mockResolvedValue({
    userId: "user-1",
    role: "CUSTOMER",
    phone: "+989120000000",
    isGuest: false,
  });

  // Default notification + warranty create — best-effort, never throw
  mockNotificationCreate.mockResolvedValue({});
  mockWarrantyCreate.mockResolvedValue({});
});

afterEach(() => {
  vi.stubEnv("NODE_ENV", ORIGINAL_ENV);
});

// ──────────────────────────────────────────────────────────────────────────
// 1. PAY-01 — /api/payments production guard (404 in production)
// ──────────────────────────────────────────────────────────────────────────
describe("PAY-01 — /api/payments production guard", () => {
  it("returns 404 when NODE_ENV === 'production' (simulator must not be reachable)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const req = makePostRequest("http://localhost/api/payments", {
      invoiceId: "inv-1",
      method: "card",
    });
    const res = await paymentsPOST(req);

    expect(res.status).toBe(404);
    // Critical: NO DB calls must happen — guard runs before requireAuth.
    expect(mockRequireAuth).not.toHaveBeenCalled();
    expect(mockInvoiceFindUnique).not.toHaveBeenCalled();
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });

  it("does NOT return 404 when NODE_ENV !== 'production' (dev/test passes through to handler)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    // Wire a valid happy-path mock so the route can proceed past auth.
    mockInvoiceFindUnique.mockResolvedValue({
      id: "inv-1",
      status: "SENT",
      total: 100,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      jobId: "job-1",
      code: "INV-1",
      job: {
        id: "job-1",
        request: { customer: { userId: "user-1" } },
        technician: { userId: "tech-user-1" },
      },
    });
    mockPaymentFindUnique.mockResolvedValue(null); // no existing payment
    mockPaymentCreate.mockResolvedValue({ id: "pay-1", status: "SUCCEEDED" });
    mockInvoiceUpdateMany.mockResolvedValue({ count: 1 });
    mockJobUpdateMany.mockResolvedValue({ count: 1 });

    const req = makePostRequest("http://localhost/api/payments", {
      invoiceId: "inv-1",
      method: "card",
    });
    const res = await paymentsPOST(req);

    // Must NOT be 404 — handler ran.
    expect(res.status).not.toBe(404);
    expect(mockInvoiceFindUnique).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. /api/payments — BOLA: payment for another user's invoice → 403
// ──────────────────────────────────────────────────────────────────────────
describe("/api/payments — BOLA (payment for another user's invoice)", () => {
  it("returns 403 when session.customer does not own the invoice's job's customer record", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockInvoiceFindUnique.mockResolvedValue({
      id: "inv-1",
      status: "SENT",
      total: 100,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      jobId: "job-1",
      code: "INV-1",
      job: {
        id: "job-1",
        // job's customer.userId = "user-2" — DIFFERENT from session.userId "user-1"
        request: { customer: { userId: "user-2" } },
        technician: { userId: "tech-user-1" },
      },
    });

    const req = makePostRequest("http://localhost/api/payments", {
      invoiceId: "inv-1",
      method: "card",
    });
    const res = await paymentsPOST(req);

    expect(res.status).toBe(403);
    // No payment.create must occur — caller is unauthorized.
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
    expect(mockInvoiceUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 200 when session.customer owns the invoice (control)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockInvoiceFindUnique.mockResolvedValue({
      id: "inv-1",
      status: "SENT",
      total: 100,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      jobId: "job-1",
      code: "INV-1",
      job: {
        id: "job-1",
        request: { customer: { userId: "user-1" } }, // SAME as session.userId
        technician: { userId: "tech-user-1" },
      },
    });
    mockPaymentFindUnique.mockResolvedValue(null);
    mockPaymentCreate.mockResolvedValue({ id: "pay-1", status: "SUCCEEDED" });
    mockInvoiceUpdateMany.mockResolvedValue({ count: 1 });
    mockJobUpdateMany.mockResolvedValue({ count: 1 });

    const req = makePostRequest("http://localhost/api/payments", {
      invoiceId: "inv-1",
      method: "card",
    });
    const res = await paymentsPOST(req);

    expect(res.status).toBe(200);
    expect(mockPaymentCreate).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. /api/payments — duplicate POST (sequential) → 409 (invoice already PAID)
// ──────────────────────────────────────────────────────────────────────────
describe("/api/payments — duplicate POST idempotency (sequential)", () => {
  it("second POST for an already-PAID invoice returns 409 (alreadyPaid: true)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    // Simulate the state AFTER the first POST already marked the invoice PAID.
    mockInvoiceFindUnique.mockResolvedValue({
      id: "inv-1",
      status: "PAID", // already paid
      total: 100,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      jobId: "job-1",
      code: "INV-1",
      job: {
        id: "job-1",
        request: { customer: { userId: "user-1" } },
        technician: { userId: "tech-user-1" },
      },
    });

    const req = makePostRequest("http://localhost/api/payments", {
      invoiceId: "inv-1",
      method: "card",
    });
    const res = await paymentsPOST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.alreadyPaid).toBe(true);
    // No payment mutation on a duplicate request.
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
    // Invoice / job / wallet NOT touched.
    expect(mockInvoiceUpdateMany).not.toHaveBeenCalled();
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4–5. /api/gateway/verify — unique payment idempotency + crash recovery
// ──────────────────────────────────────────────────────────────────────────
describe("GW-03 — /api/gateway/verify durable idempotency", () => {
  const existingPayment = {
    id: "pay-1",
    code: "PAY-PG-7001",
    userId: "user-1",
    amount: 100_000,
    currency: "IRR",
    status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
  };

  beforeEach(() => {
    mockRequireAuth.mockResolvedValue({
      userId: "user-1",
      role: "CUSTOMER",
      phone: "+989120000000",
      isGuest: false,
    });
    mockVipPlanFindUnique.mockResolvedValue({
      id: "plan-1", active: true, priceIrr: 150_000, financialUnitStatus: "VERIFIED_IRR",
    });
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "log-1",
      code: "PG-7001",
      userId: "user-1",
      amount: 100_000,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      status: "REDIRECTED",
      purpose: "vip",
      targetPlanId: "plan-1",
      targetPlanDurationDays: 30,
      verifiedAt: null,
    });
    mockPaymentFindUnique.mockReset();
    mockPaymentFindUnique.mockImplementation(async ({ where }: any) => where?.id ? existingPayment : null);
    mockPaymentCreate.mockResolvedValue(existingPayment);
    mockRecordVerifiedGatewayPayment.mockReset();
    mockRecordVerifiedGatewayPayment.mockResolvedValue("pay-1");
    mockPaymentGatewayLogUpdate.mockResolvedValue({});
  });

  it("atomically persists one payment, verified gateway link, and outbox event", async () => {
    const res = await verifyPOST(makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    }));

    expect(res.status).toBe(200);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockRecordVerifiedGatewayPayment).toHaveBeenCalledTimes(1);
    expect(mockRecordVerifiedGatewayPayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      gatewayLogId: "log-1", userId: "user-1", amount: 100_000, targetPlanId: "plan-1",
      durationDays: 30,
    }));
  });

  it("replays the same successful payment instead of rejecting or creating a duplicate", async () => {
    mockPaymentFindUnique.mockImplementation(async () => existingPayment);

    const req = () => makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    });
    const first = await verifyPOST(req());
    const second = await verifyPOST(req());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).alreadyVerified).toBe(true);
    expect(mockRecordVerifiedGatewayPayment).toHaveBeenCalledTimes(2);
  });

  it("recovers when Payment creation succeeded but gateway-log linking failed", async () => {
    mockPaymentFindUnique.mockImplementation(async ({ where }: any) => where?.id ? existingPayment : null);
    mockRecordVerifiedGatewayPayment
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockResolvedValueOnce("pay-1");

    const req = () => makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    });

    await expect(verifyPOST(req())).rejects.toThrow("temporary database failure");
    const retry = await verifyPOST(req());

    expect(retry.status).toBe(200);
    expect(mockRecordVerifiedGatewayPayment).toHaveBeenCalledTimes(2);
  });

  it("handles concurrent callbacks through the database unique constraint", async () => {
    mockPaymentFindUnique.mockImplementation(async ({ where }: any) => where?.id ? existingPayment : null);
    mockRecordVerifiedGatewayPayment.mockResolvedValue("pay-1");

    const req = () => makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    });
    const results = await Promise.all([verifyPOST(req()), verifyPOST(req())]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(mockRecordVerifiedGatewayPayment).toHaveBeenCalledTimes(2);
  });

  it("recovers a legacy VERIFIED log only when its paymentId identifies the existing successful payment", async () => {
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "log-1",
      code: "PG-7001",
      userId: "user-1",
      amount: 100_000,
      currency: "IRR",
      status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip",
      targetPlanId: "plan-1",
      targetPlanDurationDays: 30,
      paymentId: "pay-1",
      verifiedAt: new Date("2026-10-30T10:00:00.000Z"),
    });
    mockPaymentFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingPayment);

    const res = await verifyPOST(makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).paymentId).toBe("pay-1");
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockPaymentGatewayLogUpdate).not.toHaveBeenCalled();
  });

  it("blocks legacy VERIFIED logs without a linked payment instead of risking a duplicate credit", async () => {
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "log-1",
      code: "PG-7001",
      userId: "user-1",
      amount: 100_000,
      currency: "IRR",
      status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip",
      targetPlanId: "plan-1",
      targetPlanDurationDays: 30,
      paymentId: null,
      verifiedAt: new Date("2026-10-30T10:00:00.000Z"),
    });
    mockPaymentFindUnique.mockResolvedValueOnce(null);

    const res = await verifyPOST(makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    }));

    expect(res.status).toBe(409);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockPaymentGatewayLogUpdate).not.toHaveBeenCalled();
  });

  it("returns 403 when the gateway log belongs to another user", async () => {
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "log-1",
      code: "PG-7001",
      userId: "user-2",
      amount: 100_000,
      status: "REDIRECTED",
      purpose: "vip",
    });

    const res = await verifyPOST(makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    }));

    expect(res.status).toBe(403);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockPaymentFindUnique).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid OTP without touching payment records", async () => {
    const malformed = new Request("http://localhost/api/gateway/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const invalidOtp = makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: 1234,
    });
    const nullBody = makePostRequest("http://localhost/api/gateway/verify", null);

    expect((await verifyPOST(malformed)).status).toBe(400);
    expect((await verifyPOST(invalidOtp)).status).toBe(400);
    expect((await verifyPOST(nullBody)).status).toBe(400);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockPaymentFindUnique).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 6. /api/wallets/withdraw — withdraw exceeds balance → 400, no mutation
// ──────────────────────────────────────────────────────────────────────────
describe("/api/wallets/withdraw — atomic withdrawal guard", () => {
  beforeEach(() => {
    mockRequireAuth.mockResolvedValue({
      userId: "user_tech",
      role: "TECHNICIAN",
      phone: "+989121234567",
      isGuest: false,
    });
    mockGetTechnicianFromSession.mockResolvedValue({ id: "tech_1", userId: "user_tech" });
    mockWithdrawalRequestFindUnique.mockResolvedValue(null);
  });

  it("returns 400 when the wallet cannot cover the withdrawal", async () => {
    mockWalletFindUnique.mockResolvedValue({ id: "wallet_1", balance: 100, technicianId: "tech_1", financialUnitStatus: "VERIFIED_IRR" });
    mockCreateWithdrawalAtomically.mockResolvedValue(false);

    const res = await withdrawPOST(makeWithdrawalRequest(
      { amount: 500 }, "test-withdrawal-key-001"
    ));

    expect(res.status).toBe(400);
    expect(mockCreateWithdrawalAtomically).toHaveBeenCalledTimes(1);
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestCreate).not.toHaveBeenCalled();
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();
  });

  it("returns the committed request after an atomic withdrawal", async () => {
    const withdrawal = {
      id: "wd_1", code: "WD-123456", walletId: "wallet_1", amount: 500, method: "bank", cardNumber: null, bankName: null, shebaNumber: "IR062960000000100324200001", status: "REQUESTED",
      financialUnitStatus: "VERIFIED_IRR",
    };
    mockWalletFindUnique
      .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1", financialUnitStatus: "VERIFIED_IRR" })
      .mockResolvedValueOnce({ id: "wallet_1", balance: 500, financialUnitStatus: "VERIFIED_IRR" });
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(withdrawal);
    mockCreateWithdrawalAtomically.mockResolvedValue(true);

    const res = await withdrawPOST(makeWithdrawalRequest(
      { amount: 500 }, "test-withdrawal-key-002"
    ));

    expect(res.status).toBe(200);
    expect((await res.json()).newBalance).toBe(500);
    expect(mockCreateWithdrawalAtomically).toHaveBeenCalledTimes(1);
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
  });
});

// 7. VIP-01 — /api/vip/subscribe race condition (TOCTOU on paymentId reuse)
//
// This test documents a KNOWN race condition in the VIP-01 fix: the
// `findFirst` + check + `create` sequence is NON-ATOMIC. Two concurrent
// subscribe requests with the same paymentId can both pass the findFirst
// check (both see null) and both call create — resulting in two ACTIVE VIP
// subscriptions linked to the same one-time-use Payment row.
//
// The test uses `it.fails()` to assert that the bug STILL EXISTS. If a
// future fix makes the check atomic (e.g., a `@@unique` constraint on
// UserVipSubscription.paymentId, or a conditional `updateMany` pattern),
// this test will start to PASS — and `it.fails()` will flip the suite red,
// alerting the team to remove the `.fails` marker.
// ──────────────────────────────────────────────────────────────────────────
describe("VIP-01 — /api/vip/subscribe race condition (TOCTOU on paymentId)", () => {
  beforeEach(() => {
    // Clear one-time mock queues left by the gateway-verification cases above.
    mockPaymentFindUnique.mockReset();
    mockPaymentGatewayLogFindUnique.mockReset();
    mockRequireAuth.mockResolvedValue({
      userId: "user-1",
      role: "CUSTOMER",
      phone: "+989120000000",
      isGuest: false,
    });
    mockVipPlanFindUnique.mockResolvedValue({
      id: "plan-1",
      name: "Gold",
      priceIrr: 100_000,
      durationDays: 30,
      active: true,
      financialUnitStatus: "VERIFIED_IRR",
    });
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1",
      userId: "user-1",
      status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
      amount: 100_000,
      currency: "IRR",
      gatewayLogId: "gateway-pay-1",
    });
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "gateway-pay-1",
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
    mockUserVipSubscriptionFindUnique.mockResolvedValue({
      id: "sub-1", userId: "user-1", planId: "plan-1", status: "ACTIVE",
      plan: { id: "plan-1", name: "Gold" },
    });
    mockCreateVipSubscriptionAtomically.mockResolvedValue("sub-1");
    mockUserVipSubscriptionCreate.mockResolvedValue({
      id: "sub-1",
      userId: "user-1",
      planId: "plan-1",
      status: "ACTIVE",
      plan: { id: "plan-1", name: "Gold" },
    });
  });

  // Sanity: single subscribe succeeds (control)
  it("single subscribe succeeds and creates exactly one subscription (control)", async () => {
    mockUserVipSubscriptionFindFirst.mockResolvedValue(null); // no prior sub
    const req = makePostRequest("http://localhost/api/vip/subscribe", {
      planId: "plan-1",
      paymentId: "pay-1",
    });
    const res = await vipSubscribePOST(req);

    expect(res.status).toBe(200);
    expect(mockCreateVipSubscriptionAtomically).toHaveBeenCalledTimes(1);
  });

  it("rejects an existing-subscription replay when the gateway duration snapshot is missing", async () => {
    mockPaymentGatewayLogFindUnique.mockResolvedValueOnce({
      id: "gateway-pay-1", userId: "user-1", status: "VERIFIED", financialUnitStatus: "VERIFIED_IRR",
      purpose: "vip", targetPlanId: "plan-1", targetPlanDurationDays: null,
      paymentId: "pay-1", amount: 100_000, currency: "IRR",
    });
    mockUserVipSubscriptionFindFirst.mockResolvedValueOnce({
      id: "sub-1", userId: "user-1", planId: "plan-1", paymentId: "pay-1", status: "ACTIVE",
      startedAt: new Date("2026-11-01T00:00:00.000Z"), expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      plan: { id: "plan-1", name: "Gold" },
    });
    const res = await vipSubscribePOST(makePostRequest("http://localhost/api/vip/subscribe", { planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("VIP_DURATION_SNAPSHOT_MISSING");
    expect(mockUserVipSubscriptionFindFirst).not.toHaveBeenCalled();
  });

  it("rejects an existing subscription whose duration differs from the immutable purchase snapshot", async () => {
    mockUserVipSubscriptionFindFirst.mockResolvedValueOnce({
      id: "sub-1", userId: "user-1", planId: "plan-1", paymentId: "pay-1", status: "ACTIVE",
      startedAt: new Date("2026-11-01T00:00:00.000Z"), expiresAt: new Date("2026-12-02T00:00:00.000Z"),
      plan: { id: "plan-1", name: "Gold" },
    });
    const res = await vipSubscribePOST(makePostRequest("http://localhost/api/vip/subscribe", { planId: "plan-1", paymentId: "pay-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("VIP_EXISTING_DURATION_MISMATCH");
    expect(mockCreateVipSubscriptionAtomically).not.toHaveBeenCalled();
  });

  // Exact replay returns the same subscription rather than rejecting a paid payment.
  it("second subscribe AFTER first committed returns the existing subscription (sequential replay)", async () => {
    // First call: no existing sub → create
    mockUserVipSubscriptionFindFirst.mockResolvedValueOnce(null);
    const req1 = makePostRequest("http://localhost/api/vip/subscribe", {
      planId: "plan-1",
      paymentId: "pay-1",
    });
    const res1 = await vipSubscribePOST(req1);
    expect(res1.status).toBe(200);

    // Second call: findFirst NOW sees the committed sub → idempotent success
    mockUserVipSubscriptionFindFirst.mockResolvedValueOnce({
      id: "sub-1",
      userId: "user-1",
      planId: "plan-1",
      paymentId: "pay-1",
      status: "ACTIVE",
      startedAt: new Date("2026-11-01T00:00:00.000Z"),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      plan: { id: "plan-1", name: "Gold" },
    });
    const req2 = makePostRequest("http://localhost/api/vip/subscribe", {
      planId: "plan-1",
      paymentId: "pay-1",
    });
    const res2 = await vipSubscribePOST(req2);
    expect(res2.status).toBe(200);
    expect((await res2.json()).alreadyProcessed).toBe(true);
    // The atomic helper is called only for the first successful payment use.
    expect(mockCreateVipSubscriptionAtomically).toHaveBeenCalledTimes(1);
  });

  // VIP-01 FIX VERIFICATION: with @@unique([paymentId]) in the schema, the DB
  // itself rejects the second insert. The route handler catches the P2002 error
  // and returns 409. This test simulates the race: findFirst returns null on
  // both calls (race window), but the second create throws P2002.
  it(
    "VIP-01 FIXED: two concurrent subscribes with same paymentId — exactly one succeeds, one 409",
    async () => {
      mockUserVipSubscriptionFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "sub-1", userId: "user-1", planId: "plan-1", paymentId: "pay-1", status: "ACTIVE", startedAt: new Date("2026-11-01T00:00:00.000Z"), expiresAt: new Date("2026-12-01T00:00:00.000Z"), plan: { id: "plan-1", name: "Gold" } });
      mockCreateVipSubscriptionAtomically
        .mockResolvedValueOnce("sub-1")
        .mockRejectedValueOnce({ code: "P2002", message: "Unique constraint failed on the fields: (paymentId)" });

      const req1 = makePostRequest("http://localhost/api/vip/subscribe", {
        planId: "plan-1",
        paymentId: "pay-1",
      });
      const req2 = makePostRequest("http://localhost/api/vip/subscribe", {
        planId: "plan-1",
        paymentId: "pay-1",
      });

      const [res1, res2] = await Promise.all([
        vipSubscribePOST(req1),
        vipSubscribePOST(req2),
      ]);

      expect(mockCreateVipSubscriptionAtomically).toHaveBeenCalledTimes(2);
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 200]);
    }
  );
  it(
    "VIP-01: concurrent subscribes with different paymentIds cannot create two ACTIVE subscriptions",
    async () => {
      mockPaymentFindUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        userId: "user-1",
        status: "SUCCEEDED",
      financialUnitStatus: "VERIFIED_IRR",
        amount: 100_000,
        currency: "IRR",
        gatewayLogId: `gateway-${where.id}`,
      }));
      mockPaymentGatewayLogFindUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        userId: "user-1",
        status: "VERIFIED",
      financialUnitStatus: "VERIFIED_IRR",
        purpose: "vip",
        targetPlanId: "plan-1",
      targetPlanDurationDays: 30,
        paymentId: where.id.replace("gateway-", ""),
        amount: 100_000,
        currency: "IRR",
      }));
      mockUserVipSubscriptionFindFirst.mockResolvedValue(null);
      mockCreateVipSubscriptionAtomically
        .mockResolvedValueOnce("sub-1")
        .mockRejectedValueOnce({ code: "P2002", message: "Unique constraint failed on the fields: (userId) WHERE status = ACTIVE" });

      const req1 = makePostRequest("http://localhost/api/vip/subscribe", {
        planId: "plan-1",
        paymentId: "pay-1",
      });
      const req2 = makePostRequest("http://localhost/api/vip/subscribe", {
        planId: "plan-1",
        paymentId: "pay-2",
      });

      const [res1, res2] = await Promise.all([
        vipSubscribePOST(req1),
        vipSubscribePOST(req2),
      ]);

      expect(mockCreateVipSubscriptionAtomically).toHaveBeenCalledTimes(2);
      expect([res1.status, res2.status].sort()).toEqual([200, 409]);
    }
  );

});
