// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  technician: vi.fn(),
  participant: vi.fn(),
  wallet: vi.fn(),
  withdrawal: vi.fn(),
  withdrawalLedger: vi.fn(),
  job: vi.fn(),
  walletTxn: vi.fn(),
  ledger: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({
  getTechnicianFromSession: mocks.technician,
  requireJobParticipant: mocks.participant,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    wallet: { findUnique: mocks.wallet },
    withdrawalRequest: { findUnique: mocks.withdrawal },
    walletLedger: { findUnique: mocks.withdrawalLedger },
    job: { findUnique: mocks.job },
    walletTransaction: { findUnique: mocks.walletTxn },
    walletLedger: { findUnique: mocks.ledger },
  }),
}));

import { GET as getWithdrawalStatus } from "@/app/api/wallets/withdraw/status/route";
import { GET as getPrepayStatus } from "@/app/api/prepay/status/route";

const technicianSession = { userId: "user-1", role: "TECHNICIAN" };
const customerSession = { userId: "customer-1", role: "CUSTOMER" };

function request(url: string) {
  return new Request(`https://mekanix.test${url}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(technicianSession);
  mocks.technician.mockResolvedValue({ id: "tech-1" });
  mocks.participant.mockResolvedValue(null);
  mocks.wallet.mockResolvedValue({ id: "wallet-1" });
  mocks.withdrawal.mockResolvedValue(null);
  mocks.withdrawalLedger.mockResolvedValue(null);
  mocks.job.mockResolvedValue({
    id: "job-1", code: "JOB-1001", prepayPaid: false, prepayPaidAt: null,
    inspectionFee: 100, travelFee: 20, platformCommission: 12, netEarnings: 108,
  });
  mocks.walletTxn.mockResolvedValue(null);
  mocks.ledger.mockResolvedValue(null);
});

describe("read-only offline reconciliation endpoints", () => {
  it("reports a withdrawal as committed only when it belongs to the authenticated technician", async () => {
    mocks.withdrawal.mockResolvedValue({
      id: "wd-1", walletId: "wallet-1", code: "WD-1001", amount: 500,
      status: "REQUESTED", requestedAt: new Date("2026-10-31T10:00:00Z"), processedAt: null,
    });
    mocks.withdrawalLedger.mockResolvedValue({ id: "ledger-1", referenceId: "wd-1", amount: -500 });
    const response = await getWithdrawalStatus(request("/api/wallets/withdraw/status?key=idem_12345678"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "COMMITTED",
      withdrawal: { id: "wd-1", code: "WD-1001", amount: "500", status: "REQUESTED" },
    });
    expect(mocks.withdrawal).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: "idem_12345678" },
    }));
  });

  it("does not report a withdrawal committed when its debit ledger row is missing", async () => {
    mocks.withdrawal.mockResolvedValue({
      id: "wd-1", walletId: "wallet-1", code: "WD-1001", amount: 500,
      status: "REQUESTED", requestedAt: new Date("2026-10-31T10:00:00Z"), processedAt: null,
    });
    mocks.withdrawalLedger.mockResolvedValue(null);
    const response = await getWithdrawalStatus(request("/api/wallets/withdraw/status?key=idem_12345678"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      withdrawalCode: "WD-1001",
      ledgerFound: false,
    });
  });

  it("flags an orphan debit ledger row instead of reporting NOT_COMMITTED", async () => {
    mocks.withdrawal.mockResolvedValue(null);
    mocks.withdrawalLedger.mockResolvedValue({ id: "ledger-orphan", referenceId: "wd-missing", amount: -500 });
    const response = await getWithdrawalStatus(request("/api/wallets/withdraw/status?key=idem_12345678"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      ledgerFound: true,
      requestFound: false,
    });
  });

  it("flags existing withdrawal records when the technician wallet is missing", async () => {
    mocks.wallet.mockResolvedValue(null);
    mocks.withdrawal.mockResolvedValue({
      id: "wd-1", walletId: "wallet-1", code: "WD-1001", amount: 500,
      status: "REQUESTED", requestedAt: new Date(), processedAt: null,
    });
    mocks.withdrawalLedger.mockResolvedValue({ id: "ledger-1", referenceId: "wd-1", amount: -500 });
    const response = await getWithdrawalStatus(request("/api/wallets/withdraw/status?key=idem_12345678"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      requestFound: true,
      ledgerFound: true,
    });
  });

  it("reports NOT_COMMITTED when no withdrawal record exists", async () => {
    const response = await getWithdrawalStatus(request("/api/wallets/withdraw/status?key=idem_12345678"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: "NOT_COMMITTED" });
  });

  it("does not disclose a key owned by another technician", async () => {
    mocks.withdrawal.mockResolvedValue({ id: "wd-other", walletId: "wallet-other" });
    const response = await getWithdrawalStatus(request("/api/wallets/withdraw/status?key=idem_12345678"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ state: "KEY_CONFLICT" });
  });

  it("requires a valid key and technician role", async () => {
    const invalid = await getWithdrawalStatus(request("/api/wallets/withdraw/status?key=x"));
    expect(invalid.status).toBe(400);
    mocks.auth.mockResolvedValue(customerSession);
    const forbidden = await getWithdrawalStatus(request("/api/wallets/withdraw/status?key=idem_12345678"));
    expect(forbidden.status).toBe(403);
  });

  it("reports prepay committed only when the job marker and all four financial records exist", async () => {
    mocks.auth.mockResolvedValue(customerSession);
    mocks.job.mockResolvedValue({
      id: "job-1", code: "JOB-1001", prepayPaid: true,
      prepayPaidAt: new Date("2026-10-31T10:00:00Z"),
      inspectionFee: 100, travelFee: 20, platformCommission: 12, netEarnings: 108,
    });
    mocks.walletTxn.mockResolvedValue({ id: "txn" });
    mocks.ledger.mockResolvedValue({ id: "ledger" });
    const response = await getPrepayStatus(request("/api/prepay/status?jobId=job-1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "COMMITTED",
      prepay: { jobId: "job-1", jobCode: "JOB-1001", inspectionFee: "100", travelFee: "20", commission: "12", net: "108" },
    });
    expect(mocks.walletTxn).toHaveBeenCalledTimes(2);
    expect(mocks.ledger).toHaveBeenCalledTimes(2);
  });

  it("reports NOT_COMMITTED only when both the job marker and all financial rows are absent", async () => {
    mocks.auth.mockResolvedValue(customerSession);
    const response = await getPrepayStatus(request("/api/prepay/status?jobId=job-1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: "NOT_COMMITTED", jobId: "job-1", retryAllowed: true });
  });

  it("returns reconciliation-required for an inconsistent partial financial state", async () => {
    mocks.auth.mockResolvedValue(customerSession);
    mocks.job.mockResolvedValue({
      id: "job-1", code: "JOB-1001", prepayPaid: true,
      prepayPaidAt: new Date(), inspectionFee: 100, travelFee: 20,
      platformCommission: 12, netEarnings: 108,
    });
    mocks.walletTxn.mockResolvedValueOnce({ id: "txn" }).mockResolvedValueOnce(null);
    mocks.ledger.mockResolvedValueOnce({ id: "ledger" }).mockResolvedValueOnce(null);
    const response = await getPrepayStatus(request("/api/prepay/status?jobId=job-1"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      recordedFinancialRows: 2,
      expectedFinancialRows: 4,
    });
  });

  it("rejects fleet and partner roles before participant lookup", async () => {
    mocks.auth.mockResolvedValue({ userId: "fleet-1", role: "FLEET_MANAGER" });
    const response = await getPrepayStatus(request("/api/prepay/status?jobId=job-1"));
    expect(response.status).toBe(403);
    expect(mocks.participant).not.toHaveBeenCalled();
    expect(mocks.job).not.toHaveBeenCalled();
  });

  it("does not inspect a prepay job when participant authorization fails", async () => {
    mocks.auth.mockResolvedValue(customerSession);
    mocks.participant.mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const response = await getPrepayStatus(request("/api/prepay/status?jobId=job-1"));
    expect(response.status).toBe(403);
    expect(mocks.job).not.toHaveBeenCalled();
  });
});
