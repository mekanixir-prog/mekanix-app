// MEKANIX — CARE module barrel.
//
// CARE = scheduled preventive maintenance flow. Re-exports:
//   - The CARE booking Zod schemas (`src/lib/schemas/care.ts`).
//   - The booking BOLA + state-machine helpers (`src/lib/care-auth.ts`).
//   - The booking-related domain types derived from Prisma.
//
// Consumers should prefer importing from here so the underlying files stay
// free to be reorganized without breaking callers.

export {
  careBookingSchema,
  inspectionSchema,
  findingCreateSchema,
  extraProposalSchema,
  approveExtraSchema,
  rejectExtraSchema,
  healthReportSchema,
  type CareBookingInput,
  type InspectionInput,
  type FindingCreateInput,
  type ExtraProposalInput,
  type ApproveExtraInput,
  type RejectExtraInput,
  type HealthReportInput,
} from "@/lib/schemas/care";

export {
  requireBookingParticipant,
  requireAssignedTechnician,
  requireBookingOwner,
  isValidTransition,
  validateTransition,
  isValidApprovalTransition,
  APPROVAL_TRANSITIONS,
  type BookingStatus,
  type ApprovalStatus,
} from "@/lib/care-auth";

export {
  type Session,
  getCustomerFromSession,
  getTechnicianFromSession,
} from "@/lib/auth";

export {
  PERMISSIONS,
  can,
  requirePermission,
} from "@/lib/permissions";
