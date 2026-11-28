import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getCustomerFromSession } from "@/lib/auth";

// POST /api/reviews
// Only the owning customer may review the assigned technician after a job is
// completed and customer-approved. The database unique key on (jobId, fromUserId)
// is the final concurrency guard; P2002 is normalized to a 409 response.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  if (session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "فقط مشتری این کار می‌تواند نظر ثبت کند" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const { jobId, technicianId, rating } = input;
  if (typeof jobId !== "string" || !jobId.trim() || jobId.length > 128) {
    return NextResponse.json({ error: "jobId الزامی است" }, { status: 400 });
  }
  if (typeof technicianId !== "string" || !technicianId.trim() || technicianId.length > 128) {
    return NextResponse.json({ error: "technicianId الزامی است" }, { status: 400 });
  }
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "rating باید بین ۱ تا ۵ باشد" }, { status: 400 });
  }

  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const customer = await getCustomerFromSession(session);
  if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });

  const db = await getDbForLib();
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      status: true,
      customerApproved: true,
      request: { select: { customerId: true } },
      technicianId: true,
    },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
  if (job.request.customerId !== customer.id) {
    return NextResponse.json({ error: "فقط مشتری این کار می‌تواند نظر ثبت کند" }, { status: 403 });
  }
  if (job.status !== "COMPLETED" || job.customerApproved !== true) {
    return NextResponse.json({ error: "ثبت نظر پس از تکمیل و تأیید کار امکان‌پذیر است", code: "REVIEW_JOB_NOT_COMPLETED" }, { status: 409 });
  }
  if (job.technicianId !== technicianId) {
    return NextResponse.json({ error: "technicianId با مکانیک مسئول کار مطابقت ندارد" }, { status: 400 });
  }

  const existing = await db.review.findFirst({ where: { jobId, fromUserId: session.userId } });
  if (existing) {
    return NextResponse.json({ error: "شما قبلاً برای این کار نظر ثبت کرده‌اید" }, { status: 409 });
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 10).map((tag) => tag.slice(0, 30))
    : [];
  let review;
  try {
    review = await db.review.create({
      data: {
        jobId,
        technicianId,
        fromUserId: session.userId,
        rating,
        comment: typeof input.comment === "string" ? input.comment.slice(0, 2000) : null,
        tags: tags.length ? JSON.stringify(tags) : null,
      },
      include: { fromUser: { select: PARTICIPANT_USER_SELECT } },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "شما قبلاً برای این کار نظر ثبت کرده‌اید" }, { status: 409 });
    }
    throw error;
  }

  const reviews = await db.review.findMany({ where: { technicianId }, select: { rating: true } });
  const avg = reviews.reduce((sum, item) => sum + item.rating, 0) / Math.max(1, reviews.length);
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
