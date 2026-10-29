// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWalletFindUnique = vi.fn();
const mockWalletUpdateMany = vi.fn();
const mockWithdrawalFindUnique = vi.fn();
const mockWithdrawalUpdateMany = vi.fn();
const mockLedgerCreate = vi.fn();
const mockLedgerFindFirst = vi.fn();
const mockTransaction = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    $transaction: (callback: (tx: any) => Promise<unknown>) => mockTransaction(callback),
  }),
}));

import { executeAtomicRefund } from "@/lib/atomic-refund";

const input = {
  withdrawalId: "wd_1",
  walletId: "wallet_1",
  amount: 500,
  reviewerId: "admin_1",
  description: "Refund for rejected withdrawal WD-123456",
};

beforeEach(() => {
  vi.resetAllMocks();
  mockWalletFindUnique
    .mockResolvedValueOnce({ balance: 1000 })
    .mockResolvedValueOnce({ balance: 1500 });
  mockWithdrawalUpdateMany.mockResolvedValue({ count: 1 });
  mockWithdrawalFindUnique.mockResolvedValue({ status: "REFUND_PENDING", refundToken: null });
  mockWalletUpdateMany.mockResolvedValue({ count: 1 });
  mockLedgerCreate.mockResolvedValue({ id: "ledger_refund_1" });
  mockLedgerFindFirst.mockResolvedValue(null);
  mockTransaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback({
    wallet: {
      findUnique: (...args: any[]) => mockWalletFindUnique(...args),
      updateMany: (...args: any[]) => mockWalletUpdateMany(...args),
    },
    withdrawalRequest: {
      findUnique: (...args: any[]) => mockWithdrawalFindUnique(...args),
      updateMany: (...args: any[]) => mockWithdrawalUpdateMany(...args),
    },
    walletLedger: {
      create: (...args: any[]) => mockLedgerCreate(...args),
      findFirst: (...args: any[]) => mockLedgerFindFirst(...args),
    },
  }));
});

describe("executeAtomicRefund — SQLite transaction", () => {
  it("credits wallet, transitions status and writes exact ledger snapshots in one transaction", async () => {
    const result = await executeAtomicRefund(input);

    expect(result).toEqual({
      success: true,
      refundLedgerId: "ledger_refund_1",
      newBalance: 1500,
      alreadyRefunded: false,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockWithdrawalUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "wd_1", status: "REFUND_PENDING" },
      data: expect.objectContaining({ status: "REJECTED", reviewerId: "admin_1", refundToken: expect.any(String) }),
    }));
    expect(mockWalletUpdateMany).toHaveBeenCalledWith({
      where: { id: "wallet_1" },
      data: { balance: { increment: 500 } },
    });
    expect(mockLedgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId: "wallet_1",
        type: "REFUND",
        amount: 500,
        balanceBefore: 1000,
        balanceAfter: 1500,
        referenceType: "Withdrawal",
        referenceId: "wd_1",
        createdBy: "admin_1",
      }),
    });
  });

  it("does not credit again when the withdrawal is already rejected and a refund ledger exists", async () => {
    mockWithdrawalUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockWithdrawalFindUnique.mockResolvedValueOnce({ status: "REJECTED", refundToken: "existing-token" });
    mockLedgerFindFirst.mockResolvedValueOnce({ id: "ledger_existing" });
    mockWalletFindUnique.mockResolvedValueOnce({ balance: 1500 });

    const result = await executeAtomicRefund(input);
    expect(result.alreadyRefunded).toBe(true);
    expect(result.refundLedgerId).toBe("ledger_existing");
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockLedgerCreate).not.toHaveBeenCalled();
  });

  it("throws when status is already REJECTED but no ledger proves the refund", async () => {
    mockWithdrawalUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockWithdrawalFindUnique.mockResolvedValueOnce({ status: "REJECTED", refundToken: "token-without-ledger" });
    mockLedgerFindFirst.mockResolvedValueOnce(null);

    await expect(executeAtomicRefund(input)).rejects.toThrow(/without a REFUND ledger/);
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockLedgerCreate).not.toHaveBeenCalled();
  });

  it("propagates ledger failure so the enclosing database transaction rolls back", async () => {
    mockLedgerCreate.mockRejectedValueOnce(new Error("simulated ledger insert failure"));
    await expect(executeAtomicRefund(input)).rejects.toThrow("simulated ledger insert failure");
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
    // There is no separate compensation write after the transaction rejects.
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
  });
});
