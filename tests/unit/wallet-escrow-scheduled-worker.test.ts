// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { release } = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("../../src/lib/wallet-release-d1", () => ({
  releaseWalletTransactionWithD1: release,
}));

import worker from "../../workers/wallet-release/index";

function envWithPages(pages: Array<Array<{ id: string; walletId: string; holdUntil: string }>>) {
  const all = vi.fn();
  pages.forEach((rows) => all.mockResolvedValueOnce({ results: rows }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn(() => ({ bind }));
  return { DB: { prepare }, all, bind, prepare };
}

const due = (id: string, walletId: string) => ({
  id, walletId, holdUntil: "2026-10-30T11:00:00.000Z",
});

beforeEach(() => vi.clearAllMocks());

describe("scheduled wallet escrow worker", () => {
  it("queries matured pending rows and delegates each atomic release", async () => {
    const env = envWithPages([[
      due("txn-1", "wallet-1"),
      due("txn-2", "wallet-2"),
    ]]);
    release.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    let scheduledWork: Promise<unknown> | undefined;

    worker.scheduled(
      { scheduledTime: Date.parse("2026-10-30T12:00:00.000Z") },
      env as any,
      { waitUntil: (promise) => { scheduledWork = promise; } } as any
    );
    await scheduledWork;

    expect(env.prepare).toHaveBeenCalledTimes(1);
    expect(env.bind).toHaveBeenCalledWith("2026-10-30T12:00:00.000Z", 100);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenNthCalledWith(
      1, env.DB, "wallet-1", "txn-1", new Date("2026-10-30T12:00:00.000Z")
    );
  });

  it("continues processing after an individual transaction fails", async () => {
    const env = envWithPages([[
      due("txn-bad", "wallet-1"),
      due("txn-good", "wallet-2"),
    ]]);
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

  it("uses keyset pagination so an early failed row cannot block later due rows", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      due(`txn-${String(index).padStart(3, "0")}`, `wallet-${index}`)
    );
    const secondPage = [due("txn-100", "wallet-100")];
    const env = envWithPages([firstPage, secondPage]);
    release.mockResolvedValue(false);
    let scheduledWork: Promise<unknown> | undefined;

    worker.scheduled(
      { scheduledTime: Date.parse("2026-10-30T12:00:00.000Z") },
      env as any,
      { waitUntil: (promise) => { scheduledWork = promise; } } as any
    );
    await scheduledWork;

    expect(env.prepare).toHaveBeenCalledTimes(2);
    expect(env.bind).toHaveBeenNthCalledWith(
      2,
      "2026-10-30T12:00:00.000Z",
      "2026-10-30T11:00:00.000Z",
      "2026-10-30T11:00:00.000Z",
      "txn-099",
      100
    );
    expect(release).toHaveBeenCalledTimes(101);
    expect(release).toHaveBeenLastCalledWith(
      env.DB, "wallet-100", "txn-100", new Date("2026-10-30T12:00:00.000Z")
    );
  });

  it("does not expose a public HTTP endpoint", async () => {
    const response = worker.fetch();
    expect(response.status).toBe(404);
  });
});
