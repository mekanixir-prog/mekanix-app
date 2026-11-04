import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { maskJobFinancialData } from "@/lib/money/financial-read-mask";
import {
  assignServiceRequestAtomically,
  ServiceRequestAssignmentConflictError,
} from "@/lib/service-request-assignment";

const include = {
  request: { include: { customer: { include: { user: { select: PARTICIPANT_USER_SELECT } } }, vehicle: true } },
  technician: { include: { user: { select: PARTICIPANT_USER_SELECT }, specialties: true } },
  parts: true,
  diagnosisRecords: true,
  invoice: true,
  reviews: true,
  messages: { include: { fromUser: { select: PARTICIPANT_USER_SELECT } }, orderBy: { createdAt: "asc" } },
  tracking: { orderBy: { ts: "asc" } },
} as const;

// POST /api/service-requests/[id]/assign
// Customer (owner) or admin assigns an eligible technician to an OPEN request.
// The request claim, technician claim, and Job creation are one atomic operation.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه JSON نامعتبر است" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  const technicianId = (body as Record<string, unknown>).technicianId;
  if (typeof technicianId !== "string" || !technicianId.trim() || technicianId.length > 128) {
    return NextResponse.json({ error: "شناسه مکانیک معتبر الزامی است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const sr = await db.serviceRequest.findUnique({
    where: { id },
    include: { vehicle: true, job: { select: { id: true, status: true } } },
  });
  if (!sr) return NextResponse.json({ error: "درخواست یافت نشد" }, { status: 404 });

  // BOLA: customer must own the request, or be admin.
  if (session.role === "CUSTOMER") {
    const customer = await db.customer.findUnique({ where: { userId: session.userId } });
    if (!customer || sr.customerId !== customer.id) {
      return NextResponse.json({ error: "شما مالک این درخواست نیستید" }, { status: 403 });
    }
  } else if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  // A rejected Job is the previous technician attempt for this same request.
  // Reuse that Job row when assigning a replacement technician; Job.requestId is unique.
  if (
    sr.status !== "OPEN" ||
    sr.matchedTechId !== null ||
    (sr.job && sr.job.status !== "REJECTED")
  ) {
    return NextResponse.json({ error: "این درخواست دیگر باز یا قابل تخصیص نیست" }, { status: 409 });
  }

  const tech = await db.technician.findUnique({
    where: { id: technicianId },
    include: { user: { select: PARTICIPANT_USER_SELECT }, specialties: true },
  });
  if (!tech) return NextResponse.json({ error: "مکانیک یافت نشد" }, { status: 404 });

  const eligible =
    tech.verified &&
    tech.status === "ONLINE" &&
    tech.availableNow &&
    tech.user.status === "ACTIVE" &&
    tech.user.role === "TECHNICIAN" &&
    tech.specialties.some((specialty) => specialty.category === sr.category);

  if (!eligible) {
    return NextResponse.json(
      { error: "این مکانیک تأییدشده، آنلاین، آزاد یا دارای تخصص مرتبط نیست" },
      { status: 409 },
    );
  }

  // Compute ETA from distance. Null coordinates use a conservative fallback;
  // zero is a valid latitude/longitude and must not be treated as missing.
  const techLat = tech.lat;
  const techLng = tech.lng;
  const requestLat = sr.lat;
  const requestLng = sr.lng;
  const hasCoordinates =
    techLat !== null && techLng !== null && requestLat !== null && requestLng !== null;
  const km = hasCoordinates
    ? (() => {
        const R = 6371;
        const dLat = ((requestLat - techLat) * Math.PI) / 180;
        const dLng = ((requestLng - techLng) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((techLat * Math.PI) / 180) *
            Math.cos((requestLat * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
      })()
    : 10;
  const etaMins = Math.max(5, Math.round((km / 35) * 60) + tech.responseMins);

  try {
    await assignServiceRequestAtomically(db, {
      requestId: id,
      technicianId: tech.id,
      category: sr.category,
      etaMins,
      existingRejectedJobId: sr.job?.status === "REJECTED" ? sr.job.id : null,
    });
  } catch (error) {
    if (error instanceof ServiceRequestAssignmentConflictError) {
      return NextResponse.json(
        { error: "درخواست یا مکانیک هم‌زمان توسط عملیات دیگری تخصیص یافته است؛ وضعیت را تازه‌سازی کنید" },
        { status: 409 },
      );
    }
    throw error;
  }

  const job = await db.job.findUnique({ where: { requestId: id }, include });
  if (!job) throw new Error("Assignment committed but the created job could not be loaded");

  // Notification is a post-commit best-effort side effect. A notification
  // outage must not turn a successful assignment into an apparent API failure.
  try {
    await db.notification.create({
      data: {
        userId: tech.userId,
        type: "new_request",
        title: "New job assigned",
        body: `${job.code} — ${sr.title}. ETA to customer ${etaMins} min.`,
        category: "job",
        link: "technician/requests",
      },
    });
  } catch (error) {
    // Assignment and Job are already committed; do not report a false assignment failure.
    console.error(
      "[service-request-assign] technician notification failed",
      error instanceof Error ? error.message : "unknown error",
    );
  }

  return NextResponse.json(maskJobFinancialData(job));
}
