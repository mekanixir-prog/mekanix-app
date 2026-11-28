// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  walletFindUnique: vi.fn(),
  withdrawalFindUnique: vi.fn(),
  ledgerFindUnique: vi.fn(),
}));
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: vi.fn(async () => ({ userId: "tech-user", role: "TECHNICIAN" })),
}));
vi.mock("@/lib/auth", () => ({
  getTechnicianFromSession: vi.fn(async () => ({ id: "tech-1" })),
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    wallet: { findUnique: mocks.walletFindUnique },
    withdrawalRequest: { findUnique: mocks.withdrawalFindUnique },
    walletLedger: { findUnique: mocks.ledgerFindUnique },
  })),
}));

import { GET } from "@/app/api/wallets/withdraw/status/route";

const requestRow = {
  id: "withdrawal-1",
  walletId: "wallet-1",
  code: "WD-001",
  amount: 500,
  financialUnitStatus: "VERIFIED_IRR",
  status: "COMMITTED",
  requestedAt: new Date("2026-11-01T10:00:00.000Z"),
  processedAt: new Date("2026-11-01T10:01:00.000Z"),
};
const ledgerRow = {
  id: "ledger-1",
  walletId: "wallet-1",
  type: "WITHDRAWAL",
  amount: -500,
  balanceBefore: 1000,
  balanceAfter: 500,
  referenceType: "Withdrawal",
  referenceId: "withdrawal-1",
  financialUnitStatus: "VERIFIED_IRR",
};

function request() {
  return new Request("https://mekanix.test/api/wallets/withdraw/status?key=idem_key_1234");
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.walletFindUnique.mockResolvedValue({ id: "wallet-1", financialUnitStatus: "VERIFIED_IRR" });
  mocks.withdrawalFindUnique.mockResolvedValue(requestRow);
  mocks.ledgerFindUnique.mockResolvedValue(ledgerRow);
});

describe("GET /api/wallets/withdraw/status financial provenance", () => {
  it("returns an amount only when wallet, withdrawal, and matching ledger attest verified IRR", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "COMMITTED",
      withdrawal: {
        id: "withdrawal-1",
        amount: "500",
        financialUnitStatus: "VERIFIED_IRR",
      },
    });
  });

  it.each([
    { request: { financialUnitStatus: "UNVERIFIED" } },
    { request: { amount: 500.5 } },
    { wallet: { financialUnitStatus: "UNVERIFIED" } },
    { ledger: { financialUnitStatus: "UNVERIFIED" } },
    { ledger: { amount: -500.5 } },
  ])("does not expose unverified or invalid historical withdrawal amounts", async (override) => {
    mocks.walletFindUnique.mockResolvedValue({
      id: "wallet-1",
      financialUnitStatus: override.wallet?.financialUnitStatus ?? "VERIFIED_IRR",
    });
    mocks.withdrawalFindUnique.mockResolvedValue({
      ...requestRow,
      ...override.request,
    });
    mocks.ledgerFindUnique.mockResolvedValue({
      ...ledgerRow,
      ...override.ledger,
      amount: override.ledger?.amount ?? -(override.request?.amount ?? 500),
    });

    const response = await GET(request());
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.state).toBe("RECONCILIATION_REQUIRED");
    expect(payload).not.toHaveProperty("withdrawal.amount");
  });
});
