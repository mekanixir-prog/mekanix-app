// MEKANIX — Users module barrel.
//
// Re-exports user/customer/technician types and the active-user React hook.
// The underlying types come from the typed API client (`src/lib/api.ts`)
// which derives them from the Prisma payloads — keeping the source of truth
// in a single place.

export {
  // Prisma-derived domain types
  type User,
  type Customer,
  type Technician,
  type Role,
} from "@/lib/api";

// Browser-side hook that resolves the active (authed or demo) user.
export {
  useActiveUser,
  type DemoUser,
} from "@/lib/use-active-user";

// Server-side helpers that resolve a Session to a Customer / Technician row.
export {
  getCustomerFromSession,
  getTechnicianFromSession,
  type Session,
} from "@/lib/auth";

// User-related Zod schemas (admin login + OTP bootstrap are here too, but the
// primary user-facing one is `sessionSchema`).
export {
  sessionSchema,
  adminLoginSchema,
  type SessionInput,
  type AdminLoginInput,
} from "@/lib/schemas/auth";
