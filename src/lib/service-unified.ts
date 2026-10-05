// MEKANIX — Unified Service Layer (Facade)
// ============================================================================
// Per ARCHITECTURE.md §8, MEKANIX should have ONE unified service flow:
//
//   REQUESTED → SCHEDULED → MATCHING → ASSIGNED → EN_ROUTE → ARRIVED
//            → INSPECTING → WAITING_CUSTOMER_APPROVAL → APPROVED
//            → IN_SERVICE → FINAL_CHECK → COMPLETED → (warranty)
//
// In practice the codebase currently runs TWO parallel service models:
//
//   1. `ServiceRequest → Job`               (general on-demand repair flow)
//   2. `ServiceBooking → Inspection / Finding / CustomerApproval / PartUsage
//                       / VehicleHealthReport`  (CARE scheduled-maintenance flow)
//
// Migrating them into a single model is high-risk:
//   - 29 API routes under `src/app/api/jobs/**` + `src/app/api/service-requests/**`
//     reference `db.job`.
//   - 15 API routes under `src/app/api/care/bookings/**` reference
//     `db.serviceBooking`.
//
// So this module does NOT migrate. Instead it provides a unified READ-SIDE
// facade over both models. New code that wants "all services for a user" can
// call `getServicesForUser()` and get a single sorted list. Existing routes
// keep working unchanged.
//
// Future: a true merged `Service` model can replace both, and this facade's
// public API is the contract the migration must satisfy.
// ============================================================================

import { db } from "./db";

// ─────────────────────────────────────────────────────────────────────────────
// Unified Service Status
//
// This is a superset of JobStatus + ServiceBooking.status, normalised so the
// client never has to care which source model a record came from.
// ─────────────────────────────────────────────────────────────────────────────

export type ServiceStatus =
  | "REQUESTED"
  | "SCHEDULED"
  | "MATCHING"
  | "ASSIGNED"
  | "EN_ROUTE"
  | "ARRIVED"
  | "INSPECTING"
  | "WAITING_CUSTOMER_APPROVAL"
  | "APPROVED"
  | "IN_SERVICE"
  | "FINAL_CHECK"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "REJECTED";

export interface UnifiedService {
  id: string;
  code: string;
  /** which underlying model this record came from — never null */
  source: "job" | "booking";
  customerId: string; // resolves to User.id on both sides
  vehicleId: string;
  technicianId: string | null;
  status: ServiceStatus;
  location: string;
  lat: number | null;
  lng: number | null;
  category: string;
  urgency: string;
  title: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  // ── Relations (optional — populated on detail view via getServiceById) ──
  inspection?: any;
  findings?: any[];
  approvals?: any[];
  timeline?: any[];
  pricing?: any;
  invoice?: any;
  healthReport?: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status maps — normalise each model's native status into UnifiedServiceStatus
// ─────────────────────────────────────────────────────────────────────────────

// JobStatus → ServiceStatus.
//
// Job has no APPROVED / SCHEDULED / MATCHING / FINAL_CHECK states (the customer
// side is implicit via `customerApproved: Boolean`). We collapse WAITING_APPROVAL
// → WAITING_CUSTOMER_APPROVAL so the unified status vocabulary matches
// ARCHITECTURE.md §8.
const JOB_STATUS_MAP: Record<string, ServiceStatus> = {
  REQUESTED: "REQUESTED",
  ACCEPTED: "ASSIGNED",
  EN_ROUTE: "EN_ROUTE",
  ARRIVED: "ARRIVED",
  DIAGNOSING: "INSPECTING",
  REPAIRING: "IN_SERVICE",
  WAITING_APPROVAL: "WAITING_CUSTOMER_APPROVAL",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
};

// ServiceBooking.status (string, see prisma/schema.prisma:1097) → ServiceStatus.
const BOOKING_STATUS_MAP: Record<string, ServiceStatus> = {
  REQUESTED: "REQUESTED",
  SCHEDULED: "SCHEDULED",
  MATCHING: "MATCHING",
  ASSIGNED: "ASSIGNED",
  EN_ROUTE: "EN_ROUTE",
  ARRIVED: "ARRIVED",
  INSPECTING: "INSPECTING",
  WAITING_CUSTOMER_APPROVAL: "WAITING_CUSTOMER_APPROVAL",
  APPROVED: "APPROVED",
  IN_SERVICE: "IN_SERVICE",
  FINAL_CHECK: "FINAL_CHECK",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
};

// ─────────────────────────────────────────────────────────────────────────────
// Converters — pure functions, no DB calls. Useful for tests + composition.
// ─────────────────────────────────────────────────────────────────────────────

// Convert a Prisma Job (with `request`, `technician`, `invoice`,
// `diagnosisRecords` included) into a UnifiedService.
export function jobToService(job: any): UnifiedService {
  return {
    id: job.id,
    code: job.code,
    source: "job",
    customerId: job.request?.customer?.userId ?? "",
    vehicleId: job.request?.vehicleId ?? "",
    technicianId: job.technicianId ?? null,
    status: JOB_STATUS_MAP[job.status] ?? "REQUESTED",
    location: job.request?.address ?? "",
    lat: job.request?.lat ?? null,
    lng: job.request?.lng ?? null,
    category: job.request?.category ?? "general",
    urgency: job.request?.urgency ?? "NORMAL",
    title: job.request?.title ?? "",
    description: job.request?.description ?? "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    inspection: job.diagnosisRecords?.[0],
    invoice: job.invoice,
  };
}

// Convert a Prisma ServiceBooking into a UnifiedService.
//
// Note: ServiceBooking has no direct `pricing` relation — only `pricingSnapshotId`
// FK. Callers that want the pricing snapshot must fetch it separately (see
// getServiceById which does this explicitly).
export function bookingToService(booking: any): UnifiedService {
  return {
    id: booking.id,
    code: booking.code,
    source: "booking",
    customerId: booking.userId,
    vehicleId: booking.vehicleId,
    technicianId: booking.technicianId ?? null,
    status: BOOKING_STATUS_MAP[booking.status] ?? "REQUESTED",
    location: booking.location ?? "",
    lat: booking.lat ?? null,
    lng: booking.lng ?? null,
    category: booking.serviceType ?? "periodic",
    urgency: "NORMAL",
    title: booking.package?.name ?? "CARE Service",
    description: booking.notes ?? "",
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
    inspection: booking.inspection,
    findings: booking.findings,
    approvals: booking.approvals,
    timeline: booking.timeline,
    pricing: booking.pricing,
    healthReport: booking.healthReport,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read API — unified queries over both models
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all services for a user (unified from both Job + ServiceBooking models).
 *
 * The user is identified by their `User.id` — on the Job side we resolve
 * `User → Customer → ServiceRequest → Job`; on the booking side we filter
 * directly on `ServiceBooking.userId`.
 *
 * Results are merged and sorted newest-first, then truncated to `limit`.
 *
 * Status filter: when provided, applies INDEPENDENTLY to each model using
 * the unified status vocabulary. (Job statuses are mapped first.)
 */
export async function getServicesForUser(
  userId: string,
  options?: {
    status?: ServiceStatus[];
    limit?: number;
    offset?: number;
  }
): Promise<UnifiedService[]> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  // Translate unified status filter back into each model's native statuses.
  // For Jobs, multiple unified statuses can map to a single JobStatus, so we
  // build a reverse map. For Bookings, the unified vocabulary is 1:1 with
  // the booking's string statuses (with the exception of REJECTED which only
  // exists on Jobs).
  let jobStatuses: string[] | undefined;
  let bookingStatuses: string[] | undefined;
  if (options?.status && options.status.length > 0) {
    const jobReverse: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(JOB_STATUS_MAP)) {
      (jobReverse[v] ??= []).push(k);
    }
    jobStatuses = options.status.flatMap((s) => jobReverse[s] ?? []);
    bookingStatuses = options.status.filter(
      (s) => s !== "REJECTED" // booking model never uses REJECTED
    );
  }

  // Fetch jobs (via customer's service requests)
  const jobs = await db.job.findMany({
    where: {
      request: { customer: { userId } },
      ...(jobStatuses && jobStatuses.length > 0
        ? { status: { in: jobStatuses as any[] } }
        : {}),
    },
    include: {
      request: { include: { customer: true, vehicle: true } },
      technician: { include: { user: true } },
      invoice: true,
      diagnosisRecords: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });

  // Fetch bookings
  const bookings = await db.serviceBooking.findMany({
    where: {
      userId,
      ...(bookingStatuses && bookingStatuses.length > 0
        ? { status: { in: bookingStatuses as any[] } }
        : {}),
    },
    include: {
      package: true,
      timeline: { orderBy: { timestamp: "asc" } },
      findings: true,
      approvals: true,
      inspection: true,
      healthReport: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });

  // Merge and sort newest-first, then truncate to the requested limit.
  const services = [
    ...jobs.map(jobToService),
    ...bookings.map(bookingToService),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return services.slice(0, limit);
}

/**
 * Fetch a single service by ID. Tries the ServiceBooking model first, then
 * falls back to Job. Returns null if neither model has a record with this ID.
 *
 * Includes the full detail graph: package items, timeline, findings + their
 * approvals, part usages, inspection, health report, and (for bookings) the
 * frozen pricing snapshot.
 */
export async function getServiceById(
  id: string
): Promise<UnifiedService | null> {
  // Try booking first
  const booking = await db.serviceBooking.findUnique({
    where: { id },
    include: {
      package: { include: { items: true } },
      timeline: { orderBy: { timestamp: "asc" } },
      findings: { include: { approvals: true } },
      approvals: true,
      partUsages: true,
      inspection: true,
      healthReport: true,
    },
  });
  if (booking) {
    // Resolve the frozen pricing snapshot (linked via FK, not a Prisma relation).
    const pricing = booking.pricingSnapshotId
      ? await db.pricingSnapshot.findUnique({
          where: { id: booking.pricingSnapshotId },
        })
      : null;
    return bookingToService({ ...booking, pricing });
  }

  // Try job
  const job = await db.job.findUnique({
    where: { id },
    include: {
      request: {
        include: { customer: { include: { user: true } }, vehicle: true },
      },
      technician: { include: { user: true } },
      diagnosisRecords: true,
      parts: true,
      invoice: true,
      tracking: { orderBy: { ts: "asc" } },
      reviews: true,
      warranty: true,
    },
  });
  if (job) return jobToService(job);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregations — for dashboards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate service counts for a user, across both Job + ServiceBooking models.
 *
 * Used by dashboards to render a single "X services" counter without having
 * to know about the dual-model architecture.
 */
export async function getServiceStats(
  userId: string
): Promise<{
  total: number;
  active: number;
  completed: number;
  cancelled: number;
}> {
  const [jobs, bookings] = await Promise.all([
    db.job.count({
      where: { request: { customer: { userId } } },
    }),
    db.serviceBooking.count({
      where: { userId },
    }),
  ]);

  const [jobsCompleted, bookingsCompleted] = await Promise.all([
    db.job.count({
      where: {
        request: { customer: { userId } },
        status: "COMPLETED",
      },
    }),
    db.serviceBooking.count({
      where: { userId, status: "COMPLETED" },
    }),
  ]);

  const [jobsCancelled, bookingsCancelled] = await Promise.all([
    db.job.count({
      where: {
        request: { customer: { userId } },
        status: "CANCELLED",
      },
    }),
    db.serviceBooking.count({
      where: { userId, status: "CANCELLED" },
    }),
  ]);

  const total = jobs + bookings;
  const completed = jobsCompleted + bookingsCompleted;
  const cancelled = jobsCancelled + bookingsCancelled;

  return {
    total,
    active: total - completed - cancelled,
    completed,
    cancelled,
  };
}
