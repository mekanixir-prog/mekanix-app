/**
 * Explicit User projections for API responses.
 *
 * Never rely on Prisma's default scalar selection in an API response:
 * the legacy `User.password` column is retained for migration compatibility
 * and must never be serialized.
 *
 * Participant-facing projections intentionally omit phone/email; auth and
 * admin responses may include account contact fields when required.
 */
export const PARTICIPANT_USER_SELECT = {
  id: true,
  name: true,
  avatar: true,
  role: true,
  status: true,
  country: true,
  currency: true,
  language: true,
  createdAt: true,
} as const;

export const AUTH_USER_SELECT = {
  ...PARTICIPANT_USER_SELECT,
  email: true,
  phone: true,
  phoneVerified: true,
  updatedAt: true,
} as const;

export const ADMIN_USER_SELECT = {
  ...AUTH_USER_SELECT,
} as const;
