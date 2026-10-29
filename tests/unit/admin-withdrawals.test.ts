// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWithdrawalRequestFindUnique = vi.fn();
const mockWithdrawalRequestFindMany = vi.fn();
const mockWithdrawalRequestUpdateMany = vi.fn();
const mockWalletLedgerFindFirst = vi.fn();
const mockExecuteAtomicRefund = vi.fn();
const mockGetAdminFromRequest = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    withdrawalRequest: {
      findUnique: (...args: any[]) => mockWithdrawalRequestFindUnique(...args),
      findMany: (...args: any[]) => mockWithdrawalRequestFindMany(...args),
      updateMany: (...args: any[]) => mockWithdrawalRequestUpdateMany(...args),
    },
    walletLedger: {
      findFirst: (...args: any[]) => mockWalletLedgerFindFirst(...args),
    },
  })),
}));

vi.mock("@/lib/atomic-refund", () => ({
  executeAtomicRefund: (...args: any[]) => mockExecuteAtomicRefund(...args),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: (...args: any[]) => mockGetAdminFromRequest(...args),
}));

import { PATCH } from "@/app/api/admin/withdrawals/[id]/route";
import { GET } from "@/app/api/admin/withdrawals/route";

function patchReq(id: string, body: unknown, authed = true): Request {
  return new Request(`https://mekanix.test/api/admin/withdrawals/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authed ? { authorization: "Bearer admin-token" } : {}) },
    body: JSON.stringify(body),
  });
}
function getReq(search = "", authed = true): Request {
  return new Request(`https://mekanix.test/api/admin/withdrawals${search ? `?${search}` : ""}`, {
    method: "GET",
    headers: { ...(authed ? { authorization: "Bearer admin-token" } : {}) },
  });
}

const SAMPLE_REQUEST = {
  id: "wd_1",
  code: "WD-123456",
  walletId: "wallet_1",
  amount: 500,
  method: "card",
  status: "REQUESTED",
  requestedAt: new Date("2026-01-01T00:00:00Z"),
  processedAt: null,
  reviewerId: null,
  adminNotes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminFromRequest.mockResolvedValue({ adminId: "admin_1", username: "admin", role: "SUPER_ADMIN" });
  mockWalletLedgerFindFirst.mockResolvedValue(null);
  mockWithdrawalRequestFindMany.mockResolvedValue([]);
  mockWithdrawalRequestUpdateMany.mockResolvedValue({ count: 1 });
  mockExecuteAtomicRefund.mockResolvedValue({
    success: true,
    refundLedgerId: "ledger_refund_1",
    newBalance: 1000,
    alreadyRefunded: false,
  });
});

describe("Admin withdrawal state machine", () => {
  it("approves only REQUESTED withdrawals without issuing a refund", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST)
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "APPROVED", reviewerId: "admin_1" });

    const response = await PATCH(patchReq("wd_1", { action: "APPROVE" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).withdrawal.status).toBe("APPROVED");
    expect(mockWithdrawalRequestUpdateMany.mock.calls[0][0].where).toEqual({ id: "wd_1", status: "REQUESTED" });
    expect(mockExecuteAtomicRefund).not.toHaveBeenCalled();
  });

  it("acquires REQUESTED then executes the atomic refund and returns REJECTED", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST)
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED", reviewerId: "admin_1" });
    const response = await PATCH(patchReq("wd_1", { action: "REJECT", notes: "duplicate" }), { params: Promise.resolve({ id: "wd_1" }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.withdrawal.status).toBe("REJECTED");
    expect(body.refund.newBalance).toBe(1000);
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockWithdrawalRequestUpdateMany.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: { id: "wd_1", status: "REQUESTED" },
      data: expect.objectContaining({ status: "REFUND_PENDING", reviewerId: "admin_1" }),
    }));
    expect(mockExecuteAtomicRefund).toHaveBeenCalledWith(expect.objectContaining({
      withdrawalId: "wd_1",
      walletId: "wallet_1",
      amount: 500,
      reviewerId: "admin_1",
    }));
  });

  it("retries REFUND_PENDING without reacquiring the request", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PENDING" })
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });
    const response = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });

    expect(response.status).toBe(200);
    expect(mockWithdrawalRequestUpdateMany).not.toHaveBeenCalled();
    expect(mockExecuteAtomicRefund).toHaveBeenCalledTimes(1);
  });

  it("returns retry-safe 503 when atomic refund fails and no ledger proves a credit", async () => {
    mockWithdrawalRequestFindUnique
      .mockResolvedValueOnce(SAMPLE_REQUEST)
      .mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PENDING" });
    mockExecuteAtomicRefund.mockRejectedValueOnce(new Error("simulated D1 batch failure"));
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(response.status).toBe(503);
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("moves a legacy REFUND_PROCESSING row without ledger to manual reconciliation", async () => {
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REFUND_PROCESSING" });
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null);

    const response = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(response.status).toBe(409);
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: "wd_1", status: "REFUND_PROCESSING" },
      data: { status: "RECONCILIATION_NEEDED" },
    });
    expect(mockExecuteAtomicRefund).not.toHaveBeenCalled();
  });

  it("blocks REJECTED rows without a refund ledger and flags them for reconciliation", async () => {
    mockWithdrawalRequestFindUnique.mockResolvedValueOnce({ ...SAMPLE_REQUEST, status: "REJECTED" });
    mockWalletLedgerFindFirst.mockResolvedValueOnce(null);
    const response = await PATCH(patchReq("wd_1", { action: "REJECT" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(response.status).toBe(409);
    expect(mockWithdrawalRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: "wd_1", status: "REJECTED" },
      data: { status: "RECONCILIATION_NEEDED" },
    });
    expect(mockExecuteAtomicRefund).not.toHaveBeenCalled();
  });

  it("returns 401 without admin authentication", async () => {
    mockGetAdminFromRequest.mockResolvedValueOnce(null);
    const response = await PATCH(patchReq("wd_1", { action: "APPROVE" }, false), { params: Promise.resolve({ id: "wd_1" }) });
    expect(response.status).toBe(401);
    expect(mockWithdrawalRequestFindUnique).not.toHaveBeenCalled();
  });

  it("rejects invalid action and oversized notes", async () => {
    const invalidAction = await PATCH(patchReq("wd_1", { action: "PAY" }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(invalidAction.status).toBe(400);
    const longNotes = await PATCH(patchReq("wd_1", { action: "APPROVE", notes: "x".repeat(1001) }), { params: Promise.resolve({ id: "wd_1" }) });
    expect(longNotes.status).toBe(400);
  });
});

describe("GET /api/admin/withdrawals", () => {
  it("returns 401 without admin auth", async () => {
    mockGetAdminFromRequest.mockResolvedValueOnce(null);
    const response = await GET(getReq("", false));
    expect(response.status).toBe(401);
  });

  it("returns list and validates status filter", async () => {
    mockWithdrawalRequestFindMany.mockResolvedValueOnce([{ id: "wd_1" }]);
    const response = await GET(getReq("status=REQUESTED"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "wd_1" }]);
    expect(mockWithdrawalRequestFindMany.mock.calls[0][0].where).toEqual({ status: "REQUESTED" });

    const invalid = await GET(getReq("status=UNKNOWN"));
    expect(invalid.status).toBe(400);
  });
});
