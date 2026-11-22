// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("one pending OTP per canonical phone migration", () => {
  it("invalidates legacy pending codes and enforces a unique pending slot", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE "OtpCode" (
          "id" TEXT PRIMARY KEY,
          "phone" TEXT NOT NULL,
          "code" TEXT NOT NULL,
          "consumed" INTEGER NOT NULL DEFAULT 0,
          "expiresAt" TEXT NOT NULL,
          "createdAt" TEXT NOT NULL,
          "userId" TEXT
        );
        INSERT INTO "OtpCode" ("id", "phone", "code", "consumed", "expiresAt", "createdAt")
          VALUES
            ('old-1', '+989121234567', 'hash-1', 0, '2026-11-22T06:00:00.000Z', '2026-11-22T05:50:00.000Z'),
            ('old-2', '+989121234567', 'hash-2', 0, '2026-11-22T06:01:00.000Z', '2026-11-22T05:51:00.000Z'),
            ('used-1', '+989121234567', 'hash-0', 1, '2026-11-22T05:00:00.000Z', '2026-11-22T04:50:00.000Z');
      `);

      const migration = readFileSync(
        new URL("../../prisma/migrations/20261122000000_otp_single_pending_per_phone/migration.sql", import.meta.url),
        "utf8",
      );
      database.exec(migration);

      const oldPending = database.prepare(`
        SELECT "id", "consumed" FROM "OtpCode" WHERE "id" IN ('old-1', 'old-2')
      `).all() as Array<{ id: string; consumed: number }>;
      expect(oldPending).toEqual([
        { id: "old-1", consumed: 1 },
        { id: "old-2", consumed: 1 },
      ]);

      const insert = database.prepare(`
        INSERT INTO "OtpCode" ("id", "phone", "code", "consumed", "expiresAt", "createdAt")
        VALUES (?, '+989121234567', ?, 0, '2026-11-22T06:10:00.000Z', '2026-11-22T06:05:00.000Z')
      `);
      expect(() => insert.run("new-1", "hash-new-1")).not.toThrow();
      expect(() => insert.run("new-2", "hash-new-2")).toThrow(/UNIQUE constraint failed/i);

      database.prepare(`
        UPDATE "OtpCode" SET "consumed" = 1 WHERE "id" = 'new-1'
      `).run();
      expect(() => insert.run("new-3", "hash-new-3")).not.toThrow();
    } finally {
      database.close();
    }
  });
});
