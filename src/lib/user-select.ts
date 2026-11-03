/**
 * Explicit User projections for API responses.
 *
 * Never use `user: true` or `fromUser: true` in API response queries:
 * the legacy `User.password` column is retained for migration compatibility
 * and must never be serialized.
 *
 * Participant-facing projections intentionally omit phone/email; users
 * communicate through the platform. Admin projections may include contact
 * details for account operations, but still never include credentials.
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

export const ADMIN_USER_SELECT = {
  ...PARTICIPANT_USER_SELECT,
  email: true,
  phone: true,
  phoneVerified: true,
  updatedAt: true,
} as const;
