import type { PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";

type CreateVipSubscriptionInput = {
  userId: string;
  planId: string;
  paymentId: string;
  startedAt: Date;
  expiresAt: Date;
};

/**
 * Replaces an active VIP subscription and creates its successor atomically.
 * A failed insert must roll back the cancellation of the previous subscription.
 */
export async function createVipSubscriptionAtomically(
  db: PrismaClient,
  input: CreateVipSubscriptionInput,
): Promise<string> {
  const d1 = await getD1Binding();

  if (d1) {
    const id = crypto.randomUUID();
    const now = input.startedAt.toISOString();
    const assertOneChange = () =>
      d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
      d1.prepare(
        'UPDATE "UserVipSubscription" SET "status" = \'CANCELLED\', "updatedAt" = ?' +
        ' WHERE "userId" = ? AND "status" = \'ACTIVE\''
      ).bind(now, input.userId),
      d1.prepare(
        'INSERT INTO "UserVipSubscription"' +
        ' ("id", "userId", "planId", "status", "startedAt", "expiresAt", "paymentId", "createdAt", "updatedAt")' +
        ' VALUES (?, ?, ?, \'ACTIVE\', ?, ?, ?, ?, ?)'
      ).bind(
        id,
        input.userId,
        input.planId,
        input.startedAt.toISOString(),
        input.expiresAt.toISOString(),
        input.paymentId,
        now,
        now,
      ),
    ]);

    if ((results[1]?.meta?.changes ?? 0) !== 1) {
      throw new Error("VIP subscription insert did not complete");
    }
    return id;
  }

  return db.$transaction(async (tx) => {
    await tx.userVipSubscription.updateMany({
      where: { userId: input.userId, status: "ACTIVE" },
      data: { status: "CANCELLED" },
    });
    const subscription = await tx.userVipSubscription.create({
      data: {
        userId: input.userId,
        planId: input.planId,
        status: "ACTIVE",
        startedAt: input.startedAt,
        expiresAt: input.expiresAt,
        paymentId: input.paymentId,
      },
      select: { id: true },
    });
    return subscription.id;
  });
}
) END").bind();
    await d1.batch([
      d1.prepare(
        'UPDATE "UserVipSubscription" SET "status" = \'CANCELLED\', "updatedAt" = ?' +
        ' WHERE "userId" = ? AND "status" = \'ACTIVE\''
      ).bind(now, input.userId),
      d1.prepare(
        'INSERT INTO "UserVipSubscription"' +
        ' ("id", "userId", "planId", "status", "startedAt", "expiresAt", "paymentId", "createdAt", "updatedAt")' +
        ' VALUES (?, ?, ?, \'ACTIVE\', ?, ?, ?, ?, ?)'
      ).bind(
        id,
        input.userId,
        input.planId,
        input.startedAt.toISOString(),
        input.expiresAt.toISOString(),
        input.paymentId,
        now,
        now,
      ),
    ]);

    if ((results[1]?.meta?.changes ?? 0) !== 1) {
      throw new Error("VIP subscription insert did not complete");
    }
    return id;
  }

  return db.$transaction(async (tx) => {
    await tx.userVipSubscription.updateMany({
      where: { userId: input.userId, status: "ACTIVE" },
      data: { status: "CANCELLED" },
    });
    const subscription = await tx.userVipSubscription.create({
      data: {
        userId: input.userId,
        planId: input.planId,
        status: "ACTIVE",
        startedAt: input.startedAt,
        expiresAt: input.expiresAt,
        paymentId: input.paymentId,
      },
      select: { id: true },
    });
    return subscription.id;
  });
}
