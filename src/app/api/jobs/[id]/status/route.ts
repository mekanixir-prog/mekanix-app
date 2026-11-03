import { NextResponse } from "next/server";
import type { JobStatus as PrismaJobStatus } from "@prisma/client";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";
import {
  JobStatusConflictError,
  transitionJobStatusAtomically,
} from "@/lib/job-status-atomic";

const include = {
  request: { include: { customer: { include: { user: true } }, vehicle: true } },
  technician: { include: { user: true, specialties: true } },
  parts: true,
  diagnosisRecords: true,
  invoice: true,
  reviews: true,
  messages: { include: { fromUser: true }, orderBy: { createdAt: "asc" } },
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
  { to: "REPAIRING", from: ["DIAGNOSING", "ARRIVED", "WAITING_APPROVAL"] },
  { to: "WAITING_APPROVAL", from: ["REPAIRING", "DIAGNOSING"] },
  { to: "COMPLETED", from: ["REPAIRING", "WAITING_APPROVAL"] },
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
      return currentStatus === "WAITING_APPROVAL";
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

  const { status, ...extra } = body;

  // Load the current job so we can validate the transition
  const db = await getDbForLib();
  const existing = await db.job.findUnique({
    where: { id },
    select: {
      status: true,
      technicianId: true,
      requestId: true,
      code: true,
      parts: { select: { unitPrice: true, quantity: true } },
      technician: { select: { hourlyRate: true, travelFeeBase: true } },
      invoice: { select: { id: true } },
    },
  });
  if (!existing) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });

  // For technicians, ensure they are the ASSIGNED technician (requireJobParticipant already checked)
  // For customers, ensure they own the request (requireJobParticipant already checked)

  const customerApproved = extra.customerApproved != null ? Boolean(extra.customerApproved) : undefined;

  // If neither status nor customerApproved is provided, nothing to do
  if (!status && customerApproved === undefined) {
    return NextResponse.json({ error: "status یا customerApproved الزامی است" }, { status: 400 });
  }

  // Validate state-machine transition
  const targetStatus = status ?? existing.status;
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

  if (status === "WAITING_APPROVAL" && extra.laborHours !== undefined &&
      (typeof extra.laborHours !== "number" || !Number.isFinite(extra.laborHours) ||
       extra.laborHours <= 0 || extra.laborHours > 24)) {
    return NextResponse.json({ error: "مدت کار باید عددی بین ۰ تا ۲۴ ساعت باشد" }, { status: 400 });
  }

  const invoiceInput = status === "WAITING_APPROVAL" && !existing.invoice
    ? (() => {
        const laborHours = extra.laborHours ?? 1.5;
        const laborRate = Number(existing.technician.hourlyRate);
        const laborTotal = laborHours * laborRate;
        const partsTotal = existing.parts.reduce(
          (sum, part) => sum + Number(part.unitPrice) * part.quantity,
          0,
        );
        const travelFee = Number(existing.technician.travelFeeBase);
        const subtotal = laborTotal + partsTotal + travelFee;
        const taxRate = 0.09;
        const taxTotal = subtotal * taxRate;
        return {
          id: crypto.randomUUID(),
          code: `INV-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
          jobId: id,
          laborHours,
          laborRate,
          laborTotal,
          partsTotal,
          travelFee,
          subtotal,
          taxRate,
          taxTotal,
          discount: 0,
          total: subtotal + taxTotal,
          currency: "IRR",
          status: "SENT" as const,
          notes: "Parts covered by 6-month warranty.",
        };
      })()
    : null;
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
      body: `Review and approve your repair estimate for ${job.code}`,
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

  return NextResponse.json(job);
}
