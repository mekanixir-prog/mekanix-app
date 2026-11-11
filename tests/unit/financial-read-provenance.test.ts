import { describe, expect, it } from "vitest";
import { maskInvoiceMoney, maskWalletMoney } from "@/lib/money/read-provenance";

describe("financial API read provenance masking", () => {
  it("masks wallet totals and each unverified transaction/withdrawal independently", () => {
    const result = maskWalletMoney({
      financialUnitStatus: "UNVERIFIED",
      balance: 1000,
      pendingBalance: 200,
      totalEarned: 1200,
      totalCommission: 100,
      totalWithdrawn: 0,
      transactions: [
        { financialUnitStatus: "UNVERIFIED", grossAmount: 100, commissionAmount: 10, netAmount: 90, status: "PENDING" },
        { financialUnitStatus: "VERIFIED_IRR", grossAmount: 200, commissionAmount: 20, netAmount: 180, status: "AVAILABLE" },
      ],
      withdrawals: [
        { financialUnitStatus: "UNVERIFIED", amount: 50, status: "REQUESTED" },
        { financialUnitStatus: "VERIFIED_IRR", amount: 75, status: "PAID" },
      ],
    });

    expect(result.balance).toBeNull();
    expect(result.pendingBalance).toBeNull();
    expect((result.transactions as any[])[0]).toMatchObject({
      grossAmount: null, commissionAmount: null, netAmount: null, status: "PENDING",
    });
    expect((result.transactions as any[])[1].netAmount).toBe(180);
    expect((result.withdrawals as any[])[0]).toMatchObject({ amount: null, status: "REQUESTED" });
    expect((result.withdrawals as any[])[1].amount).toBe(75);
  });

  it("requires explicit verified IRR on wallet and all child records", () => {
    const result = maskWalletMoney({
      financialUnitStatus: "VERIFIED_IRR",
      balance: 500,
      transactions: [{ financialUnitStatus: "VERIFIED_IRR", grossAmount: 500 }],
      withdrawals: [{ financialUnitStatus: "VERIFIED_IRR", amount: 100 }],
    });
    expect(result.balance).toBe(500);
    expect((result.transactions as any[])[0].grossAmount).toBe(500);
    expect((result.withdrawals as any[])[0].amount).toBe(100);
  });

  it("masks invoice and nested payment/job/technician/part values by each row's own provenance", () => {
    const result = maskInvoiceMoney({
      financialUnitStatus: "UNVERIFIED",
      currency: "IRR",
      total: 1000,
      laborRate: 100,
      payment: { financialUnitStatus: "VERIFIED_IRR", currency: "IRR", amount: 1000 },
      job: {
        financialUnitStatus: "UNVERIFIED",
        inspectionFee: 50,
        technician: {
          financialUnitStatus: "VERIFIED_IRR",
          hourlyRate: 100,
          travelFeeBase: 20,
        },
        parts: [
          { financialUnitStatus: "UNVERIFIED", unitPrice: 300, name: "part A" },
          { financialUnitStatus: "VERIFIED_IRR", unitPrice: 400, name: "part B" },
        ],
      },
    });

    expect(result.total).toBeNull();
    expect(result.laborRate).toBeNull();
    expect((result.payment as any).amount).toBe(1000);
    expect((result.job as any).inspectionFee).toBeNull();
    expect((result.job as any).technician.hourlyRate).toBe(100);
    expect((result.job as any).parts[0]).toMatchObject({ unitPrice: null, name: "part A" });
    expect((result.job as any).parts[1].unitPrice).toBe(400);
  });

  it("does not treat an IRR currency label as provenance", () => {
    const result = maskInvoiceMoney({
      financialUnitStatus: "UNVERIFIED",
      currency: "IRR",
      total: 900,
      payment: { financialUnitStatus: "VERIFIED_IRR", currency: "USD", amount: 900 },
    });
    expect(result.total).toBeNull();
    expect((result.payment as any).amount).toBeNull();
  });
});
