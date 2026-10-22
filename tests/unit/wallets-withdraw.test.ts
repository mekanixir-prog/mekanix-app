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
    },
    walletLedger: {
      create: (...args: any[]) => mockWalletLedgerCreate(...args),
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
function jsonReq(url: string, token: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
    },
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
  mockSessionUpdateMany.mockResolvedValue({ count: 0 });

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
