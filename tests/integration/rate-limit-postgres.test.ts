// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";
import { rateLimitAsync } from "@/lib/rate-limit";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("rateLimitAsync PostgreSQL concurrency integration", () => {
  const prefix = `rate-limit-pg-test:${crypto.randomUUID()}`;
  let db: Awaited<ReturnType<typeof getDbForLib>>;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "production");
    db = await getDbForLib();
  });

  afterAll(async () => {
    if (db) {
      await db.rateLimit.deleteMany({ where: { key: { startsWith: prefix } } });
    }
    vi.unstubAllEnvs();
  });

  it("allows exactly max concurrent first-hit requests and saturates at max+1", async () => {
    const key = `${prefix}:first-hit`;
    const results = await Promise.all(
      Array.from({ length: 80 }, () => rateLimitAsync(key, 7, 60_000))
    );

    expect(results.filter((result) => result.success)).toHaveLength(7);
    expect(results.filter((result) => !result.success && !result.unavailable)).toHaveLength(73);
    expect(results.some((result) => result.unavailable)).toBe(false);

    const row = await db.rateLimit.findUnique({ where: { key: `rl:${key}` } });
    expect(Number(row?.count)).toBe(8);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("starts one expiry window under concurrent requests without resetting other increments", async () => {
    const key = `${prefix}:expiry`;
    await db.rateLimit.create({
      data: {
        key: `rl:${key}`,
        count: 99,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const results = await Promise.all(
      Array.from({ length: 80 }, () => rateLimitAsync(key, 7, 60_000))
    );

    expect(results.filter((result) => result.success)).toHaveLength(7);
    expect(results.filter((result) => !result.success && !result.unavailable)).toHaveLength(73);
    expect(results.some((result) => result.unavailable)).toBe(false);

    const row = await db.rateLimit.findUnique({ where: { key: `rl:${key}` } });
    expect(Number(row?.count)).toBe(8);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
