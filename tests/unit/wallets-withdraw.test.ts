// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, atomic } = vi.hoisted(() => ({
  db: {
    wallet: { findUnique: vi.fn() },
    withdrawalRequest: { findUnique: vi.fn() },
    notification: { create: vi.fn() },
  },
  atomic: vi.fn(),
}));
vi.mock("@/lib/db-access", () => ({ getDbForLib: async () => db }));
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: async () => ({ userId: "user-1", role: "TECHNICIAN" }),
}));
vi.mock("@/lib/auth", () => ({
  getTechnicianFromSession: async () => ({ id: "tech-1" }),
}));
vi.mock("@/lib/withdrawal-atomic", () => ({ createWithdrawalAtomically: (...args: any[]) => atomic(...args) }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: async () => ({ success: true, resetMs: 60000 }),
  getClientId: () => "test-client",
  RATE_LIMITS: { WITHDRAW: { max: 3, windowMs: 3600000 } },
}));

import { POST } from "@/app/api/wallets/withdraw/route";

function request(body: unknown, key = "withdrawal-request-0001") {
  return new Request("https://mekanix.test/api/wallets/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.wallet.findUnique.mockResolvedValue({ id: "wallet-1", balance: 1000 });
  db.withdrawalRequest.findUnique.mockResolvedValue(null);
});

describe("atomic withdrawal route", () => {
  it("commits a withdrawal and returns the updated balance", async () => {
    const withdrawal = { id: "wd-1", walletId: "wallet-1", amount: 500, status: "REQUESTED" };
    atomic.mockResolvedValue(true);
    db.withdrawalRequest.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(withdrawal);
    db.wallet.findUnique.mockResolvedValueOnce({ id: "wallet-1", balance: 1000 })
      .mockResolvedValueOnce({ id: "wallet-1", balance: 500 });
    const response = await POST(request({ amount: 500 }));
    expect(response.status).toBe(200);
    expect((await response.json()).newBalance).toBe(500);
    expect(atomic).toHaveBeenCalledTimes(1);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
  });

  it("returns the existing request on retry without debiting again", async () => {
    db.withdrawalRequest.findUnique.mockResolvedValue({
      id: "wd-existing", walletId: "wallet-1", amount: 500, status: "REQUESTED",
    });
    const response = await POST(request({ amount: 500 }));
    expect(response.status).toBe(200);
    expect((await response.json()).idempotent).toBe(true);
    expect(atomic).not.toHaveBeenCalled();
  });

  it("rejects invalid amounts and missing idempotency keys", async () => {
    expect((await POST(request({ amount: 0 }))).status).toBe(400);
    expect((await POST(request({ amount: 500 }, ""))).status).toBe(400);
    expect(atomic).not.toHaveBeenCalled();
  });

  it("does not send a notification when the atomic debit fails", async () => {
    atomic.mockResolvedValue(false);
    const response = await POST(request({ amount: 500 }));
    expect(response.status).toBe(400);
    expect(db.notification.create).not.toHaveBeenCalled();
  });
});
