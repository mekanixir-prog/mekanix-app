import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// Verify a payment (simulated Shaparak OTP flow).
// Simulator-only: real provider callbacks must use provider signature verification.
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { code, otp } = body;
  if (typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }
  if (typeof otp !== "string" || otp.length < 4) {
    return NextResponse.json({ error: "Invalid OTP" }, { status: 400 });
  }

  const db = await getDbForLib();
  const log = await db.paymentGatewayLog.findUnique({ where: { code } });
  if (!log) return NextResponse.json({ error: "Payment log not found" }, { status: 404 });
  if (log.userId !== session.userId) {
    return NextResponse.json({ error: "این درخواست متعلق به شما نیست" }, { status: 403 });
  }
  if (log.status === "FAILED" || log.status === "CANCELLED") {
    return NextResponse.json({ error: "این پرداخت ناموفق یا لغو شده است" }, { status: 409 });
  }

  // Recover safely if a previous request created the Payment but failed before
  // linking it to the gateway log. gatewayLogId is a database-enforced unique key.
  let payment = await db.payment.findUnique({ where: { gatewayLogId: log.id } });
  if (payment) {
    if (payment.userId !== session.userId || payment.status !== "SUCCEEDED") {
      return NextResponse.json({ error: "وضعیت پرداخت قابل تأیید نیست" }, { status: 409 });
    }
    await db.paymentGatewayLog.update({
      where: { id: log.id },
      data: { status: "VERIFIED", verifiedAt: log.verifiedAt ?? new Date(), paymentId: payment.id },
    });
    return NextResponse.json({ ok: true, paymentId: payment.id, amount: payment.amount, purpose: log.purpose, alreadyVerified: true });
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
        gatewayLogId: log.id,
      },
    });
  } catch (error: any) {
    if (error?.code !== "P2002" && !error?.message?.includes("Unique constraint")) {
      throw error;
    }
    payment = await db.payment.findUnique({ where: { gatewayLogId: log.id } });
    if (!payment || payment.userId !== session.userId || payment.status !== "SUCCEEDED") {
      throw error;
    }
  }

  // If this write fails, the payment remains discoverable by gatewayLogId;
  // retrying this endpoint repairs the log instead of losing the payment.
  await db.paymentGatewayLog.update({
    where: { id: log.id },
    data: { status: "VERIFIED", verifiedAt: log.verifiedAt ?? new Date(), paymentId: payment.id },
  });

  return NextResponse.json({ ok: true, paymentId: payment.id, amount: payment.amount, purpose: log.purpose });
}
