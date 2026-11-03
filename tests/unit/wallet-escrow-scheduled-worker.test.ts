// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { release } = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("../../src/lib/wallet-release-d1", () => ({
  releaseWalletTransactionWithD1: release,
}));

import worker from "../../workers/wallet-release/index";

type Row = { id: string; walletId: string; holdUntil: string };
type State = { cursorHoldUntil: string | null; cursorId: string | null } | null;

function envWithPages(pages: Row[][], initialState: State = null) {
  const pageQueries: string[] = [];
  const pageBinds: unknown[][] = [];
  const stateWrites: unknown[][] = [];
  let pageIndex = 0;
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('FROM "WalletReleaseWorkerState"')) {
      return {
        bind: (..._values: unknown[]) => ({
          first: async () => initialState,
        }),
      };
    }
    if (sql.includes('INSERT INTO "WalletReleaseWorkerState"')) {
      return {
        bind: (...values: unknown[]) => {
          stateWrites.push(values);
          return { run: async () => ({ meta: { changes: 1 } }) };
        },
      };
    }
    return {
      bind: (...values: unknown[]) => {
        pageQueries.push(sql);
        pageBinds.push(values);
        const rows = pages[pageIndex++] ?? [];
        return { all: async () => ({ results: rows }) };
      },
    };
  });
  return {
    DB: { prepare },
    prepare,
    pageQueries,
    pageBinds,
    stateWrites,
  };
}

const due = (id: string, walletId: string) => ({
  id, walletId, holdUntil: "2026-10-30T11:00:00.000Z",
});

async function runWorker(env: ReturnType<typeof envWithPages>) {
  let scheduledWork: Promise<unknown> | undefined;
  worker.scheduled(
    { scheduledTime: Date.parse("2026-10-30T12:00:00.000Z") },
    env as any,
    { waitUntil: (promise) => { scheduledWork = promise; } } as any
  );
  await scheduledWork;
}

beforeEach(() => vi.clearAllMocks());

describe("scheduled wallet escrow worker", () => {
  it("queries matured pending rows and delegates each atomic release", async () => {
    const env = envWithPages([[
      due("txn-1", "wallet-1"),
      due("txn-2", "wallet-2"),
    ]]);
    release.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await runWorker(env);

    expect(env.pageQueries).toHaveLength(1);
    expect(env.pageBinds[0]).toEqual(["2026-10-30T12:00:00.000Z", 100]);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenNthCalledWith(
      1, env.DB, "wallet-1", "txn-1", new Date("2026-10-30T12:00:00.000Z")
    );
    expect(env.stateWrites[0]).toEqual([
      "wallet-release", null, null, "2026-10-30T12:00:00.000Z",
    ]);
  });

  it("continues processing after an individual transaction fails", async () => {
    const env = envWithPages([[
      due("txn-bad", "wallet-1"),
      due("txn-good", "wallet-2"),
    ]]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    release.mockRejectedValueOnce(new Error("wallet mismatch")).mockResolvedValueOnce(true);

    await runWorker(env);

    expect(release).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("uses keyset pagination so an early failed row cannot block later rows in the same run", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      due(`txn-${String(index).padStart(3, "0")}`, `wallet-${index}`)
    );
    const secondPage = [due("txn-100", "wallet-100")];
    const env = envWithPages([firstPage, secondPage]);
    release.mockResolvedValue(false);

    await runWorker(env);

    expect(env.pageQueries).toHaveLength(2);
    expect(env.pageBinds[1]).toEqual([
      "2026-10-30T12:00:00.000Z",
      "2026-10-30T11:00:00.000Z",
      "2026-10-30T11:00:00.000Z",
      "txn-099",
      100,
    ]);
    expect(release).toHaveBeenCalledTimes(101);
    expect(release).toHaveBeenLastCalledWith(
      env.DB, "wallet-100", "txn-100", new Date("2026-10-30T12:00:00.000Z")
    );
  });

  it("persists the cursor at the 1,000-row cap and resumes after it on the next Cron run", async () => {
    const pages = Array.from({ length: 10 }, (_, page) =>
      Array.from({ length: 100 }, (_, index) => {
        const number = page * 100 + index;
        return due(`txn-${String(number).padStart(3, "0")}`, `wallet-${number}`);
      })
    );
    const firstRun = envWithPages(pages);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    release.mockRejectedValueOnce(new Error("oldest row remains inconsistent")).mockResolvedValue(false);

    await runWorker(firstRun);

    expect(release).toHaveBeenCalledTimes(1_000);
    expect(firstRun.stateWrites[0]).toEqual([
      "wallet-release",
      "2026-10-30T11:00:00.000Z",
      "txn-999",
      "2026-10-30T12:00:00.000Z",
    ]);

    const savedState = {
      cursorHoldUntil: firstRun.stateWrites[0][1] as string,
      cursorId: firstRun.stateWrites[0][2] as string,
    };
    release.mockClear();
    const secondRun = envWithPages(
      [[due("txn-1000", "wallet-1000")]],
      savedState
    );
    release.mockResolvedValue(true);

    await runWorker(secondRun);

    expect(secondRun.pageBinds[0]).toEqual([
      "2026-10-30T12:00:00.000Z",
      "2026-10-30T11:00:00.000Z",
      "2026-10-30T11:00:00.000Z",
      "txn-999",
      100,
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      secondRun.DB, "wallet-1000", "txn-1000", new Date("2026-10-30T12:00:00.000Z")
    );
    expect(secondRun.stateWrites[0]).toEqual([
      "wallet-release", null, null, "2026-10-30T12:00:00.000Z",
    ]);
    errorSpy.mockRestore();
  });

  it("does not expose a public HTTP endpoint", async () => {
    const response = worker.fetch();
    expect(response.status).toBe(404);
  });
});
