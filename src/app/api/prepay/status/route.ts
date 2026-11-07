import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";
import { maskFinancialFields } from "@/lib/money/financial-read-mask";
import { validatePrepayRecordSet } from "@/lib/prepay-reconciliation";

// Read-only reconciliation lookup. It verifies the job marker and all
// four financial records written by recordPrepayAtomically().
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  if (!["CUSTOMER", "TECHNICIAN", "ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "دسترسی به وضعیت پرداخت مجاز نیست" }, { status: 403 });
  }

  const jobId = new URL(req.url).searchParams.get("jobId")?.trim() ?? "";
  if (!jobId || jobId.length > 128) {
    return NextResponse.json({ error: "شناسه کار نامعتبر است" }, { status: 400 });
  }

  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      code: true,
      prepayPaid: true,
      prepayPaidAt: true,
      inspectionFee: true,
      travelFee: true,
      platformCommission: true,
      netEarnings: true,
      financialUnitStatus: true,
    },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });

  const safeJob = maskFinancialFields(job as unknown as Record<string, unknown>, [
    "inspectionFee", "travelFee", "platformCommission", "netEarnings",
  ]);

  const [prepayTxn, commissionTxn, holdLedger, commissionLedger] = await Promise.all([
    db.walletTransaction.findUnique({
      where: { idempotencyKey: `prepay:${job.id}:PREPAY` },
      select: { id: true, walletId: true, jobId: true, kind: true, status: true, grossAmount: true, commissionAmount: true, netAmount: true, idempotencyKey: true, financialUnitStatus: true },
    }),
    db.walletTransaction.findUnique({
      where: { idempotencyKey: `prepay:${job.id}:COMMISSION` },
      select: { id: true, walletId: true, jobId: true, kind: true, status: true, grossAmount: true, commissionAmount: true, netAmount: true, idempotencyKey: true, financialUnitStatus: true },
    }),
    db.walletLedger.findUnique({
      where: { idempotencyKey: `prepay:${job.id}:LEDGER_HOLD` },
      select: { id: true, walletId: true, type: true, amount: true, balanceBefore: true, balanceAfter: true, referenceType: true, referenceId: true, idempotencyKey: true, financialUnitStatus: true },
    }),
    db.walletLedger.findUnique({
      where: { idempotencyKey: `prepay:${job.id}:LEDGER_COMMISSION` },
      select: { id: true, walletId: true, type: true, amount: true, balanceBefore: true, balanceAfter: true, referenceType: true, referenceId: true, idempotencyKey: true, financialUnitStatus: true },
    }),
  ]);

  const recordCount = [prepayTxn, commissionTxn, holdLedger, commissionLedger].filter(Boolean).length;
  if (job.prepayPaid && recordCount === 4) {
    const reconciliation = validatePrepayRecordSet({
      job,
      prepayTransaction: prepayTxn,
      commissionTransaction: commissionTxn,
      holdLedger,
      commissionLedger,
    });
    if (!reconciliation.ok) {
      return NextResponse.json({
        state: "RECONCILIATION_REQUIRED",
        jobId: job.id,
        recordedFinancialRows: recordCount,
        expectedFinancialRows: 4,
        reason: reconciliation.reason,
      }, { status: 409 });
    }
    return NextResponse.json({
      state: "COMMITTED",
      prepay: {
        jobId: job.id,
        jobCode: job.code,
        paidAt: job.prepayPaidAt,
        inspectionFee: safeJob.inspectionFee == null ? null : String(safeJob.inspectionFee),
        travelFee: safeJob.travelFee == null ? null : String(safeJob.travelFee),
        commission: safeJob.platformCommission == null ? null : String(safeJob.platformCommission),
        net: safeJob.netEarnings == null ? null : String(safeJob.netEarnings),
        financialUnitStatus: safeJob.financialUnitStatus,
      },
    });
  }

  if (!job.prepayPaid && recordCount === 0) {
    return NextResponse.json({
      state: "NOT_COMMITTED",
      jobId: job.id,
      // Prepay remains a simulator-only route until issue #24 is completed.
      retryAllowed: process.env.NODE_ENV !== "production",
    });
  }

  return NextResponse.json({
    state: "RECONCILIATION_REQUIRED",
    jobId: job.id,
    recordedFinancialRows: recordCount,
    expectedFinancialRows: 4,
  }, { status: 409 });
}
