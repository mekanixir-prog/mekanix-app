import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";

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
    },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });

  const [prepayTxn, commissionTxn, holdLedger, commissionLedger] = await Promise.all([
    db.walletTransaction.findUnique({ where: { idempotencyKey: `prepay:${job.id}:PREPAY` }, select: { id: true } }),
    db.walletTransaction.findUnique({ where: { idempotencyKey: `prepay:${job.id}:COMMISSION` }, select: { id: true } }),
    db.walletLedger.findUnique({ where: { idempotencyKey: `prepay:${job.id}:LEDGER_HOLD` }, select: { id: true } }),
    db.walletLedger.findUnique({ where: { idempotencyKey: `prepay:${job.id}:LEDGER_COMMISSION` }, select: { id: true } }),
  ]);

  const recordCount = [prepayTxn, commissionTxn, holdLedger, commissionLedger].filter(Boolean).length;
  if (job.prepayPaid && recordCount === 4) {
    return NextResponse.json({
      state: "COMMITTED",
      prepay: {
        jobId: job.id,
        jobCode: job.code,
        paidAt: job.prepayPaidAt,
        inspectionFee: String(job.inspectionFee ?? 0),
        travelFee: String(job.travelFee ?? 0),
        commission: String(job.platformCommission ?? 0),
        net: String(job.netEarnings ?? 0),
      },
    });
  }

  if (!job.prepayPaid && recordCount === 0) {
    return NextResponse.json({ state: "NOT_COMMITTED", jobId: job.id });
  }

  return NextResponse.json({
    state: "RECONCILIATION_REQUIRED",
    jobId: job.id,
    recordedFinancialRows: recordCount,
    expectedFinancialRows: 4,
  }, { status: 409 });
}
