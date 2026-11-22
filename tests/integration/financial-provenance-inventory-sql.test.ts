// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const modelTables = [
  "Technician", "Job", "Part", "Invoice", "Payment", "ServiceCategory",
  "Referral", "InsurancePolicy", "InsuranceClaim", "Wallet",
  "WalletTransaction", "WithdrawalRequest", "VipPlan", "PaymentGatewayLog",
  "WalletLedger", "ServicePackage", "CustomerApproval", "PartUsage",
  "PricingSnapshot",
] as const;

describe("read-only financial provenance inventory SQL", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("executes on SQLite and reports contradictions without exposing money values", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);

    for (const table of modelTables) {
      const hasCurrency = table === "Invoice" || table === "Payment" || table === "PaymentGatewayLog";
      database.exec(
        `CREATE TABLE "${table}" (
          "id" TEXT PRIMARY KEY,
          "financialUnitStatus" TEXT${hasCurrency ? ', "currency" TEXT' : ""}
        )`,
      );
    }
    database.exec(`
      CREATE TABLE "DiscountCode" (
        "id" TEXT PRIMARY KEY,
        "type" TEXT NOT NULL,
        "valueUnitStatus" TEXT,
        "minAmountUnitStatus" TEXT
      );
      INSERT INTO "Invoice" ("id", "financialUnitStatus", "currency")
        VALUES ('invoice-verified-wrong-currency', 'VERIFIED_IRR', 'USD');
      INSERT INTO "Payment" ("id", "financialUnitStatus", "currency")
        VALUES ('payment-verified-irr', 'VERIFIED_IRR', 'IRR');
      INSERT INTO "PaymentGatewayLog" ("id", "financialUnitStatus", "currency")
        VALUES ('gateway-verified-null-currency', 'VERIFIED_IRR', NULL);
      INSERT INTO "Job" ("id", "financialUnitStatus")
        VALUES ('job-unverified', 'UNVERIFIED');
      INSERT INTO "Wallet" ("id", "financialUnitStatus")
        VALUES ('wallet-null-status', NULL);
      INSERT INTO "DiscountCode" ("id", "type", "valueUnitStatus", "minAmountUnitStatus")
        VALUES ('discount-percent', 'PERCENT', 'UNVERIFIED', NULL);
    `);

    const sql = readFileSync(
      new URL("../../scripts/audit-financial-provenance.sql", import.meta.url),
      "utf8",
    );

    expect(() => database.exec(sql)).not.toThrow();

    const contradictions = database.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT "id" FROM "Invoice"
        WHERE "financialUnitStatus" = 'VERIFIED_IRR'
          AND ("currency" IS NULL OR "currency" <> 'IRR')
        UNION ALL
        SELECT "id" FROM "Payment"
        WHERE "financialUnitStatus" = 'VERIFIED_IRR'
          AND ("currency" IS NULL OR "currency" <> 'IRR')
        UNION ALL
        SELECT "id" FROM "PaymentGatewayLog"
        WHERE "financialUnitStatus" = 'VERIFIED_IRR'
          AND ("currency" IS NULL OR "currency" <> 'IRR')
      )
    `).get() as { count: number };
    expect(contradictions.count).toBe(2);

    const worklist = database.prepare(`
      SELECT "id", "financialUnitStatus"
      FROM "Job"
      WHERE "financialUnitStatus" IS NULL OR "financialUnitStatus" <> 'VERIFIED_IRR'
    `).all() as Array<Record<string, unknown>>;
    expect(worklist).toEqual([{ id: "job-unverified", financialUnitStatus: "UNVERIFIED" }]);
    expect(Object.keys(worklist[0])).toEqual(["id", "financialUnitStatus"]);

    const discount = database.prepare(`
      SELECT "type", "valueUnitStatus", "minAmountUnitStatus"
      FROM "DiscountCode"
      WHERE "valueUnitStatus" IS NULL OR "valueUnitStatus" <> 'VERIFIED_IRR'
         OR "minAmountUnitStatus" IS NULL OR "minAmountUnitStatus" <> 'VERIFIED_IRR'
    `).all() as Array<Record<string, unknown>>;
    expect(discount).toEqual([{ type: "PERCENT", valueUnitStatus: "UNVERIFIED", minAmountUnitStatus: null }]);
  });
});
