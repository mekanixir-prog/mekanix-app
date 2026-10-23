/**
 * QA Repro Tests — Task E-6 (updated by Agent 1 after D1-01 fix)
 * =================================================================
 *
 * Reproduces concrete bugs surfaced by the B-2/B-3/B-4/B-5 audit reports.
 * Tests are derived directly from findings in the AUDIT_*.md reports.
 *
 * Bugs documented here:
 *   QA-01 → D1-01 (CRITICAL, now FIXED) — schema/migration drift
 *           RateLimit + IdempotencyKey are declared in `prisma/schema.prisma`
 *           and were missing from the D1 migration. FIXED by the additive
 *           migration `20260926000000_add_rate_limit_idempotency/migration.sql`
 *           (commit ecf20b6). This test is now a POSITIVE regression guard:
 *           it scans the UNION of ALL migration files and asserts every schema
 *           model has a corresponding CREATE TABLE somewhere. If a future
 *           change adds a model to the schema without a matching migration,
 *           this test FAILS — preventing a recurrence of D1-01.
 *   QA-02 → D1-02 (HIGH/perf, NOT YET FIXED) — unbounded `User.findMany`
 *           in OTP verify. `src/app/api/auth/otp/verify/route.ts:91-93` does
 *           a full-table scan on every OTP verify. Still open (accepted risk).
 *           Documented via `it.fails()`.
 *
 * All tests are filesystem-only — no DB, no Worker, no Redis required.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../..");
const SCHEMA_PATH = resolve(ROOT, "prisma/schema.prisma");
const MIGRATIONS_DIR = resolve(ROOT, "prisma/migrations");
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

// Read the UNION of CREATE TABLE names across ALL migration SQL files.
// This is the correct check now that D1-01 is fixed via an additive sibling
// migration — a model may be created in the init migration OR a later one.
function readAllMigrationTables(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const tables: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sqlPath = join(dir, entry.name, "migration.sql");
    let sql: string;
    try {
      sql = readFileSync(sqlPath, "utf8");
    } catch {
      continue; // migration dir without migration.sql (shouldn't happen)
    }
    const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"([A-Za-z0-9_]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) tables.push(m[1]);
  }
  return tables;
}

describe("QA-01 — D1-01 schema/migration drift (CRITICAL, FIXED)", () => {
  const models = readModelsFromSchema(SCHEMA_PATH);
  const tables = readAllMigrationTables(MIGRATIONS_DIR);
  const tableSet = new Set(tables);

  it("control — schema.prisma declares a non-empty set of models", () => {
    expect(models.length).toBeGreaterThan(50);
  });

  it("control — the migration set declares a non-empty set of CREATE TABLEs", () => {
    expect(tables.length).toBeGreaterThan(50);
  });

  it(
    "D1-01 fix verified — every schema model now has a matching CREATE TABLE " +
      "somewhere in the D1 migration set (init + additive migrations)",
    () => {
      // After commit ecf20b6 (additive migration 20260926000000_add_rate_limit_idempotency),
      // RateLimit + IdempotencyKey now exist in the migration set. This test
      // PASSES and will FAIL if a future schema model is added without a
      // corresponding migration — i.e. it is a real regression guard.
      const missing = models.filter((m) => !tableSet.has(m));
      expect(missing).toEqual([]);
    }
  );

  it(
    "D1-01 fix verified — RateLimit + IdempotencyKey tables exist in a migration",
    () => {
      expect(tableSet.has("RateLimit")).toBe(true);
      expect(tableSet.has("IdempotencyKey")).toBe(true);
    }
  );
});

describe("QA-02 — D1-02 unbounded User.findMany in OTP verify (HIGH/perf, NOT YET FIXED)", () => {
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
