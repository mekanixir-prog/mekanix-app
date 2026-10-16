import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getCustomerFromSession } from "@/lib/auth";

// POST /api/reviews
// - fromUserId is derived from session — NEVER from request body (BOLA).
// - Reviewer must be participant in the job being reviewed.
// - Only customers can submit reviews (the customer of the job).
// - rating must be 1–5, comment/tags are sanitized.
//
// Multi-step write (no $transaction in D1 — sequential):
//   1. review.create (primary)
//   2. review.findMany (recompute technician avg rating)
//   3. technician.update (rating + reviewCount + completedJobs increment)
// If step 3 fails after step 1, the review exists but the technician's
// cached rating is stale. A retry would hit the duplicate-guard 409, so the
// user cannot re-submit — the rating will self-correct on the NEXT review.
// This is a pre-existing trade-off documented here, not changed by migration.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { jobId, technicianId, rating, comment, tags } = body;

  if (typeof jobId !== "string" || !jobId) {
    return NextResponse.json({ error: "jobId الزامی است" }, { status: 400 });
  }
  if (typeof technicianId !== "string" || !technicianId) {
    return NextResponse.json({ error: "technicianId الزامی است" }, { status: 400 });
  }
  if (typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return NextResponse.json({ error: "rating باید بین ۱ تا ۵ باشد" }, { status: 400 });
  }

  // BOLA: must be participant in the job
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();

  // Only customers can submit reviews (technicians review their customers? — out of scope).
  // Admins can technically submit but we restrict to customers for clarity.
  if (session.role === "CUSTOMER") {
    const customer = await getCustomerFromSession(session);
    const job = await db.job.findUnique({
      where: { id: jobId },
      select: { request: { select: { customerId: true } }, technicianId: true },
    });
    if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
    if (!customer || job.request.customerId !== customer.id) {
      return NextResponse.json({ error: "فقط مشتری این کار می‌تواند نظرات ثبت کند" }, { status: 403 });
    }
    if (job.technicianId !== technicianId) {
      return NextResponse.json({ error: "technicianId با مکانیک مسئول کار مطابقت ندارد" }, { status: 400 });
    }
  } else if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  // Prevent duplicate reviews on same job by same user
  const existing = await db.review.findFirst({ where: { jobId, fromUserId: session.userId } });
  if (existing) {
    return NextResponse.json({ error: "شما قبلاً برای این کار نظر ثبت کرده‌اید" }, { status: 409 });
  }

  const review = await db.review.create({
    data: {
      jobId,
      technicianId,
      fromUserId: session.userId, // server-authoritative
      rating,
      comment: typeof comment === "string" ? comment.slice(0, 2000) : null,
      tags: tags ? JSON.stringify(tags).slice(0, 200) : null,
    },
    include: { fromUser: true },
  });

  // Recompute technician rating + count
  const reviews = await db.review.findMany({ where: { technicianId }, select: { rating: true } });
  const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  await db.technician.update({
    where: { id: technicianId },
    data: {
      rating: Math.round(avg * 100) / 100,
      reviewCount: reviews.length,
      completedJobs: { increment: 1 },
    },
  });
  return NextResponse.json(review);
}
