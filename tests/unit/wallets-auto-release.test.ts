// @vitest-environment node
// MEKANIX — SEC-8 Wallets Auto-Release Tests (Bundle 3)
// ============================================================================
// Verifies the SEC-8 fix in src/app/api/wallets/route.ts (GET handler).
//
// The fix uses a conditional `updateMany` with `where: { id, status: "PENDING" }`
// + count check to prevent the double-credit race condition:
//   - When count === 1 (race winner): apply wallet.update (balance increment)
//   - When count === 0 (race loser): skip wallet.update (no double-credit)
//
// These tests mock `getDbForLib` + `requireAuth` + `getTechnicianFromSession`
// and exercise the GET /api/wallets handler with a single releasable PENDING
// transaction.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ──────────── Module-level mocks (hoisted by vitest) ────────────
const mockWalletFindUnique = vi.fn();
const mockWalletTransactionUpdateMany = vi.fn();
const mockWalletUpdate = vi.fn();
const mockWalletCreate = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    wallet: {
      findUnique: (...args: any[]) => mockWalletFindUnique(...args),
      update: (...args: any[]) => mockWalletUpdate(...args),
      create: (...args: any[]) => mockWalletCreate(...args),
    },
    walletTransaction: {
      updateMany: (...args: any[]) => mockWalletTransactionUpdateMany(...args),
    },
  })),
}));

// Mock requireAuth — controllable per-test
const mockRequireAuth = vi.fn();
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: (...args: any[]) => mockRequireAuth(...args),
}));

// Mock getTechnicianFromSession
const mockGetTechnicianFromSession = vi.fn();
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual("@/lib/auth");
  return {
    ...actual,
    getTechnicianFromSession: (...args: any[]) => mockGetTechnicianFromSession(...args),
  };
});

// ──────────── Import route handler (after mocks hoisted) ────────────
import { GET } from "@/app/api/wallets/route";

// ──────────── Helpers ────────────
function makeGetRequest(technicianId?: string): Request {
  const url = technicianId
    ? `http://localhost/api/wallets?technicianId=${technicianId}`
    : "http://localhost/api/wallets";
  return new Request(url, { method: "GET" });
}

// Build a wallet with ONE PENDING transaction that is past its holdUntil.
function walletWithPendingTx(opts: { walletId?: string; netAmount?: number; techId?: string } = {}) {
  const walletId = opts.walletId ?? "wallet-1";
  const netAmount = opts.netAmount ?? 1000;
  const techId = opts.techId ?? "tech-1";
  const past = new Date(Date.now() - 60_000); // 1 minute ago
  return {
    id: walletId,
    technicianId: techId,
    balance: 5000,
    pendingBalance: 1000,
    transactions: [
      {
        id: "txn-1",
        status: "PENDING",
        netAmount,
        holdUntil: past,
        releasedAt: null,
      },
    ],
    withdrawals: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: TECHNICIAN session
  mockRequireAuth.mockResolvedValue({
    userId: "user-1",
    role: "TECHNICIAN",
    phone: "+989120000000",
    isGuest: false,
  });
  mockGetTechnicianFromSession.mockResolvedValue({ id: "tech-1", userId: "user-1" });
});

describe("SEC-8 — /api/wallets auto-release double-credit prevention", () => {
  // ──────────── Winner: count === 1 ────────────
  it("when updateMany returns count=1, applies wallet.update (balance increment)", async () => {
    // Setup: initial findUnique returns wallet with PENDING txn.
    // After auto-release, route re-reads the wallet (second findUnique call).
    mockWalletFindUnique
      .mockResolvedValueOnce(walletWithPendingTx()) // initial lookup
      .mockResolvedValueOnce({
        ...walletWithPendingTx(),
        balance: 6000, // after increment
        pendingBalance: 0,
        transactions: [{ id: "txn-1", status: "AVAILABLE", netAmount: 1000 }],
      }); // re-read after release
    mockWalletTransactionUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockWalletUpdate.mockResolvedValueOnce({});

    const req = makeGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);

    // The conditional updateMany was called with WHERE on status=PENDING
    expect(mockWalletTransactionUpdateMany).toHaveBeenCalledTimes(1);
    const updateManyArgs = mockWalletTransactionUpdateMany.mock.calls[0][0];
    expect(updateManyArgs.where).toEqual({ id: "txn-1", status: "PENDING" });
    expect(updateManyArgs.data).toEqual(
      expect.objectContaining({ status: "AVAILABLE" })
    );

    // CRITICAL: wallet.update WAS called (race winner credits the wallet)
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    const walletUpdateArgs = mockWalletUpdate.mock.calls[0][0];
    expect(walletUpdateArgs.where).toEqual({ id: "wallet-1" });
    expect(walletUpdateArgs.data).toEqual({
      pendingBalance: { decrement: 1000 },
      balance: { increment: 1000 },
    });
  });

  // ──────────── Loser: count === 0 ────────────
  it("when updateMany returns count=0, does NOT call wallet.update (no double-credit)", async () => {
    // Setup: initial findUnique returns wallet with PENDING txn.
    // Race loser: another concurrent request already transitioned txn-1 to AVAILABLE.
    mockWalletFindUnique
      .mockResolvedValueOnce(walletWithPendingTx()) // initial lookup
      .mockResolvedValueOnce({
        ...walletWithPendingTx(),
        transactions: [{ id: "txn-1", status: "AVAILABLE", netAmount: 1000 }],
      }); // re-read after race
    mockWalletTransactionUpdateMany.mockResolvedValueOnce({ count: 0 });

    const req = makeGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);

    // The conditional updateMany WAS attempted (with WHERE on status=PENDING)
    expect(mockWalletTransactionUpdateMany).toHaveBeenCalledTimes(1);
    const updateManyArgs = mockWalletTransactionUpdateMany.mock.calls[0][0];
    expect(updateManyArgs.where).toEqual({ id: "txn-1", status: "PENDING" });

    // CRITICAL SEC-8 invariant: wallet.update must NOT be called —
    // the race loser must not double-credit the wallet.
    expect(mockWalletUpdate).not.toHaveBeenCalled();
  });

  // ──────────── Extra: multiple PENDING txns — count check applies per-txn ────────────
  it("applies wallet.update once per winning txn when multiple PENDING txns exist", async () => {
    const past = new Date(Date.now() - 60_000);
    mockWalletFindUnique
      .mockResolvedValueOnce({
        id: "wallet-2",
        technicianId: "tech-1",
        balance: 0,
        pendingBalance: 2000,
        transactions: [
          { id: "txn-A", status: "PENDING", netAmount: 700, holdUntil: past, releasedAt: null },
          { id: "txn-B", status: "PENDING", netAmount: 1300, holdUntil: past, releasedAt: null },
        ],
        withdrawals: [],
      })
      .mockResolvedValueOnce({
        id: "wallet-2",
        technicianId: "tech-1",
        balance: 700,
        pendingBalance: 1300,
        transactions: [],
        withdrawals: [],
      });

    // First txn wins, second txn loses (race condition simulation)
    mockWalletTransactionUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockWalletUpdate.mockResolvedValue({});

    const req = makeGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);

    // updateMany called twice (once per PENDING txn)
    expect(mockWalletTransactionUpdateMany).toHaveBeenCalledTimes(2);

    // wallet.update called ONLY for the winner (txn-A), NOT for txn-B
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    const walletUpdateArgs = mockWalletUpdate.mock.calls[0][0];
    expect(walletUpdateArgs.data).toEqual({
      pendingBalance: { decrement: 700 },
      balance: { increment: 700 },
    });
  });

  // ──────────── Extra: AVAILABLE txn is skipped (no updateMany call) ────────────
  it("does NOT call updateMany for transactions already AVAILABLE", async () => {
    const past = new Date(Date.now() - 60_000);
    mockWalletFindUnique
      .mockResolvedValueOnce({
        id: "wallet-3",
        technicianId: "tech-1",
        balance: 1000,
        pendingBalance: 0,
        transactions: [
          // Already AVAILABLE — should be skipped
          { id: "txn-released", status: "AVAILABLE", netAmount: 1000, holdUntil: past, releasedAt: past },
        ],
        withdrawals: [],
      })
      .mockResolvedValueOnce({
        id: "wallet-3",
        technicianId: "tech-1",
        balance: 1000,
        pendingBalance: 0,
        transactions: [],
        withdrawals: [],
      });

    const req = makeGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    // No releasable txns → updateMany never called
    expect(mockWalletTransactionUpdateMany).not.toHaveBeenCalled();
    expect(mockWalletUpdate).not.toHaveBeenCalled();
  });

  // ──────────── Extra: PENDING txn with future holdUntil is NOT released ────────────
  it("does NOT release PENDING txn whose holdUntil is in the future", async () => {
    const future = new Date(Date.now() + 60_000); // 1 minute from now
    mockWalletFindUnique
      .mockResolvedValueOnce({
        id: "wallet-4",
        technicianId: "tech-1",
        balance: 0,
        pendingBalance: 1000,
        transactions: [
          { id: "txn-future", status: "PENDING", netAmount: 1000, holdUntil: future, releasedAt: null },
        ],
        withdrawals: [],
      })
      .mockResolvedValueOnce({
        id: "wallet-4",
        technicianId: "tech-1",
        balance: 0,
        pendingBalance: 1000,
        transactions: [],
        withdrawals: [],
      });

    const req = makeGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    // Not yet releasable → updateMany never called
    expect(mockWalletTransactionUpdateMany).not.toHaveBeenCalled();
    expect(mockWalletUpdate).not.toHaveBeenCalled();
  });
});
