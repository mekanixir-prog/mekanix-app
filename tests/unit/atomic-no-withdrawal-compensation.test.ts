import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = {
  wallet: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  walletLedger: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  idempotencyKey: {
    updateMany: vi.fn(),
  },
};
const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    $transaction: (callback: (client: typeof tx) => Promise<unknown>) => transaction(callback),
  })),
}));

import { executeAtomicNoWithdrawalCompensation } from "@/lib/atomic-refund";

describe("executeAtomicNoWithdrawalCompensation (SQLite transaction)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.wallet.findUnique.mockResolvedValue({ balance: 1000 });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.walletLedger.findFirst.mockResolvedValue(null);
    tx.walletLedger.create.mockResolvedValue({ id: "ledger_comp_1" });
    tx.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });
  });

  const input = {
    walletId: "wallet_1",
    amount: 500,
    scopedKey: "withdraw:user_1:key_1",
    description: "Compensation refund",
    createdBy: "system-compensation",
  };

  it("increments, writes exact ledger balances, and finalizes the key in one transaction", async () => {
    const result = await executeAtomicNoWithdrawalCompensation(input);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet_1" },
      data: { balance: { increment: 500 } },
    });
    expect(tx.walletLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId: "wallet_1",
        type: "REFUND",
        amount: 500,
        balanceBefore: 1000,
        balanceAfter: 1500,
        referenceType: "Withdrawal",
        referenceId: input.scopedKey,
      }),
    });
    expect(tx.idempotencyKey.updateMany).toHaveBeenCalledWith({
      where: { key: input.scopedKey, status: "IN_PROGRESS" },
      data: {
        status: "FAILED",
        response: expect.stringContaining('"compensation":"completed"'),
      },
    });
    expect(result).toMatchObject({
      success: true,
      refundLedgerId: "ledger_comp_1",
      newBalance: 1500,
      alreadyRefunded: false,
    });
  });

  it("does not increment again when the refund ledger already exists", async () => {
    tx.walletLedger.findFirst.mockResolvedValue({ id: "ledger_existing" });
    tx.wallet.findUnique.mockResolvedValue({ balance: 1500 });

    const result = await executeAtomicNoWithdrawalCompensation(input);

    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      refundLedgerId: "ledger_existing",
      newBalance: 1500,
      alreadyRefunded: true,
    });
  });

  it("propagates ledger failures so the transaction can roll back the balance update", async () => {
    tx.walletLedger.create.mockRejectedValue(new Error("ledger write failed"));

    await expect(executeAtomicNoWithdrawalCompensation(input)).rejects.toThrow("ledger write failed");
    expect(tx.wallet.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.walletLedger.create).toHaveBeenCalledTimes(1);
    expect(tx.idempotencyKey.updateMany).not.toHaveBeenCalled();
  });

  it("throws if the idempotency key cannot be finalized, causing transaction rollback", async () => {
    tx.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });

    await expect(executeAtomicNoWithdrawalCompensation(input)).rejects.toThrow(
      "Idempotency key changed during atomic compensation"
    );
  });
});
