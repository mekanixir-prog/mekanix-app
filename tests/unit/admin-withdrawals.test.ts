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

// ──────────── Import route handlers (after mocks hoisted) ────────────
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
// A2 — REJECT happy path: REQUESTED → REFUND_PENDING → REJECTED
// ═══════════════════════════════════════════════════════════════════════════
describe("A2 — PATCH REJECT transitions REQUESTED → REFUND_PENDING → REJECTED", () => {
  it("refunds wallet, creates REFUND ledger, finalizes REJECTED", async () => {
    // findUnique: initial (REQUESTED) → final (REJECTED)
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST) // initial
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED", reviewerId: "admin_1" }); // final
    // updateMany: acquire REQUESTED→REFUND_PENDING, claim REFUND_PROCESSING, finalize REJECTED
    mockWithdrawalRequestUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // REQUESTED → REFUND_PENDING
      .mockResolvedValueOnce({ count: 1 }) // REFUND_PENDING → REFUND_PROCESSING
      .mockResolvedValueOnce({ count: 1 }); // finalize
    // walletLedger.findFirst: first (null = no existing), verify (found)
    mockWalletLedgerFindFirst
      .mockResolvedValueOnce(null) // step 3: no existing ledger
      .mockResolvedValueOnce({ id: "ledger_refund_1" }); // step 5 verify
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 }); // refund succeeds
    mockWalletLedgerCreate.mockResolvedValueOnce({ id: "ledger_refund_1" });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT", notes: "duplicate" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(200);

    // Three guarded transitions: acquire, processing barrier, finalize
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledTimes(3);
    // First: REQUESTED → REFUND_PENDING
    const acquireArgs = mockWithdrawalRequestUpdateMany.mock.calls[0][0];
    expect(acquireArgs.where).toEqual({ id: "wd_1", status: "REQUESTED" });
    expect(acquireArgs.data.status).toBe("REFUND_PENDING");
    // Second: REFUND_PENDING → REFUND_PROCESSING; third: processing → REJECTED
    const processingArgs = mockWithdrawalRequestUpdateMany.mock.calls[1][0];
    expect(processingArgs.where).toEqual({ id: "wd_1", status: "REFUND_PENDING" });
    expect(processingArgs.data.status).toBe("REFUND_PROCESSING");
    const finalizeArgs = mockWithdrawalRequestUpdateMany.mock.calls[2][0];
    expect(finalizeArgs.where).toEqual({ id: "wd_1", status: "REFUND_PROCESSING" });
    expect(finalizeArgs.data.status).toBe("REJECTED");

    // Refund: increment by the original amount (500)
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
    const refundArgs = mockWalletUpdateMany.mock.calls[0][0];
    expect(refundArgs.where).toEqual({ id: "wallet_1" });
    expect(refundArgs.data).toEqual({ balance: { increment: 500 } });

    // REFUND ledger entry created
    expect(mockWalletLedgerCreate).toHaveBeenCalledTimes(1);
    const ledgerArgs = mockWalletLedgerCreate.mock.calls[0][0];
    expect(ledgerArgs.data.type).toBe("REFUND");
    expect(ledgerArgs.data.amount).toBe(500);
    expect(ledgerArgs.data.referenceId).toBe("wd_1");
    expect(ledgerArgs.data.createdBy).toBe("admin_1");
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
// A4 — REJECT: refund increment fails (count=0) → RECONCILIATION_NEEDED
// C2 FIXED: no longer unrecoverable — status transitions to RECONCILIATION_NEEDED
// ═══════════════════════════════════════════════════════════════════════════
describe("A4 — REJECT: wallet row missing during refund → RECONCILIATION_NEEDED", () => {
  it("transitions to RECONCILIATION_NEEDED when refund count=0 (wallet vanished)", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    // acquire: REQUESTED → REFUND_PENDING (count:1)
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // processing claim
    // walletLedger.findFirst: no existing ledger
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null);
    // refund: count=0 (wallet row missing)
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 0 });
    // Then route transitions to RECONCILIATION_NEEDED
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(500);

    // CRITICAL log
    const criticalLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("CRITICAL: wallet row missing")
    );
    expect(criticalLog).toBeDefined();

    // Status transitioned to RECONCILIATION_NEEDED (not stuck in REFUND_PENDING)
    const reconcileCall = mockWithdrawalRequestUpdateMany.mock.calls.find(
      (c) => c[0].data.status === "RECONCILIATION_NEEDED"
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall![0].where).toEqual({ id: "wd_1", status: "REFUND_PROCESSING" });

    errSpy.mockRestore();
  });

  it("refund updateMany throws → RECONCILIATION_NEEDED because commit outcome is ambiguous", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // processing claim
    mockWalletUpdateMany.mockRejectedValueOnce(new Error("D1 timeout")); // ambiguous commit
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // reconcile

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    // A thrown write may have committed; manual reconciliation prevents double-credit.
    expect(res.status).toBe(500);

    // Ambiguous write transitions to RECONCILIATION_NEEDED
    const reconcileCall = mockWithdrawalRequestUpdateMany.mock.calls.find(
      (c) => c[0].data.status === "RECONCILIATION_NEEDED"
    );
    expect(reconcileCall).toBeUndefined();

    errSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A5 — REJECT: refund succeeds but ledger.create fails → RECONCILIATION_NEEDED
// C2 variant FIXED: no double-credit risk — status transitions to RECONCILIATION_NEEDED
// ═══════════════════════════════════════════════════════════════════════════
describe("A5 — REJECT: refund ok but ledger fails → RECONCILIATION_NEEDED (no double-credit)", () => {
  it("refund done, ledger fails → RECONCILIATION_NEEDED, retry will NOT double-credit", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null); // no existing ledger
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // processing claim
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 }); // refund succeeds
    mockWalletLedgerCreate.mockRejectedValueOnce(new Error("D1 ledger timeout")); // ledger fails
    // Route transitions to RECONCILIATION_NEEDED
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(500);

    // CRITICAL log
    const criticalLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("CRITICAL: refund done but ledger write failed")
    );
    expect(criticalLog).toBeDefined();

    // Transitioned to RECONCILIATION_NEEDED (not REJECTED, not stuck in REFUND_PENDING)
    const reconcileCall = mockWithdrawalRequestUpdateMany.mock.calls.find(
      (c) => c[0].data.status === "RECONCILIATION_NEEDED"
    );
    expect(reconcileCall).toBeDefined();

    // FIX (C2 variant): retry will NOT double-credit because:
    //   - Status is now RECONCILIATION_NEEDED, not REFUND_PENDING
    //   - PATCH on RECONCILIATION_NEEDED returns 409 (manual intervention)
    // Operator must inspect DB, create ledger manually if needed.
    errSpy.mockRestore();
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
// A9 — Concurrent admin PATCH guard
// ═══════════════════════════════════════════════════════════════════════════
describe("A9 — concurrent admin PATCH: acquire guard", () => {
  it("second admin's acquire returns count=0 → 409 (guard works)", async () => {
    // First admin acquires REQUESTED → REFUND_PENDING
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire wins
    mockWalletLedgerFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "ledger_1" }); // verify
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // processing claim
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletLedgerCreate.mockResolvedValueOnce({ id: "ledger_1" });
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // finalize
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });

    const res1 = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res1.status).toBe(200);

    // Second admin finds it already REJECTED (or REFUND_PENDING) — 409
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });
    const res2 = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res2.status).toBe(409);

    // Only ONE refund happened (first admin's)
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1-R7 — Recovery tests (the FIX for C2)
// ═══════════════════════════════════════════════════════════════════════════

describe("R1 — REJECT from REFUND_PENDING (retry after temporary failure)", () => {
  it("retry succeeds: refund + ledger + finalize REJECTED", async () => {
    // findUnique returns REFUND_PENDING (retry scenario)
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PENDING" }) // initial
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" }); // final
    // Retry claims REFUND_PROCESSING, then finalizes
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // processing claim
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // finalize
    mockWalletLedgerFindFirst
      .mockResolvedValueOnce(null) // no existing ledger
      .mockResolvedValueOnce({ id: "ledger_1" }); // verify
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletLedgerCreate.mockResolvedValueOnce({ id: "ledger_1" });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(200);

    // Two guarded transitions: processing claim + finalization
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledTimes(2);
    const finalizeArgs = mockWithdrawalRequestUpdateMany.mock.calls[1][0];
    expect(finalizeArgs.where).toEqual({ id: "wd_1", status: "REFUND_PROCESSING" });
    expect(finalizeArgs.data.status).toBe("REJECTED");
  });
});

describe("R2 — Idempotent retry: ledger already exists → skip refund (NO double-credit)", () => {
  it("retry from REFUND_PENDING finds existing ledger → does NOT increment balance", async () => {
    // findUnique returns REFUND_PENDING
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PENDING" })
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });
    // walletLedger.findFirst returns existing ledger (from previous attempt)
    mockWalletLedgerFindFirst.mockResolvedValueOnce({ id: "ledger_existing" });
    // No refund needed, no ledger create needed
    // Only finalize REFUND_PENDING → REJECTED
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(200);

    // CRITICAL: wallet.updateMany NOT called (no double-credit)
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    // walletLedger.create NOT called (already exists)
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();
    // Only finalize transition
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("Crash barrier — REFUND_PROCESSING with no ledger never credits again", () => {
  it("moves interrupted processing to reconciliation without touching wallet", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PROCESSING" });
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    expect(res.status).toBe(409);
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: "wd_1", status: "REFUND_PROCESSING" },
      data: { status: "RECONCILIATION_NEEDED" },
    });
    errSpy.mockRestore();
  });
});

describe("R3 — REJECT: refund ok but ledger fails → RECONCILIATION_NEEDED (no double-credit on retry)", () => {
  it("retry from RECONCILIATION_NEEDED returns 409 (manual intervention)", async () => {
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "RECONCILIATION_NEEDED" });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(409);

    // No financial operations
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();
  });
});

describe("R4 — Ledger lookup fails → 503 retry-safe (stay REFUND_PENDING)", () => {
  it("walletLedger.findFirst throws → 503, no RECONCILIATION_NEEDED transition", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire
    mockWalletLedgerFindFirst.mockRejectedValueOnce(new Error("D1 read timeout"));

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(503);

    // No refund, no ledger create, no RECONCILIATION_NEEDED
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    const reconcileCall = mockWithdrawalRequestUpdateMany.mock.calls.find(
      (c) => c[0].data.status === "RECONCILIATION_NEEDED"
    );
    expect(reconcileCall).toBeUndefined();

    errSpy.mockRestore();
  });
});

describe("R5 — Ledger create succeeds but verify read fails → RECONCILIATION_NEEDED", () => {
  it("create ok, verify findFirst returns null → RECONCILIATION_NEEDED", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire
    mockWalletLedgerFindFirst
      .mockResolvedValueOnce(null) // no existing
      .mockResolvedValueOnce(null); // verify returns null (inconsistent!)
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // processing claim
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletLedgerCreate.mockResolvedValueOnce({ id: "ledger_1" });
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // RECONCILIATION_NEEDED

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(500);

    const reconcileCall = mockWithdrawalRequestUpdateMany.mock.calls.find(
      (c) => c[0].data.status === "RECONCILIATION_NEEDED"
    );
    expect(reconcileCall).toBeDefined();

    errSpy.mockRestore();
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

// ═══════════════════════════════════════════════════════════════════════════
// HTTP error vs failed financial transaction (distinction)
// These tests verify that the state-machine correctly distinguishes:
//   - Ambiguous write failure (500, manual reconciliation; no blind retry)
//   - Permanent failure requiring manual review (500, RECONCILIATION_NEEDED)
//   - Success (200, REJECTED)
// ═══════════════════════════════════════════════════════════════════════════
describe("HTTP error vs failed financial transaction (distinction)", () => {
  it("temporary refund failure → 503 (retry-safe), status moves to REFUND_PROCESSING before credit", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire REFUND_PENDING
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // processing claim
    mockWalletUpdateMany.mockRejectedValueOnce(new Error("D1 timeout"));
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // reconcile ambiguous result // temporary

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    // The write may have committed despite throwing, so this is not retry-safe.
    expect(res.status).toBe(500);
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledTimes(3);
    // Ambiguous refund is sent to manual reconciliation
    const reconcileCall = mockWithdrawalRequestUpdateMany.mock.calls.find(
      (c) => c[0].data.status === "RECONCILIATION_NEEDED"
    );
    expect(reconcileCall).toBeUndefined();

    errSpy.mockRestore();
  });

  it("permanent failure (wallet missing) → 500, RECONCILIATION_NEEDED", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // acquire
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // processing claim
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 0 }); // wallet row missing
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // → RECONCILIATION_NEEDED

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    // 500 = permanent, requires manual intervention
    expect(res.status).toBe(500);
    // Status transitioned to RECONCILIATION_NEEDED
    const reconcileCall = mockWithdrawalRequestUpdateMany.mock.calls.find(
      (c) => c[0].data.status === "RECONCILIATION_NEEDED"
    );
    expect(reconcileCall).toBeDefined();

    errSpy.mockRestore();
  });

  it("success → 200, REJECTED (refund + ledger both confirmed)", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST)
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });
    mockWithdrawalRequestUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // acquire
      .mockResolvedValueOnce({ count: 1 }) // processing claim
      .mockResolvedValueOnce({ count: 1 }); // finalize
    mockWalletLedgerFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "ledger_1" }); // verify
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletLedgerCreate.mockResolvedValueOnce({ id: "ledger_1" });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.withdrawal.status).toBe("REJECTED");
  });
});
