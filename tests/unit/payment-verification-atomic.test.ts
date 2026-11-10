// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { recordVerifiedGatewayPaymentAtomically } from "@/lib/payment-verification-atomic";

const mockLogFindUnique = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentCreate = vi.fn();
const mockPaymentUpdateMany = vi.fn();
const mockLogUpdateMany = vi.fn();
const mockOutboxUpsert = vi.fn();
const mockTransaction = vi.fn();

const mockGetD1Binding = vi.hoisted(() => vi.fn(async (): Promise<any> => null));

vi.mock("@/lib/idempotency", () => ({
  getD1Binding: mockGetD1Binding,
}));


const sqliteDbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of sqliteDbs.splice(0)) db.close();
});

function makeSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE "Payment" (
      "id" TEXT PRIMARY KEY, "code" TEXT NOT NULL, "invoiceId" TEXT, "userId" TEXT NOT NULL,
      "amount" INTEGER NOT NULL, "currency" TEXT NOT NULL, "method" TEXT NOT NULL,
      "status" TEXT NOT NULL, "financialUnitStatus" TEXT NOT NULL, "gatewayLogId" TEXT UNIQUE,
      "createdAt" TEXT NOT NULL
    );
    CREATE TABLE "PaymentGatewayLog" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "purpose" TEXT NOT NULL, "targetPlanId" TEXT NOT NULL,
      "targetPlanDurationDays" INTEGER NOT NULL, "amount" INTEGER NOT NULL, "currency" TEXT NOT NULL,
      "financialUnitStatus" TEXT NOT NULL, "status" TEXT NOT NULL, "verifiedAt" TEXT, "paymentId" TEXT
    );
    CREATE TABLE "PaymentOutboxEvent" (
      "id" TEXT PRIMARY KEY, "eventType" TEXT NOT NULL, "aggregateType" TEXT NOT NULL, "aggregateId" TEXT NOT NULL,
      "payload" TEXT NOT NULL, "idempotencyKey" TEXT UNIQUE NOT NULL, "status" TEXT NOT NULL,
      "attempts" INTEGER NOT NULL, "availableAt" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
    );
  `);
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first<T>() {
              return Promise.resolve((sqlite.prepare(sql).get(...values as never[]) as T) ?? null);
            },
            run() {
              const result = sqlite.prepare(sql).run(...values as never[]);
              return Promise.resolve({ meta: { changes: Number(result.changes) } });
            },
          };
        },
      };
    },
    async batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) {
      sqlite.exec("BEGIN");
      try {
        const results: Array<{ meta: { changes: number } }> = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, d1 };
}

function seedSqliteGateway(sqlite: DatabaseSync, durationDays = 30) {
  sqlite.prepare(`INSERT INTO "PaymentGatewayLog"
    ("id","userId","purpose","targetPlanId","targetPlanDurationDays","amount","currency","financialUnitStatus","status","verifiedAt","paymentId")
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      "gateway-1", "customer-1", "vip", "plan-1", durationDays, 100_000, "IRR", "VERIFIED_IRR", "REDIRECTED", null, null
    );
}

function makeDb() {
  const tx = {
    paymentGatewayLog: { findUnique: (...args: unknown[]) => mockLogFindUnique(...args), updateMany: (...args: unknown[]) => mockLogUpdateMany(...args) },
    payment: { findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args), create: (...args: unknown[]) => mockPaymentCreate(...args), updateMany: (...args: unknown[]) => mockPaymentUpdateMany(...args) },
    paymentOutboxEvent: { upsert: (...args: unknown[]) => mockOutboxUpsert(...args) },
  };
  return { $transaction: (callback: (client: typeof tx) => Promise<unknown>) => mockTransaction(() => callback(tx)) } as never;
}

const input = {
  gatewayLogId: "gateway-1",
  userId: "customer-1",
  paymentId: "payment-1",
  paymentCode: "PAY-PG-test",
  amount: 100_000,
  targetPlanId: "plan-1",
  durationDays: 30,
  verifiedAt: new Date("2026-11-07T10:00:00.000Z"),
};

describe("atomic verified gateway payment persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetD1Binding.mockResolvedValue(null);
    mockLogFindUnique.mockResolvedValue({
      id: "gateway-1", userId: "customer-1", purpose: "vip", targetPlanId: "plan-1", targetPlanDurationDays: 30,
      amount: 100_000, currency: "IRR", financialUnitStatus: "VERIFIED_IRR",
      status: "REDIRECTED", verifiedAt: null,
    });
    mockPaymentFindUnique.mockResolvedValue(null);
    mockPaymentUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentCreate.mockResolvedValue({
      id: "payment-1", userId: "customer-1", amount: 100_000, currency: "IRR",
      status: "SUCCEEDED", financialUnitStatus: "VERIFIED_IRR",
    });
    mockLogUpdateMany.mockResolvedValue({ count: 1 });
    mockOutboxUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => create);
    mockTransaction.mockImplementation(async (callback: () => Promise<unknown>) => callback());
  });

  it("creates payment, verifies gateway log, and inserts one idempotent outbox event in one transaction", async () => {
    const result = await recordVerifiedGatewayPaymentAtomically(makeDb(), input);
    expect(result).toBe("payment-1");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPaymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ gatewayLogId: "gateway-1", amount: 100_000, status: "SUCCEEDED" }),
    }));
    expect(mockLogUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "gateway-1", status: { in: ["REDIRECTED", "VERIFIED"] } }),
      data: expect.objectContaining({ status: "VERIFIED", paymentId: "payment-1" }),
    }));
    expect(mockOutboxUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: "payment.succeeded:gateway-1" },
      create: expect.objectContaining({
        eventType: "PAYMENT_SUCCEEDED",
        aggregateType: "Payment",
        aggregateId: "payment-1",
        idempotencyKey: "payment.succeeded:gateway-1",
        payload: expect.stringContaining('"durationDays":30'),
      }),
      update: {},
    }));
  });

  it("reuses the existing Payment and still ensures the outbox event exists", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1", userId: "customer-1", amount: 100_000, currency: "IRR",
      status: "SUCCEEDED", financialUnitStatus: "VERIFIED_IRR",
    });
    const result = await recordVerifiedGatewayPaymentAtomically(makeDb(), input);
    expect(result).toBe("payment-1");
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockOutboxUpsert).toHaveBeenCalledTimes(1);
  });

  it("binds a valid legacy Payment and emits the outbox event atomically", async () => {
    const legacy = {
      id: "payment-legacy", userId: "customer-1", amount: 100_000, currency: "IRR",
      status: "SUCCEEDED", financialUnitStatus: "VERIFIED_IRR", gatewayLogId: null,
    };
    let gatewayLookupCount = 0;
    mockPaymentFindUnique.mockImplementation(async ({ where }: { where: { gatewayLogId?: string; id?: string } }) => {
      if (where.id) return legacy;
      gatewayLookupCount += 1;
      return gatewayLookupCount === 1 ? null : { ...legacy, gatewayLogId: "gateway-1" };
    });
    const result = await recordVerifiedGatewayPaymentAtomically(makeDb(), {
      ...input, paymentId: "payment-legacy", legacyPaymentId: "payment-legacy",
    });
    expect(result).toBe("payment-legacy");
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockPaymentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "payment-legacy", gatewayLogId: null }),
      data: { gatewayLogId: "gateway-1" },
    }));
    expect(mockOutboxUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ aggregateId: "payment-legacy" }),
    }));
  });

  it("executes D1 payment, gateway, and outbox writes atomically on SQLite", async () => {
    const { sqlite, d1 } = makeSqliteD1();
    sqliteDbs.push(sqlite);
    seedSqliteGateway(sqlite);
    mockGetD1Binding.mockResolvedValue(d1);

    const result = await recordVerifiedGatewayPaymentAtomically(makeDb(), input);
    expect(result).toBe("payment-1");
    expect(sqlite.prepare(`SELECT "status","paymentId","financialUnitStatus" FROM "PaymentGatewayLog" WHERE "id"='gateway-1'`).get()).toEqual({
      status: "VERIFIED", paymentId: "payment-1", financialUnitStatus: "VERIFIED_IRR",
    });
    expect(sqlite.prepare(`SELECT "userId","amount","currency","status","gatewayLogId" FROM "Payment" WHERE "id"='payment-1'`).get()).toEqual({
      userId: "customer-1", amount: 100_000, currency: "IRR", status: "SUCCEEDED", gatewayLogId: "gateway-1",
    });
    const event = sqlite.prepare(`SELECT "eventType","aggregateId","idempotencyKey","status","payload" FROM "PaymentOutboxEvent"`).get() as { eventType: string; aggregateId: string; idempotencyKey: string; status: string; payload: string };
    expect(event).toMatchObject({
      eventType: "PAYMENT_SUCCEEDED", aggregateId: "payment-1",
      idempotencyKey: "payment.succeeded:gateway-1", status: "PENDING",
    });
    expect(JSON.parse(event.payload)).toMatchObject({
      paymentId: "payment-1", gatewayLogId: "gateway-1", userId: "customer-1",
      amount: 100_000, currency: "IRR", purpose: "vip", targetPlanId: "plan-1", durationDays: 30,
    });
  });

  it("rolls back the D1 batch when the purchase-time duration snapshot does not match", async () => {
    const { sqlite, d1 } = makeSqliteD1();
    sqliteDbs.push(sqlite);
    seedSqliteGateway(sqlite, 31);
    mockGetD1Binding.mockResolvedValue(d1);

    await expect(recordVerifiedGatewayPaymentAtomically(makeDb(), input)).rejects.toThrow();
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Payment"`).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(`SELECT "status","paymentId" FROM "PaymentGatewayLog" WHERE "id"='gateway-1'`).get()).toEqual({
      status: "REDIRECTED", paymentId: null,
    });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "PaymentOutboxEvent"`).get()).toEqual({ count: 0 });
  });

  it("builds the D1 outbox JSON projection with valid column quoting", async () => {
    const prepared: string[] = [];
    const d1 = {
      prepare(sql: string) {
        return {
          bind(..._values: unknown[]) {
            prepared.push(sql);
            return { first: async () => ({ id: "payment-1" }) };
          },
        };
      },
      batch: vi.fn(async () => []),
    };
    mockGetD1Binding.mockResolvedValue(d1);
    const result = await recordVerifiedGatewayPaymentAtomically(makeDb(), input);
    expect(result).toBe("payment-1");
    expect(d1.batch).toHaveBeenCalledTimes(1);
    const outboxSql = prepared.find((sql) => sql.includes('INSERT INTO "PaymentOutboxEvent"'));
    expect(outboxSql).toContain("'paymentId', p." + '"id"' + ", 'gatewayLogId'");
    expect(outboxSql).toContain("'userId', p." + '"userId"' + ", 'amount', p." + '"amount"' + ", 'currency'");
    expect(outboxSql).not.toContain("p.\"id\\',");
    expect(outboxSql).not.toContain("p.\"userId\\',");
    expect(outboxSql).not.toContain("p.\"amount\\',");
  });

  it("rejects a gateway attempt whose server-owned amount no longer matches", async () => {
    mockLogFindUnique.mockResolvedValue({
      id: "gateway-1", userId: "customer-1", purpose: "vip", targetPlanId: "plan-1", targetPlanDurationDays: 30,
      amount: 90_000, currency: "IRR", financialUnitStatus: "VERIFIED_IRR", status: "REDIRECTED",
    });
    await expect(recordVerifiedGatewayPaymentAtomically(makeDb(), input)).rejects.toThrow(
      "Gateway attempt changed before atomic verification"
    );
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockOutboxUpsert).not.toHaveBeenCalled();
  });

  it("rejects an outbox idempotency key already bound to another aggregate", async () => {
    mockOutboxUpsert.mockResolvedValue({
      eventType: "PAYMENT_SUCCEEDED", aggregateType: "Payment", aggregateId: "payment-other",
    });
    await expect(recordVerifiedGatewayPaymentAtomically(makeDb(), input)).rejects.toThrow(
      "Outbox idempotency key is bound to a different event"
    );
  });

  it("rejects a conflicting pre-existing Payment instead of emitting an event", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-other", userId: "another-user", amount: 100_000, currency: "IRR",
      status: "SUCCEEDED", financialUnitStatus: "VERIFIED_IRR",
    });
    await expect(recordVerifiedGatewayPaymentAtomically(makeDb(), input)).rejects.toThrow(
      "Existing Payment does not match"
    );
    expect(mockOutboxUpsert).not.toHaveBeenCalled();
  });
});
