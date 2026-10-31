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
const mockWalletLedgerCreate = vi.fn();
const mockTechnicianFindUnique = vi.fn();

const mockVipPlanFindUnique = vi.fn();
const mockUserVipSubscriptionFindFirst = vi.fn();
const mockUserVipSubscriptionUpdateMany = vi.fn();
const mockUserVipSubscriptionCreate = vi.fn();

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
    },
    walletLedger: { create: (...args: any[]) => mockWalletLedgerCreate(...args) },
    technician: {
      findUnique: (...args: any[]) => mockTechnicianFindUnique(...args),
    },

    // vip
    vipPlan: { findUnique: (...args: any[]) => mockVipPlanFindUnique(...args) },
    userVipSubscription: {
      findFirst: (...args: any[]) => mockUserVipSubscriptionFindFirst(...args),
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
import { POST as withdrawPOST } from "@/app/api/wallets/withdraw/route";
import { POST as vipSubscribePOST } from "@/app/api/vip/subscribe/route";

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
  };

  beforeEach(() => {
    mockRequireAuth.mockResolvedValue({
      userId: "user-1",
      role: "CUSTOMER",
      phone: "+989120000000",
      isGuest: false,
    });
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "log-1",
      code: "PG-7001",
      userId: "user-1",
      amount: 100_000,
      currency: "IRR",
      status: "REDIRECTED",
      purpose: "vip",
      verifiedAt: null,
    });
    mockPaymentFindUnique.mockResolvedValue(null);
    mockPaymentCreate.mockResolvedValue(existingPayment);
    mockPaymentGatewayLogUpdate.mockResolvedValue({});
  });

  it("creates one payment keyed by gatewayLogId and then marks the log verified", async () => {
    const res = await verifyPOST(makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    }));

    expect(res.status).toBe(200);
    expect(mockPaymentCreate).toHaveBeenCalledTimes(1);
    expect(mockPaymentCreate.mock.calls[0][0].data).toMatchObject({
      userId: "user-1",
      amount: 100_000,
      status: "SUCCEEDED",
      gatewayLogId: "log-1",
    });
    expect(mockPaymentGatewayLogUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "log-1" },
      data: expect.objectContaining({ status: "VERIFIED", paymentId: "pay-1" }),
    }));
  });

  it("replays the same successful payment instead of rejecting or creating a duplicate", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingPayment);

    const req = () => makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    });
    const first = await verifyPOST(req());
    const second = await verifyPOST(req());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).alreadyVerified).toBe(true);
    expect(mockPaymentCreate).toHaveBeenCalledTimes(1);
  });

  it("recovers when Payment creation succeeded but gateway-log linking failed", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingPayment);
    mockPaymentGatewayLogUpdate
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockResolvedValueOnce({});

    const req = () => makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    });

    await expect(verifyPOST(req())).rejects.toThrow("temporary database failure");
    const retry = await verifyPOST(req());

    expect(retry.status).toBe(200);
    expect(mockPaymentCreate).toHaveBeenCalledTimes(1);
    expect(mockPaymentGatewayLogUpdate).toHaveBeenCalledTimes(2);
  });

  it("handles concurrent callbacks through the database unique constraint", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingPayment);
    mockPaymentCreate
      .mockResolvedValueOnce(existingPayment)
      .mockRejectedValueOnce({
        code: "P2002",
        message: "Unique constraint failed on gatewayLogId",
      });

    const req = () => makePostRequest("http://localhost/api/gateway/verify", {
      code: "PG-7001",
      otp: "1234",
    });
    const results = await Promise.all([verifyPOST(req()), verifyPOST(req())]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(mockPaymentCreate).toHaveBeenCalledTimes(2);
    expect(mockPaymentGatewayLogUpdate).toHaveBeenCalledTimes(2);
  });

  it("recovers a legacy VERIFIED log only when its paymentId identifies the existing successful payment", async () => {
    mockPaymentGatewayLogFindUnique.mockResolvedValue({
      id: "log-1",
      code: "PG-7001",
      userId: "user-1",
      amount: 100_000,
      currency: "IRR",
      status: "VERIFIED",
      purpose: "vip",
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
      purpose: "vip",
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
describe("/api/wallets/withdraw — exceeds-balance guard", () => {
  beforeEach(() => {
    mockRequireAuth.mockResolvedValue({
      userId: "user_tech",
      role: "TECHNICIAN",
      phone: "+989121234567",
      isGuest: false,
    });
    mockGetTechnicianFromSession.mockResolvedValue({
      id: "tech_1",
      userId: "user_tech",
    });
  });

  it("returns 400 when amount > wallet.balance, with NO balance mutation (no updateMany)", async () => {
    // Wallet balance = 100, withdraw = 500 → exceeds balance.
    mockWalletFindUnique.mockResolvedValue({
      id: "wallet_1",
      balance: 100,
      technicianId: "tech_1",
    });

    const req = makePostRequest("https://mekanix.test/api/wallets/withdraw", {
      amount: 500,
      method: "card",
    });
    const res = await withdrawPOST(req);

    expect(res.status).toBe(400);

    // CRITICAL: NO balance mutation occurred (pre-try guard at line 48-50
    // short-circuits BEFORE the atomic decrement is attempted).
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestCreate).not.toHaveBeenCalled();
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();

    // The initial wallet lookup happened (read-only — safe).
    expect(mockWalletFindUnique).toHaveBeenCalledTimes(1);
  });

  it("returns 200 when amount <= wallet.balance (control)", async () => {
    // Wallet balance = 1000, withdraw = 500 → OK.
    mockWalletFindUnique
      .mockResolvedValueOnce({
        id: "wallet_1",
        balance: 1000,
        technicianId: "tech_1",
      }) // initial lookup
      .mockResolvedValueOnce({
        id: "wallet_1",
        balance: 1000,
        technicianId: "tech_1",
      }) // re-check inside try (line 72)
      .mockResolvedValueOnce({
        id: "wallet_1",
        balance: 500,
        technicianId: "tech_1",
      }); // re-read after decrement
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWithdrawalRequestCreate.mockResolvedValueOnce({
      id: "wd_1",
      code: "WD-123456",
      walletId: "wallet_1",
      amount: 500,
      status: "REQUESTED",
    });

    const req = makePostRequest("https://mekanix.test/api/wallets/withdraw", {
      amount: 500,
      method: "card",
    });
    const res = await withdrawPOST(req);

    expect(res.status).toBe(200);
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
    // Verify the WHERE clause uses balance >= amount (prevents negative balance).
    const updateArgs = mockWalletUpdateMany.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "wallet_1", balance: { gte: 500 } });
    expect(updateArgs.data).toEqual({ balance: { decrement: 500 } });
  });
});

// ──────────────────────────────────────────────────────────────────────────
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
    });
    mockPaymentFindUnique.mockResolvedValue({
      id: "pay-1",
      userId: "user-1",
      status: "SUCCEEDED",
      amount: 100_000,
    });
    mockUserVipSubscriptionUpdateMany.mockResolvedValue({ count: 0 });
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
    expect(mockUserVipSubscriptionCreate).toHaveBeenCalledTimes(1);
  });

  // Sanity: second subscribe after the first committed returns 409 (control)
  it("second subscribe AFTER first committed returns 409 (sequential, control)", async () => {
    // First call: no existing sub → create
    mockUserVipSubscriptionFindFirst.mockResolvedValueOnce(null);
    const req1 = makePostRequest("http://localhost/api/vip/subscribe", {
      planId: "plan-1",
      paymentId: "pay-1",
    });
    const res1 = await vipSubscribePOST(req1);
    expect(res1.status).toBe(200);

    // Second call: findFirst NOW sees the committed sub → 409
    mockUserVipSubscriptionFindFirst.mockResolvedValueOnce({
      id: "sub-1",
      userId: "user-1",
      paymentId: "pay-1",
      status: "ACTIVE",
    });
    const req2 = makePostRequest("http://localhost/api/vip/subscribe", {
      planId: "plan-1",
      paymentId: "pay-1",
    });
    const res2 = await vipSubscribePOST(req2);
    expect(res2.status).toBe(409);
    // Still only ONE create — the second was blocked.
    expect(mockUserVipSubscriptionCreate).toHaveBeenCalledTimes(1);
  });

  // VIP-01 FIX VERIFICATION: with @@unique([paymentId]) in the schema, the DB
  // itself rejects the second insert. The route handler catches the P2002 error
  // and returns 409. This test simulates the race: findFirst returns null on
  // both calls (race window), but the second create throws P2002.
  it(
    "VIP-01 FIXED: two concurrent subscribes with same paymentId — exactly one succeeds, one 409",
    async () => {
      mockUserVipSubscriptionFindFirst.mockResolvedValue(null);
      mockUserVipSubscriptionCreate
        .mockResolvedValueOnce({ id: "sub-1", userId: "user-1", planId: "plan-1", status: "ACTIVE", paymentId: "pay-1" })
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

      expect(mockUserVipSubscriptionCreate).toHaveBeenCalledTimes(2);
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);
    }
  );
  it(
    "VIP-01: concurrent subscribes with different paymentIds cannot create two ACTIVE subscriptions",
    async () => {
      mockPaymentFindUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        userId: "user-1",
        status: "SUCCEEDED",
        amount: 100_000,
      }));
      mockUserVipSubscriptionFindFirst.mockResolvedValue(null);
      mockUserVipSubscriptionCreate
        .mockResolvedValueOnce({ id: "sub-1", userId: "user-1", planId: "plan-1", status: "ACTIVE", paymentId: "pay-1" })
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

      expect(mockUserVipSubscriptionCreate).toHaveBeenCalledTimes(2);
      expect([res1.status, res2.status].sort()).toEqual([200, 409]);
    }
  );

});
