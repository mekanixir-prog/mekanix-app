// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const { release } = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("../../src/lib/wallet-release-d1", () => ({
  releaseWalletTransactionWithD1: release,
}));

import worker from "../../workers/wallet-release/index";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE "WalletTransaction" (
      "id" TEXT PRIMARY KEY,
      "walletId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "holdUntil" TEXT
    );
    CREATE TABLE "WalletReleaseWorkerState" (
      "id" TEXT PRIMARY KEY,
      "cursorHoldUntil" TEXT,
      "cursorId" TEXT,
      "updatedAt" TEXT NOT NULL
    );
  `);
  const DB = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all: async <T>() => ({
              results: sqlite.prepare(sql).all(...(values as never[])) as T[],
            }),
            first: async <T>() =>
              (sqlite.prepare(sql).get(...(values as never[])) as T | undefined) ?? null,
            run: async () => sqlite.prepare(sql).run(...(values as never[])),
          };
        },
      };
    },
  };
  return { sqlite, DB };
}

async function scheduledRun(DB: ReturnType<typeof makeD1>["DB"]) {
  let work: Promise<unknown> | undefined;
  worker.scheduled(
    { scheduledTime: Date.parse("2026-10-30T12:00:00.000Z") },
    { DB } as any,
    { waitUntil: (promise) => { work = promise; } } as any
  );
  await work;
}

describe("wallet release worker durable cursor — SQLite integration", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    vi.clearAllMocks();
  });

  it("continues beyond the first 1,000 rows even when the oldest row keeps failing", async () => {
    const { sqlite, DB } = makeD1();
    databases.push(sqlite);
    const insert = sqlite.prepare(
      'INSERT INTO "WalletTransaction" ("id", "walletId", "status", "holdUntil") VALUES (?, ?, ?, ?)'
    );
    for (let index = 0; index < 1_001; index++) {
      insert.run(
        `txn-${String(index).padStart(4, "0")}`,
        `wallet-${index}`,
        "PENDING",
        "2026-10-30T11:00:00.000Z"
      );
    }

    release.mockRejectedValueOnce(new Error("oldest row remains inconsistent")).mockResolvedValue(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await scheduledRun(DB);

    expect(release).toHaveBeenCalledTimes(1_000);
    expect(sqlite.prepare('SELECT "cursorId" FROM "WalletReleaseWorkerState" WHERE "id" = ?')
      .get("wallet-release")).toEqual({ cursorId: "txn-0999" });

    release.mockClear();
    await scheduledRun(DB);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      DB, "wallet-1000", "txn-1000", new Date("2026-10-30T12:00:00.000Z")
    );
    expect(sqlite.prepare('SELECT "cursorHoldUntil", "cursorId" FROM "WalletReleaseWorkerState" WHERE "id" = ?')
      .get("wallet-release")).toEqual({ cursorHoldUntil: null, cursorId: null });
    errorSpy.mockRestore();
  });
});
