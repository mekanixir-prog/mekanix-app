/**
 * QA Repro Tests — Task E-6
 * ========================
 *
 * Reproduces concrete bugs surfaced by the B-2/B-3/B-4/B-5 audit reports that
 * previously had NO automated test coverage. Every test below is derived
 * directly from a finding in one of the AUDIT_*.md reports and is designed
 * to FAIL today (via the `it.fails()` wrapper) so the suite stays green
 * while still pinning the bug. When the underlying fix lands, flip the
 * wrapper to `it()` and the test will start enforcing the correct
 * behaviour. (Convention matches tests/unit/payment-wallet-audit.test.ts
 * where B-5 documented PAY-05 with `it.fails()`.)
 *
 * Bugs documented here:
 *   QA-01 → D1-01 (CRITICAL) — schema/migration drift
 *           RateLimit + IdempotencyKey are declared in `prisma/schema.prisma`
 *           but have NO `CREATE TABLE` in
 *           `prisma/migrations/20260925000000_init/migration.sql`. The Prisma
 *           Client will emit `SELECT/INSERT INTO "RateLimit"`/`"IdempotencyKey"`
 *           at runtime, the D1 driver will throw "no such table", the
 *           try/catch in `src/lib/rate-limit.ts` + `src/lib/auth.ts` will
 *           swallow the error, and production rate limiting + idempotency
 *           silently degrade to per-isolate in-memory (effectively bypassable
 *           across Cloudflare Workers isolates). Source: AUDIT_D1_PRISMA.md §7.4.
 *   QA-02 → D1-02 (HIGH/perf) — unbounded `User.findMany` in OTP verify
 *           `src/app/api/auth/otp/verify/route.ts:91-93` does a full-table
 *           scan on every OTP verify whose normalized phone does not match
 *           the stored value. On D1 this loads every user row into the
 *           isolate per login attempt. Source: AUDIT_D1_PRISMA.md §8 (D1-02).
 *
 * All tests are filesystem-only — no DB, no Worker, no Redis required.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const SCHEMA_PATH = resolve(ROOT, "prisma/schema.prisma");
const MIGRATION_PATH = resolve(
  ROOT,
  "prisma/migrations/20260925000000_init/migration.sql"
);
const OTP_VERIFY_PATH = resolve(
  ROOT,
  "src/app/api/auth/otp/verify/route.ts"
);

function readModelsFromSchema(path: string): string[] {
  const src = readFileSync(path, "utf8");
  const re = /^model\s+([A-Za-z0-9_]+)\s*\{/gim;
  const models: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) models.push(m[1]);
  return models;
}

function readTablesFromMigration(path: string): string[] {
  const sql = readFileSync(path, "utf8");
  const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"([A-Za-z0-9_]+)"/g;
  const tables: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) tables.push(m[1]);
  return tables;
}

describe("QA-01 — D1-01 schema/migration drift (CRITICAL)", () => {
  const models = readModelsFromSchema(SCHEMA_PATH);
  const tables = readTablesFromMigration(MIGRATION_PATH);
  const tableSet = new Set(tables);

  it("control — schema.prisma declares a non-empty set of models", () => {
    expect(models.length).toBeGreaterThan(50);
  });

  it("control — migration.sql declares a non-empty set of CREATE TABLEs", () => {
    expect(tables.length).toBeGreaterThan(50);
  });

  // EXPECTED TO FAIL until a follow-up migration adds the missing
  // RateLimit + IdempotencyKey CREATE TABLE statements. The `it.fails()`
  // wrapper documents the bug without breaking the suite.
  it.fails(
    "every model in schema.prisma has a matching CREATE TABLE in the D1 migration",
    () => {
      const missing = models.filter((m) => !tableSet.has(m));
      expect(missing).toEqual([]);
    }
  );

  it(
    "documents the exact drift — only RateLimit + IdempotencyKey are missing " +
      "(PASSES today; will FAIL once a fix lands and should be updated)",
    () => {
      const missing = models.filter((m) => !tableSet.has(m));
      // This test PASSES today — it pins the *current* drift so a partial
      // fix (one table but not the other) does not silently regress.
      expect(missing.sort()).toEqual(["IdempotencyKey", "RateLimit"]);
    }
  );
});

describe("QA-02 — D1-02 unbounded User.findMany in OTP verify (HIGH/perf)", () => {
  // EXPECTED TO FAIL until D1-02 is fixed (replace findMany with findUnique on
  // normalized phone or backfill the column). The `it.fails()` wrapper
  // documents the bug.
  it.fails(
    "OTP verify route does NOT perform an unbounded User.findMany (select-only, no where/take)",
    () => {
      const src = readFileSync(OTP_VERIFY_PATH, "utf8");
      // The bug pattern: `db.user.findMany({ select: { id: true, phone: true } })`
      // — select-only, no WHERE clause, no take limit → full-table scan.
      const hasUnboundedFindMany =
        /db\.user\.findMany\(\s*\{\s*select:\s*\{\s*id:\s*true,\s*phone:\s*true\s*\}\s*,?\s*\}\s*\)/.test(
          src
        );
      expect(hasUnboundedFindMany).toBe(false);
    }
  );
});
