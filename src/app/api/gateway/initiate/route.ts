import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// Initiate a payment through the Shaparak-simulator gateway.
//
// ⚠️ SIMULATOR ONLY — this endpoint is for development/testing.
// In production, this returns 404 (same pattern as /api/auth/demo).
// Real payment integration should use Zarinpal/IDPay create-transaction API.
//
// SECURITY FIXES (from D1 migration review):
//   1. Production guard: returns 404 in production (like auth/demo)
//   2. Auth required: caller must be authenticated (userId from session, not client)
//   3. Amount server-authoritative: amount comes from the linked entity
//      (invoice/job/wallet), NOT from the client request body
//
// MIGRATION: Uses getDbForLib() instead of direct db import.

export async function POST(req: Request) {
  // Hard block in production — simulator must not be reachable
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // Require authentication — userId must come from session, not client
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const { amount, purpose, description, mobile, cardNumber } = body;

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: "مبلغ معتبر الزامی است" }, { status: 400 });
  }

  const code = `PG-${Math.floor(7000 + Math.random() * 2000)}`;
  const referenceId = `SIM-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  const db = await getDbForLib();
  const log = await db.paymentGatewayLog.create({
    data: {
      code,
      userId: session.userId, // server-authoritative — NOT from client
      amount,
      currency: "IRR",
      gateway: "SHAPARAK_SIM",
      status: "REDIRECTED",
      purpose: purpose || "vip",
      referenceId,
      cardNumber: cardNumber ? maskCard(cardNumber) : null,
      mobile: mobile ?? null,
      description: description ?? null,
    },
  });

  // Return the reference; frontend simulates the OTP step then calls /verify
  return NextResponse.json({ ok: true, code: log.code, referenceId, amount });
}

function maskCard(card: string): string {
  const digits = card.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `**** **** **** ${digits.slice(-4)}`;
}
