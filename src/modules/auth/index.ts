// MEKANIX — Auth module barrel.
//
// Re-exports everything auth-related from the lib layer so consumers can
// import from a single canonical path:
//
//   import { requireAuth, requireRole, can, otpSendSchema } from "@/modules/auth";
//
// This module is purely additive — the underlying files (`src/lib/auth.ts`,
// `src/lib/permissions.ts`, `src/lib/schemas/auth.ts`) remain the source of
// truth and all existing imports continue to work unchanged.

export {
  createSession,
  verifySession,
  revokeSession,
  revokeAllUserSessions,
  getSessionFromRequest,
  requireAuth,
  requireRole,
  getCustomerFromSession,
  getTechnicianFromSession,
  requireVehicleOwner,
  requireJobParticipant,
  requireNotificationOwner,
  requireWalletOwner,
  requireTicketOwner,
  requirePolicyOwner,
  ALLOWED_FIELDS,
  FORBIDDEN_FIELDS,
  sanitizeInput,
  generateRequestId,
  apiError,
  type Session,
} from "@/lib/auth";

export {
  can,
  canSession,
  requirePermission,
  requireSessionPermission,
  permissionsForRole,
  isKnownRole,
  listRoles,
  PERMISSIONS,
  type Permission,
  type KnownPermission,
} from "@/lib/permissions";

export {
  otpSendSchema,
  otpVerifySchema,
  sessionSchema,
  adminLoginSchema,
  type OtpSendInput,
  type OtpVerifyInput,
  type SessionInput,
  type AdminLoginInput,
} from "@/lib/schemas/auth";
