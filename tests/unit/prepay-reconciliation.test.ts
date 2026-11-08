import { describe, expect, it } from "vitest";
import { isCommittedPrepayConsistent } from "@/lib/prepay-reconciliation";

const job = {
  id: "job-1",
  prepayPaid: true,
  financialUnitStatus: "VERIFIED_IRR",
  inspectionFee: 600,
  travelFee: 400,
  platformCommission: 100,
  netEarnings: 900,
};
const wallet = {
  id: "wallet-1",
  financialUnitStatus: "VERIFIED_IRR",
  balance: 0,
  pendingBalance: 1000,
  totalEarned: 1000,
  totalCommission: 100,
  totalWithdrawn: 0,
};
const prepayTransaction = {
  walletId: "wallet-1",
  jobId: "job-1",
  financialUnitStatus: "VERIFIED_IRR",
  kind: "PREPAY",
  status: "PENDING",
  grossAmount: 1000,
  commissionAmount: 100,
  netAmount: 900,
};
const commissionTransaction = {
  walletId: "wallet-1",
  jobId: "job-1",
  financialUnitStatus: "VERIFIED_IRR",
  kind: "COMMISSION",
  status: "COMPLETED",
  grossAmount: 0,
  commissionAmount: 100,
  netAmount: -100,
};
const holdLedger = {
  walletId: "wallet-1",
  financialUnitStatus: "VERIFIED_IRR",
  type: "HOLD",
  amount: 900,
  balanceBefore: 100,
  balanceAfter: 1000,
  referenceType: "Job",
  referenceId: "job-1",
};
const commissionLedger = {
  walletId: "wallet-1",
  financialUnitStatus: "VERIFIED_IRR",
  type: "COMMISSION",
  amount: -100,
  balanceBefore: 100,
  balanceAfter: 100,
  referenceType: "Job",
  referenceId: "job-1",
};

function check(overrides: {
  job?: Record<string, unknown>;
  wallet?: Record<string, unknown> | null;
  prepayTransaction?: Record<string, unknown> | null;
  commissionTransaction?: Record<string, unknown> | null;
  holdLedger?: Record<string, unknown> | null;
  commissionLedger?: Record<string, unknown> | null;
} = {}) {
  return isCommittedPrepayConsistent(
    { ...job, ...overrides.job } as never,
    overrides.wallet === undefined ? wallet : overrides.wallet as never,
    overrides.prepayTransaction === undefined ? prepayTransaction : overrides.prepayTransaction as never,
    overrides.commissionTransaction === undefined ? commissionTransaction : overrides.commissionTransaction as never,
    overrides.holdLedger === undefined ? holdLedger : overrides.holdLedger as never,
    overrides.commissionLedger === undefined ? commissionLedger : overrides.commissionLedger as never,
  );
}

describe("prepay reconciliation evidence", () => {
  it("accepts a complete, linked, verified IRR prepay", () => {
    expect(check()).toBe(true);
  });

  it("rejects a paid marker when a financial row amount does not match the job", () => {
    expect(check({ prepayTransaction: { ...prepayTransaction, netAmount: 899 } })).toBe(false);
  });

  it("rejects a row with missing or unverified provenance", () => {
    expect(check({ commissionLedger: { ...commissionLedger, financialUnitStatus: "UNVERIFIED" } })).toBe(false);
  });

  it("rejects rows linked to another wallet or job", () => {
    expect(check({ holdLedger: { ...holdLedger, referenceId: "job-other" } })).toBe(false);
    expect(check({ prepayTransaction: { ...prepayTransaction, walletId: "wallet-other" } })).toBe(false);
  });

  it("rejects unsafe, missing, or internally inconsistent job amounts", () => {
    expect(check({ job: { netEarnings: null } })).toBe(false);
    expect(check({ job: { inspectionFee: 600.5 } })).toBe(false);
    expect(check({ job: { netEarnings: 800 } })).toBe(false);
  });

  it("rejects a missing or unverified wallet even when all four ledger rows exist", () => {
    expect(check({ wallet: null })).toBe(false);
    expect(check({ wallet: { ...wallet, financialUnitStatus: "UNVERIFIED" } })).toBe(false);
  });

  it("checks the hold ledger arithmetic rather than just its existence", () => {
    expect(check({ holdLedger: { ...holdLedger, balanceAfter: 999 } })).toBe(false);
  });
});
