// MEKANIX — Services module barrel.
//
// "Services" here = BOTH:
//   1. The on-demand repair flow (ServiceRequest + Job) — distinct from
//   2. The CARE module which covers scheduled maintenance bookings.
//
// Per ARCHITECTURE.md §8 there should be ONE unified service flow, but a
// full migration is high-risk (29 routes reference db.job, 15 reference
// db.serviceBooking). Instead we expose a Unified Service facade that
// abstracts over both models without migrating data — see
// `src/lib/service-unified.ts`.
//
// Re-exports:
//   - Zod schemas for service requests, job status updates, job diagnosis,
//     CARE bookings.
//   - Prisma-derived ServiceRequest / Job / Invoice domain types.
//   - Server-side BOLA helpers for jobs (requireJobParticipant).
//   - Unified Service facade: getServicesForUser / getServiceById /
//     getServiceStats + UnifiedService / ServiceStatus types.

export {
  serviceRequestCreateSchema,
  jobStatusUpdateSchema,
  jobDiagnosisSchema,
  URGENCY_LEVELS,
  type ServiceRequestCreateInput,
  type JobStatusUpdateInput,
  type JobDiagnosisInput,
} from "@/lib/schemas/service";

export { careBookingSchema } from "@/lib/schemas/care";

export {
  type ServiceRequest,
  type Job,
  type Invoice,
  type ServiceCategory,
} from "@/lib/api";

export {
  requireJobParticipant,
  type Session,
} from "@/lib/auth";

// ── Unified Service facade (read-side over Job + ServiceBooking) ──
export {
  getServicesForUser,
  getServiceById,
  getServiceStats,
  jobToService,
  bookingToService,
  type UnifiedService,
  type ServiceStatus,
} from "@/lib/service-unified";

// ── Unified Service facade (write-side: create + status transition) ──
// ADDITIVE: existing /api/jobs/[id]/status and /api/care/bookings routes
// continue to work unchanged. New callers can use these functions to write
// to either model through a single API.
export {
  createService,
  transitionServiceStatus,
  type CreateServiceInput,
  type CreateServiceResult,
} from "@/lib/service-write";
