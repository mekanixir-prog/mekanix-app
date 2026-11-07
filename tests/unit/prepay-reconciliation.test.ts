import { describe, expect, it } from "vitest";
import { validatePrepayRecordSet, type PrepayRecordSet } from "@/lib/prepay-reconciliation";

const valid: PrepayRecordSet = {
  job: {
    id: "job-1",
    prepayPaid: true,
    prepayPaidAt: new Date("2026-11-07T08:00:00.000Z"),
    inspectionFee: 600,
    travelFee: 400,
    platformCommission: 100,
    netEarnings: 900,
    financialUnitStatus: "VERIFIED_IRR",
  },
  prepayTransaction: {
    walletId: "wallet-1",
    jobId: "job-1",
    kind: "PREPAY",
    status: "PENDING",
    grossAmount: 1000,
    commissionAmount: 100,
    netAmount: 900,
    idempotencyKey: "prepay:job-1:PREPAY",
    financialUnitStatus: "VERIFIED_IRR",
  },
  commissionTransaction: {
    walletId: "wallet-1",
    jobId: "job-1",
    kind: "COMMISSION",
    status: "COMPLETED",
    grossAmount: 0,
    commissionAmount: 100,
    netAmount: -100,
    idempotencyKey: "prepay:job-1:COMMISSION",
    financialUnitStatus: "VERIFIED_IRR",
  },
  holdLedger: {
    walletId: "wallet-1",
    type: "HOLD",
    amount: 900,
    balanceBefore: 50,
    balanceAfter: 950,
    referenceType: "Job",
    referenceId: "job-1",
    idempotencyKey: "prepay:job-1:LEDGER_HOLD",
    financialUnitStatus: "VERIFIED_IRR",
  },
  commissionLedger: {
    walletId: "wallet-1",
    type: "COMMISSION",
    amount: -100,
    balanceBefore: 950,
    balanceAfter: 950,
    referenceType: "Job",
    referenceId: "job-1",
    idempotencyKey: "prepay:job-1:LEDGER_COMMISSION",
    financialUnitStatus: "VERIFIED_IRR",
  },
};

describe("prepay record-set reconciliation", () => {
  it("accepts a fully matching verified-IRR record set", () => {
    expect(validatePrepayRecordSet(valid)).toEqual({ ok: true });
  });

  it("rejects an existing but mismatched PREPAY transaction", () => {
    const changed = {
      ...valid,
      prepayTransaction: { ...valid.prepayTransaction!, grossAmount: 999 },
    };
    expect(validatePrepayRecordSet(changed)).toMatchObject({
      ok: false,
      reason: "PREPAY_TRANSACTION_MISMATCH",
    });
  });

  it("rejects a wallet or job reference mismatch", () => {
    const changed = {
      ...valid,
      commissionLedger: { ...valid.commissionLedger!, walletId: "wallet-other" },
    };
    expect(validatePrepayRecordSet(changed)).toMatchObject({
      ok: false,
      reason: "WALLET_REFERENCE_MISMATCH",
    });
  });

  it("rejects a ledger balance that does not follow the hold", () => {
    const changed = {
      ...valid,
      holdLedger: { ...valid.holdLedger!, balanceAfter: 949 },
    };
    expect(validatePrepayRecordSet(changed)).toMatchObject({
      ok: false,
      reason: "HOLD_LEDGER_MISMATCH",
    });
  });

  it("rejects unverified financial provenance even when all four rows exist", () => {
    const changed = {
      ...valid,
      commissionTransaction: {
        ...valid.commissionTransaction!,
        financialUnitStatus: "UNVERIFIED",
      },
    };
    expect(validatePrepayRecordSet(changed)).toMatchObject({
      ok: false,
      reason: "LEDGER_FINANCIAL_PROVENANCE_UNVERIFIED",
    });
  });

  it("rejects a paid marker without the complete four-row set", () => {
    const changed = { ...valid, commissionLedger: null };
    expect(validatePrepayRecordSet(changed)).toMatchObject({
      ok: false,
      reason: "FINANCIAL_RECORD_MISSING",
    });
  });
});
