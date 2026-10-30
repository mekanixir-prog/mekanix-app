import type { PrismaClient } from "@prisma/client";

type Input = {
  userId: string;
  planId: string;
  paymentId: string;
  startedAt: Date;
  expiresAt: Date;
};
type D1Statement = { bind: (...values: unknown[]) => D1Statement };
type D1Database = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<Array<{ meta?: { changes?: number } }>>;
};

/** Replace the user's active subscription and create its successor atomically. */
export async function createVipSubscriptionWithPrisma(
  db: PrismaClient,
  input: Input
): Promise<string> {
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

/**
 * D1 batch is transactional. If paymentId or the one-active-per-user partial
 * unique index rejects the new row, the preceding cancellation is rolled back.
 */
export async function createVipSubscriptionWithD1(
  d1: D1Database,
  input: Input
): Promise<string> {
  const id = crypto.randomUUID();
  const startedAt = input.startedAt.toISOString();
  const expiresAt = input.expiresAt.toISOString();
  const now = startedAt;
  const results = await d1.batch([
    d1.prepare(`
      UPDATE "UserVipSubscription"
      SET "status" = 'CANCELLED', "updatedAt" = ?
      WHERE "userId" = ? AND "status" = 'ACTIVE'
    `).bind(now, input.userId),
    d1.prepare(`
      INSERT INTO "UserVipSubscription"
        ("id", "userId", "planId", "status", "startedAt", "expiresAt",
         "paymentId", "createdAt", "updatedAt")
      VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
    `).bind(
      id, input.userId, input.planId, startedAt, expiresAt,
      input.paymentId, now, now
    ),
  ]);
  if (results[1]?.meta?.changes !== 1) {
    throw new Error("VIP subscription insert did not complete");
  }
  return id;
}

export async function createVipSubscriptionAtomically(
  db: PrismaClient,
  input: Input
): Promise<string> {
  const isWorker = typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers";
  if (!isWorker) return createVipSubscriptionWithPrisma(db, input);

  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const context = await getCloudflareContext({ async: true });
  const d1 = (context.env as unknown as { DB?: D1Database }).DB;
  if (!d1) throw new Error("D1 binding 'DB' is unavailable for VIP subscription activation");
  return createVipSubscriptionWithD1(d1, input);
}
