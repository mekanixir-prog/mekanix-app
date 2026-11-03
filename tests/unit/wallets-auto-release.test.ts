// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWalletFindUnique = vi.fn();
const mockWalletCreate = vi.fn();
const mockReleaseWalletTransaction = vi.fn();
const mockRequireAuth = vi.fn();
const mockGetTechnicianFromSession = vi.fn();
const mockJobFindMany = vi.fn();
const mockWalletTransactionFindMany = vi.fn();
const mockWalletTransactionUpdateMany = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    wallet: {
      findUnique: (...args: any[]) => mockWalletFindUnique(...args),
      create: (...args: any[]) => mockWalletCreate(...args),
    },
    walletTransaction: {
      findMany: (...args: any[]) => mockWalletTransactionFindMany(...args),
      updateMany: (...args: any[]) => mockWalletTransactionUpdateMany(...args),
    },
    job: { findMany: (...args: any[]) => mockJobFindMany(...args) },
  })),
}));
vi.mock("@/lib/wallet-release", () => ({
  releaseWalletTransaction: (...args: any[]) => mockReleaseWalletTransaction(...args),
}));
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: (...args: any[]) => mockRequireAuth(...args),
}));
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual("@/lib/auth");
  return { ...actual, getTechnicianFromSession: (...args: any[]) => mockGetTechnicianFromSession(...args) };
});

import { GET } from "@/app/api/wallets/route";

function makeRequest() {
  return new Request("http://localhost/api/wallets", { method: "GET" });
}

function wallet(transactions: any[] = []) {
  return {
    id: "wallet-1",
    technicianId: "tech-1",
    balance: 5000,
    pendingBalance: 1000,
    transactions,
    withdrawals: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks preserves queued mockResolvedValueOnce implementations.
  // Reset this mock so an unconsumed result from a throwing test cannot leak
  // into the next test and change which ledger query receives the fixture.
  mockWalletTransactionFindMany.mockReset();
  mockWalletTransactionFindMany.mockResolvedValue([]);
  vi.stubEnv("MEKANIX_WALLET_IRR_PROVENANCE_VERIFIED", "true");
  vi.stubEnv("WALLET_RELEASE_SCHEDULED", "false");
  mockRequireAuth.mockResolvedValue({
    userId: "user-1", role: "TECHNICIAN", phone: "+989120000000", isGuest: false,
  });
  mockGetTechnicianFromSession.mockResolvedValue({ id: "tech-1", userId: "user-1" });
  mockWalletFindUnique.mockResolvedValue(wallet());
  mockWalletCreate.mockResolvedValue(wallet());
  mockReleaseWalletTransaction.mockResolvedValue(true);
  mockJobFindMany.mockResolvedValue([]);
  mockWalletTransactionFindMany.mockResolvedValue([]);
  mockWalletTransactionUpdateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/wallets — atomic escrow release orchestration", () => {
  it("delegates each matured pending transaction to the atomic release service", async () => {
    const due = new Date(Date.now() - 60_000);
    mockWalletTransactionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "txn-due" }]).mockResolvedValueOnce([]);
    mockWalletFindUnique
      .mockResolvedValueOnce(wallet([
        { id: "txn-due", status: "PENDING", netAmount: 1000, holdUntil: due },
      ]))
      .mockResolvedValueOnce(wallet([
        { id: "txn-due", status: "AVAILABLE", netAmount: 1000, holdUntil: due },
      ]));

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(mockReleaseWalletTransaction).toHaveBeenCalledTimes(1);
    const [db, walletId, transactionId, now] = mockReleaseWalletTransaction.mock.calls[0];
    expect(walletId).toBe("wallet-1");
    expect(transactionId).toBe("txn-due");
    expect(now).toBeInstanceOf(Date);
    expect(db.wallet.findUnique).toBeTypeOf("function");
  });

  it("releases matured escrow rows older than the 50-transaction UI window", async () => {
    const dueRows = Array.from({ length: 60 }, (_, index) => ({ id: `old-due-${index}` }));
    mockWalletTransactionFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(dueRows)
      .mockResolvedValueOnce([]);
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(mockReleaseWalletTransaction).toHaveBeenCalledTimes(60);
    const maturedQuery = mockWalletTransactionFindMany.mock.calls[1][0];
    expect(maturedQuery.take).toBeUndefined();
  });

  it("keeps GET read-only for escrow when the scheduled release worker is enabled", async () => {
    vi.stubEnv("WALLET_RELEASE_SCHEDULED", "true");

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockJobFindMany).not.toHaveBeenCalled();
    expect(mockWalletTransactionUpdateMany).not.toHaveBeenCalled();
    expect(mockReleaseWalletTransaction).not.toHaveBeenCalled();
    // The only wallet-transaction query is the read-only earnings summary.
    expect(mockWalletTransactionFindMany).toHaveBeenCalledTimes(1);
  });

  it("does not attempt release for future holds or non-pending transactions", async () => {
    mockWalletTransactionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockWalletFindUnique
      .mockResolvedValueOnce(wallet([
        { id: "txn-future", status: "PENDING", netAmount: 1000, holdUntil: new Date(Date.now() + 60_000) },
        { id: "txn-done", status: "AVAILABLE", netAmount: 500, holdUntil: new Date(Date.now() - 60_000) },
      ]))
      .mockResolvedValueOnce(wallet());

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(mockReleaseWalletTransaction).not.toHaveBeenCalled();
  });

  it("propagates a failed atomic release rather than returning stale success", async () => {
    mockWalletTransactionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "txn-due" }]).mockResolvedValueOnce([]);
    mockWalletFindUnique.mockResolvedValueOnce(wallet([
      { id: "txn-due", status: "PENDING", netAmount: 1000, holdUntil: new Date(Date.now() - 60_000) },
    ]));
    mockReleaseWalletTransaction.mockRejectedValueOnce(new Error("atomic batch failed"));

    await expect(GET(makeRequest())).rejects.toThrow("atomic batch failed");
  });
  it("repairs a completed job's stranded prepay hold and releases it after the original 12-hour window", async () => {
    const completedAt = new Date(Date.now() - 13 * 60 * 60 * 1000);
    const holdUntil = new Date(completedAt.getTime() + 12 * 60 * 60 * 1000);
    const stranded = {
      id: "txn-prepay",
      jobId: "job-1",
      kind: "PREPAY",
      status: "PENDING",
      netAmount: 900,
      holdUntil: null,
    };
    const repaired = { ...stranded, holdUntil };
    const released = { ...repaired, status: "AVAILABLE" };

    mockWalletFindUnique
      .mockResolvedValueOnce(wallet([stranded]))
      .mockResolvedValueOnce(wallet([repaired]))
      .mockResolvedValueOnce(wallet([released]));
    mockWalletTransactionFindMany.mockImplementation(async (args: any) => {
      if (args.where?.holdUntil === null) return [stranded];
      if (args.where?.holdUntil?.not === null && args.where?.holdUntil?.lte) return [{ id: "txn-prepay" }];
      return [];
    });
    mockJobFindMany.mockResolvedValue([{ id: "job-1", completedAt }]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(mockWalletTransactionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "txn-prepay",
        status: "PENDING",
        holdUntil: null,
      }),
      data: { holdUntil },
    }));
    expect(mockReleaseWalletTransaction).toHaveBeenCalledTimes(1);
    const payload = await response.json();
    expect(payload.currency).toBe("IRR");
    expect(payload.earningsSummary.currency).toBe("IRR");
  });

  it("does not mutate escrow or expose legacy amounts while wallet currency is unverified", async () => {
    vi.stubEnv("MEKANIX_WALLET_IRR_PROVENANCE_VERIFIED", "false");
    const legacy: any = wallet([{
      id: "txn-legacy",
      grossAmount: 1200,
      commissionAmount: 120,
      netAmount: 1080,
      status: "PENDING",
      holdUntil: new Date(Date.now() - 60_000),
    }]);
    legacy.withdrawals = [{ id: "wd-legacy", amount: 500 }];
    mockWalletFindUnique
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce(legacy);

    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.currency).toBe("UNVERIFIED");
    expect(payload.balance).toBeNull();
    expect(payload.pendingBalance).toBeNull();
    expect(payload.transactions[0]).toMatchObject({
      grossAmount: null,
      commissionAmount: null,
      netAmount: null,
    });
    expect(payload.withdrawals[0].amount).toBeNull();
    expect(payload.earningsSummary.currency).toBe("UNVERIFIED");
    expect(payload.earningsSummary.valid).toBe(false);
    expect(payload.earningsSummary.todayIrr).toBeNull();
    expect(mockWalletTransactionUpdateMany).not.toHaveBeenCalled();
    expect(mockReleaseWalletTransaction).not.toHaveBeenCalled();
  });

  it("builds earnings summaries only from released positive net IRR ledger entries", async () => {
    const createdAt = new Date();
    mockWalletFindUnique
      .mockResolvedValueOnce(wallet())
      .mockResolvedValueOnce(wallet());
    mockWalletTransactionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      { createdAt, netAmount: 250 },
    ]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(mockWalletTransactionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        walletId: "wallet-1",
        status: "AVAILABLE",
        netAmount: { gt: 0 },
        createdAt: expect.objectContaining({ lte: expect.any(Date) }),
      }),
    }));
    const payload = await response.json();
    expect(payload.currency).toBe("IRR");
    expect(payload.earningsSummary.valid).toBe(true);
    expect(payload.earningsSummary.todayIrr).toBe(250);
    expect(payload.earningsSummary.last7DaysIrr).toBe(250);
  });

});
