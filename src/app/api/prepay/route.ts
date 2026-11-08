import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";
import { recordPrepayAtomically } from "@/lib/prepay-atomic";
import { isSafeStoredIrrAmount, maskJobFinancialData } from "@/lib/money/financial-read-mask";
import { isCommittedPrepayConsistent } from "@/lib/prepay-reconciliation";

// Pre-service payment: customer pays inspection fee + travel fee.
// This activates chat/call with the mechanic.
// - 10% platform commission deducted immediately
// - Net amount credited to technician's wallet as PENDING (12h hold from job completion)
// - Job.prepayPaid = true, prepayPaidAt = now
// - Inspection fee differs for passenger vs heavy machinery
//
// ⚠️ PAYMENT SIMULATOR — in dev mode, any non-empty cardNumber succeeds.
// In production, this endpoint returns 404 (like auth/demo and gateway).
// Real payment processing should call Zarinpal/IDPay verify API.
//
// SECURITY FIXES (from D1 migration review):
//   1. Production guard: returns 404 in production
//   2. Auth required: caller must be authenticated
//   3. Job ownership: requireJobParticipant checks customer owns the job
//   4. Optimistic concurrency: updateMany with where: { prepayPaid: false }
//      prevents double-payment race condition
//   5. Amount server-authoritative: fees from technician profile, not client
//
// MIGRATION: Uses getDbForLib() instead of direct db import.


async function inspectPrepayEvidence(db: Awaited<ReturnType<typeof getDbForLib>>, job: any) {
  const [wallet, prepayTransaction, commissionTransaction, holdLedger, commissionLedger] = await Promise.all([
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
  const rows = [prepayTransaction, commissionTransaction, holdLedger, commissionLedger];
  return {
    wallet,
    recordCount: rows.filter(Boolean).length,
    consistent: isCommittedPrepayConsistent(
      job, wallet, prepayTransaction, commissionTransaction, holdLedger, commissionLedger,
    ),
  };
}

function isHeavyMachine(type: string): boolean {
  return type !== "CAR";
}

export async function POST(req: Request) {
  // Hard block in production — simulator must not process real payments
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // Require authentication
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const policyApproved = process.env.MEKANIX_PREPAY_POLICY_APPROVED === "true";
  const commissionRate = Number(process.env.MEKANIX_PREPAY_COMMISSION_RATE);
  if (!policyApproved || !Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 1) {
    return NextResponse.json(
      { error: "سیاست پیش‌پرداخت و کمیسیون هنوز تصویب و پیکربندی نشده است", code: "PREPAY_POLICY_UNAPPROVED" },
      { status: 503 },
    );
  }

  const body = await req.json();
  const { jobId, method, cardNumber, mobile } = body;
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  // Job ownership: caller must be a participant (customer who owns it, or admin)
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: {
      request: { include: { vehicle: true, customer: { include: { user: { select: PARTICIPANT_USER_SELECT } } } } },
      technician: { include: { wallet: true, user: { select: PARTICIPANT_USER_SELECT } } },
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // A paid marker without all four idempotent financial records is a legacy
  // partial-write state. Do not guess whether to credit again; surface it for
  // explicit reconciliation instead of silently claiming the wallet is correct.
  if (job.prepayPaid) {
    const evidence = await inspectPrepayEvidence(db, job);
    if (!evidence.consistent) {
      return NextResponse.json({
        error: "Pre-service payment requires financial reconciliation",
        reconciliationRequired: true,
        jobId: job.id,
        recordedFinancialRows: evidence.recordCount,
        expectedFinancialRows: 4,
      }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      alreadyPaid: true,
      job: maskJobFinancialData(job as unknown as Record<string, unknown>),
      amount: Number(job.inspectionFee) + Number(job.travelFee),
      commission: Number(job.platformCommission),
      net: Number(job.netEarnings),
    });
  }

  const tech = job.technician;
  if (!tech) return NextResponse.json({ error: "No technician assigned" }, { status: 400 });

  // Determine fee based on machine type (passenger CAR vs heavy)
  const machineType = job.request.vehicle.type;
  const heavy = isHeavyMachine(machineType);
  const inspectionFeeRaw = heavy ? tech.inspectionFeeHeavy : tech.inspectionFee;
  const travelFeeRaw = tech.travelFeeBase;
  if (tech.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(inspectionFeeRaw) || !isSafeStoredIrrAmount(travelFeeRaw)) {
    return NextResponse.json({ error: "تعرفه‌های مکانیک هنوز از نظر منشأ و واحد ریال تأیید نشده‌اند", code: "TECHNICIAN_FEE_PROVENANCE_UNVERIFIED" }, { status: 409 });
  }
  const inspectionFee = Number(inspectionFeeRaw);
  const travelFee = Number(travelFeeRaw);
  const gross = inspectionFee + travelFee;
  const commission = gross * commissionRate;
  const net = gross - commission;
  if (![inspectionFee, travelFee, gross, commission, net].every(isSafeStoredIrrAmount)) {
    return NextResponse.json({ error: "مبالغ پیش‌پرداخت باید اعداد صحیح امن ریالی باشند؛ گردکردن خودکار انجام نمی‌شود", code: "PREPAY_AMOUNT_NOT_INTEGER_IRR" }, { status: 409 });
  }

  // Simulate gateway success (in production: call Zarinpal/IDPay verify here)
  if (!cardNumber && method === "card") {
    return NextResponse.json({ error: "Card number required" }, { status: 400 });
  }

  // Record the paid marker, wallet transactions, ledger and aggregates atomically.
  // A concurrent request that loses the Job transition does not create financial rows.
  const paidAt = new Date();
  const recorded = await recordPrepayAtomically(db, {
    jobId: job.id,
    jobCode: job.code,
    technicianId: tech.id,
    gross,
    commission,
    net,
    inspectionFee,
    travelFee,
    paidAt,
    machineLabel: heavy ? "heavy" : "passenger",
  });

  if (!recorded) {
    const currentJob = await db.job.findUnique({ where: { id: jobId } });
    if (currentJob?.prepayPaid) {
      const evidence = await inspectPrepayEvidence(db, currentJob);
      if (!evidence.consistent) {
        return NextResponse.json({
          error: "Pre-service payment requires financial reconciliation",
          reconciliationRequired: true,
          jobId: currentJob.id,
          recordedFinancialRows: evidence.recordCount,
          expectedFinancialRows: 4,
        }, { status: 409 });
      }
      return NextResponse.json({
        ok: true,
        alreadyPaid: true,
        job: maskJobFinancialData(currentJob as unknown as Record<string, unknown>),
        amount: Number(currentJob.inspectionFee) + Number(currentJob.travelFee),
        commission: Number(currentJob.platformCommission),
        net: Number(currentJob.netEarnings),
      });
    }
    return NextResponse.json({ error: "Pre-service payment could not be recorded; retry safely" }, { status: 409 });
  }

  // Re-fetch with includes for the response after the financial transaction commits.
  const updatedJob = await db.job.findUnique({
    where: { id: jobId },
    include: {
      request: { include: { vehicle: true, customer: { include: { user: { select: PARTICIPANT_USER_SELECT } } } } },
      technician: { include: { user: { select: PARTICIPANT_USER_SELECT }, specialties: true } },
      parts: true,
      diagnosisRecords: true,
      invoice: true,
      reviews: true,
      messages: { include: { fromUser: { select: PARTICIPANT_USER_SELECT } }, orderBy: { createdAt: "asc" } },
      tracking: { orderBy: { ts: "asc" } },
    },
  });

  // Notifications are intentionally best-effort: a notification outage must
  // never turn a committed financial transaction into an apparent payment failure.
  try {
    await db.notification.create({
      data: {
        userId: job.request.customer.user.id,
        type: "payment_required",
        title: "Pre-service payment received",
        body: `Chat & call with ${tech.user.name} is now active for ${job.code}`,
        category: "payment",
        link: "customer/track",
      },
    });
    await db.notification.create({
      data: {
        userId: tech.userId,
        type: "payment_required",
        title: "Pre-service payment received",
        body: `${job.code} — customer paid inspection + travel fee. You can start moving now.`,
        category: "payment",
        link: "technician/requests",
      },
    });
    await db.message.create({
      data: {
        jobId: job.id,
        fromUserId: job.request.customer.user.id,
        kind: "system",
        body: "Pre-service payment received — chat unlocked.",
      },
    });
  } catch (notificationError) {
    console.error("[prepay] financial commit succeeded but notification delivery failed", notificationError);
  }

  return NextResponse.json({ ok: true, job: maskJobFinancialData(updatedJob as unknown as Record<string, unknown>), amount: gross, commission, net });
}
