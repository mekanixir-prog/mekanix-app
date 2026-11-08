import { isPaymentSimulatorRouteEnabled } from "@/lib/payment-simulator-guard";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";
import { recordVerifiedGatewayPaymentAtomically } from "@/lib/payment-verification-atomic";

// Verify a payment (simulated Shaparak OTP flow).
// Simulator-only: real provider callbacks must use provider signature verification.
export async function POST(req: Request) {
  if (!isPaymentSimulatorRouteEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { code, otp } = body as Record<string, unknown>;
  if (typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }
  if (typeof otp !== "string" || otp.length < 4) {
    return NextResponse.json({ error: "Invalid OTP" }, { status: 400 });
  }

  const db = await getDbForLib();
  const normalizedCode = code.trim();
  const log = await db.paymentGatewayLog.findUnique({ where: { code: normalizedCode } });
  if (!log) return NextResponse.json({ error: "Payment log not found" }, { status: 404 });
  if (log.userId !== session.userId) {
    return NextResponse.json({ error: "این درخواست متعلق به شما نیست" }, { status: 403 });
  }
  if (log.currency !== "IRR" || log.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(log.amount) || Number(log.amount) <= 0) {
    return NextResponse.json({ error: "مبلغ درگاه از نظر واحد و منشأ ریال تأیید نشده است", code: "GATEWAY_IRR_PROVENANCE_UNVERIFIED" }, { status: 409 });
  }

  // This simulator endpoint supports VIP only. The plan identity and amount
  // are persisted at initiation; client purpose/amount never select fulfillment.
  if (log.purpose !== "vip" || !log.targetPlanId) {
    return NextResponse.json({ error: "این تلاش پرداخت به طرح VIP معتبر متصل نیست", code: "GATEWAY_PURPOSE_UNBOUND" }, { status: 409 });
  }
  const targetPlan = await db.vipPlan.findUnique({ where: { id: log.targetPlanId } });
  if (
    !Number.isSafeInteger(log.targetPlanDurationDays) || Number(log.targetPlanDurationDays) <= 0 ||
    Number(log.targetPlanDurationDays) > 36500 ||
    !targetPlan
  ) {
    return NextResponse.json({ error: "طرح یا مبلغ تلاش پرداخت دیگر قابل تأیید نیست", code: "VIP_PLAN_SNAPSHOT_MISMATCH" }, { status: 409 });
  }
  if (log.status === "FAILED" || log.status === "CANCELLED") {
    return NextResponse.json({ error: "این پرداخت ناموفق یا لغو شده است" }, { status: 409 });
  }

  // Recover safely if a prior request persisted the Payment. The helper also
  // repairs the gateway link and guarantees the matching outbox event exists.
  const existingPayment = await db.payment.findUnique({ where: { gatewayLogId: log.id } });
  if (existingPayment) {
    if (existingPayment.userId !== session.userId || existingPayment.status !== "SUCCEEDED" || existingPayment.currency !== "IRR" || existingPayment.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(existingPayment.amount) || Number(existingPayment.amount) !== Number(log.amount)) {
      return NextResponse.json({ error: "وضعیت پرداخت قابل تأیید نیست" }, { status: 409 });
    }
    const paymentId = await recordVerifiedGatewayPaymentAtomically(db, {
      gatewayLogId: log.id,
      userId: session.userId,
      paymentId: existingPayment.id,
      paymentCode: existingPayment.code,
      amount: Number(log.amount),
      targetPlanId: log.targetPlanId,
      durationDays: log.targetPlanDurationDays!,
      verifiedAt: log.verifiedAt ?? new Date(),
    });
    return NextResponse.json({ ok: true, paymentId, amount: Number(existingPayment.amount), purpose: log.purpose, alreadyVerified: true });
  }

  // Legacy simulator callbacks marked the log VERIFIED before creating and
  // linking the Payment. A VERIFIED row without the new gatewayLogId key may
  // therefore represent an ambiguous partial write. Recover only when the
  // legacy paymentId proves which Payment belongs to this attempt.
  if (log.status === "VERIFIED") {
    if (!log.paymentId) {
      return NextResponse.json(
        { error: "وضعیت پرداخت قدیمی مبهم است و نیاز به بررسی دستی دارد" },
        { status: 409 }
      );
    }
    const legacyPayment = await db.payment.findUnique({ where: { id: log.paymentId } });
    if (!legacyPayment || legacyPayment.userId !== session.userId || legacyPayment.status !== "SUCCEEDED" || legacyPayment.currency !== "IRR" || legacyPayment.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(legacyPayment.amount) || Number(legacyPayment.amount) !== Number(log.amount)) {
      return NextResponse.json({ error: "رکورد پرداخت قبلی قابل تطبیق نیست؛ بررسی دستی لازم است" }, { status: 409 });
    }
    const paymentId = await recordVerifiedGatewayPaymentAtomically(db, {
      gatewayLogId: log.id,
      userId: session.userId,
      paymentId: legacyPayment.id,
      paymentCode: legacyPayment.code,
      legacyPaymentId: legacyPayment.id,
      amount: Number(log.amount),
      targetPlanId: log.targetPlanId,
      durationDays: log.targetPlanDurationDays!,
      verifiedAt: log.verifiedAt ?? new Date(),
    });
    return NextResponse.json({
      ok: true, paymentId, amount: Number(legacyPayment.amount),
      purpose: log.purpose, alreadyVerified: true,
    });
  }

  // Persist Payment, VERIFIED gateway state, and PAYMENT_SUCCEEDED outbox
  // event atomically. A unique-key race is recovered by loading the winner and
  // retrying the atomic helper, which also ensures its outbox event exists.
  let paymentId: string;
  try {
    paymentId = await recordVerifiedGatewayPaymentAtomically(db, {
      gatewayLogId: log.id,
      userId: session.userId,
      paymentId: crypto.randomUUID(),
      paymentCode: `PAY-${log.code}`,
      amount: Number(log.amount),
      targetPlanId: log.targetPlanId,
      durationDays: log.targetPlanDurationDays!,
      verifiedAt: log.verifiedAt ?? new Date(),
    });
  } catch (error: any) {
    if (error?.code !== "P2002" && !/unique constraint/i.test(String(error?.message ?? ""))) throw error;
    const racedPayment = await db.payment.findUnique({ where: { gatewayLogId: log.id } });
    if (!racedPayment || racedPayment.userId !== session.userId || racedPayment.status !== "SUCCEEDED" || racedPayment.currency !== "IRR" || racedPayment.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(racedPayment.amount) || Number(racedPayment.amount) !== Number(log.amount)) {
      throw error;
    }
    paymentId = await recordVerifiedGatewayPaymentAtomically(db, {
      gatewayLogId: log.id,
      userId: session.userId,
      paymentId: racedPayment.id,
      paymentCode: racedPayment.code,
      amount: Number(log.amount),
      targetPlanId: log.targetPlanId,
      durationDays: log.targetPlanDurationDays!,
      verifiedAt: log.verifiedAt ?? new Date(),
    });
  }

  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new Error("Verified Payment disappeared after atomic persistence");
  return NextResponse.json({ ok: true, paymentId: payment.id, amount: Number(payment.amount), purpose: log.purpose });
}
