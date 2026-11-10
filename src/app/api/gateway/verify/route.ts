import { isPaymentSimulatorRouteEnabled } from "@/lib/payment-simulator-guard";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";

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
  // The local simulator has one documented test code; this is not a real OTP.
  if (otp !== "1234") {
    return NextResponse.json({ error: "کد آزمایشی نامعتبر است", code: "SIMULATOR_OTP_INVALID" }, { status: 400 });
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
    !targetPlan ||
    !targetPlan.active ||
    targetPlan.financialUnitStatus !== "VERIFIED_IRR" ||
    !isSafeStoredIrrAmount(targetPlan.priceIrr)
  ) {
    return NextResponse.json({ error: "طرح یا مبلغ تلاش پرداخت دیگر قابل تأیید نیست", code: "VIP_PLAN_SNAPSHOT_MISMATCH" }, { status: 409 });
  }
  if (log.status === "FAILED" || log.status === "CANCELLED") {
    return NextResponse.json({ error: "این پرداخت ناموفق یا لغو شده است" }, { status: 409 });
  }

  // Recover safely if a previous request created the Payment but failed before
  // linking it to the gateway log. gatewayLogId is a database-enforced unique key.
  let payment = await db.payment.findUnique({ where: { gatewayLogId: log.id } });
  if (payment) {
    if (payment.userId !== session.userId || payment.status !== "SUCCEEDED" || payment.currency !== "IRR" || payment.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(payment.amount) || Number(payment.amount) !== Number(log.amount)) {
      return NextResponse.json({ error: "وضعیت پرداخت قابل تأیید نیست" }, { status: 409 });
    }
    await db.paymentGatewayLog.update({
      where: { id: log.id },
      data: { status: "VERIFIED", financialUnitStatus: "VERIFIED_IRR", verifiedAt: log.verifiedAt ?? new Date(), paymentId: payment.id },
    });
    return NextResponse.json({ ok: true, paymentId: payment.id, amount: Number(payment.amount), purpose: log.purpose, alreadyVerified: true });
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
    return NextResponse.json({
      ok: true, paymentId: legacyPayment.id, amount: Number(legacyPayment.amount),
      purpose: log.purpose, alreadyVerified: true,
    });
  }

  // Create first with a unique idempotency key. If two callbacks race, the
  // database permits exactly one Payment row. The losing request reloads it.
  try {
    payment = await db.payment.create({
      data: {
        code: `PAY-${log.code}`,
        invoiceId: null,
        userId: session.userId,
        amount: log.amount,
        currency: log.currency || "IRR",
        method: "card",
        status: "SUCCEEDED",
        financialUnitStatus: "VERIFIED_IRR",
        gatewayLogId: log.id,
      },
    });
  } catch (error: any) {
    if (error?.code !== "P2002" && !error?.message?.includes("Unique constraint")) {
      throw error;
    }
    payment = await db.payment.findUnique({ where: { gatewayLogId: log.id } });
    if (!payment || payment.userId !== session.userId || payment.status !== "SUCCEEDED" || payment.currency !== "IRR" || payment.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(payment.amount) || Number(payment.amount) !== Number(log.amount)) {
      throw error;
    }
  }

  // If this write fails, the payment remains discoverable by gatewayLogId;
  // retrying this endpoint repairs the log instead of losing the payment.
  await db.paymentGatewayLog.update({
    where: { id: log.id },
    data: { status: "VERIFIED", financialUnitStatus: "VERIFIED_IRR", verifiedAt: log.verifiedAt ?? new Date(), paymentId: payment.id },
  });

  return NextResponse.json({ ok: true, paymentId: payment.id, amount: Number(payment.amount), purpose: log.purpose });
}
