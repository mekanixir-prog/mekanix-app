// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth";

const mockWalletFindUnique = vi.fn();
const mockWalletUpdateMany = vi.fn();
const mockWithdrawalRequestCreate = vi.fn();
const mockWalletLedgerCreate = vi.fn();
const mockNotificationCreate = vi.fn();
const mockTechnicianFindUnique = vi.fn();
const mockIdempotencyKeyCreate = vi.fn();
const mockIdempotencyKeyFindUnique = vi.fn();
const mockIdempotencyKeyUpdateMany = vi.fn();
const mockSessionFindUnique = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionUpdateMany = vi.fn();

let currentBalance = 1000;
let transactionCalls = 0;

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    $transaction: async (callback: (tx: any) => Promise<unknown>) => {
      transactionCalls++;
      const balanceBeforeTransaction = currentBalance;
      try {
        return await callback({
          wallet: {
            findUnique: (...args: any[]) => mockWalletFindUnique(...args),
            updateMany: (...args: any[]) => mockWalletUpdateMany(...args),
          },
          withdrawalRequest: {
            create: (...args: any[]) => mockWithdrawalRequestCreate(...args),
          },
          walletLedger: {
            create: (...args: any[]) => mockWalletLedgerCreate(...args),
          },
          idempotencyKey: {
            updateMany: (...args: any[]) => mockIdempotencyKeyUpdateMany(...args),
          },
        });
      } catch (error) {
        // Model DB rollback for the mocked SQLite transaction.
        currentBalance = balanceBeforeTransaction;
        throw error;
      }
    },
    wallet: {
      findUnique: (...args: any[]) => mockWalletFindUnique(...args),
      updateMany: (...args: any[]) => mockWalletUpdateMany(...args),
    },
    withdrawalRequest: {
      create: (...args: any[]) => mockWithdrawalRequestCreate(...args),
    },
    walletLedger: {
      create: (...args: any[]) => mockWalletLedgerCreate(...args),
    },
    notification: {
      create: (...args: any[]) => mockNotificationCreate(...args),
    },
    technician: {
      findUnique: (...args: any[]) => mockTechnicianFindUnique(...args),
    },
    session: {
      create: (...args: any[]) => mockSessionCreate(...args),
      findUnique: (...args: any[]) => mockSessionFindUnique(...args),
      updateMany: (...args: any[]) => mockSessionUpdateMany(...args),
    },
    idempotencyKey: {
      create: (...args: any[]) => mockIdempotencyKeyCreate(...args),
      findUnique: (...args: any[]) => mockIdempotencyKeyFindUnique(...args),
      updateMany: (...args: any[]) => mockIdempotencyKeyUpdateMany(...args),
    },
  })),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, resetMs: 60_000 })),
  rateLimitAsync: vi.fn().mockResolvedValue({ success: true, resetMs: 60_000 }),
  checkRateLimit: vi.fn(() => null),
  getClientId: vi.fn(() => "127.0.0.1"),
  RATE_LIMITS: {
    OTP_SEND: { max: 5, windowMs: 60_000 },
    OTP_VERIFY: { max: 5, windowMs: 60_000 },
    PAYMENT: { max: 5, windowMs: 60_000 },
    WITHDRAW: { max: 3, windowMs: 3_600_000 },
    API_DEFAULT: { max: 60, windowMs: 60_000 },
  },
}));

import { POST } from "@/app/api/wallets/withdraw/route";

function jsonReq(token: string, body: unknown, key = "test-idempotency-key"): Request {
  return new Request("https://mekanix.test/api/wallets/withdraw", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}

async function tokenForTechnician(): Promise<string> {
  return createSession({
    userId: "user_tech",
    role: "TECHNICIAN",
    phone: "+989121234567",
    isGuest: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentBalance = 1000;
  transactionCalls = 0;

  mockWalletFindUnique.mockImplementation(async () => ({
    id: "wallet_1",
    balance: currentBalance,
    technicianId: "tech_1",
  }));
  mockWalletUpdateMany.mockImplementation(async (args: any) => {
    const amount = Number(args.data.balance.decrement);
    if (currentBalance < amount) return { count: 0 };
    currentBalance -= amount;
    return { count: 1 };
  });
  mockWithdrawalRequestCreate.mockImplementation(async ({ data }: any) => ({
    id: "wd_1",
    code: data.code,
    walletId: data.walletId,
    amount: data.amount,
    method: data.method,
    cardNumber: data.cardNumber ?? null,
    bankName: data.bankName ?? null,
    shebaNumber: data.shebaNumber ?? null,
    status: "REQUESTED",
    requestedAt: data.requestedAt ?? new Date(),
    processedAt: null,
    adminNotes: null,
    reviewerId: null,
    txnId: null,
  }));
  mockWalletLedgerCreate.mockResolvedValue({ id: "ledger_1" });
  mockNotificationCreate.mockResolvedValue({});
  mockTechnicianFindUnique.mockResolvedValue({ id: "tech_1", userId: "user_tech" });
  mockIdempotencyKeyCreate.mockResolvedValue({});
  mockIdempotencyKeyFindUnique.mockResolvedValue(null);
  mockIdempotencyKeyUpdateMany.mockResolvedValue({ count: 1 });
  mockSessionFindUnique.mockResolvedValue({
    id: "sess_1",
    userId: "user_tech",
    tokenHash: "hash-placeholder",
    device: null,
    ip: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    createdAt: new Date(),
  });
  mockSessionCreate.mockResolvedValue({});
  mockSessionUpdateMany.mockResolvedValue({ count: 0 });
});

describe("atomic wallet withdrawal", () => {
  it("requires an idempotency key before any financial write", async () => {
    const token = await tokenForTechnician();
    const req = new Request("https://mekanix.test/api/wallets/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 500, method: "card" }),
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
    expect(mockWithdrawalRequestCreate).not.toHaveBeenCalled();
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();
  });

  it("commits debit, withdrawal, ledger and idempotency finalization in one transaction", async () => {
    const token = await tokenForTechnician();
    const response = await POST(jsonReq(token, { amount: 500, method: "card" }, "key-success"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.withdrawal.id).toBe("wd_1");
    expect(body.newBalance).toBe(500);
    expect(transactionCalls).toBe(1);
    expect(mockWalletUpdateMany).toHaveBeenCalledWith({
      where: { id: "wallet_1", balance: { gte: 500 } },
      data: { balance: { decrement: 500 } },
    });
    expect(mockWithdrawalRequestCreate).toHaveBeenCalledTimes(1);
    expect(mockWalletLedgerCreate).toHaveBeenCalledTimes(1);
    expect(mockIdempotencyKeyUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: "withdraw:user_tech:key-success", status: "IN_PROGRESS" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    }));
    expect(currentBalance).toBe(500);
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
  });

  it("does not create a withdrawal or ledger when the balance is insufficient", async () => {
    currentBalance = 100;
    const token = await tokenForTechnician();
    const response = await POST(jsonReq(token, { amount: 500, method: "card" }, "key-insufficient"));

    expect(response.status).toBe(409);
    expect(mockWithdrawalRequestCreate).not.toHaveBeenCalled();
    expect(mockWalletLedgerCreate).not.toHaveBeenCalled();
    expect(currentBalance).toBe(100);
  });

  it("rolls back the debit when ledger insertion fails; never issues a separate refund", async () => {
    mockWalletLedgerCreate.mockRejectedValueOnce(new Error("simulated ledger write failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = await tokenForTechnician();
    const response = await POST(jsonReq(token, { amount: 500, method: "card" }, "key-ledger-failure"));

    expect(response.status).toBe(500);
    expect(currentBalance).toBe(1000);
    expect(mockWithdrawalRequestCreate).toHaveBeenCalledTimes(1);
    expect(mockWalletLedgerCreate).toHaveBeenCalledTimes(1);
    // Only the one debit attempt occurs; no non-atomic compensation increment.
    expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockWalletUpdateMany).toHaveBeenCalledWith({
      where: { id: "wallet_1", balance: { gte: 500 } },
      data: { balance: { decrement: 500 } },
    });
    errorSpy.mockRestore();
  });

  it("returns cached response for a completed idempotency key without another transaction", async () => {
    mockIdempotencyKeyCreate.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    mockIdempotencyKeyFindUnique.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 60_000),
      requestHash: "placeholder",
      status: "COMPLETED",
      response: JSON.stringify({ withdrawal: { id: "wd_cached" }, newBalance: 700 }),
    });
    // The request hash is computed from the body; set up a matching record below.
    const body = { amount: 300, method: "card" };
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
    mockIdempotencyKeyFindUnique.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 60_000),
      requestHash: hash,
      status: "COMPLETED",
      response: JSON.stringify({ withdrawal: { id: "wd_cached" }, newBalance: 700 }),
    });

    const token = await tokenForTechnician();
    const response = await POST(jsonReq(token, body, "key-cached"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ withdrawal: { id: "wd_cached" }, newBalance: 700 });
    expect(transactionCalls).toBe(0);
    expect(mockWalletUpdateMany).not.toHaveBeenCalled();
  });
});
