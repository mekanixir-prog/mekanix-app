// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
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
