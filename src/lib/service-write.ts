// MEKANIX — Unified Service Write Facade
// ============================================================================
// Per ARCHITECTURE.md §8, all service writes should go through a single state
// machine, regardless of whether the underlying model is Job or ServiceBooking.
//
// This facade provides create + status transition for both models, with a
// unified state machine. It is ADDITIVE: existing /api/jobs/[id]/status and
// /api/care/bookings routes are not removed — they continue to work. New
// callers can use this facade to write to either model through a single API.
//
// Routing rules:
//   - CARE bookings (packageId present, or category = "periodic") → ServiceBooking
//   - General repair (everything else) → ServiceRequest + optional Job
//
// Job.technicianId is non-nullable in the schema (see prisma/schema.prisma:291),
// so the repair-flow create accepts an optional `technicianId`:
//   - When provided (admin pre-assignment / direct book), a Job is created
//     immediately and the returned `id` is the Job id.
//   - When omitted, only a ServiceRequest is created (matching the existing
//     `/api/service-requests` POST flow), and the returned `id` is the SR id.
//     The customer then accepts a matched technician via
//     `/api/service-requests/[id]/assign`, which creates the Job.
//
// transitionJob handles both Job and ServiceRequest ids transparently:
//   - Job id → map unified status to JobStatus + update.
//   - ServiceRequest id (no Job yet) → only CANCELLED is allowed (maps to
//     RequestStatus.CANCELLED).
// ============================================================================

import { db } from "./db";
import { isValidTransition } from "./care-auth";
import { sendNotification, NOTIFICATION_TYPES } from "./notifications";
import type { ServiceStatus } from "./service-unified";

export interface CreateServiceInput {
  customerId: string;
  vehicleId: string;
  category: string; // "repair" | "periodic" | "emergency"
  urgency?: string; // "NORMAL" | "URGENT" | "EMERGENCY"
  title: string;
  description: string;
  location: string;
  lat: number;
  lng: number;
  mediaUrls?: string[];
  voiceNote?: string;
  // Optional CARE-specific fields
  packageId?: string;
  date?: Date;
  timeWindow?: string;
  currentMileage?: number;
  // Optional technician pre-assignment (repair flow only). If omitted, only
  // a ServiceRequest is created and the customer picks a technician later.
  technicianId?: string;
}

export interface CreateServiceResult {
  id: string;
  code: string;
  source: "job" | "booking";
  status: ServiceStatus;
}

// Route creation to the right model based on category.
//
// The CARE branch fires when:
//   - a `packageId` is provided (caller knows which CARE package they want), OR
//   - `category === "periodic"` (CARE scheduled-maintenance flow).
//
// Everything else (general on-demand repair) goes through the Job flow.
export async function createService(
  input: CreateServiceInput,
  userId: string
): Promise<CreateServiceResult> {
  if (input.packageId || input.category === "periodic") {
    return createBookingService(input, userId);
  }
  return createJobService(input, userId);
}

// Create a ServiceBooking (CARE flow). Matches the existing
// `/api/care/bookings` POST route's booking-shape (without the pricing
// snapshot — that is created separately via `createPricingSnapshot`).
async function createBookingService(
  input: CreateServiceInput,
  userId: string
): Promise<CreateServiceResult> {
  const code = `CARE-${Math.floor(100000 + Math.random() * 900000)}`;

  const booking = await db.serviceBooking.create({
    data: {
      code,
      userId,
      vehicleId: input.vehicleId,
      packageId: input.packageId || null,
      serviceType: input.category,
      location: input.location,
      lat: input.lat,
      lng: input.lng,
      date: input.date || null,
      timeWindow: input.timeWindow || null,
      currentMileage: input.currentMileage || null,
      status: "REQUESTED",
    },
  });

  // Timeline event — mirrors the existing /api/care/bookings POST route.
  await db.serviceTimelineEvent.create({
    data: {
      bookingId: booking.id,
      eventType: "booking_created",
      actor: userId,
    },
  });

  return {
    id: booking.id,
    code: booking.code,
    source: "booking",
    status: "REQUESTED",
  };
}

// Create a ServiceRequest + optional Job (repair flow).
//
// Vehicle ownership is verified before the SR is created (BOLA / mass-
// assignment guard). The SR's `customerId` is resolved from the session's
// Customer profile — never copied from `input.customerId` (which is the
// *caller's* user id, used only for logging).
async function createJobService(
  input: CreateServiceInput,
  userId: string
): Promise<CreateServiceResult> {
  // Resolve customer record from session (server-authoritative).
  const customer = await db.customer.findUnique({ where: { userId } });
  if (!customer) throw new Error("Customer profile not found");

  // Verify vehicle ownership (BOLA guard — mirrors /api/service-requests POST).
  const vehicle = await db.vehicle.findUnique({
    where: { id: input.vehicleId },
    select: { id: true, customerId: true, type: true },
  });
  if (!vehicle || vehicle.customerId !== customer.id) {
    throw new Error("Vehicle not owned by customer");
  }

  // Create the ServiceRequest.
  const srCode = `SR-${Math.floor(2000 + Math.random() * 8000)}`;
  const request = await db.serviceRequest.create({
    data: {
      code: srCode,
      customerId: customer.id,
      vehicleId: input.vehicleId,
      category: input.category,
      urgency: (input.urgency as any) || "NORMAL",
      title: input.title,
      description: input.description,
      mediaUrls: JSON.stringify(input.mediaUrls || []),
      voiceNote: input.voiceNote || null,
      address: input.location,
      lat: input.lat,
      lng: input.lng,
      status: "OPEN",
    },
  });

  // Optional: create a Job immediately if a technician is pre-assigned.
  // This skips the customer-picks-from-matches step (admin / direct book).
  if (input.technicianId) {
    const tech = await db.technician.findUnique({
      where: { id: input.technicianId },
      select: { id: true, userId: true },
    });
    if (!tech) throw new Error("Technician not found");

    // Promote the SR to ASSIGNED + record the matchedTech (mirrors /assign).
    await db.serviceRequest.update({
      where: { id: request.id },
      data: { status: "ASSIGNED", matchedTechId: tech.id },
    });

    const jobCode = `JOB-${Math.floor(3000 + Math.random() * 7000)}`;
    const job = await db.job.create({
      data: {
        code: jobCode,
        requestId: request.id,
        technicianId: tech.id,
        status: "REQUESTED",
        etaMins: 25,
      },
    });

    // Notify the assigned technician (mirrors /assign notification).
    await sendNotification({
      userId: tech.userId,
      type: NOTIFICATION_TYPES.REQUEST_ACCEPTED,
      title: "New job assigned",
      body: `${job.code} — ${request.title}`,
      category: "job",
      link: "technician/requests",
    });

    return {
      id: job.id,
      code: job.code,
      source: "job",
      status: "REQUESTED",
    };
  }

  // No technician pre-assigned — return the ServiceRequest id. The customer
  // will assign a technician later via `/api/service-requests/[id]/assign`,
  // which creates the Job. Until then, transitionServiceStatus on this id
  // only supports CANCELLED (see transitionJob fallback).
  return {
    id: request.id,
    code: request.code,
    source: "job",
    status: "REQUESTED",
  };
}

// Unified status transition. Routes to the right model based on `source`.
export async function transitionServiceStatus(
  serviceId: string,
  source: "job" | "booking",
  newStatus: ServiceStatus,
  role: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  if (source === "booking") {
    return transitionBooking(serviceId, newStatus, role, userId);
  }
  return transitionJob(serviceId, newStatus, role, userId);
}

// Transition a ServiceBooking. Uses the Booking state machine
// (`isValidTransition` from care-auth.ts) for validation, then applies
// the update with optimistic concurrency (status-anchored updateMany).
async function transitionBooking(
  bookingId: string,
  newStatus: ServiceStatus,
  role: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  const booking = await db.serviceBooking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true, userId: true, technicianId: true },
  });

  if (!booking) return { success: false, error: "Booking not found" };

  // Validate the transition against the Booking state machine + role matrix.
  const valid = isValidTransition(role as any, booking.status, newStatus);
  if (!valid) {
    return {
      success: false,
      error: `Invalid transition: ${booking.status} → ${newStatus}`,
    };
  }

  // Optimistic concurrency: only update if the status hasn't changed since
  // we read it. If another request flipped the status first, this returns
  // count=0 and we report a conflict.
  const result = await db.serviceBooking.updateMany({
    where: { id: bookingId, status: booking.status },
    data: { status: newStatus },
  });

  if (result.count === 0) {
    return { success: false, error: "Status changed concurrently" };
  }

  // Timeline event — records who did what, for audit + UI rendering.
  await db.serviceTimelineEvent.create({
    data: {
      bookingId,
      eventType: newStatus.toLowerCase(),
      actor: userId,
    },
  });

  return { success: true };
}

// Transition a Job. Looks up the Job by id first; falls back to
// ServiceRequest if no Job exists yet (the "SR created, awaiting assign"
// case). For an SR, only CANCELLED is allowed (maps to RequestStatus.CANCELLED).
//
// Job's state machine is implicit (the existing /api/jobs/[id]/status route
// enforces it inline). This facade does NOT re-implement the Job state
// machine — it just maps the unified status to the Job's native enum value
// and updates. API routes that need role-based enforcement should use the
// existing /api/jobs/[id]/status route OR add their own role check before
// calling this facade.
async function transitionJob(
  jobId: string,
  newStatus: ServiceStatus,
  _role: string,
  _userId: string
): Promise<{ success: boolean; error?: string }> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, technicianId: true },
  });

  if (job) {
    // Map unified status → JobStatus. The unified vocabulary is a superset
    // of JobStatus; the collapse rules mirror JOB_STATUS_MAP in
    // service-unified.ts (e.g., ASSIGNED → ACCEPTED, INSPECTING → DIAGNOSING).
    const jobStatusMap: Record<string, string> = {
      ASSIGNED: "ACCEPTED",
      INSPECTING: "DIAGNOSING",
      IN_SERVICE: "REPAIRING",
      WAITING_CUSTOMER_APPROVAL: "WAITING_APPROVAL",
      COMPLETED: "COMPLETED",
      CANCELLED: "CANCELLED",
      FAILED: "REJECTED",
    };

    const jobStatus = jobStatusMap[newStatus] || newStatus;

    // Optimistic concurrency: only update if status hasn't changed since read.
    const result = await db.job.updateMany({
      where: { id: jobId, status: job.status },
      data: { status: jobStatus as any },
    });

    if (result.count === 0) {
      return { success: false, error: "Status changed concurrently" };
    }

    return { success: true };
  }

  // No Job found — try ServiceRequest (the "SR created, awaiting assign" case).
  const sr = await db.serviceRequest.findUnique({
    where: { id: jobId },
    select: { id: true, status: true },
  });

  if (!sr) {
    return { success: false, error: "Job not found" };
  }

  // SR's state graph is much narrower than Job's:
  //   OPEN → MATCHED → ASSIGNED → CANCELLED / EXPIRED
  // Only CANCELLED is exposed via this unified facade (the others are driven
  // by the matching/assign engine, not by user-facing transitions).
  if (newStatus !== "CANCELLED") {
    return {
      success: false,
      error: `ServiceRequest (no Job yet) cannot transition to ${newStatus} — assign a technician first`,
    };
  }

  if (!["OPEN", "MATCHED", "ASSIGNED"].includes(sr.status)) {
    return {
      success: false,
      error: `Cannot cancel ServiceRequest in status ${sr.status}`,
    };
  }

  await db.serviceRequest.update({
    where: { id: sr.id },
    data: { status: "CANCELLED" },
  });

  return { success: true };
}
