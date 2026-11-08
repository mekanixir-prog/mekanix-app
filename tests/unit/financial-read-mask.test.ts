import { describe, expect, it } from "vitest";
import {
  isSafeStoredIrrAmount,
  maskFinancialFields,
  markFinancialRecordUnverifiedWhenFieldsChanged,
  TECHNICIAN_FEE_FIELDS,
  maskInvoiceFinancialData,
  maskJobFinancialData,
  maskWalletFinancialData,
  sumSafeStoredIrrAmounts,
  sumVerifiedIrrAmounts,
} from "@/lib/money/financial-read-mask";

describe("financial read masking", () => {
  it("validates integer IRR values without rounding or unsafe Number coercion", () => {
    expect(isSafeStoredIrrAmount(0)).toBe(true);
    expect(isSafeStoredIrrAmount(-125)).toBe(true);
    expect(isSafeStoredIrrAmount("9007199254740991")).toBe(true);
    expect(isSafeStoredIrrAmount("12.5")).toBe(false);
    expect(isSafeStoredIrrAmount("9007199254740992")).toBe(false);
    expect(isSafeStoredIrrAmount("not-a-number")).toBe(false);
    expect(isSafeStoredIrrAmount(null)).toBe(true);
  });

  it("invalidates technician fee attestation whenever any fee field changes", () => {
    expect(markFinancialRecordUnverifiedWhenFieldsChanged(
      { hourlyRate: 2500 },
      TECHNICIAN_FEE_FIELDS,
    )).toEqual({ hourlyRate: 2500, financialUnitStatus: "UNVERIFIED" });

    expect(markFinancialRecordUnverifiedWhenFieldsChanged(
      { bio: "Updated profile" },
      TECHNICIAN_FEE_FIELDS,
    )).toEqual({ bio: "Updated profile" });
  });

  it("sums verified integer IRR amounts without exceeding safe integer precision", () => {
    expect(sumSafeStoredIrrAmounts(["100", 250, null])).toBe(350);
    expect(sumSafeStoredIrrAmounts([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
    expect(sumSafeStoredIrrAmounts(["10", "0.5"])).toBeNull();
    expect(sumSafeStoredIrrAmounts(["9007199254740992"])).toBeNull();
    expect(sumSafeStoredIrrAmounts([])).toBe(0);
  });

  it("returns no verified revenue aggregate when an amount is missing or unsafe", () => {
    expect(sumVerifiedIrrAmounts([100, "250"])).toBe(350);
    expect(sumVerifiedIrrAmounts([100, null])).toBeNull();
    expect(sumVerifiedIrrAmounts(["10.5"])).toBeNull();
    expect(sumVerifiedIrrAmounts([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
    expect(sumVerifiedIrrAmounts([])).toBe(0);
  });

  it("masks all monetary fields when provenance is absent or unverified", () => {
    const result = maskFinancialFields(
      { id: "w1", financialUnitStatus: "UNVERIFIED", balance: "1200", label: "wallet" },
      ["balance"],
    );
    expect(result).toMatchObject({
      id: "w1",
      financialUnitStatus: "UNVERIFIED",
      balance: null,
      label: "wallet",
    });
  });

  it("preserves only safe integer IRR records with matching currency", () => {
    const record = {
      financialUnitStatus: "VERIFIED_IRR",
      currency: "IRR",
      amount: "125000",
    };
    expect(maskFinancialFields(record, ["amount"], "currency")).toEqual(record);
  });

  it("quarantines conflicting currency and invalid amounts even when status claims verified", () => {
    expect(maskFinancialFields(
      { financialUnitStatus: "VERIFIED_IRR", currency: "USD", amount: 100 },
      ["amount"],
      "currency",
    )).toMatchObject({ financialUnitStatus: "QUARANTINED", amount: null });

    expect(maskFinancialFields(
      { financialUnitStatus: "VERIFIED_IRR", amount: "12.75" },
      ["amount"],
    )).toMatchObject({ financialUnitStatus: "QUARANTINED", amount: null });
  });

  it("masks wallet aggregates, each transaction, and withdrawals independently", () => {
    const wallet = maskWalletFinancialData({
      id: "wallet-1",
      financialUnitStatus: "UNVERIFIED",
      balance: "100",
      pendingBalance: "50",
      totalEarned: "200",
      totalCommission: "20",
      totalWithdrawn: "30",
      transactions: [{
        id: "txn-1",
        financialUnitStatus: "VERIFIED_IRR",
        grossAmount: "100",
        commissionAmount: "10",
        netAmount: "90",
      }, {
        id: "txn-2",
        financialUnitStatus: "UNVERIFIED",
        grossAmount: "200",
        commissionAmount: "20",
        netAmount: "180",
      }],
      withdrawals: [{
        id: "wd-1",
        financialUnitStatus: "UNVERIFIED",
        amount: "25",
      }],
    });

    expect(wallet.balance).toBeNull();
    expect(wallet.totalEarned).toBeNull();
    expect(wallet.transactions[0].netAmount).toBe("90");
    expect(wallet.transactions[1].netAmount).toBeNull();
    expect(wallet.withdrawals[0].amount).toBeNull();
  });

  it("masks nested invoice, payment, technician, and part amounts", () => {
    const invoice = maskInvoiceFinancialData({
      id: "inv-1",
      financialUnitStatus: "UNVERIFIED",
      currency: "IRR",
      total: "5000",
      payment: { id: "pay-1", financialUnitStatus: "UNVERIFIED", currency: "IRR", amount: "5000" },
      job: {
        id: "job-1",
        financialUnitStatus: "UNVERIFIED",
        travelFee: "200",
        technician: { id: "tech-1", financialUnitStatus: "UNVERIFIED", hourlyRate: "100" },
        parts: [{ id: "part-1", financialUnitStatus: "UNVERIFIED", unitPrice: "300" }],
      },
    });

    expect(invoice.total).toBeNull();
    expect(invoice.payment.amount).toBeNull();
    expect(invoice.job.travelFee).toBeNull();
    expect(invoice.job.technician.hourlyRate).toBeNull();
    expect(invoice.job.parts[0].unitPrice).toBeNull();
  });

  it("masks job reads using the same record-level rules", () => {
    const job = maskJobFinancialData({
      id: "job-2",
      financialUnitStatus: "UNVERIFIED",
      inspectionFee: "100",
      invoice: { id: "inv-2", financialUnitStatus: "UNVERIFIED", currency: "IRR", total: "100" },
      parts: [{ id: "part-2", financialUnitStatus: "VERIFIED_IRR", unitPrice: "75" }],
    });
    expect(job.inspectionFee).toBeNull();
    expect(job.invoice.total).toBeNull();
    expect(job.parts[0].unitPrice).toBe("75");
  });
  it("masks a wallet nested under the technician relation in a job response", () => {
    const job = maskJobFinancialData({
      id: "job-wallet",
      financialUnitStatus: "VERIFIED_IRR",
      inspectionFee: 100,
      technician: {
        id: "tech-wallet",
        financialUnitStatus: "VERIFIED_IRR",
        hourlyRate: 10,
        wallet: {
          id: "wallet-nested",
          financialUnitStatus: "UNVERIFIED",
          balance: "5000",
          pendingBalance: "2000",
          totalEarned: "7000",
          totalCommission: "700",
          totalWithdrawn: "0",
        },
      },
    });
    expect(job.technician.hourlyRate).toBe(10);
    expect(job.technician.wallet.balance).toBeNull();
    expect(job.technician.wallet.pendingBalance).toBeNull();
    expect(job.technician.wallet.financialUnitStatus).toBe("UNVERIFIED");
  });

});
