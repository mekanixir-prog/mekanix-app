// @vitest-environment node
// MEKANIX Bundle 2.2 — Withdrawal Consistency Fix (orphaned-WithdrawalRequest prevention)
//
// Tests the actual POST handler at src/app/api/wallets/withdraw/route.ts by
// calling POST() with mocked Request objects. The route uses `getDbForLib()`
// from `@/lib/db-access` (async — returns a PrismaClient). We mock
// `getDbForLib()` to return a mock client whose wallet/updateMany outcome we
// control per-test. Rate-limit + auth helpers are mocked so the route can
// reach the withdraw logic.
//
// We use the `node` environment (not jsdom) because we mint real JWTs via
// jose's `SignJWT` (cross-realm Uint8Array issue, same reason as care.test.ts).
//
// Covered (B2.2 invariant):
//   1. When the atomic decrement returns count=0 (race loser), the route
//      returns 409 AND does NOT call `withdrawalRequest.create` (no orphaned
//      WithdrawalRequest row in DB). Ledger + notification also skipped.
//   2. When the atomic decrement returns count=1 (winner), the route
//      returns 200 AND calls `withdrawalRequest.create` AFTER the decrement
//      succeeded — normal happy path.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSession } from "@/lib/auth";

// ──────────── Module-level mocks (hoisted by vitest) ────────────
const mockWalletFindUnique = vi.fn();
const mockWalletUpdateMany = vi.fn();
const mockWithdrawalRequestCreate = vi.fn();
const mockWalletLedgerCreate = vi.fn();
const mockWalletLedgerDelete = vi.fn();
const mockWithdrawalRequestDelete = vi.fn();
const mockNotificationCreate = vi.fn();
const mockTechnicianFindUnique = vi.fn();

// Session DB mock — `verifySession` queries `session.findUnique` by tokenHash.
// Return a valid (non-revoked, non-expired) record so JWT verification passes.
const mockSessionFindUnique = vi.fn().mockResolvedValue({
  id: "sess_1",
  userId: "user_tech",
  tokenHash: "hash-placeholder",
  device: null,
  ip: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
  revokedAt: null,
  createdAt: new Date(),
});
const mockSessionCreate = vi.fn().mockResolvedValue({});
const mockSessionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
const mockIdempotencyKeyCreate = vi.fn();
const mockIdempotencyKeyFindUnique = vi.fn();
const mockIdempotencyKeyUpdateMany = vi.fn();

// The withdraw route calls `const db = await getDbForLib();` and then uses
// `db.wallet.*`, `db.withdrawalRequest.*`, etc. We mock getDbForLib to return
// a mock client with all the methods the route touches.
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    wallet: {
      findUnique: (...args: any[]) => mockWalletFindUnique(...args),
      updateMany: (...args: any[]) => mockWalletUpdateMany(...args),
    },
    withdrawalRequest: {
      create: (...args: any[]) => mockWithdrawalRequestCreate(...args),
      delete: (...args: any[]) => mockWithdrawalRequestDelete(...args),
    },
    walletLedger: {
      create: (...args: any[]) => mockWalletLedgerCreate(...args),
      delete: (...args: any[]) => mockWalletLedgerDelete(...args),
    },
    notification: {
      create: (...args: any[]) => mockNotificationCreate(...args),
    },
    technician: {
      findUnique: (...args: any[]) => mockTechnicianFindUnique(...args),
    },
    session: {
      create: (...args: any[]) => mockSessionCreate(...args),
      findUnique: (...args: any[]) => mockSessionFindUnique(...args),
      updateMany: (...args: any[]) => mockSessionUpdateMany(...args),
    },
    idempotencyKey: {
      create: (...args: any[]) => mockIdempotencyKeyCreate(...args),
      findUnique: (...args: any[]) => mockIdempotencyKeyFindUnique(...args),
      updateMany: (...args: any[]) => mockIdempotencyKeyUpdateMany(...args),
    },
  })),
}));

// Mock rate-limit so withdraw budget isn't exhausted across tests.
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, resetMs: 60_000 })),
  rateLimitAsync: vi.fn().mockResolvedValue({ success: true, resetMs: 60_000 }),
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

// ──────────── Import route handler (after mocks hoisted) ────────────
import { POST } from "@/app/api/wallets/withdraw/route";

// ──────────── Helpers ────────────
// Default: generate a unique Idempotency-Key per request (required by route).
// Tests that need to test idempotency behavior (e.g. duplicate POST) pass
// an explicit key.
function jsonReq(url: string, token: string, body: unknown, idempotencyKey?: string): Request {
  const key = idempotencyKey ?? `test-key-${Math.random().toString(36).slice(2, 10)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    authorization: `Bearer ${token}`,
    "Idempotency-Key": key,
  };
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function mintTechnicianToken(): Promise<string> {
  return createSession({
    userId: "user_tech",
    role: "TECHNICIAN",
    phone: "+989121234567",
    isGuest: false,
  });
}

beforeEach(() => {
  // clearAllMocks resets call history. The mockResolvedValueOnce queue is
  // intentionally NOT reset here — tests must consume their own once-queue
  // (each test sets up exactly as many mockResolvedValueOnce calls as the
  // route will make). This keeps each test self-contained and exposes any
  // mismatch between the expected and actual call count.
  vi.clearAllMocks();
  // Restore default "valid session" record — individual tests can override
  // with mockResolvedValueOnce.
  mockSessionFindUnique.mockResolvedValue({
    id: "sess_1",
    userId: "user_tech",
    tokenHash: "hash-placeholder",
    device: null,
    ip: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    createdAt: new Date(),
  });
  mockSessionCreate.mockResolvedValue({});
  mockWithdrawalRequestCreate.mockResolvedValue({ id: "wd_1", code: "WD-123456", walletId: "wallet_1", amount: 500, status: "REQUESTED" });
  mockWalletLedgerCreate.mockResolvedValue({ id: "ledger_1" });
  mockWithdrawalRequestDelete.mockResolvedValue({});
  mockWalletLedgerDelete.mockResolvedValue({});
  mockSessionUpdateMany.mockResolvedValue({ count: 0 });

  // Default: idempotencyKey.create succeeds (we own the key).
  mockIdempotencyKeyCreate.mockResolvedValue({});
  mockIdempotencyKeyFindUnique.mockResolvedValue(null);
  mockIdempotencyKeyUpdateMany.mockResolvedValue({ count: 1 });

  // Default technician record (so getTechnicianFromSession returns a tech).
  mockTechnicianFindUnique.mockResolvedValue({
    id: "tech_1",
    userId: "user_tech",
  });
});

// ──────────── B2.2 invariant: no orphaned WithdrawalRequest ────────────
describe("B2.2 — withdraw route orphaned-WithdrawalRequest prevention", () => {
  it("does NOT create WithdrawalRequest when atomic decrement fails (count=0)", async () => {
    // Arrange: wallet has 1000 balance (passes initial + re-check).
    // updateMany returns count=0 — simulates a concurrent withdraw winning
    // the race: balance was already deducted by another request.
    mockWalletFindUnique
      .mockResolvedValueOnce({
        id: "wallet_1",
        balance: 1000,
        technicianId: "tech_1",
      }) // initial lookup (line ~43)
      .mockResolvedValueOnce({
        id: "wallet_1",
        balance: 1000,
        technicianId: "tech_1",
      }); // re-check inside try (line ~72)
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 0 }); // race loser

    const token = await mintTechnicianToken();
    const req = jsonReq(
      "https://mekanix.test/api/wallets/withdraw",
      token,
      { amount: 500, method: "card" }
    );
    const res = await POST(req);

    // Assert: 400 response (route threw "موجودی توسط درخواست هم‌زمان تغییر کرد")
    expect(res.status).toBe(409);

    // CRITICAL B2.2 invariant: WithdrawalRequest must NOT be created — no
    // orphaned row in DB that an admin could later approve without a
    // corresponding balance deduction.
    expect(mockWithdrawalRequestCreate).not.toHaveBeenCalled();

    // Ledger and notification also must not be created.
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();
    expect(mockNotificationCreate).not.toHaveBeenCalled();

    // The atomic decrement WAS attempted (with WHERE balance >= amount).
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = mockWalletUpdateMany.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "wallet_1", balance: { gte: 500 } });
    expect(updateArgs.data).toEqual({ balance: { decrement: 500 } });
  });

  it("creates WithdrawalRequest ONLY after atomic decrement succeeds (count=1)", async () => {
    // Arrange: wallet has 1000 balance on initial lookup, then 1000 on re-check
    // inside try, then 500 after the decrement (re-read). updateMany returns
    // count=1 — race winner.
    mockWalletFindUnique
      .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1" }) // initial lookup
      .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1" }) // re-check inside try
      .mockResolvedValueOnce({ id: "wallet_1", balance: 500, technicianId: "tech_1" }); // re-read after decrement
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWithdrawalRequestCreate.mockResolvedValueOnce({
      id: "wd_1",
      code: "WD-123456",
      walletId: "wallet_1",
      amount: 500,
      status: "REQUESTED",
    });

    const token = await mintTechnicianToken();
    const req = jsonReq(
      "https://mekanix.test/api/wallets/withdraw",
      token,
      { amount: 500, method: "card" }
    );
    const res = await POST(req);

    // Assert: 200 response
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.withdrawal.id).toBe("wd_1");
    expect(body.newBalance).toBe(500);

    // CRITICAL B2.2 invariant: WithdrawalRequest IS created (after decrement).
    expect(mockWithdrawalRequestCreate).toHaveBeenCalledTimes(1);

    // Ledger created with the ACTUAL post-decrement balance (500, not the
    // pre-computed balanceBefore - amount).
    expect(mockWalletLedgerCreate).toHaveBeenCalledTimes(1);
    const ledgerArgs = mockWalletLedgerCreate.mock.calls[0][0];
    expect(ledgerArgs.data.balanceBefore).toBe(1000);
    expect(ledgerArgs.data.balanceAfter).toBe(500);
    expect(ledgerArgs.data.amount).toBe(-500);

    // Notification also created.
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);

    // The atomic decrement was attempted with the correct WHERE clause.
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = mockWalletUpdateMany.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "wallet_1", balance: { gte: 500 } });
    expect(updateArgs.data).toEqual({ balance: { decrement: 500 } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FAILURE-PATH TEST SUITE (PR #4 review — Task ID: 3)
// ═══════════════════════════════════════════════════════════════════════════
// Purpose: document the ACTUAL behavior of the compensation block and
// idempotency gaps, so we can decide which fixes are needed before merge.
//
// These tests do NOT assume a specific "correct" outcome — they record what
// the code currently does. Failures indicate either a real bug or a missing
// feature (gap). Each test annotates which category applies.
//
// Key distinctions (per reviewer feedback):
//   - Compensation success ≠ concurrency safety — tested separately
//   - HTTP error response ≠ failed financial transaction — tested separately
// ═══════════════════════════════════════════════════════════════════════════

// Helper: standard wallet + technician + token setup. Wallet lookups return
// balance=1000 throughout. updateMany decrement returns count=1.
async function standardSetup(): Promise<string> {
  mockWalletFindUnique
    .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1" }) // initial lookup
    .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1" }) // re-check inside try
    .mockResolvedValueOnce({ id: "wallet_1", balance: 500, technicianId: "tech_1" }); // re-read after decrement
  mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 }); // decrement succeeds
  return mintTechnicianToken();
}

// Helper to suppress console.error noise while still allowing spy assertions.
function muteConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("W1 — compensation triggers when withdrawalRequest.create throws", () => {
  it("refunds balance and does NOT delete ledger/withdrawal (none created yet)", async () => {
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    // withdrawalRequest.create throws a generic DB error (NOT P2002)
    mockWithdrawalRequestCreate.mockRejectedValueOnce(new Error("D1 write timeout"));

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500, method: "card" });
    const res = await POST(req);

    // HTTP 500 (compensation path returns 500 after rollback)
    expect(res.status).toBe(500);

    // Compensation: balance IS refunded (second updateMany call)
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(2);
    const refundArgs = mockWalletUpdateMany.mock.calls[1][0];
    expect(refundArgs.data).toEqual({ balance: { increment: 500 } });
    // Refund WHERE is unconditional (no balance check) — documents current behavior
    expect(refundArgs.where).toEqual({ id: "wallet_1" });

    // Nothing to delete — withdrawal/ledger never created
    expect(mockWithdrawalRequestDelete).not.toHaveBeenCalled();
    expect(mockWalletLedgerDelete).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("distinguishes P2002 unique-code collision from generic DB error (C3 documentation)", async () => {
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    // Simulate Prisma P2002 (unique constraint violation on `code`)
    const p2002 = Object.assign(new Error("Unique constraint failed on the fields: (`code`)"), {
      code: "P2002",
      meta: { target: ["code"] },
    });
    mockWithdrawalRequestCreate.mockRejectedValueOnce(p2002);

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 });
    const res = await POST(req);
    const body = await res.json();

    // CURRENT BEHAVIOR: P2002 is treated as a generic failure → 500 + compensation.
    // This is a GAP: P2002 on the random code should be retried, not surfaced to user.
    expect(res.status).toBe(500);
    // Response is generic — operator cannot tell from body that this was a collision
    expect(body.error).toContain("پشتیبانی");
    // Balance WAS refunded (compensation ran)
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });
});

describe("W2 — compensation triggers when walletLedger.create throws", () => {
  it("deletes the withdrawal AND refunds balance; original error preserved in log", async () => {
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    // withdrawal.create succeeds, ledger.create throws
    mockWithdrawalRequestCreate.mockResolvedValueOnce({
      id: "wd_1", code: "WD-123456", walletId: "wallet_1", amount: 500, status: "REQUESTED",
    });
    mockWalletLedgerCreate.mockRejectedValueOnce(new Error("D1 ledger write timeout"));
    // Refund updateMany (second call) must succeed for compensation to complete
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 });
    const res = await POST(req);

    expect(res.status).toBe(500);

    // Compensation: ledger.delete NOT called (no ledger created),
    // withdrawal.delete IS called, balance refund IS called.
    expect(mockWalletLedgerDelete).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestDelete).toHaveBeenCalledTimes(1);
    expect(mockWithdrawalRequestDelete.mock.calls[0][0]).toEqual({ where: { id: "wd_1" } });

    // Balance refunded (decrement + refund = 2 updateMany calls)
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockWalletUpdateMany.mock.calls[1][0].data).toEqual({ balance: { increment: 500 } });

    // Log entry preserves original error message
    const logCall = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("compensation completed")
    );
    expect(logCall).toBeDefined();
    expect(logCall![1]).toMatchObject({ walletId: "wallet_1" });

    errSpy.mockRestore();
  });

  it("NOTE: compensation success does NOT prove concurrency safety (separate property)", async () => {
    // This test documents that the compensation block executes correctly in
    // isolation. It does NOT test what happens if a concurrent admin PATCH
    // reads the WithdrawalRequest between withdrawal.create and
    // withdrawal.delete. That scenario is covered in admin-withdrawals.test.ts
    // (A9: concurrent admin PATCH during compensation).
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    mockWithdrawalRequestCreate.mockResolvedValueOnce({
      id: "wd_1", code: "WD-123456", walletId: "wallet_1", amount: 500, status: "REQUESTED",
    });
    mockWalletLedgerCreate.mockRejectedValueOnce(new Error("timeout"));
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 }); // refund succeeds

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 });
    await POST(req);

    // In this isolated test, compensation completes — but a concurrent admin
    // PATCH racing between create and delete would still see wd_1 as
    // REQUESTED and could approve it. This is NOT covered here.
    expect(mockWithdrawalRequestDelete).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe("W3 — notification failure is best-effort (no compensation, 200 response)", () => {
  it("returns 200 even if notification.create throws (no double-charge risk)", async () => {
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    mockNotificationCreate.mockRejectedValueOnce(new Error("notification service down"));

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 });
    const res = await POST(req);

    // 200 — withdrawal succeeded despite notification outage
    expect(res.status).toBe(200);

    // NO compensation triggered
    expect(mockWithdrawalRequestDelete).not.toHaveBeenCalled();
    expect(mockWalletLedgerDelete).not.toHaveBeenCalled();
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1); // only the decrement

    // Notification failure logged but did not affect outcome
    const notifLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("Notification failed")
    );
    expect(notifLog).toBeDefined();

    errSpy.mockRestore();
  });
});

describe("W4 — compensation self-failure preserves original error in log", () => {
  it("logs both originalError and compensationError, returns 500 with generic body (no correlation id)", async () => {
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    // withdrawal.create throws (decrement already queued by standardSetup).
    // Override the refund (second updateMany call) to throw.
    mockWithdrawalRequestCreate.mockRejectedValueOnce(new Error("create timeout"));
    mockWalletUpdateMany.mockRejectedValueOnce(new Error("D1 unavailable during refund"));

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(500);

    // CRITICAL log entry contains BOTH errors
    const criticalLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("CRITICAL: withdrawal compensation failed")
    );
    expect(criticalLog).toBeDefined();
    const logPayload = criticalLog![1] as Record<string, unknown>;
    expect(logPayload.originalError).toBeDefined();
    expect(logPayload.error).toBeDefined(); // note: field is `error`, not `compensationError`
    expect(logPayload.walletId).toBe("wallet_1");
    // Response body is generic — no correlation id (GAP: C6)
    expect(body.error).toContain("پشتیبانی");
    expect(body).not.toHaveProperty("correlationId");
    expect(body).not.toHaveProperty("withdrawalId");

    errSpy.mockRestore();
  });
});

describe("W5 — refund count=0 (wallet cascade-deleted mid-request)", () => {
  it("surfaces as 500 CRITICAL but money is silently lost (C1 confirmed)", async () => {
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    // withdrawal.create throws → compensation runs → refund returns count=0
    mockWithdrawalRequestCreate.mockRejectedValueOnce(new Error("create timeout"));
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 0 }); // refund finds no row

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    // CRITICAL path: response is the generic support message
    expect(body.error).toContain("پشتیبانی");

    // CRITICAL log — compensation failed
    const criticalLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("CRITICAL")
    );
    expect(criticalLog).toBeDefined();

    // The refund "did not update exactly one row" — this is the silent-loss path.
    // Balance was decremented (count=1) but refund found no row (count=0).
    // Note: the log field is `error` (not `compensationError`).
    const logPayload = criticalLog![1] as Record<string, unknown>;
    expect(String(logPayload.error)).toMatch(/did not update exactly one row/);
    expect(logPayload.originalError).toBeDefined();

    errSpy.mockRestore();
  });

  it("also handles thrown DB error during refund (not just count=0)", async () => {
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    mockWithdrawalRequestCreate.mockRejectedValueOnce(new Error("create timeout"));
    const dbErr = Object.assign(new Error("D1 connection reset"), { code: "D1_1020" });
    mockWalletUpdateMany.mockRejectedValueOnce(dbErr);

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const criticalLog = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("CRITICAL")
    );
    expect(criticalLog).toBeDefined();
    const logPayload = criticalLog![1] as Record<string, unknown>;
    // Note: the log field is `error` (not `compensationError`).
    expect(logPayload.error).toBe(dbErr);

    errSpy.mockRestore();
  });
});

describe("W6 — compensation order: ledger.delete → withdrawal.delete → refund", () => {
  it("documents current call order (does NOT prove admin-concurrency safety)", async () => {
    const errSpy = muteConsoleError();
    const token = await standardSetup();
    // withdrawal.create succeeds, ledger.create throws (no ledgerId)
    mockWithdrawalRequestCreate.mockResolvedValueOnce({
      id: "wd_1", code: "WD-123456", walletId: "wallet_1", amount: 500, status: "REQUESTED",
    });
    mockWalletLedgerCreate.mockRejectedValueOnce(new Error("ledger timeout"));
    // Refund (second updateMany) succeeds — compensation completes
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 });
    const res = await POST(req);
    const body = await res.json();

    // Compensation completed → 500 with original error message (NOT generic)
    expect(res.status).toBe(500);
    expect(body.error).toBe("ledger timeout");

    // Current order: since ledgerId is null, ledger.delete is NOT called.
    // withdrawal.delete IS called. refund IS called.
    expect(mockWalletLedgerDelete).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestDelete).toHaveBeenCalledTimes(1);
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(2);

    // NOTE: this test documents compensation order in isolation. It does NOT
    // test the race where a concurrent admin PATCH reads wd_1 between
    // withdrawal.create and withdrawal.delete. That race is the C5 concern
    // and requires a separate test that interleaves two event loops —
    // covered in admin-withdrawals.test.ts A9.
    errSpy.mockRestore();
  });
});

describe("W7 — duplicate POST with DIFFERENT keys documents current behavior (each key = one withdrawal)", () => {
  // Two POSTs with DIFFERENT Idempotency-Keys = two withdrawals (correct).
  // Two POSTs with the SAME key = one withdrawal (tested in I1 below).
  it("two POSTs with different keys create two withdrawals (correct, not a bug)", async () => {
    // First POST: full happy path
    mockWalletFindUnique
      .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1" })
      .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1" })
      .mockResolvedValueOnce({ id: "wallet_1", balance: 500, technicianId: "tech_1" });
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWithdrawalRequestCreate.mockResolvedValueOnce({
      id: "wd_1", code: "WD-111111", walletId: "wallet_1", amount: 500, status: "REQUESTED",
    });

    // Second POST: balance is now 500 (still ≥ 500), decrement succeeds again
    mockWalletFindUnique
      .mockResolvedValueOnce({ id: "wallet_1", balance: 500, technicianId: "tech_1" })
      .mockResolvedValueOnce({ id: "wallet_1", balance: 500, technicianId: "tech_1" })
      .mockResolvedValueOnce({ id: "wallet_1", balance: 0, technicianId: "tech_1" });
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWithdrawalRequestCreate.mockResolvedValueOnce({
      id: "wd_2", code: "WD-222222", walletId: "wallet_1", amount: 500, status: "REQUESTED",
    });

    const token = await mintTechnicianToken();
    // Different keys = different intents
    const req1 = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 }, "key-aaa");
    const req2 = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 }, "key-bbb");

    const res1 = await POST(req1);
    const res2 = await POST(req2);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.withdrawal.id).toBe("wd_1");
    expect(body2.withdrawal.id).toBe("wd_2");

    // Two separate decrements — this is CORRECT (different keys = different intents)
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockWithdrawalRequestCreate).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I1-I4 — Idempotency tests (the FIX for C4)
// ═══════════════════════════════════════════════════════════════════════════

describe("I1 — POST without Idempotency-Key returns 400", () => {
  it("rejects request without idempotency header", async () => {
    const token = await mintTechnicianToken();
    // Manually craft a request WITHOUT the Idempotency-Key header
    const req = new Request("https://mekanix.test/api/wallets/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ amount: 500, method: "card" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Idempotency-Key");

    // No financial operations should have run
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestCreate).not.toHaveBeenCalled();
  });
});

describe("I2 — duplicate POST with SAME key returns cached response (no double-charge)", () => {
  it("second POST with same key returns cached response, only one withdrawal created", async () => {
    // First POST: succeeds, creates withdrawal, marks idempotency COMPLETED
    mockWalletFindUnique
      .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1" })
      .mockResolvedValueOnce({ id: "wallet_1", balance: 1000, technicianId: "tech_1" })
      .mockResolvedValueOnce({ id: "wallet_1", balance: 500, technicianId: "tech_1" });
    mockWalletUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWithdrawalRequestCreate.mockResolvedValueOnce({
      id: "wd_1", code: "WD-123456", walletId: "wallet_1", amount: 500, status: "REQUESTED",
    });

    const token = await mintTechnicianToken();
    const reqBody = { amount: 500, method: "card" };
    const req1 = jsonReq("https://mekanix.test/api/wallets/withdraw", token, reqBody, "same-key-123");
    const res1 = await POST(req1);
    expect(res1.status).toBe(200);

    // Compute the same requestHash the route will compute for the second request
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256").update(JSON.stringify(reqBody)).digest("hex").slice(0, 32);

    // Second POST with SAME key: idempotencyKey.create throws P2002
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mockIdempotencyKeyCreate.mockRejectedValueOnce(p2002);
    // findUnique returns COMPLETED with cached response, matching requestHash
    mockIdempotencyKeyFindUnique.mockResolvedValueOnce({
      key: "withdraw:user_tech:same-key-123",
      status: "COMPLETED",
      response: JSON.stringify({
        withdrawal: { id: "wd_1", code: "WD-123456", walletId: "wallet_1", amount: 500, status: "REQUESTED" },
        newBalance: 500,
      }),
      requestHash: expectedHash,
      expiresAt: new Date(Date.now() + 1000000),
    });

    const req2 = jsonReq("https://mekanix.test/api/wallets/withdraw", token, reqBody, "same-key-123");
    const res2 = await POST(req2);

    // Returns 200 with cached response
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.withdrawal.id).toBe("wd_1");

    // CRITICAL: only ONE withdrawal created (no double-charge)
    expect(mockWithdrawalRequestCreate).toHaveBeenCalledTimes(1);
    // Only ONE balance decrement
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("I3 — same key with DIFFERENT payload returns 409 (misuse)", () => {
  it("same key, different amount → 409", async () => {
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mockIdempotencyKeyCreate.mockRejectedValueOnce(p2002);
    // Existing entry has a different requestHash than what we're sending
    mockIdempotencyKeyFindUnique.mockResolvedValueOnce({
      key: "withdraw:user_tech:reuse-key",
      status: "COMPLETED",
      response: JSON.stringify({ withdrawal: { id: "wd_1" }, newBalance: 500 }),
      requestHash: "different-hash-than-current-request",
      expiresAt: new Date(Date.now() + 1000000),
    });

    const token = await mintTechnicianToken();
    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, { amount: 500 }, "reuse-key");
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("محتوای متفاوت");

    // No financial operations
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestCreate).not.toHaveBeenCalled();
  });
});

describe("I4 — IN_PROGRESS key returns 409 (concurrent request)", () => {
  it("another request with same key while first is running → 409", async () => {
    const reqBody = { amount: 500 };
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256").update(JSON.stringify(reqBody)).digest("hex").slice(0, 32);

    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mockIdempotencyKeyCreate.mockRejectedValueOnce(p2002);
    mockIdempotencyKeyFindUnique.mockResolvedValueOnce({
      key: "withdraw:user_tech:in-progress-key",
      status: "IN_PROGRESS",
      response: null,
      requestHash: expectedHash,
      expiresAt: new Date(Date.now() + 1000000),
    });

    const token = await mintTechnicianToken();
    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, reqBody, "in-progress-key");
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("در حال اجرا");

    // No financial operations
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
  });
});

describe("I5 — FAILED key returns 409 (key not reusable)", () => {
  it("previous attempt failed → 409, client must use new key", async () => {
    const reqBody = { amount: 500 };
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256").update(JSON.stringify(reqBody)).digest("hex").slice(0, 32);

    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mockIdempotencyKeyCreate.mockRejectedValueOnce(p2002);
    mockIdempotencyKeyFindUnique.mockResolvedValueOnce({
      key: "withdraw:user_tech:failed-key",
      status: "FAILED",
      response: null,
      requestHash: expectedHash,
      expiresAt: new Date(Date.now() + 1000000),
    });

    const token = await mintTechnicianToken();
    const req = jsonReq("https://mekanix.test/api/wallets/withdraw", token, reqBody, "failed-key");
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("کلید جدید");

    // No financial operations
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
  });
});
