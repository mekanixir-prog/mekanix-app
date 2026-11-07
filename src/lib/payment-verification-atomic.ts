import type { PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";
import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";

type VerifiedGatewayPaymentInput = {
  gatewayLogId: string;
  userId: string;
  paymentId: string;
  paymentCode: string;
  amount: number;
  targetPlanId: string;
  legacyPaymentId?: string;
  verifiedAt: Date;
};

type VerifiedGatewayPayment = {
  id: string;
  userId: string;
  amount: unknown;
  currency: string;
  status: string;
  financialUnitStatus: string;
};

function assertInput(input: VerifiedGatewayPaymentInput) {
  if (!input.gatewayLogId || !input.userId || !input.paymentId || !input.paymentCode || !input.targetPlanId ||
      !Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 100_000_000) {
    throw new Error("Invalid verified gateway payment input");
  }
}

function isMatchingPayment(payment: VerifiedGatewayPayment | null, input: VerifiedGatewayPaymentInput) {
  return Boolean(
    payment &&
    payment.userId === input.userId &&
    payment.status === "SUCCEEDED" &&
    payment.currency === "IRR" &&
    payment.financialUnitStatus === "VERIFIED_IRR" &&
    isSafeStoredIrrAmount(payment.amount) &&
    Number(payment.amount) === input.amount
  );
}

/**
 * Persists the Payment, VERIFIED gateway state, and PAYMENT_SUCCEEDED outbox
 * event as one atomic unit. D1 uses a transactional batch; Prisma uses
 * an interactive transaction. Outbox consumers must deduplicate by key.
 */
export async function recordVerifiedGatewayPaymentAtomically(
  db: PrismaClient,
  input: VerifiedGatewayPaymentInput,
): Promise<string> {
  assertInput(input);
  const eventKey = `payment.succeeded:${input.gatewayLogId}`;
  const d1 = await getD1Binding();
  if (d1) {
    const now = input.verifiedAt.toISOString();
    const eventId = crypto.randomUUID();
    const paymentWrite = input.legacyPaymentId
      ? d1.prepare(
          'UPDATE "Payment" SET "gatewayLogId" = ? WHERE "id" = ? AND "userId" = ? AND "amount" = ? AND "currency" = \'IRR\' AND "status" = \'SUCCEEDED\' AND "financialUnitStatus" = \'VERIFIED_IRR\' AND "gatewayLogId" IS NULL'
        ).bind(input.gatewayLogId, input.legacyPaymentId, input.userId, input.amount)
      : d1.prepare(
          'INSERT INTO "Payment" ("id", "code", "invoiceId", "userId", "amount", "currency", "method", "status", "financialUnitStatus", "gatewayLogId", "createdAt") ' +
          'SELECT ?, ?, NULL, ?, ?, \'IRR\', \'card\', \'SUCCEEDED\', \'VERIFIED_IRR\', ?, ? ' +
          'WHERE EXISTS (SELECT 1 FROM "PaymentGatewayLog" WHERE "id" = ? AND "userId" = ? AND "purpose" = \'vip\' AND "targetPlanId" = ? AND "amount" = ? AND "currency" = \'IRR\' AND "financialUnitStatus" = \'VERIFIED_IRR\' AND "status" IN (\'REDIRECTED\', \'VERIFIED\')) ' +
          'ON CONFLICT("gatewayLogId") DO NOTHING'
        ).bind(
          input.paymentId, input.paymentCode, input.userId, input.amount,
          input.gatewayLogId, now, input.gatewayLogId, input.userId,
          input.targetPlanId, input.amount,
        );

    const linkAndVerify = d1.prepare(
      'UPDATE "PaymentGatewayLog" SET "status" = \'VERIFIED\', "financialUnitStatus" = \'VERIFIED_IRR\', ' +
      '"verifiedAt" = COALESCE("verifiedAt", ?), "paymentId" = (SELECT p."id" FROM "Payment" p WHERE p."gatewayLogId" = ? AND p."userId" = ? AND p."amount" = ? AND p."currency" = \'IRR\' AND p."status" = \'SUCCEEDED\' AND p."financialUnitStatus" = \'VERIFIED_IRR\') ' +
      'WHERE "id" = ? AND "userId" = ? AND "purpose" = \'vip\' AND "targetPlanId" = ? AND "amount" = ? AND "currency" = \'IRR\' AND "financialUnitStatus" = \'VERIFIED_IRR\' ' +
      'AND ("status" = \'REDIRECTED\' OR ("status" = \'VERIFIED\' AND ("paymentId" IS NULL OR "paymentId" = (SELECT p."id" FROM "Payment" p WHERE p."gatewayLogId" = ? AND p."userId" = ?)))) ' +
      'AND EXISTS (SELECT 1 FROM "Payment" p WHERE p."gatewayLogId" = ? AND p."userId" = ? AND p."amount" = ? AND p."currency" = \'IRR\' AND p."status" = \'SUCCEEDED\' AND p."financialUnitStatus" = \'VERIFIED_IRR\')'
    ).bind(
      now, input.gatewayLogId, input.userId, input.amount,
      input.gatewayLogId, input.userId, input.targetPlanId, input.amount,
      input.gatewayLogId, input.userId,
      input.gatewayLogId, input.userId, input.amount,
    );

    const outboxInsert = d1.prepare(
      'INSERT INTO "PaymentOutboxEvent" ("id", "eventType", "aggregateType", "aggregateId", "payload", "idempotencyKey", "status", "attempts", "availableAt", "createdAt", "updatedAt") ' +
      'SELECT ?, \'PAYMENT_SUCCEEDED\', \'Payment\', p."id", json_object(\'eventType\', \'PAYMENT_SUCCEEDED\', \'paymentId\', p."id\', \'gatewayLogId\', ?, \'userId\', p."userId\', \'amount\', p."amount\', \'currency\', \'IRR\', \'purpose\', \'vip\', \'targetPlanId\', ?), ?, \'PENDING\', 0, ?, ?, ? ' +
      'FROM "Payment" p JOIN "PaymentGatewayLog" g ON g."id" = p."gatewayLogId" ' +
      'WHERE p."gatewayLogId" = ? AND p."userId" = ? AND p."amount" = ? AND p."currency" = \'IRR\' AND p."status" = \'SUCCEEDED\' ' +
      'AND g."status" = \'VERIFIED\' AND g."paymentId" = p."id" ' +
      'ON CONFLICT("idempotencyKey") DO NOTHING'
    ).bind(eventId, input.gatewayLogId, input.targetPlanId, eventKey, now, now, now, input.gatewayLogId, input.userId, input.amount);

    const assertVerifiedAndEnqueued = d1.prepare(
      'SELECT CASE WHEN EXISTS (SELECT 1 FROM "Payment" p JOIN "PaymentGatewayLog" g ON g."id" = p."gatewayLogId" ' +
      'JOIN "PaymentOutboxEvent" o ON o."idempotencyKey" = ? AND o."aggregateId" = p."id" AND o."eventType" = \'PAYMENT_SUCCEEDED\' ' +
      'AND json_extract(o."payload", \'$.paymentId\') = p."id" AND json_extract(o."payload", \'$.gatewayLogId\') = p."gatewayLogId" ' +
      'AND json_extract(o."payload", \'$.userId\') = p."userId" AND json_extract(o."payload", \'$.amount\') = p."amount" ' +
      'AND json_extract(o."payload", \'$.targetPlanId\') = ? ' +
      'WHERE p."gatewayLogId" = ? AND p."userId" = ? AND p."amount" = ? AND p."currency" = \'IRR\' AND p."status" = \'SUCCEEDED\' ' +
      'AND p."financialUnitStatus" = \'VERIFIED_IRR\' AND g."status" = \'VERIFIED\' AND g."paymentId" = p."id" ' +
      'AND g."purpose" = \'vip\' AND g."targetPlanId" = ? AND g."financialUnitStatus" = \'VERIFIED_IRR\') ' +
      'THEN 1 ELSE json_extract(\'not-json\', \'$\') END'
    ).bind(eventKey, input.targetPlanId, input.gatewayLogId, input.userId, input.amount, input.targetPlanId);

    await d1.batch([paymentWrite, linkAndVerify, outboxInsert, assertVerifiedAndEnqueued]);
    const row = await d1.prepare('SELECT "id" FROM "Payment" WHERE "gatewayLogId" = ?').bind(input.gatewayLogId).first<{ id: string }>();
    if (!row?.id) throw new Error("Atomic gateway verification did not produce a Payment");
    return row.id;
  }

  return db.$transaction(async (tx) => {
    const log = await tx.paymentGatewayLog.findUnique({ where: { id: input.gatewayLogId } });
    if (
      !log || log.userId !== input.userId || log.purpose !== "vip" ||
      log.targetPlanId !== input.targetPlanId || log.currency !== "IRR" ||
      log.financialUnitStatus !== "VERIFIED_IRR" ||
      !isSafeStoredIrrAmount(log.amount) || Number(log.amount) !== input.amount ||
      !["REDIRECTED", "VERIFIED"].includes(log.status)
    ) {
      throw new Error("Gateway attempt changed before atomic verification");
    }

    let payment = await tx.payment.findUnique({ where: { gatewayLogId: input.gatewayLogId } });
    if (!payment && input.legacyPaymentId) {
      const legacyPayment = await tx.payment.findUnique({ where: { id: input.legacyPaymentId } });
      if (!legacyPayment || !isMatchingPayment(legacyPayment, input) || legacyPayment.gatewayLogId) {
        throw new Error("Legacy Payment cannot be safely bound to this gateway attempt");
      }
      const bound = await tx.payment.updateMany({
        where: {
          id: input.legacyPaymentId,
          userId: input.userId,
          amount: input.amount,
          currency: "IRR",
          status: "SUCCEEDED",
          financialUnitStatus: "VERIFIED_IRR",
          gatewayLogId: null,
        },
        data: { gatewayLogId: input.gatewayLogId },
      });
      payment = await tx.payment.findUnique({ where: { gatewayLogId: input.gatewayLogId } });
      if (bound.count !== 1 && (!payment || payment.id !== input.legacyPaymentId)) {
        throw new Error("Legacy Payment was concurrently bound to another gateway attempt");
      }
    }
    if (!payment) {
      payment = await tx.payment.create({
        data: {
          id: input.paymentId,
          code: input.paymentCode,
          invoiceId: null,
          userId: input.userId,
          amount: input.amount,
          currency: "IRR",
          method: "card",
          status: "SUCCEEDED",
          financialUnitStatus: "VERIFIED_IRR",
          gatewayLogId: input.gatewayLogId,
        },
      });
    }
    if (!isMatchingPayment(payment, input)) {
      throw new Error("Existing Payment does not match the verified gateway attempt");
    }

    const linked = await tx.paymentGatewayLog.updateMany({
      where: {
        id: input.gatewayLogId,
        userId: input.userId,
        purpose: "vip",
        targetPlanId: input.targetPlanId,
        amount: input.amount,
        currency: "IRR",
        financialUnitStatus: "VERIFIED_IRR",
        status: { in: ["REDIRECTED", "VERIFIED"] },
        OR: [{ paymentId: null }, { paymentId: payment.id }],
      },
      data: { status: "VERIFIED", verifiedAt: log.verifiedAt ?? input.verifiedAt, paymentId: payment.id },
    });
    if (linked.count !== 1) throw new Error("Gateway attempt could not be linked to its Payment");

    const payload = JSON.stringify({
      eventType: "PAYMENT_SUCCEEDED",
      paymentId: payment.id,
      gatewayLogId: input.gatewayLogId,
      userId: input.userId,
      amount: input.amount,
      currency: "IRR",
      purpose: "vip",
      targetPlanId: input.targetPlanId,
    });
    const event = await tx.paymentOutboxEvent.upsert({
      where: { idempotencyKey: eventKey },
      create: {
        eventType: "PAYMENT_SUCCEEDED",
        aggregateType: "Payment",
        aggregateId: payment.id,
        payload,
        idempotencyKey: eventKey,
        status: "PENDING",
        availableAt: input.verifiedAt,
      },
      update: {},
    });
    if (event.eventType !== "PAYMENT_SUCCEEDED" || event.aggregateType !== "Payment" || event.aggregateId !== payment.id || event.payload !== payload) {
      throw new Error("Outbox idempotency key is bound to a different event");
    }
    return payment.id;
  });
}
