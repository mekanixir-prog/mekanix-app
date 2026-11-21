// MEKANIX — Zod schemas for authentication request bodies.
//
// These schemas are the canonical input contract for the OTP send / verify
// endpoints and for session bootstrap. They are imported by:
//   - src/app/api/auth/otp/send/route.ts   (otpSendSchema)
//   - src/app/api/auth/otp/verify/route.ts  (otpVerifySchema)
//
// Validation philosophy:
//   - Phone numbers are validated leniently at the schema layer (length + digit
//     pattern) so an obvious junk payload fails fast with a 400. Normalization
//     (stripping spaces / dashes / parentheses) happens in the route handler,
//     not in the schema, because the same payload shape is reused by the
//     verify endpoint which must match the stored (normalized) phone.
//   - `code` is exactly 6 digits — the OTP generator produces 6-digit codes.
//   - `name` is optional and only used on first-time signup. We cap it to
//     100 chars to avoid storing a paragraph as a display name.
//
// All error messages are in Persian (Farsi) to match the rest of the API.

import { z } from "zod";

// Phone: optional leading + followed by 8..15 digits. Allows the user to type
// "09121234567", "+98 912 123 4567", or "+1-415-224-1180" — the route handler
// strips non-digit characters before lookup.
const phoneField = z
  .string({ error: "شماره موبایل الزامی است" })
  .min(8, "شماره موبایل نامعتبر است")
  .max(20, "شماره موبایل نامعتبر است")
  .regex(/^[+]?[\d\s\-()]{8,20}$/, "شماره موبایل نامعتبر است");

// 6-digit numeric OTP code (matches the format produced by otp/send).
const otpCodeField = z
  .string({ error: "کد تأیید الزامی است" })
  .length(6, "کد تأیید باید ۶ رقم باشد")
  .regex(/^\d{6}$/, "کد تأیید باید ۶ رقم باشد");

// ──────────── OTP send ────────────
// POST /api/auth/otp/send
export const otpSendSchema = z.object({
  phone: phoneField,
});

export type OtpSendInput = z.infer<typeof otpSendSchema>;

// ──────────── OTP verify ────────────
// POST /api/auth/otp/verify
// `name` is optional and only stored on first-time signup (when no user with
// this phone exists yet). Returning users can omit it.
export const otpVerifySchema = z.object({
  phone: phoneField,
  code: otpCodeField,
  name: z.string().min(1).max(100).optional(),
});

export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

// ──────────── Session bootstrap ────────────
// Used by /api/auth/session to refresh the current session. We accept an
// optional userId hint (ignored — the real userId comes from the JWT), but
// the schema validates the shape so a malformed body fails fast.
export const sessionSchema = z.object({
  userId: z.string().min(1).optional(),
});

export type SessionInput = z.infer<typeof sessionSchema>;

// ──────────── Admin login (admin-panel) ────────────
// POST /api/admin-panel/auth/login — username + password. Used by the admin
// portal's classic credential flow. (OTP is the customer/technician flow.)
export const adminLoginSchema = z.object({
  username: z.string().min(1, "نام کاربری الزامی است").max(100),
  password: z.string().min(1, "رمز عبور الزامی است").max(200),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
