// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  technician: vi.fn(),
  walletFindUnique: vi.fn(),
  walletCreate: vi.fn(),
  release: vi.fn(),
  legacyFallback: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({ getTechnicianFromSession: mocks.technician }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    wallet: {
      findUnique: mocks.walletFindUnique,
      create: mocks.walletCreate,
    },
  })),
}));
vi.mock("@/lib/wallet-release", () => ({ releaseWalletTransaction: mocks.release }));
vi.mock("@/lib/wallet-release-policy", () => ({
  shouldUseLegacyWalletReleaseFallback: mocks.legacyFallback,
}));

import { GET } from "@/app/api/wallets/route";

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.auth.mockResolvedValue({ userId: "tech-user", role: "TECHNICIAN" });
  mocks.technician.mockResolvedValue({ id: "tech-1" });
  mocks.legacyFallback.mockReturnValue(false);
});

describe("GET /api/wallets financial provenance", () => {
  it("quarantines a claimed verified wallet with fractional or negative aggregates", async () => {
    for (const balance of ["120000.5", "-1"]) {
      const wallet = {
        id: "wallet-invalid",
        financialUnitStatus: "VERIFIED_IRR",
        balance,
        pendingBalance: "30000",
        totalEarned: "150000",
        totalCommission: "15000",
        totalWithdrawn: "5000",
        transactions: [],
        withdrawals: [],
      };
      mocks.walletFindUnique.mockResolvedValue(wallet);

      const response = await GET(new Request("https://mekanix.test/api/wallets"));
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.financialUnitStatus).toBe("QUARANTINED");
      expect(payload.balance).toBeNull();
      expect(payload.pendingBalance).toBeNull();
    }
  });

  it("preserves verified aggregates but masks unverified child rows independently", async () => {
    const wallet = {
      id: "wallet-verified",
      financialUnitStatus: "VERIFIED_IRR",
      balance: "120000",
      pendingBalance: "30000",
      totalEarned: "150000",
      totalCommission: "15000",
      totalWithdrawn: "5000",
      transactions: [{
        id: "txn-legacy",
        financialUnitStatus: "UNVERIFIED",
        grossAmount: "100000",
        commissionAmount: "10000",
        netAmount: "90000",
      }],
      withdrawals: [{
        id: "wd-legacy",
        financialUnitStatus: "UNVERIFIED",
        amount: "5000",
      }],
    };
    mocks.walletFindUnique.mockResolvedValue(wallet);

    const response = await GET(new Request("https://mekanix.test/api/wallets"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      financialUnitStatus: "VERIFIED_IRR",
      balance: 120000,
      transactions: [{ financialUnitStatus: "UNVERIFIED", grossAmount: null, netAmount: null }],
      withdrawals: [{ financialUnitStatus: "UNVERIFIED", amount: null }],
    });
  });

  it("masks unverified wallet aggregates, transactions, and withdrawals", async () => {
    const wallet = {
      id: "wallet-1",
      financialUnitStatus: "UNVERIFIED",
      balance: "120000",
      pendingBalance: "30000",
      totalEarned: "150000",
      totalCommission: "15000",
      totalWithdrawn: "5000",
      transactions: [{
        id: "txn-1",
        financialUnitStatus: "UNVERIFIED",
        grossAmount: "100000",
        commissionAmount: "10000",
        netAmount: "90000",
      }],
      withdrawals: [{
        id: "wd-1",
        financialUnitStatus: "UNVERIFIED",
        amount: "5000",
      }],
    };
    mocks.walletFindUnique.mockResolvedValueOnce(wallet).mockResolvedValueOnce(wallet);

    const response = await GET(new Request("https://mekanix.test/api/wallets"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      financialUnitStatus: "UNVERIFIED",
      balance: null,
      pendingBalance: null,
      totalEarned: null,
      transactions: [{ grossAmount: null, commissionAmount: null, netAmount: null }],
      withdrawals: [{ amount: null }],
    });
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
