import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";
import { isCommittedPrepayConsistent } from "@/lib/prepay-reconciliation";

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
      technicianId: true,
      financialUnitStatus: true,
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

  const [wallet, prepayTxn, commissionTxn, holdLedger, commissionLedger] = await Promise.all([
    db.wallet.findUnique({
      where: { technicianId: job.technicianId },
      select: {
        id: true, financialUnitStatus: true, balance: true, pendingBalance: true,
        totalEarned: true, totalCommission: true, totalWithdrawn: true,
      },
    }),
    db.walletTransaction.findUnique({ where: { idempotencyKey: `prepay:${job.id}:PREPAY` } }),
    db.walletTransaction.findUnique({ where: { idempotencyKey: `prepay:${job.id}:COMMISSION` } }),
    db.walletLedger.findUnique({ where: { idempotencyKey: `prepay:${job.id}:LEDGER_HOLD` } }),
    db.walletLedger.findUnique({ where: { idempotencyKey: `prepay:${job.id}:LEDGER_COMMISSION` } }),
  ]);

  const records = [prepayTxn, commissionTxn, holdLedger, commissionLedger];
  const recordCount = records.filter(Boolean).length;
  const consistent = isCommittedPrepayConsistent(
    job, wallet, prepayTxn, commissionTxn, holdLedger, commissionLedger,
  );
  if (consistent) {
    return NextResponse.json({
      state: "COMMITTED",
      prepay: {
        jobId: job.id,
        jobCode: job.code,
        paidAt: job.prepayPaidAt,
        inspectionFee: String(job.inspectionFee),
        travelFee: String(job.travelFee),
        commission: String(job.platformCommission),
        net: String(job.netEarnings),
        financialUnitStatus: job.financialUnitStatus,
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
