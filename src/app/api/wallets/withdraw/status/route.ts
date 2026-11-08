import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { isSafeStoredIrrAmount, maskFinancialFields } from "@/lib/money/financial-read-mask";

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
    select: { id: true, financialUnitStatus: true },
  });
  const [request, ledger] = await Promise.all([
    db.withdrawalRequest.findUnique({
      where: { idempotencyKey: key },
      select: {
        id: true,
        walletId: true,
        code: true,
        amount: true,
        financialUnitStatus: true,
        status: true,
        requestedAt: true,
        processedAt: true,
      },
    }),
    db.walletLedger.findUnique({
      where: { idempotencyKey: `withdrawal:${key}:LEDGER` },
      select: { id: true, walletId: true, type: true, amount: true, balanceBefore: true, balanceAfter: true, referenceType: true, referenceId: true, financialUnitStatus: true },
    }),
  ]);

  if (!request && !ledger) return NextResponse.json({ state: "NOT_COMMITTED" });
  if (!wallet) {
    return NextResponse.json({
      state: "RECONCILIATION_REQUIRED",
      requestFound: Boolean(request),
      ledgerFound: Boolean(ledger),
    }, { status: 409 });
  }
  if (!request && ledger) {
    return NextResponse.json({
      state: "RECONCILIATION_REQUIRED",
      ledgerFound: true,
      requestFound: false,
    }, { status: 409 });
  }
  if (request!.walletId !== wallet.id) {
    return NextResponse.json({ state: "KEY_CONFLICT" }, { status: 409 });
  }

  // A matching amount is not enough: the wallet, request, and immutable ledger
  // must each carry an explicit IRR attestation and safe integer value.
  const requestAmount = request!.amount;
  const ledgerAmount = ledger?.amount;
  const financiallyVerified =
    wallet.financialUnitStatus === "VERIFIED_IRR" &&
    request!.financialUnitStatus === "VERIFIED_IRR" &&
    isSafeStoredIrrAmount(requestAmount) &&
    Number(requestAmount) > 0 &&
    ledger?.financialUnitStatus === "VERIFIED_IRR" &&
    ledger.walletId === wallet.id &&
    ledger.type === "WITHDRAWAL" &&
    ledger.referenceType === "Withdrawal" &&
    isSafeStoredIrrAmount(ledgerAmount) &&
    Number(ledgerAmount) === -Number(requestAmount) &&
    isSafeStoredIrrAmount(ledger.balanceBefore) &&
    isSafeStoredIrrAmount(ledger.balanceAfter) &&
    Number(ledger.balanceAfter) === Number(ledger.balanceBefore) + Number(ledgerAmount);
  if (!ledger || !financiallyVerified || ledger.referenceId !== request!.id) {
    return NextResponse.json({
      state: "RECONCILIATION_REQUIRED",
      withdrawalCode: request!.code,
      ledgerFound: Boolean(ledger),
      requestFound: true,
    }, { status: 409 });
  }

  const safeWithdrawal = maskFinancialFields(request!, ["amount"]);
  return NextResponse.json({
    state: "COMMITTED",
    withdrawal: {
      id: request!.id,
      code: request!.code,
      amount: safeWithdrawal.amount == null ? null : String(safeWithdrawal.amount),
      financialUnitStatus: safeWithdrawal.financialUnitStatus,
      status: request!.status,
      requestedAt: request!.requestedAt,
      processedAt: request!.processedAt,
    },
  });
}
