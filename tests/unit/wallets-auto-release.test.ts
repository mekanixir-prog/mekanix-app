// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWalletFindUnique = vi.fn();
const mockWalletCreate = vi.fn();
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
});

describe("GET /api/wallets — read-only wallet retrieval", () => {
  it("returns wallet data without releasing matured escrow or changing financial state", async () => {
    const due = new Date(Date.now() - 60_000);
    const original = wallet([
      { id: "txn-due", status: "PENDING", netAmount: 1000, holdUntil: due },
    ]);
    mockWalletFindUnique.mockResolvedValueOnce(original);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "wallet-1",
      balance: 5000,
      pendingBalance: 1000,
      transactions: [{ id: "txn-due", status: "PENDING" }],
    });
    expect(mockWalletFindUnique).toHaveBeenCalledTimes(1);
    expect(mockWalletCreate).not.toHaveBeenCalled();
  });

  it("does not create or mutate a wallet when it already exists", async () => {
    mockWalletFindUnique.mockResolvedValueOnce(wallet([
      { id: "txn-future", status: "PENDING", netAmount: 1000, holdUntil: new Date(Date.now() + 60_000) },
      { id: "txn-done", status: "AVAILABLE", netAmount: 500, holdUntil: new Date(Date.now() - 60_000) },
    ]));

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(mockWalletFindUnique).toHaveBeenCalledTimes(1);
    expect(mockWalletCreate).not.toHaveBeenCalled();
  });
});
