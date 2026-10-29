// @vitest-environment node
// MEKANIX — Admin Withdrawal Routes Test Suite (PR #4 review — Task ID: 3)
// ============================================================================
// Documents the ACTUAL behavior of:
//   - GET  /api/admin/withdrawals        (list)
//   - PATCH /api/admin/withdrawals/[id]  (approve / reject + refund)
//
// Focus: failure paths, concurrency guards, and the distinction between
// HTTP error response and failed financial transaction.
//
// Scenarios A1–A10 (per agreed plan, with reviewer's additions A9/A10).
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────── Module-level mocks ────────────
const mockWithdrawalRequestFindUnique = vi.fn();
const mockWithdrawalRequestFindMany = vi.fn();
const mockWithdrawalRequestUpdateMany = vi.fn();
const mockWalletUpdateMany = vi.fn();
const mockWalletLedgerCreate = vi.fn();
const mockWalletLedgerFindFirst = vi.fn();
const mockExecuteAtomicRefund = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    withdrawalRequest: {
      findUnique: (...args: any[]) => mockWithdrawalRequestFindUnique(...args),
      findMany: (...args: any[]) => mockWithdrawalRequestFindMany(...args),
      updateMany: (...args: any[]) => mockWithdrawalRequestUpdateMany(...args),
    },
    wallet: {
      updateMany: (...args: any[]) => mockWalletUpdateMany(...args),
    },
    walletLedger: {
      create: (...args: any[]) => mockWalletLedgerCreate(...args),
      findFirst: (...args: any[]) => mockWalletLedgerFindFirst(...args),
    },
  })),
}));

// Mock admin auth — returns a valid admin session by default
const mockGetAdminFromRequest = vi.fn().mockResolvedValue({
  adminId: "admin_1",
  username: "admin",
  role: "SUPER_ADMIN",
});

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: (...args: any[]) => mockGetAdminFromRequest(...args),
}));

// Mock atomic-refund helper
vi.mock("@/lib/atomic-refund", () => ({
  executeAtomicRefund: (...args: any[]) => mockExecuteAtomicRefund(...args),
}));
import { PATCH } from "@/app/api/admin/withdrawals/[id]/route";
import { GET } from "@/app/api/admin/withdrawals/route";

// ──────────── Helpers ────────────
function patchReq(id: string, body: unknown, authed = true): Request {
  return new Request(`https://mekanix.test/api/admin/withdrawals/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(authed ? { authorization: "Bearer admin-token" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getReq(search = "", authed = true): Request {
  const qs = search ? `?${search}` : "";
  return new Request(`https://mekanix.test/api/admin/withdrawals${qs}`, {
    method: "GET",
    headers: { ...(authed ? { authorization: "Bearer admin-token" } : {}) },
  });
}

const SAMPLE_REQUEST = {
  id: "wd_1",
  code: "WD-123456",
  walletId: "wallet_1",
  amount: 500,
  method: "card",
  status: "REQUESTED",
  requestedAt: new Date("2026-01-01T00:00:00Z"),
  processedAt: null,
  reviewerId: null,
  adminNotes: null,
};

function muteConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish default admin auth (in case a test overrode it)
  mockGetAdminFromRequest.mockResolvedValue({ adminId: "admin_1", username: "admin", role: "SUPER_ADMIN" });
  // Default: no existing refund ledger (first attempt)
  mockWalletLedgerFindFirst.mockResolvedValue(null);
  // Default: atomic refund succeeds (happy path)
  mockExecuteAtomicRefund.mockResolvedValue({
    success: true,
    refundLedgerId: "ledger_refund_1",
    newBalance: 1500,
    alreadyRefunded: false,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A1 — APPROVE happy path
// ═══════════════════════════════════════════════════════════════════════════
describe("A1 — PATCH APPROVE transitions REQUESTED → APPROVED", () => {
  it("commits status, sets reviewerId, returns updated withdrawal (no refund)", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST) // initial findUnique
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "APPROVED", reviewerId: "admin_1" }); // final findUnique
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });

    const res = await PATCH(patchReq("wd_1", { action: "APPROVE" }), { params: Promise.resolve({ id: "wd_1" }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.withdrawal.status).toBe("APPROVED");

    // Transition guard: WHERE includes status: "REQUESTED"
    const updateArgs = mockWithdrawalRequestUpdateMany.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "wd_1", status: "REQUESTED" });
    expect(updateArgs.data.status).toBe("APPROVED");
    expect(updateArgs.data.reviewerId).toBe("admin_1");

    // APPROVE does NOT refund
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2 — REJECT happy path: REQUESTED → REFUND_PENDING → atomic refund → REJECTED
// ═══════════════════════════════════════════════════════════════════════════
describe("A2 — PATCH REJECT transitions REQUESTED → REFUND_PENDING → REJECTED", () => {
  it("acquires REFUND_PENDING, calls executeAtomicRefund, returns REJECTED", async () => {
    // findUnique: initial (REQUESTED) → final (REJECTED)
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST) // initial
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED", reviewerId: "admin_1" }); // final
    // updateMany: acquire (REQUESTED→REFUND_PENDING) = count:1
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });
    // executeAtomicRefund is mocked in beforeEach to return success

    const res = await PATCH(patchReq("wd_1", { action: "REJECT", notes: "duplicate" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.withdrawal.status).toBe("REJECTED");
    expect(body.refund.success).toBe(true);
    expect(body.refund.alreadyRefunded).toBe(false);
    expect(body.refund.newBalance).toBe(1500);

    // Only ONE updateMany on withdrawalRequest: acquire (REQUESTED → REFUND_PENDING)
    // The finalization (REFUND_PENDING → REJECTED) happens inside executeAtomicRefund
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledTimes(1);
    const acquireArgs = mockWithdrawalRequestUpdateMany.mock.calls[0][0];
    expect(acquireArgs.where).toEqual({ id: "wd_1", status: "REQUESTED" });
    expect(acquireArgs.data.status).toBe("REFUND_PENDING");

    // executeAtomicRefund was called with correct args
    expect(mockExecuteAtomicRefund).toHaveBeenCalledTimes(1);
    const refundArgs = mockExecuteAtomicRefund.mock.calls[0][0];
    expect(refundArgs.withdrawalId).toBe("wd_1");
    expect(refundArgs.walletId).toBe("wallet_1");
    expect(refundArgs.amount).toBe(500);
    expect(refundArgs.reviewerId).toBe("admin_1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A3 — Transition guards for various statuses
// ═══════════════════════════════════════════════════════════════════════════
describe("A3 — PATCH on non-acquirable status returns 409", () => {
  it("rejects APPROVED (already approved, cannot reject)", async () => {
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "APPROVED" });
    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(409);
    expect(mockWithdrawalRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects REJECTED (already completed)", async () => {
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });
    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(409);
  });

  it("rejects RECONCILIATION_NEEDED (manual intervention required)", async () => {
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "RECONCILIATION_NEEDED" });
    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A4 — REJECT: atomic refund throws → RECONCILIATION_NEEDED
// ═══════════════════════════════════════════════════════════════════════════
describe("A4 — REJECT: atomic refund fails → RECONCILIATION_NEEDED", () => {
  it("executeAtomicRefund throws → status transitions to RECONCILIATION_NEEDED", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST) // initial
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PENDING" }); // after error
    mockWithdrawalRequestUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // acquire
      .mockResolvedValueOnce({ count: 1 }); // transition to RECONCILIATION_NEEDED
    // executeAtomicRefund throws
    mockExecuteAtomicRefund.mockRejectedValueOnce(new Error("D1 batch failed"));

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(500);

    // CRITICAL log
    const errorLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("Atomic refund failed")
    );
    expect(errorLog).toBeDefined();

    // Status transitioned to RECONCILIATION_NEEDED
    const reconcileCall = mockWithdrawalRequestUpdateMany.mock.calls.find(
      (c) => c[0].data.status === "RECONCILIATION_NEEDED"
    );
    expect(reconcileCall).toBeDefined();

    errSpy.mockRestore();
  });

  it("executeAtomicRefund throws but status already REJECTED → return success (race won by another)", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST) // initial
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED", reviewerId: "admin_2" }); // after error
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire
    mockExecuteAtomicRefund.mockRejectedValueOnce(new Error("race lost"));

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.withdrawal.status).toBe("REJECTED");
    expect(body.message).toContain("مدیر دیگری");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A5 — REJECT: atomic refund already refunded → idempotent response
// ═══════════════════════════════════════════════════════════════════════════
describe("A5 — REJECT: already refunded → idempotent response (no double-refund)", () => {
  it("executeAtomicRefund returns alreadyRefunded=true → success without double-credit", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PENDING" }) // initial
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED", reviewerId: "admin_1" }); // final
    mockExecuteAtomicRefund.mockResolvedValueOnce({
      success: true,
      refundLedgerId: "ledger_existing",
      newBalance: 1500,
      alreadyRefunded: true,
    });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refund.alreadyRefunded).toBe(true);
    expect(body.refund.newBalance).toBe(1500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A6 — Invalid action → 400
// ═══════════════════════════════════════════════════════════════════════════
describe("A6 — PATCH with invalid action returns 400", () => {
  it("rejects unknown action values", async () => {
    const res = await PATCH(patchReq("wd_1", { action: "DELETE" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(400);

    expect(mockWithdrawalRequestFindUnique).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestUpdateMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A7 — Unauthenticated → 401
// ═══════════════════════════════════════════════════════════════════════════
describe("A7 — PATCH without admin auth returns 401", () => {
  it("rejects unauthenticated requests before any DB call", async () => {
    mockGetAdminFromRequest.mockResolvedValueOnce(null);

    const res = await PATCH(patchReq("wd_1", { action: "APPROVE" }, false), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(401);

    expect(mockWithdrawalRequestFindUnique).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A8 — Notes too long → 400
// ═══════════════════════════════════════════════════════════════════════════
describe("A8 — PATCH with notes > 1000 chars returns 400", () => {
  it("validates notes length", async () => {
    const longNotes = "x".repeat(1001);
    const res = await PATCH(patchReq("wd_1", { action: "APPROVE", notes: longNotes }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(400);

    expect(mockWithdrawalRequestFindUnique).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A9 — Concurrent admin PATCH: acquire guard
// ═══════════════════════════════════════════════════════════════════════════
describe("A9 — concurrent admin PATCH: acquire guard", () => {
  it("second admin finds REJECTED → 409, only one executeAtomicRefund call", async () => {
    // First admin: REQUESTED → REFUND_PENDING → REJECTED (via helper)
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST)
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire

    const res1 = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res1.status).toBe(200);

    // Second admin: finds REJECTED → 409
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });
    const res2 = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res2.status).toBe(409);

    // Only ONE executeAtomicRefund call (first admin's)
    expect(mockExecuteAtomicRefund).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1 — REFUND_PENDING can be rejected (helper handles idempotency)
// ═══════════════════════════════════════════════════════════════════════════
describe("R1 — REFUND_PENDING REJECT calls executeAtomicRefund", () => {
  it("REJECT on REFUND_PENDING proceeds to atomic refund", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PENDING" })
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(200);
    expect(mockExecuteAtomicRefund).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R2 — RECONCILIATION_NEEDED: REJECT blocked
// ═══════════════════════════════════════════════════════════════════════════
describe("R2 — RECONCILIATION_NEEDED returns 409", () => {
  it("REJECT on RECONCILIATION_NEEDED returns 409, no financial ops", async () => {
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "RECONCILIATION_NEEDED" });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(409);
    expect(mockExecuteAtomicRefund).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET endpoint — basic coverage
// ═══════════════════════════════════════════════════════════════════════════
describe("GET /api/admin/withdrawals", () => {
  it("returns 401 without admin auth", async () => {
    mockGetAdminFromRequest.mockResolvedValueOnce(null);

    const res = await GET(getReq("", false));
    expect(res.status).toBe(401);
    expect(mockWithdrawalRequestFindMany).not.toHaveBeenCalled();
  });

  it("returns list with default (no status filter)", async () => {
    mockWithdrawalRequestFindMany.mockResolvedValueOnce([SAMPLE_REQUEST]);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);

    // findMany called without where filter
    const args = mockWithdrawalRequestFindMany.mock.calls[0][0];
    expect(args.where).toBeUndefined();
    expect(args.take).toBe(100);
    expect(args.orderBy).toEqual({ requestedAt: "desc" });
  });

  it("filters by status when provided", async () => {
    mockWithdrawalRequestFindMany.mockResolvedValueOnce([]);
    await GET(getReq("status=REQUESTED"));
    const args = mockWithdrawalRequestFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: "REQUESTED" });
  });

  it("rejects invalid status filter", async () => {
    const res = await GET(getReq("status=BOGUS"));
    expect(res.status).toBe(400);
    expect(mockWithdrawalRequestFindMany).not.toHaveBeenCalled();
  });
});
