// VIP Engine — manages annual subscriptions per ARCHITECTURE.md §13.
//
// VIP includes:
//   - Annual subscription
//   - Free periodic visit
//   - Priority service
// VIP does NOT include:
//   - Free repair
//   - Free parts
//
// Schema mapping (per `prisma/schema.prisma`):
//   - The Prisma model is `UserVipSubscription` (camelCase accessor:
//     `db.userVipSubscription`). The public API calls it `VipSubscription`
//     for caller ergonomics — the mapping happens inside this file.
//   - DB fields: `startedAt`  ↔ public API `startDate`
//   - DB fields: `expiresAt` ↔ public API `endDate`     (null = lifetime)
//   - DB fields: `plan.discountPct` ↔ public API `discountPercent`
//   - DB enum:    `VipStatus`       ↔ public API status union
//     ("ACTIVE" | "EXPIRED" | "CANCELLED")
//     (DB also has "PENDING_PAYMENT" — internal only, never returned.)

import { getDbForLib } from "./db-access";

export interface VipSubscriptionResult {
  subscriptionId: string;
  planName: string;
  status: "ACTIVE" | "EXPIRED" | "CANCELLED";
  startDate: Date;
  endDate: Date;
  benefits: {
    freePeriodicVisit: boolean;
    priorityService: boolean;
    discountPercent: number;
  };
}

// Subscribe a user to a VIP plan.
//
// Steps:
//   1. Look up the plan — throw if not found.
//   2. Expire any currently-ACTIVE subscription the user already has
//      (a user can only have one ACTIVE VIP at a time).
//   3. Create a new ACTIVE subscription with a 1-year validity window.
//
// Note: the new subscription is created in `ACTIVE` status directly. The
// `PENDING_PAYMENT` status is reserved for the future checkout flow — the
// payment gateway integration in Phase 5 will set status to PENDING_PAYMENT
// first, then flip to ACTIVE on payment verification.
export async function subscribeToVip(userId: string, planId: string): Promise<VipSubscriptionResult> {
  const db = await getDbForLib();
  const plan = await db.vipPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("VIP plan not found");

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setFullYear(endDate.getFullYear() + 1); // annual

  // Deactivate any existing active VIP subscription. `updateMany` returns a
  // count but we don't need it — there should be 0 or 1.
  await db.userVipSubscription.updateMany({
    where: { userId, status: "ACTIVE" },
    data: { status: "EXPIRED", expiresAt: startDate },
  });

  // Create new subscription
  const sub = await db.userVipSubscription.create({
    data: {
      userId,
      planId,
      startedAt: startDate,
      expiresAt: endDate,
      status: "ACTIVE",
    },
  });

  return {
    subscriptionId: sub.id,
    planName: plan.name,
    status: "ACTIVE",
    startDate,
    endDate,
    benefits: {
      freePeriodicVisit: true,
      priorityService: true,
      discountPercent: plan.discountPct ?? 10,
    },
  };
}

// Check if user has active VIP.
//
// Returns `{ active: false, discountPercent: 0 }` if no active sub.
// Returns `{ active: true, discountPercent: <plan.discountPct> }` if active.
//
// "Active" = status is ACTIVE AND (expiresAt is null (lifetime) OR expiresAt
// is in the future). Expired subscriptions still in ACTIVE status (e.g. a
// cron hasn't run yet to flip them) are treated as inactive here — the
// date check is authoritative.
export async function checkVipStatus(userId: string): Promise<{ active: boolean; discountPercent: number; plan?: string; expiresAt?: Date }> {
  const db = await getDbForLib();
  const sub = await db.userVipSubscription.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      OR: [
        { expiresAt: null }, // lifetime
        { expiresAt: { gt: new Date() } }, // not expired
      ],
    },
    include: { plan: true },
  });

  if (!sub) return { active: false, discountPercent: 0 };

  return {
    active: true,
    plan: sub.plan?.slug,
    expiresAt: sub.expiresAt ?? undefined,
    discountPercent: sub.plan?.discountPct ?? 10,
  };
}

// Convenience wrapper: just return the discount % (0 if no active VIP).
// Kept for backward compat with callers that only need the percentage.
export async function getVipDiscount(userId: string): Promise<number> {
  const { discountPercent } = await checkVipStatus(userId);
  return discountPercent;
}
