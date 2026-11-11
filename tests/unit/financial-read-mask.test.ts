import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  isSafeStoredIrrAmount,
  isSafeNonNegativeStoredIrrAmount,
  sumSafeStoredIrrAmounts,
  sumVerifiedPositiveIrrAmounts,
  markFinancialRecordUnverifiedWhenFieldsChanged,
  maskFinancialFields,
  maskInvoiceFinancialData,
  maskJobFinancialData,
  maskWalletFinancialData,
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
    expect(isSafeNonNegativeStoredIrrAmount(0)).toBe(true);
    expect(isSafeNonNegativeStoredIrrAmount(-1)).toBe(false);
    expect(isSafeNonNegativeStoredIrrAmount("12.5")).toBe(false);
  });

  it("sums exact IRR amounts and returns null on invalid or overflowing aggregates", () => {
    expect(sumSafeStoredIrrAmounts([new Decimal("100"), "200", 300])).toBe(600);
    expect(sumSafeStoredIrrAmounts([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
    expect(sumSafeStoredIrrAmounts([100, "1.5"])).toBeNull();
  });

  it("requires every dashboard amount to be present, safe, and positive", () => {
    expect(sumVerifiedPositiveIrrAmounts([100, new Decimal("200")])).toBe(300);
    expect(sumVerifiedPositiveIrrAmounts([])).toBe(0);
    expect(sumVerifiedPositiveIrrAmounts([100, 0])).toBeNull();
    expect(sumVerifiedPositiveIrrAmounts([100, null])).toBeNull();
    expect(sumVerifiedPositiveIrrAmounts([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
  });

  it("invalidates technician fee provenance when any fee field changes", () => {
    expect(markFinancialRecordUnverifiedWhenFieldsChanged(
      { hourlyRate: 500, bio: "updated" },
      ["hourlyRate", "travelFeeBase"],
    )).toMatchObject({ hourlyRate: 500, bio: "updated", financialUnitStatus: "UNVERIFIED" });
    expect(markFinancialRecordUnverifiedWhenFieldsChanged(
      { bio: "updated" },
      ["hourlyRate", "travelFeeBase"],
    )).toEqual({ bio: "updated" });
  });

  it("quarantines negative nonnegative fields while preserving signed transaction deltas", () => {
    const invoice = maskFinancialFields(
      { financialUnitStatus: "VERIFIED_IRR", total: -100 },
      ["total"],
    );
    expect(invoice).toMatchObject({ financialUnitStatus: "QUARANTINED", total: null });

    const wallet = maskWalletFinancialData({
      financialUnitStatus: "VERIFIED_IRR",
      balance: -1,
      pendingBalance: 0,
      totalEarned: 0,
      totalCommission: 0,
      totalWithdrawn: 0,
      transactions: [{
        financialUnitStatus: "VERIFIED_IRR",
        grossAmount: 0,
        commissionAmount: 100,
        netAmount: -100,
      }],
    });
    expect(wallet.financialUnitStatus).toBe("QUARANTINED");
    expect(wallet.balance).toBeNull();
    expect(wallet.transactions[0].financialUnitStatus).toBe("VERIFIED_IRR");
    expect(wallet.transactions[0].netAmount).toBe(-100);
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

  it("quarantines a verified invoice when its explicit currency field is missing", () => {
    expect(maskFinancialFields(
      { financialUnitStatus: "VERIFIED_IRR", amount: 125 },
      ["amount"],
      "currency",
    )).toMatchObject({ financialUnitStatus: "QUARANTINED", amount: null });
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
});
