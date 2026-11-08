import { isPaymentSimulatorRouteEnabled } from "@/lib/payment-simulator-guard";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { createVipSubscriptionAtomically } from "@/lib/vip-subscription-atomic";
import { isSafeStoredIrrAmount, maskFinancialFields } from "@/lib/money/financial-read-mask";

// Subscribe the authenticated user to a VIP plan.
// userId is derived from the session — NEVER from the request body (BOLA fix).
//
// SEC-7 fix (3-layer):
// 1. Production guard — returns 404 in production builds (consistent with
//    /api/auth/demo and /api/seed). Dev-only simulation until the real
//    payment gateway is wired in.
// 2. requireAuth — userId derived from session, never from body.
// 3. paymentId validated server-side: must exist, belong to caller, have
//    status SUCCEEDED, and cover plan price. Closes the free-VIP bypass.
export async function POST(req: Request) {
  // 1. Production guard — fail closed. This route is dev-only simulation
  //    until a real payment gateway integration exists.
  if (!isPaymentSimulatorRouteEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  // 2. Auth — userId comes from the session, never from the body.
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { planId, paymentId } = body;
  const userId = session.userId; // server-authoritative — NOT from body
  if (typeof planId !== "string" || !planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const db = await getDbForLib();

  // The payment attempt is the authoritative purchase snapshot. A plan may be
  // deactivated or edited after payment; that must not invalidate an already-paid entitlement.
  const plan = await db.vipPlan.findUnique({ where: { id: planId } });
  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  // 3. Validate paymentId — must be a real SUCCEEDED payment by this user
  //    that covers the plan price. This closes the free-VIP bypass.
  //    Note: VipPlan stores price as `priceIrr` (Decimal, Iranian Rial).
  if (typeof paymentId !== "string" || !paymentId) {
    return NextResponse.json({ error: "paymentId is required" }, { status: 400 });
  }
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (
    !payment ||
    payment.userId !== userId ||
    payment.status !== "SUCCEEDED" ||
    payment.financialUnitStatus !== "VERIFIED_IRR" ||
    !isSafeStoredIrrAmount(payment.amount) ||
    payment.currency !== "IRR" ||
    !payment.gatewayLogId
  ) {
    return NextResponse.json({ error: "Invalid or insufficient payment" }, { status: 400 });
  }

  // A successful Payment row alone is not proof that it was intended for VIP.
  // Require the exact verified gateway attempt to belong to this user, to be
  // marked for the VIP purpose, and to be the attempt that created this Payment.
  const gatewayLog = await db.paymentGatewayLog.findUnique({
    where: { id: payment.gatewayLogId },
  });
  if (
    !gatewayLog ||
    gatewayLog.userId !== userId ||
    gatewayLog.status !== "VERIFIED" ||
    gatewayLog.financialUnitStatus !== "VERIFIED_IRR" ||
    !isSafeStoredIrrAmount(gatewayLog.amount) ||
    gatewayLog.purpose !== "vip" ||
    gatewayLog.targetPlanId !== planId ||
    gatewayLog.paymentId !== payment.id ||
    gatewayLog.currency !== payment.currency ||
    Number(gatewayLog.amount) !== Number(payment.amount)
  ) {
    return NextResponse.json({ error: "Payment is not a verified VIP payment" }, { status: 400 });
  }

  // The paymentId unique constraint is the final replay guard. Return the
  // already-created subscription for a retry instead of reporting a false
  // failure or attempting to consume the same payment again.
  const existingSub = await db.userVipSubscription.findFirst({
    where: { paymentId, status: { in: ["ACTIVE", "CANCELLED", "EXPIRED"] } },
    include: { plan: true },
  });
  if (existingSub) {
    if (existingSub.userId !== userId || existingSub.planId !== planId) {
      return NextResponse.json({ error: "پرداخت قبلاً به اشتراک دیگری متصل شده است" }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      alreadyProcessed: true,
      subscription: {
        ...existingSub,
        plan: maskFinancialFields(existingSub.plan, ["priceIrr"]),
      },
    });
  }

  // Entitlement duration is immutable: use the value captured at payment initiation,
  // never the mutable VipPlan.durationDays field.
  const durationSnapshot = gatewayLog.targetPlanDurationDays;
  if (typeof durationSnapshot !== "number" || !Number.isSafeInteger(durationSnapshot) || durationSnapshot <= 0 || durationSnapshot > 36500) {
    return NextResponse.json({ error: "مدت ثبت‌شده برای این پرداخت معتبر نیست و نیاز به بررسی دارد", code: "VIP_DURATION_SNAPSHOT_MISSING" }, { status: 409 });
  }
  const durationDays = durationSnapshot;

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

  // Replace the previous active subscription and consume this payment in one
  // database transaction (Prisma) or one transactional D1 batch. If creation
  // fails, the prior ACTIVE subscription remains intact.
  let sub;
  try {
    const subscriptionId = await createVipSubscriptionAtomically(db, {
      userId,
      planId,
      paymentId,
      startedAt,
      expiresAt,
    });
    sub = await db.userVipSubscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true },
    });
    if (!sub) throw new Error("VIP subscription could not be loaded after atomic creation");
  } catch (e: any) {
    if (e?.code === "P2002" || /unique constraint/i.test(String(e?.message ?? ""))) {
      // A concurrent request may have consumed this payment after the initial
      // read. Recover only the exact same payment/user/plan binding.
      const racedSub = await db.userVipSubscription.findFirst({
        where: { paymentId, status: { in: ["ACTIVE", "CANCELLED", "EXPIRED"] } },
        include: { plan: true },
      });
      if (racedSub && racedSub.userId === userId && racedSub.planId === planId) {
        return NextResponse.json({
          ok: true,
          alreadyProcessed: true,
          subscription: {
            ...racedSub,
            plan: maskFinancialFields(racedSub.plan, ["priceIrr"]),
          },
        });
      }
      return NextResponse.json(
        { error: "پرداخت قبلاً استفاده شده یا اشتراک فعال دیگری ثبت شده است" },
        { status: 409 }
      );
    }
    throw e;
  }

  // Notify user — best-effort, never fail a subscription over a notification.
  try {
    await db.notification.create({
      data: {
        id: `vip-activated:${paymentId}`,
        userId,
        type: "vip_activated",
        title: "اشتراک VIP فعال شد",
        body: "اشتراک VIP شما ثبت و فعال‌سازی شد.",
        category: "system",
        link: "customer/settings",
      },
    });
  } catch (e) {
    console.error("[vip/subscribe] Failed to create notification (subscription still created):", e);
  }

  return NextResponse.json({ ok: true, subscription: sub ? { ...sub, plan: maskFinancialFields(sub.plan, ["priceIrr"]) } : sub });
}
