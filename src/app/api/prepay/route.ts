import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";

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

const COMMISSION_RATE = 0.10; // 10% platform cut
const HOLD_HOURS = 12; // 12-hour hold from job completion

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
      request: { include: { vehicle: true, customer: { include: { user: true } } } },
      technician: { include: { wallet: true, user: true } },
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Idempotency: if already paid, return current state
  if (job.prepayPaid) {
    return NextResponse.json({
      ok: true,
      alreadyPaid: true,
      job,
      amount: Number(job.inspectionFee ?? 0) + Number(job.travelFee ?? 0),
      commission: Number(job.platformCommission ?? 0),
      net: Number(job.netEarnings ?? 0),
    });
  }

  const tech = job.technician;
  if (!tech) return NextResponse.json({ error: "No technician assigned" }, { status: 400 });

  // Determine fee based on machine type (passenger CAR vs heavy)
  const machineType = job.request.vehicle.type;
  const heavy = isHeavyMachine(machineType);
  const inspectionFee = Number(heavy ? tech.inspectionFeeHeavy : tech.inspectionFee);
  const travelFee = Number(tech.travelFeeBase);
  const gross = inspectionFee + travelFee;
  const commission = gross * COMMISSION_RATE;
  const net = gross - commission;

  // Simulate gateway success (in production: call Zarinpal/IDPay verify here)
  if (!cardNumber && method === "card") {
    return NextResponse.json({ error: "Card number required" }, { status: 400 });
  }

  // 1. Update job: mark prepay paid with optimistic concurrency check
  //    where: { prepayPaid: false } prevents double-payment race condition
  //    If another request already set prepayPaid=true, updateMany returns count=0
  const result = await db.job.updateMany({
    where: { id: jobId, prepayPaid: false },
    data: {
      prepayPaid: true,
      prepayPaidAt: new Date(),
      inspectionFee,
      travelFee,
      platformCommission: commission,
      netEarnings: net,
      holdUntil: null, // set when job completes
    },
  });

  if (result.count === 0) {
    // Race condition: another request paid first
    return NextResponse.json({
      ok: true,
      alreadyPaid: true,
      message: "Pre-service payment already paid (concurrent request)",
    });
  }

  // Re-fetch with includes for response
  const updatedJob = await db.job.findUnique({
    where: { id: jobId },
    include: {
      request: { include: { vehicle: true, customer: { include: { user: true } } } },
      technician: { include: { user: true, specialties: true } },
      parts: true,
      diagnosisRecords: true,
      invoice: true,
      reviews: true,
      messages: { include: { fromUser: true }, orderBy: { createdAt: "asc" } },
      tracking: { orderBy: { ts: "asc" } },
    },
  });

  // 2. Create / fetch wallet, record transaction
  let wallet = tech.wallet;
  if (!wallet) {
    wallet = await db.wallet.create({ data: { technicianId: tech.id } });
  }

  // 3. Record PREPAY transaction (PENDING until job completes)
  await db.walletTransaction.create({
    data: {
      walletId: wallet.id,
      jobId: job.id,
      kind: "PREPAY",
      status: "PENDING",
      grossAmount: gross,
      commissionAmount: commission,
      netAmount: net,
      holdUntil: null,
      description: `Pre-service payment — ${job.code} (${heavy ? "heavy" : "passenger"})`,
    },
  });

  // 4. Separate commission txn (for audit clarity)
  await db.walletTransaction.create({
    data: {
      walletId: wallet.id,
      jobId: job.id,
      kind: "COMMISSION",
      status: "COMPLETED",
      grossAmount: 0,
      commissionAmount: commission,
      netAmount: -commission,
      description: `Platform commission (10%) — ${job.code}`,
    },
  });

  // 5. Update wallet aggregates
  await db.wallet.update({
    where: { id: wallet.id },
    data: {
      pendingBalance: { increment: net },
      totalEarned: { increment: gross },
      totalCommission: { increment: commission },
    },
  });

  // 6. Notify customer + mechanic, system message
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

  return NextResponse.json({ ok: true, job: updatedJob, amount: gross, commission, net });
}
