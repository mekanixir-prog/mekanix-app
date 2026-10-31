// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { execute: null as null | ((query: any) => Promise<any[]>) },
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    $queryRaw: (query: any) => {
      if (!state.execute) throw new Error("SQLite query executor not initialized");
      return state.execute(query);
    },
  }),
}));

import { rateLimitAsync } from "@/lib/rate-limit";

describe("atomic shared rate-limit D1/SQLite upsert", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE "RateLimit" (
        "id" TEXT PRIMARY KEY,
        "key" TEXT NOT NULL UNIQUE,
        "count" INTEGER NOT NULL DEFAULT 1,
        "expiresAt" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    state.execute = async (query: any) => {
      const values = query.values.map((value: unknown) => value instanceof Date ? value.toISOString() : value);
      const rows = sqlite.prepare(query.sql).all(...values);
      return rows.map((row: any) => ({ ...row, count: Number(row.count) }));
    };
  });

  afterEach(() => {
    state.execute = null;
    vi.restoreAllMocks();
    sqlite.close();
  });

  it("allows exactly max requests under concurrent first-hit load", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => rateLimitAsync("otp:first-hit", 5, 60_000))
    );
    expect(results.filter((result) => result.success)).toHaveLength(5);
    expect(results.filter((result) => !result.success && !result.unavailable)).toHaveLength(45);
    expect(results.some((result) => result.unavailable)).toBe(false);
    expect(sqlite.prepare('SELECT "count" FROM "RateLimit" WHERE "key" = ?').get("rl:otp:first-hit"))
      .toEqual({ count: 6 });
  });

  it("starts exactly one new window at the expiry boundary", async () => {
    expect(await rateLimitAsync("otp:expiry", 3, 60_000)).toMatchObject({ success: true });
    vi.mocked(Date.now).mockReturnValue(1_060_000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => rateLimitAsync("otp:expiry", 3, 60_000))
    );
    expect(results.filter((result) => result.success)).toHaveLength(3);
    expect(results.filter((result) => !result.success && !result.unavailable)).toHaveLength(2);
    expect(sqlite.prepare('SELECT "count", "expiresAt" FROM "RateLimit" WHERE "key" = ?').get("rl:otp:expiry"))
      .toEqual({ count: 4, expiresAt: "1970-01-01T00:18:40.000Z" });
  });

  it("saturates at max+1 so repeated denied requests cannot overflow the counter", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rateLimitAsync("otp:saturation", 2, 60_000))
    );
    expect(results.filter((result) => result.success)).toHaveLength(2);
    expect(results.filter((result) => !result.success && !result.unavailable)).toHaveLength(18);
    expect(sqlite.prepare('SELECT "count" FROM "RateLimit" WHERE "key" = ?').get("rl:otp:saturation"))
      .toEqual({ count: 3 });
  });

  it("fails closed in production when the atomic store query fails", async () => {
    state.execute = async () => { throw new Error("database unavailable"); };
    const result = await rateLimitAsync("otp:outage", 5, 60_000);
    expect(result).toMatchObject({ success: false, unavailable: true });
  });
});
