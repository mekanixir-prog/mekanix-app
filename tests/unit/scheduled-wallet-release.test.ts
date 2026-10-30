// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({ walletTransaction: { findMany: mocks.findMany } }),
}));
vi.mock("@/lib/wallet-release", () => ({
  releaseWalletTransaction: mocks.release,
}));

import { POST } from "@/app/api/internal/wallet-release/route";

const secret = "test-cron-secret-that-is-at-least-32-chars";
const request = (token?: string) => new Request("https://mekanix.test/api/internal/wallet-release", {
  method: "POST",
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", secret);
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([
    { id: "txn-1", walletId: "wallet-1" },
    { id: "txn-2", walletId: "wallet-2" },
  ]);
  mocks.release.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/internal/wallet-release", () => {
  it("rejects missing and incorrect scheduler credentials", async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("incorrect-secret"))).status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns 503 when no sufficiently strong secret is configured", async () => {
    vi.stubEnv("CRON_SECRET", "short");
    expect((await POST(request("short"))).status).toBe(503);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("releases due entries through the atomic service and reports race skips", async () => {
    mocks.release.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const response = await POST(request(secret));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, scanned: 2, released: 1, skipped: 1, hasMore: false,
    });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "PENDING", holdUntil: expect.objectContaining({ not: null, lte: expect.any(Date) }) },
      take: 100,
      select: { id: true, walletId: true },
    }));
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("reports backlog when the per-run safety limit is reached", async () => {
    mocks.findMany.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({ id: `txn-${index}`, walletId: "wallet-1" }))
    );
    mocks.release.mockResolvedValue(false);
    const response = await POST(request(secret));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scanned: 100, released: 0, skipped: 100, hasMore: true });
  });

  it("propagates a failed atomic release so the scheduler retries the remaining entries", async () => {
    mocks.release.mockRejectedValueOnce(new Error("wallet release failed"));
    await expect(POST(request(secret))).rejects.toThrow("wallet release failed");
  });
});
