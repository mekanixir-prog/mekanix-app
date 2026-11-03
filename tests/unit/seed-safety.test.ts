import { describe, expect, it, vi } from "vitest";
import {
  assertDatabaseEmptyForDemoSeed,
  SEED_PROTECTED_MODEL_DELEGATES,
} from "@/lib/seed-safety";

function makeDb(counts: Record<string, number> = {}) {
  return Object.fromEntries(
    SEED_PROTECTED_MODEL_DELEGATES.map((name) => [
      name,
      { count: vi.fn(async () => counts[name] ?? 0) },
    ]),
  );
}

describe("demo seed safety guard", () => {
  it("allows seeding only when every application table is empty", async () => {
    const db = makeDb();
    await expect(assertDatabaseEmptyForDemoSeed(db)).resolves.toBeUndefined();

    for (const name of SEED_PROTECTED_MODEL_DELEGATES) {
      expect((db as any)[name].count).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses to run when financial or operational rows exist even without users", async () => {
    const db = makeDb({ walletLedger: 2, payment: 1, job: 4 });

    await expect(assertDatabaseEmptyForDemoSeed(db)).rejects.toThrow(
      /database is not empty.*payment=1.*job=4.*walletLedger=2/,
    );
  });

  it("fails closed if any model cannot be checked", async () => {
    const db = makeDb();
    delete (db as any).walletLedger;

    await expect(assertDatabaseEmptyForDemoSeed(db)).rejects.toThrow(
      /delegate walletLedger is unavailable/,
    );
  });

  it("rejects a missing database client", async () => {
    await expect(assertDatabaseEmptyForDemoSeed(null)).rejects.toThrow(
      /database client is required/,
    );
  });
});
