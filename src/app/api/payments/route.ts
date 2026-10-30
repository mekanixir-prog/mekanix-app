import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";

// POST /api/payments
// Records a payment against an invoice.
// - userId is derived from the session — NEVER from the request body (BOLA).
// - Only the customer who owns the job can pay their own invoice.
// - Status transitions to PAID happen ONLY here (after simulated gateway verify).
//
// ⚠️ PAYMENT SIMULATOR — 95% random success rate.
// In production, this endpoint should call the real payment gateway verify API.
// The simulator must not be used for real payments.
//
// SECURITY:
//   1. Auth required: requireAuth
//   2. Invoice ownership: session.userId === job.request.customer.userId
//   3. Amount server-authoritative: from invoice.total, NOT client
//   4. Race condition prevention: optimistic concurrency on invoice.status
//      - updateMany with where: { status: "SENT" } prevents double-payment
//      - If invoice already PAID, returns 409 Conflict
//   5. Job status: updateMany with where: { status: { not: "COMPLETED" } }
//      prevents re-completing an already completed job
//
// MIGRATION: Uses getDbForLib() instead of direct db import.

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  // Rate limit on payments
  const clientId = getClientId(req);
  const rl = await rateLimitAsync(
    `payment:${clientId}`,
    RATE_LIMITS.PAYMENT.max,
    RATE_LIMITS.PAYMENT.windowMs
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: "درخواست‌های پرداخت بیش از حد، بعداً دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { invoiceId, method } = body;
  if (typeof invoiceId !== "string" || !invoiceId) {
    return NextResponse.json({ error: "invoiceId الزامی است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const inv = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { job: { include: { request: { include: { customer: true } }, technician: true } } },
  });
  if (!inv) return NextResponse.json({ error: "فاکتور یافت نشد" }, { status: 404 });

  // Resolve payer from SESSION — server-authoritative
  if (session.role === "ADMIN") {
    // Admins can pay on behalf (rare); fall through with admin's userId
  } else if (session.role === "CUSTOMER") {
    // The customer paying must own this invoice's job's request
    const job = inv.job;
    if (!job || !job.request || !job.request.customer) {
      return NextResponse.json({ error: "نمی‌توان پرداخت‌کننده را تشخیص داد" }, { status: 400 });
    }
    if (job.request.customer.userId !== session.userId) {
      return NextResponse.json(
        { error: "شما مالک این فاکتور نیستید" },
        { status: 403 }
      );
    }
  } else {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  const userId = session.userId;
  if (!userId) return NextResponse.json({ error: "Unable to resolve payer" }, { status: 400 });

  // Check if invoice is already paid — prevent duplicate payment
  if (inv.status === "PAID") {
    return NextResponse.json(
      { error: "این فاکتور قبلاً پرداخت شده است", alreadyPaid: true, invoiceId },
      { status: 409 }
    );
  }

  // simulate processing — 95% success
  const ok = Math.random() > 0.05;
  const status = ok ? "SUCCEEDED" : "FAILED";
  const safeMethod = ["card", "wallet", "bank", "cash"].includes(method) ? method : "card";

  // Check if a payment record already exists for this invoice
  const existing = await db.payment.findUnique({ where: { invoiceId } });
  if (existing) {
    // Update existing payment record
    const updated = await db.payment.update({
      where: { id: existing.id },
      data: { status, method: safeMethod },
    });

    if (ok) {
      // Optimistic concurrency: only update invoice if it's still not PAID
      const invResult = await db.invoice.updateMany({
        where: { id: invoiceId, status: { not: "PAID" } },
        data: { status: "PAID" },
      });

      if (invResult.count > 0) {
        // Invoice was successfully marked PAID — now update job
        // Optimistic concurrency: only complete if not already COMPLETED
        await db.job.updateMany({
          where: { id: inv.jobId, status: { not: "COMPLETED" } },
          data: { status: "COMPLETED", completedAt: new Date() },
        });

        // Create warranty (catch — may already exist from duplicate)
        await db.warranty.create({ data: { jobId: inv.jobId, months: 6, active: true } }).catch(() => {});

        if (inv.job?.technician?.userId) {
          await db.notification.create({
            data: {
              userId: inv.job.technician.userId,
              type: "job_completed",
              title: "Payment received",
              body: `Invoice ${inv.code} paid — $${inv.total}`,
              category: "payment",
              link: "technician/earnings",
            },
          });
        }
      }
    }
    return NextResponse.json(updated);
  }

  // Create new payment record — amount from invoice.total (server-authoritative)
  const pay = await db.payment.create({
    data: {
      code: `PAY-${Math.floor(5000 + Math.random() * 4000)}`,
      invoiceId,
      userId,
      amount: inv.total, // server-authoritative — from invoice, NOT client
      currency: "USD",
      method: safeMethod,
      status,
    },
  });

  if (ok) {
    // Optimistic concurrency: only update invoice if it's still not PAID
    const invResult = await db.invoice.updateMany({
      where: { id: invoiceId, status: { not: "PAID" } },
      data: { status: "PAID" },
    });

    if (invResult.count > 0) {
      // Invoice was successfully marked PAID — now update job
      await db.job.updateMany({
        where: { id: inv.jobId, status: { not: "COMPLETED" } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });

      await db.warranty.create({ data: { jobId: inv.jobId, months: 6, active: true } }).catch(() => {});

      if (inv.job?.technician?.userId) {
        await db.notification.create({
          data: {
            userId: inv.job.technician.userId,
            type: "job_completed",
            title: "Payment received",
            body: `Invoice ${inv.code} paid — $${inv.total}`,
            category: "payment",
            link: "technician/earnings",
          },
        });
      }
    }
  }
  return NextResponse.json(pay);
}
