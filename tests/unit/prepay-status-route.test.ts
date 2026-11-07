// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  participant: vi.fn(),
  db: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({ requireJobParticipant: mocks.participant }));
vi.mock("@/lib/db-access", () => ({ getDbForLib: mocks.db }));

import { GET } from "@/app/api/prepay/status/route";

const job = {
  id: "job-1",
  code: "JOB-100001",
  prepayPaid: true,
  prepayPaidAt: new Date("2026-11-07T08:00:00.000Z"),
  inspectionFee: 600,
  travelFee: 400,
  platformCommission: 100,
  netEarnings: 900,
  financialUnitStatus: "VERIFIED_IRR",
};

const prepayTransaction = {
  walletId: "wallet-1",
  jobId: "job-1",
  kind: "PREPAY",
  status: "PENDING",
  grossAmount: 1000,
  commissionAmount: 100,
  netAmount: 900,
  idempotencyKey: "prepay:job-1:PREPAY",
  financialUnitStatus: "VERIFIED_IRR",
};

const commissionTransaction = {
  walletId: "wallet-1",
  jobId: "job-1",
  kind: "COMMISSION",
  status: "COMPLETED",
  grossAmount: 0,
  commissionAmount: 100,
  netAmount: -100,
  idempotencyKey: "prepay:job-1:COMMISSION",
  financialUnitStatus: "VERIFIED_IRR",
};

const holdLedger = {
  walletId: "wallet-1",
  type: "HOLD",
  amount: 900,
  balanceBefore: 50,
  balanceAfter: 950,
  referenceType: "Job",
  referenceId: "job-1",
  idempotencyKey: "prepay:job-1:LEDGER_HOLD",
  financialUnitStatus: "VERIFIED_IRR",
};

const commissionLedger = {
  walletId: "wallet-1",
  type: "COMMISSION",
  amount: -100,
  balanceBefore: 950,
  balanceAfter: 950,
  referenceType: "Job",
  referenceId: "job-1",
  idempotencyKey: "prepay:job-1:LEDGER_COMMISSION",
  financialUnitStatus: "VERIFIED_IRR",
};

function makeDb(rows = {}) {
  return {
    job: { findUnique: vi.fn().mockResolvedValue(job) },
    walletTransaction: {
      findUnique: vi.fn()
        .mockImplementation(async ({ where }: { where: { idempotencyKey: string } }) =>
          where.idempotencyKey.endsWith(":PREPAY")
            ? (rows.prepay ?? prepayTransaction)
            : (rows.commission ?? commissionTransaction)),
    },
    walletLedger: {
      findUnique: vi.fn()
        .mockImplementation(async ({ where }: { where: { idempotencyKey: string } }) =>
          where.idempotencyKey.endsWith(":LEDGER_HOLD")
            ? (rows.hold ?? holdLedger)
            : (rows.commissionLedger ?? commissionLedger)),
    },
  };
}

function request() {
  return new Request("https://mekanix.test/api/prepay/status?jobId=job-1");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "customer-1", role: "CUSTOMER" });
  mocks.participant.mockResolvedValue(null);
});

describe("GET /api/prepay/status", () => {
  it("reports COMMITTED only when the job and all four financial rows reconcile", async () => {
    mocks.db.mockResolvedValue(makeDb());
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "COMMITTED",
      prepay: {
        jobId: "job-1",
        inspectionFee: "600",
        travelFee: "400",
        commission: "100",
        net: "900",
        financialUnitStatus: "VERIFIED_IRR",
      },
    });
  });

  it("does not report COMMITTED when four existing rows contain a mismatched amount", async () => {
    mocks.db.mockResolvedValue(makeDb({
      prepay: { ...prepayTransaction, grossAmount: 999 },
    }));
    const response = await GET(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      recordedFinancialRows: 4,
      reason: "PREPAY_TRANSACTION_MISMATCH",
    });
  });

  it("does not report COMMITTED when a ledger row has unverified provenance", async () => {
    mocks.db.mockResolvedValue(makeDb({
      commissionLedger: { ...commissionLedger, financialUnitStatus: "UNVERIFIED" },
    }));
    const response = await GET(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      reason: "LEDGER_FINANCIAL_PROVENANCE_UNVERIFIED",
    });
  });

  it("reports NOT_COMMITTED only when neither the job marker nor any financial row exists", async () => {
    const db = makeDb({
      prepay: null,
      commission: null,
      hold: null,
      commissionLedger: null,
    });
    db.job.findUnique.mockResolvedValue({ ...job, prepayPaid: false });
    mocks.db.mockResolvedValue(db);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "NOT_COMMITTED", retryAllowed: true });
  });
});
