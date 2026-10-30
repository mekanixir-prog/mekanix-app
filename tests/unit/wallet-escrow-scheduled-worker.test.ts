// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { release } = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("../../src/lib/wallet-release", () => ({
  releaseWalletTransactionWithD1: release,
}));

import worker from "../../workers/wallet-release/index";

function envWithDue(rows: Array<{ id: string; walletId: string }>) {
  const all = vi.fn().mockResolvedValue({ results: rows });
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn(() => ({ bind }));
  return { DB: { prepare }, all, bind, prepare };
}

beforeEach(() => vi.clearAllMocks());

describe("scheduled wallet escrow worker", () => {
  it("queries matured pending rows and delegates each atomic release", async () => {
    const env = envWithDue([
      { id: "txn-1", walletId: "wallet-1" },
      { id: "txn-2", walletId: "wallet-2" },
    ]);
    release.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    let scheduledWork: Promise<unknown> | undefined;

    worker.scheduled(
      { scheduledTime: Date.parse("2026-10-30T12:00:00.000Z") },
      env as any,
      { waitUntil: (promise) => { scheduledWork = promise; } } as any
    );
    await scheduledWork;

    expect(env.prepare).toHaveBeenCalledTimes(1);
    expect(env.bind).toHaveBeenCalledWith("2026-10-30T12:00:00.000Z");
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenNthCalledWith(
      1, env.DB, "wallet-1", "txn-1", new Date("2026-10-30T12:00:00.000Z")
    );
  });

  it("continues processing after an individual transaction fails", async () => {
    const env = envWithDue([
      { id: "txn-bad", walletId: "wallet-1" },
      { id: "txn-good", walletId: "wallet-2" },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    release.mockRejectedValueOnce(new Error("wallet mismatch")).mockResolvedValueOnce(true);
    let scheduledWork: Promise<unknown> | undefined;

    worker.scheduled(
      { scheduledTime: Date.parse("2026-10-30T12:00:00.000Z") },
      env as any,
      { waitUntil: (promise) => { scheduledWork = promise; } } as any
    );
    await scheduledWork;

    expect(release).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("does not expose a public HTTP endpoint", async () => {
    const response = worker.fetch();
    expect(response.status).toBe(404);
  });
});
