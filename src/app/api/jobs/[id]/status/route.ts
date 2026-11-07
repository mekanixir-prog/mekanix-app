import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import type { JobStatus as PrismaJobStatus } from "@prisma/client";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";
import { calculatePrice } from "@/lib/pricing";
import { maskJobFinancialData } from "@/lib/money/financial-read-mask";
import { areJobPartPriceSourcesVerified } from "@/lib/money/provenance";
import { estimateTravelDistanceKm, serviceCodeFromCategory } from "@/lib/job-invoice-pricing";
import {
  type AtomicInvoiceInput,
  JobStatusConflictError,
  transitionJobStatusAtomically,
} from "@/lib/job-status-atomic";

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

// 12-hour hold from job completion before funds become withdrawable
const HOLD_HOURS = 12;

// ──────────── Job State Machine ────────────
// Per-role allowed transitions. The current job status must be one of
// `from[]` for the transition into `to` to be valid for that role.

type Status =
  | "REQUESTED" | "ACCEPTED" | "EN_ROUTE" | "ARRIVED" | "DIAGNOSING"
  | "REPAIRING" | "WAITING_APPROVAL" | "COMPLETED" | "CANCELLED" | "REJECTED";

const TECH_TRANSITIONS: { to: Status; from: Status[] }[] = [
  { to: "ACCEPTED", from: ["REQUESTED"] },
  { to: "EN_ROUTE", from: ["ACCEPTED"] },
  { to: "ARRIVED", from: ["EN_ROUTE", "ACCEPTED"] },
  { to: "DIAGNOSING", from: ["ARRIVED", "EN_ROUTE", "ACCEPTED"] },
  { to: "REPAIRING", from: ["DIAGNOSING", "WAITING_APPROVAL"] },
  { to: "WAITING_APPROVAL", from: ["REPAIRING"] },
  { to: "COMPLETED", from: ["REPAIRING"] },
  { to: "REJECTED", from: ["REQUESTED"] },
];

// Customer transitions:
//  - CANCEL only before technician arrives (REQUESTED, ACCEPTED, EN_ROUTE)
//  - APPROVE_REPAIR (customerApproved=true) only when WAITING_APPROVAL
const CUSTOMER_CANCEL_FROM: Status[] = ["REQUESTED", "ACCEPTED", "EN_ROUTE"];

function isAllowedTransition(
  role: "CUSTOMER" | "TECHNICIAN" | "ADMIN" | "FLEET_MANAGER" | "PARTNER",
  currentStatus: string,
  nextStatus: string,
  customerApproved: boolean | undefined
): boolean {
  if (role === "ADMIN") return true;

  // FLEET_MANAGER behaves like a customer for the job-status state machine
  // (can cancel pre-service and approve repair estimates for fleet vehicles).
  // PARTNER is read-only and cannot transition anything.
  const actsAsCustomer = role === "CUSTOMER" || role === "FLEET_MANAGER";
  if (role === "PARTNER") return false;

  // Special: customer setting customerApproved=true (approve repair)
  if (actsAsCustomer) {
    if (customerApproved === true) {
      return currentStatus === "WAITING_APPROVAL" && nextStatus === currentStatus;
    }
    if (nextStatus === "CANCELLED") {
      return CUSTOMER_CANCEL_FROM.includes(currentStatus as Status);
    }
    return false;
  }

  if (role === "TECHNICIAN") {
    const rule = TECH_TRANSITIONS.find((t) => t.to === (nextStatus as Status));
    if (!rule) return false;
    return rule.from.includes(currentStatus as Status);
  }
  return false;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  // BOLA: must be a job participant (or admin)
  const access = await requireJobParticipant(session, id);
  if (access) return access;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  const { status, ...extra } = body;
  const hasCustomerApproval = Object.prototype.hasOwnProperty.call(extra, "customerApproved");
  if (hasCustomerApproval && extra.customerApproved !== true) {
    return NextResponse.json(
      { error: "تأیید مشتری باید با مقدار Boolean واقعی true ارسال شود", code: "CUSTOMER_APPROVAL_INVALID" },
      { status: 400 },
    );
  }

  // Load the current job so we can validate the transition
  const db = await getDbForLib();
  const existing = await db.job.findUnique({
    where: { id },
    select: {
      status: true,
      customerApproved: true,
      updatedAt: true,
      technicianId: true,
      requestId: true,
      code: true,
      parts: { select: { unitPrice: true, quantity: true } },
      request: { select: { category: true, urgency: true, lat: true, lng: true, vehicle: { select: { type: true } } } },
      tracking: { orderBy: { ts: "asc" }, take: 1, select: { lat: true, lng: true } },
      invoice: { select: { id: true, currency: true, financialUnitStatus: true } },
    },
  });
  if (!existing) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });

  // For technicians, ensure they are the ASSIGNED technician (requireJobParticipant already checked)
  // For customers, ensure they own the request (requireJobParticipant already checked)

  if (hasCustomerApproval && session.role !== "CUSTOMER" && session.role !== "FLEET_MANAGER") {
    return NextResponse.json(
      { error: "فقط مشتری یا مدیر ناوگان می‌تواند برآورد تعمیر را تأیید کند", code: "CUSTOMER_APPROVAL_FORBIDDEN" },
      { status: 403 },
    );
  }

  const customerApproved = hasCustomerApproval ? true : undefined;

  // The estimate is a hard consent gate: no actor may start or complete work
  // from WAITING_APPROVAL until the customer has accepted the estimate.
  const targetStatus = status ?? existing.status;
  if (targetStatus === "REPAIRING" && !["DIAGNOSING", "WAITING_APPROVAL"].includes(existing.status)) {
    return NextResponse.json(
      { error: "برای ورود به مرحله تعمیر، ابتدا باید عیب‌یابی انجام شود و پیش‌فاکتور در مسیر مجاز بررسی شود", code: "REPAIR_ESTIMATE_REQUIRED" },
      { status: 409 },
    );
  }
  const hasVerifiedEstimate = existing.invoice?.currency === "IRR" &&
    existing.invoice.financialUnitStatus === "VERIFIED_IRR";

  if (targetStatus === "REPAIRING" && existing.status === "WAITING_APPROVAL" && !hasVerifiedEstimate) {
    return NextResponse.json(
      { error: "پیش‌فاکتور معتبر با واحد ریال تأییدشده برای این کار یافت نشد", code: "REPAIR_ESTIMATE_REQUIRED" },
      { status: 409 },
    );
  }
  if (targetStatus === "REPAIRING" && existing.status === "DIAGNOSING" && existing.invoice) {
    return NextResponse.json(
      { error: "این کار پیش‌فاکتور صادرشده دارد؛ تأیید مشتری باید از مسیر بررسی برآورد ثبت شود", code: "CUSTOMER_APPROVAL_REQUIRED" },
      { status: 409 },
    );
  }
  if (targetStatus === "REPAIRING" && existing.status === "WAITING_APPROVAL" && existing.customerApproved !== true) {
    return NextResponse.json(
      { error: "شروع تعمیر تا زمان تأیید پیش‌فاکتور توسط مشتری مجاز نیست", code: "CUSTOMER_APPROVAL_REQUIRED" },
      { status: 409 },
    );
  }
  if (existing.status === "WAITING_APPROVAL" && targetStatus === "COMPLETED") {
    return NextResponse.json(
      { error: "کار نمی‌تواند پیش از شروع و تأیید برآورد تکمیل شود", code: "REPAIR_NOT_STARTED" },
      { status: 409 },
    );
  }

  if (targetStatus === "COMPLETED" && existing.status === "REPAIRING" && !hasVerifiedEstimate) {
    return NextResponse.json(
      { error: "تکمیل کار بدون پیش‌فاکتور معتبر و تأییدشده مجاز نیست", code: "REPAIR_ESTIMATE_REQUIRED" },
      { status: 409 },
    );
  }
  if (targetStatus === "COMPLETED" && existing.status === "REPAIRING" && existing.customerApproved !== true) {
    return NextResponse.json(
      { error: "تکمیل کار پیش از تأیید پیش‌فاکتور توسط مشتری مجاز نیست", code: "CUSTOMER_APPROVAL_REQUIRED" },
      { status: 409 },
    );
  }

  if (hasCustomerApproval && !hasVerifiedEstimate) {
    return NextResponse.json(
      { error: "برای تأیید مشتری، پیش‌فاکتور معتبر باید صادر شده باشد", code: "REPAIR_ESTIMATE_REQUIRED" },
      { status: 409 },
    );
  }

  // If neither status nor customerApproved is provided, nothing to do
  if (!status && customerApproved === undefined) {
    return NextResponse.json({ error: "status یا customerApproved الزامی است" }, { status: 400 });
  }

  // Validate state-machine transition
  const allowed = isAllowedTransition(session.role, existing.status, targetStatus, customerApproved);
  if (!allowed) {
    return NextResponse.json(
      { error: `انتقال مجاز نیست: ${existing.status} → ${targetStatus} برای نقش ${session.role}` },
      { status: 403 }
    );
  }

  // Capture the trusted technician profile ID and pass it into the atomic CAS.
  // The route-level check is for fast rejection; the database guard below is
  // what closes the reassignment race between authorization and mutation.
  const actorTechnician = session.role === "TECHNICIAN"
    ? await getTechnicianFromSession(session)
    : null;
  if (session.role === "TECHNICIAN" &&
      (!actorTechnician?.id || actorTechnician.id !== existing.technicianId)) {
    return NextResponse.json({ error: "فقط مکانیک مسئول این کار مجاز است" }, { status: 403 });
  }

  // Legacy laborHours input is ignored: labor is priced as a fixed service unit.

  let invoiceInput: AtomicInvoiceInput | null = null;
  if (status === "WAITING_APPROVAL" && !existing.invoice) {
    if (!existing.request?.vehicle?.type) {
      return NextResponse.json({ error: "نوع وسیله برای محاسبه تعرفه مشخص نیست", code: "VEHICLE_RATE_CLASS_REQUIRED" }, { status: 409 });
    }
    if (!areJobPartPriceSourcesVerified(existing.parts.length > 0)) {
      return NextResponse.json(
        { error: "واحد قیمت قطعات هنوز به ریال تطبیق داده نشده است؛ صدور پیش‌فاکتور پس از تأیید سوابق قطعات فعال می‌شود", code: "JOB_PART_CURRENCY_UNVERIFIED" },
        { status: 409 },
      );
    }
    const partsTotal = existing.parts.reduce((sum, part) => {
      const unitPrice = Number(part.unitPrice);
      const quantity = Number(part.quantity);
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 0 ||
          !Number.isSafeInteger(quantity) || quantity < 0) return Number.NaN;
      const next = sum + unitPrice * quantity;
      return Number.isSafeInteger(next) ? next : Number.NaN;
    }, 0);
    if (!Number.isSafeInteger(partsTotal) || partsTotal < 0) {
      return NextResponse.json({ error: "مبلغ قطعات باید ریال صحیح و تأییدشده باشد", code: "PART_AMOUNT_UNVERIFIED" }, { status: 409 });
    }

    const serviceCode = serviceCodeFromCategory(existing.request.category);
    if (!serviceCode) {
      return NextResponse.json(
        { error: "دسته خدمت در نرخ‌نامه تعریف نشده است؛ پیش از تأیید برآورد باید خدمت به کد تعرفه متصل شود", code: "SERVICE_RATE_MAPPING_REQUIRED" },
        { status: 409 },
      );
    }
    const dispatchOrigin = existing.tracking[0];
    const travelDistanceKm = dispatchOrigin
      ? estimateTravelDistanceKm(
          { lat: dispatchOrigin.lat, lng: dispatchOrigin.lng },
          { lat: existing.request.lat, lng: existing.request.lng },
        )
      : 0;

    let pricing: Awaited<ReturnType<typeof calculatePrice>>;
    try {
      pricing = await calculatePrice({
        vehicleType: existing.request.vehicle.type,
        serviceCode,
        laborHours: 0,
        partsCost: partsTotal,
        travelDistanceKm,
        isEmergency: existing.request.urgency === "EMERGENCY",
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "محاسبه تعرفه ممکن نیست", code: "PRICING_NOT_AVAILABLE" },
        { status: 409 },
      );
    }

    invoiceInput = {
      id: crypto.randomUUID(),
      code: `INV-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      jobId: id,
      laborHours: 1,
      laborRate: pricing.labor,
      laborTotal: pricing.labor,
      partsTotal,
      travelFee: pricing.travel,
      inspectionFee: pricing.inspection,
      emergencyFee: pricing.emergency,
      subtotal: pricing.subtotal,
      taxRate: pricing.taxRate,
      taxTotal: pricing.taxTotal,
      discount: pricing.discount,
      total: pricing.total,
      currency: "IRR",
      pricingVersion: pricing.pricingVersion,
      financialUnitStatus: "VERIFIED_IRR",
      status: "SENT" as const,
      notes: `پیش‌فاکتور بر اساس نرخ‌نامه ثابت نسخه ${pricing.pricingVersion} و کد خدمت ${serviceCode} صادر شده است. مسافت تقریبی حرکت تکنسین ${travelDistanceKm} کیلومتر است و هزینه رفت‌وآمد در همین برآورد محاسبه شده؛ انجام تعمیر و دریافت وجه منوط به تأیید این پیش‌فاکتور توسط مشتری است. شرایط ضمانت تابع توافق‌نامه جداگانه و تأییدشده خدمت است.`,
    };
  }
  const holdUntil = status === "COMPLETED"
    ? new Date(Date.now() + HOLD_HOURS * 60 * 60 * 1000)
    : null;

  const updates: {
    startedAt?: Date;
    arrivedAt?: Date;
    completedAt?: Date;
    technicianNotes?: string;
    customerApproved?: boolean;
  } = {};
  if (status === "ACCEPTED") updates.startedAt = new Date();
  if (status === "ARRIVED") updates.arrivedAt = new Date();
  if (status === "COMPLETED") updates.completedAt = new Date();
  if (extra.technicianNotes != null) updates.technicianNotes = extra.technicianNotes;
  if (customerApproved !== undefined) updates.customerApproved = customerApproved;

  try {
    await transitionJobStatusAtomically(db, {
      jobId: id,
      requestId: existing.requestId,
      technicianId: existing.technicianId,
      actorRole: session.role === "ADMIN" ? "ADMIN"
        : session.role === "TECHNICIAN" ? "TECHNICIAN"
        : session.role === "FLEET_MANAGER" ? "FLEET_MANAGER" : "CUSTOMER",
      actorTechnicianId: actorTechnician?.id ?? null,
      invoice: invoiceInput,
      holdUntil,
      currentStatus: existing.status as PrismaJobStatus,
      expectedUpdatedAt: existing.updatedAt,
      nextStatus: (status ?? existing.status) as PrismaJobStatus,
      updates,
    });
  } catch (error) {
    if (error instanceof JobStatusConflictError) {
      return NextResponse.json(
        { error: "وضعیت کار یا درخواست هم‌زمان تغییر کرده است — لطفاً دوباره تلاش کنید" },
        { status: 409 },
      );
    }
    throw error;
  }

  // Fetch updated job with relations
  const job = await db.job.findUnique({ where: { id }, include });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
  const cust = job.request.customer.user;
  const tech = job.technician.user;

  // Financial state is already committed atomically; notifications are best-effort.
  if (status === "COMPLETED") {
    // Notifications and chat are best-effort after the financial state commit.
    try {
      await db.notification.create({
        data: {
          userId: cust.id,
          type: "job_completed",
          title: "کار تکمیل شد",
          body: `${tech.name} کار را تکمیل کرد. فاکتور آماده بررسی است.`,
          category: "job",
          link: "customer/invoice",
        },
      });
      await db.message.create({
        data: {
          jobId: job.id,
          fromUserId: tech.id,
          kind: "system",
          body: `کار تکمیل شد — ${job.code}`,
        },
      });
    } catch (error) {
      console.error("[jobs/status] Completion notification failed:", error);
    }
  } else {
    // Side-effects: notifications + system messages
    const notifMap: Record<string, { type: string; title: string; body: string; category: string; link: string }> = {
    ACCEPTED: {
      type: "request_accepted",
      title: "Technician accepted your request",
      body: `${tech.name} is preparing to depart — ETA ${job.etaMins} min`,
      category: "job",
      link: "customer/track",
    },
    EN_ROUTE: {
      type: "technician_arriving",
      title: "Technician en route",
      body: `${tech.name} is on the way to your location`,
      category: "job",
      link: "customer/track",
    },
    ARRIVED: {
      type: "technician_arriving",
      title: "Technician arrived",
      body: `${tech.name} has arrived and will begin diagnosis`,
      category: "job",
      link: "customer/track",
    },
    DIAGNOSING: {
      type: "technician_arriving",
      title: "Diagnosis started",
      body: `${tech.name} is inspecting your machine`,
      category: "job",
      link: "customer/track",
    },
    WAITING_APPROVAL: {
      type: "estimate_ready",
      title: "Estimate ready for approval",
      body: `پیش‌فاکتور تعمیر ${job.code} آماده بررسی و تأیید شماست. انجام تعمیر پس از تأیید شما آغاز می‌شود.`,
      category: "job",
      link: "customer/invoice",
    },
    COMPLETED: {
      type: "job_completed",
      title: "Job completed",
      body: `${job.code} is complete. Please review & pay.`,
      category: "job",
      link: "customer/completion",
    },
    REJECTED: {
      type: "request_rejected",
      title: `Mechanic declined your request`,
      body: `${tech.name} could not accept ${job.code}. We're finding another mechanic for you.`,
      category: "job",
      link: "customer/home",
    },
  };
  const notif = notifMap[status];
  if (notif) {
    const notifCategory = status === "REJECTED" ? "alert" : notif.category;
    try {
      await db.notification.create({
        data: {
          userId: cust.id,
          type: notif.type,
          title: notif.title,
          body: notif.body,
          category: notifCategory,
          link: notif.link,
        },
      });
      await db.message.create({
        data: {
          jobId: job.id,
          fromUserId: tech.id,
          kind: "system",
          body: notif.title,
        },
      });
    } catch (error) {
      console.error("[jobs/status] Status notification failed:", error);
    }
  }
  }

  return NextResponse.json(maskJobFinancialData(job as unknown as Record<string, unknown>));
}
