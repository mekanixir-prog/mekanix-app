import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// Verify a payment (simulate Shaparak OTP verify).
//
// ⚠️ SIMULATOR ONLY — this endpoint is for development/testing.
// In production, this returns 404 (same pattern as /api/auth/demo).
// Real payment verification should call Zarinpal/IDPay verify API.
//
// SECURITY FIXES (from D1 migration review):
//   1. Production guard: returns 404 in production
//   2. Auth required: caller must be authenticated
//   3. userId server-authoritative: comes from session, NOT client body
//   4. Double-verification protection: optimistic check on log status
//   5. Amount server-authoritative: comes from the gateway log, NOT client
//
// MIGRATION: Uses getDbForLib() instead of direct db import.

export async function POST(req: Request) {
  // Hard block in production — simulator must not be reachable
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // Require authentication
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const { code, otp } = body;
  if (!code) return NextResponse.json({ error: "code is required" }, { status: 400 });
  if (!otp || otp.length < 4) {
    return NextResponse.json({ error: "Invalid OTP" }, { status: 400 });
  }

  const db = await getDbForLib();
  const log = await db.paymentGatewayLog.findUnique({ where: { code } });
  if (!log) return NextResponse.json({ error: "Payment log not found" }, { status: 404 });

  // SECURITY: userId comes from session, NOT from client body.
  // The payment is attributed to the authenticated user, not whoever
  // the client claims to be.
  if (log.userId !== session.userId) {
    return NextResponse.json({ error: "این درخواست متعلق به شما نیست" }, { status: 403 });
  }

  // Atomic double-verify prevention: only transition to VERIFIED if not already verified
  const verifyResult = await db.paymentGatewayLog.updateMany({
    where: { id: log.id, status: { not: "VERIFIED" } },
    data: { status: "VERIFIED", verifiedAt: new Date() },
  });
  if (verifyResult.count === 0) {
    return NextResponse.json({ error: "Already verified" }, { status: 400 });
  }

  // Create a Payment record — amount from server log, NOT from client
  const payment = await db.payment.create({
    data: {
      code: `PAY-${Math.floor(8000 + Math.random() * 1000)}`,
      invoiceId: null, // gateway payments are standalone (not tied to invoice)
      userId: session.userId, // server-authoritative
      amount: log.amount, // from server log, NOT client
      currency: "IRR",
      method: "card",
      status: "SUCCEEDED",
    },
  });

  // Link the gateway log to the payment
  await db.paymentGatewayLog.update({
    where: { id: log.id },
    data: { paymentId: payment.id },
  });

  return NextResponse.json({ ok: true, paymentId: payment.id, amount: log.amount, purpose: log.purpose });
}
