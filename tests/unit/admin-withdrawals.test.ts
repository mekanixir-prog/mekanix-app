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
// A2 — REJECT happy path (refund + ledger)
// ═══════════════════════════════════════════════════════════════════════════
describe("A2 — PATCH REJECT transitions REQUESTED → REJECTED and refunds", () => {
  it("commits status, refunds wallet balance, creates REFUND ledger entry", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST)
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED", reviewerId: "admin_1" });
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletLedgerCreate.mockResolvedValueOnce({ id: "ledger_refund_1" });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT", notes: "duplicate" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(200);

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
// A3 — Transition guard: non-REQUESTED status → 409
// ═══════════════════════════════════════════════════════════════════════════
describe("A3 — PATCH on non-REQUESTED withdrawal returns 409", () => {
  it("rejects when status is already APPROVED (no second transition)", async () => {
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "APPROVED" });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(409);

    // No mutation attempted
    expect(mockWithdrawalRequestUpdateMany).not.toHaveBeenCalled();
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A4 — REJECT: refund updateMany fails → C2 unrecoverable state confirmed
// ═══════════════════════════════════════════════════════════════════════════
describe("A4 — REJECT refund failure leaves unrecoverable state (C2 confirmed)", () => {
  it("status committed REJECTED but balance NOT refunded; no retry path", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // status transition committed
    // Refund updateMany returns count=0 (wallet vanished) — or could throw
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("پشتیبانی");

    // CRITICAL log
    const criticalLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("CRITICAL: rejected withdrawal requires reconciliation")
    );
    expect(criticalLog).toBeDefined();
    const logPayload = criticalLog![1] as Record<string, unknown>;
    expect(logPayload.withdrawalId).toBe("wd_1");
    expect(logPayload.walletId).toBe("wallet_1");

    // GAP (C2): status IS REJECTED in DB (committed before refund attempt),
    // but balance was never refunded. There is NO status like REFUND_PENDING
    // to retry from. Operator must run manual SQL.
    // The transition guard now blocks any further PATCH:
    //   WHERE { id, status: "REQUESTED" } will match 0 rows (status is REJECTED).
    errSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A5 — REJECT: refund succeeds but ledger.create fails → ambiguous state
// ═══════════════════════════════════════════════════════════════════════════
describe("A5 — REJECT: refund ok but ledger.create fails (C2 variant)", () => {
  it("balance refunded, status REJECTED, but no REFUND ledger row (reconciliation ambiguous)", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 }); // refund succeeded
    mockWalletLedgerCreate.mockRejectedValueOnce(new Error("D1 ledger write timeout"));

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(500);

    // CRITICAL: operator cannot tell from response whether refund happened
    const criticalLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("CRITICAL")
    );
    expect(criticalLog).toBeDefined();

    // Balance WAS refunded (count=1) but ledger is missing.
    // GAP (C2 variant): if operator naively re-runs a refund based on
    // "ledger missing", they will DOUBLE-CREDIT the wallet. The response
    // body does not distinguish "refund ok, ledger failed" from "refund failed".
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockWalletLedgerCreate).toHaveBeenCalledTimes(1);

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
// A9 — Concurrent admin PATCH (two admins reject same withdrawal)
// ═══════════════════════════════════════════════════════════════════════════
describe("A9 — concurrent admin PATCH: only one transition + one refund", () => {
  it("second admin's PATCH returns 409 because transition count=0 (guard works)", async () => {
    // Both admins see status=REQUESTED in findUnique
    mockWithdrawalRequestFindUnique.mockResolvedValue(SAMPLE_REQUEST);
    // First admin's updateMany succeeds (count=1); second admin's returns count=0
    // because the first already changed status to REJECTED.
    mockWithdrawalRequestUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // admin 1 wins
      .mockResolvedValueOnce({ count: 0 }); // admin 2 loses
    mockWalletUpdateMany.mockResolvedValue({ count: 1 });
    mockWalletLedgerCreate.mockResolvedValue({ id: "ledger_1" });

    // Simulate two concurrent PATCH calls (sequential in test, but second
    // sees the row already REJECTED because updateMany WHERE clause filters it).
    const p1 = PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    const p2 = PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    const [res1, res2] = await Promise.all([p1, p2]);

    // One succeeds, one gets 409
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Only ONE refund happened (the winner's)
    // Note: in real concurrent execution, both findUnique calls might return
    // REQUESTED, but only one updateMany matches. The losing admin's refund
    // never runs because the route checks transition.count !== 1 BEFORE refund.
    const winner = res1.status === 200 ? res1 : res2;
    const loser = res1.status === 200 ? res2 : res1;
    expect(await winner.json()).toHaveProperty("withdrawal");
    const loserBody = await loser.json();
    expect(loserBody.error).toContain("هم‌زمان");
  });

  it("NOTE: the transition guard prevents double-refund ONLY if both admins reach updateMany after findUnique", async () => {
    // This sub-test documents the limit of the guard: it relies on the
    // conditional updateMany. If a future refactor moves the status check
    // to findUnique-only (without the conditional updateMany), the double-
    // refund becomes possible. The test below asserts the current contract.
    mockWithdrawalRequestFindUnique.mockResolvedValue(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockWalletUpdateMany.mockResolvedValue({ count: 1 });
    mockWalletLedgerCreate.mockResolvedValue({ id: "ledger_1" });

    await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    // Exactly one refund (the winner's) — the guard works for this case.
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A10 — Mid-refund failure: balance refunded but ledger.create fails
//        (same as A5 but framed as "is the state recoverable without double-refund?")
// ═══════════════════════════════════════════════════════════════════════════
describe("A10 — mid-refund failure: recoverable? (reconciliation safety)", () => {
  it("balance refunded, ledger missing → operator CANNOT safely retry refund (double-credit risk)", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 }); // refund ok
    mockWalletLedgerCreate.mockRejectedValueOnce(new Error("ledger timeout"));

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(res.status).toBe(500);

    // Re-fetch the withdrawal: it shows REJECTED (no REFUND_PENDING state to retry from)
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED", reviewerId: "admin_1" });
    const retryRes = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(retryRes.status).toBe(409); // transition guard blocks

    // GAP (C2/A10): operator must manually inspect wallet balance to decide
    // whether to insert a REFUND ledger row. There is no programmatic path.
    // This is the crux of why REFUND_PENDING (or equivalent) is needed.
    expect(errSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("CRITICAL")
    )).toBe(true);
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
// Distinguishing HTTP error from failed financial transaction
// ═══════════════════════════════════════════════════════════════════════════
describe("HTTP error vs failed financial transaction (distinction)", () => {
  it("A4: 500 response but transaction PARTIALLY committed (status REJECTED, no refund)", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 }); // status committed
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 0 }); // refund failed

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    // HTTP 500 (looks like total failure) BUT the status transition already
    // committed. This is NOT a failed transaction — it's a PARTIALLY
    // committed transaction with a missing refund. The 500 status code
    // misrepresents the system state.
    expect(res.status).toBe(500);
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledTimes(1); // committed
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1); // attempted, count=0

    errSpy.mockRestore();
  });

  it("A5: 500 response but balance WAS refunded (transaction succeeded, audit failed)", async () => {
    const errSpy = muteConsoleError();
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce(SAMPLE_REQUEST);
    mockWithdrawalRequestUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 }); // refund succeeded
    mockWalletLedgerCreate.mockRejectedValueOnce(new Error("ledger fail"));

    const res = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    // HTTP 500 (looks like failure) BUT the financial transaction (refund)
    // actually succeeded. Only the audit ledger failed. The 500 status code
    // overstates the failure — the user's money IS back in their wallet.
    expect(res.status).toBe(500);
    expect(mockWalletUpdateMany.mock.calls[0][0].data).toEqual({ balance: { increment: 500 } });

    errSpy.mockRestore();
  });
});
