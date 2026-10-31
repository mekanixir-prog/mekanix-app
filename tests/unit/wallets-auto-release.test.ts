// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWalletFindUnique = vi.fn();
const mockWalletCreate = vi.fn();
const mockReleaseWalletTransaction = vi.fn();
const mockRequireAuth = vi.fn();
const mockGetTechnicianFromSession = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    wallet: {
      findUnique: (...args: any[]) => mockWalletFindUnique(...args),
      create: (...args: any[]) => mockWalletCreate(...args),
    },
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
  mockRequireAuth.mockResolvedValue({
    userId: "user-1", role: "TECHNICIAN", phone: "+989120000000", isGuest: false,
  });
  mockGetTechnicianFromSession.mockResolvedValue({ id: "tech-1", userId: "user-1" });
  mockWalletFindUnique.mockResolvedValue(wallet());
  mockWalletCreate.mockResolvedValue(wallet());
  mockReleaseWalletTransaction.mockResolvedValue(true);
});

describe("GET /api/wallets — atomic escrow release orchestration", () => {
  it("delegates each matured pending transaction to the atomic release service", async () => {
    const due = new Date(Date.now() - 60_000);
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

  it("does not attempt release for future holds or non-pending transactions", async () => {
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
    mockWalletFindUnique.mockResolvedValueOnce(wallet([
      { id: "txn-due", status: "PENDING", netAmount: 1000, holdUntil: new Date(Date.now() - 60_000) },
    ]));
    mockReleaseWalletTransaction.mockRejectedValueOnce(new Error("atomic batch failed"));

    await expect(GET(makeRequest())).rejects.toThrow("atomic batch failed");
  });
});
