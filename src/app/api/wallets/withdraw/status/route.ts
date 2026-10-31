import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";

// Read-only reconciliation lookup. It never creates or mutates a wallet/request.
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  if (session.role !== "TECHNICIAN") {
    return NextResponse.json({ error: "فقط مکانیک می‌تواند وضعیت برداشت خود را بررسی کند" }, { status: 403 });
  }

  const key = new URL(req.url).searchParams.get("key")?.trim() ?? "";
  if (key.length < 8 || key.length > 128) {
    return NextResponse.json({ error: "شناسه پیگیری محلی نامعتبر است" }, { status: 400 });
  }

  const technician = await getTechnicianFromSession(session);
  if (!technician) return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 404 });
  const db = await getDbForLib();
  const wallet = await db.wallet.findUnique({
    where: { technicianId: technician.id },
    select: { id: true },
  });
  if (!wallet) return NextResponse.json({ state: "NOT_COMMITTED" });

  const request = await db.withdrawalRequest.findUnique({
    where: { idempotencyKey: key },
    select: {
      id: true,
      walletId: true,
      code: true,
      amount: true,
      status: true,
      requestedAt: true,
      processedAt: true,
    },
  });

  if (!request) return NextResponse.json({ state: "NOT_COMMITTED" });
  if (request.walletId !== wallet.id) {
    return NextResponse.json({ state: "KEY_CONFLICT" }, { status: 409 });
  }

  // A WithdrawalRequest row alone is not proof of a committed debit. Verify
  // the matching immutable ledger row before telling the client it succeeded.
  const ledger = await db.walletLedger.findUnique({
    where: { idempotencyKey: `withdrawal:${key}:LEDGER` },
    select: { id: true, referenceId: true, amount: true },
  });
  const expectedDebit = new Prisma.Decimal(request.amount).negated();
  if (!ledger || ledger.referenceId !== request.id || !expectedDebit.equals(ledger.amount)) {
    return NextResponse.json({
      state: "RECONCILIATION_REQUIRED",
      withdrawalCode: request.code,
      ledgerFound: Boolean(ledger),
    }, { status: 409 });
  }

  return NextResponse.json({
    state: "COMMITTED",
    withdrawal: {
      id: request.id,
      code: request.code,
      amount: String(request.amount),
      status: request.status,
      requestedAt: request.requestedAt,
      processedAt: request.processedAt,
    },
  });
}
