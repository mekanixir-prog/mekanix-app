// MEKANIX — OTP Crypto
// Works in both Node.js and Cloudflare Workers (nodejs_compat).

import { createHash, createHmac, randomInt } from "node:crypto";

// Generate a 6-digit OTP code using a cryptographically secure PRNG.
export function generateOtpCode(): string {
  return String(randomInt(100000, 1000000));
}

function getOtpPepper(): string {
  const configured = process.env.OTP_HASH_SECRET;
  if (configured && new TextEncoder().encode(configured).length >= 32) {
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("OTP_HASH_SECRET must be configured with at least 32 bytes in production");
  }

  // Development/test only. Production never accepts this predictable key.
  return "mekanix-otp-test-only-secret-not-for-production";
}

function hmac(domain: string, value: string): string {
  return createHmac("sha256", getOtpPepper())
    .update(`mekanix:${domain}:v1:${value}`, "utf8")
    .digest("hex");
}

/**
 * Keyed OTP verifier. A database-only compromise cannot enumerate the
 * one-million-code OTP space without also obtaining OTP_HASH_SECRET.
 */
export function hashOtpCode(code: string): string {
  if (!/^\d{6}$/.test(code)) throw new Error("OTP code must be exactly six digits");
  return hmac("otp-code", code);
}

/**
 * Keyed phone identifier for rate-limit keys. This prevents raw phone numbers
 * from being copied into the shared rate-limit table.
 */
function canonicalOtpPhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");

  // Canonicalize Iranian mobile representations to +98XXXXXXXXXX so
  // 09..., 98..., and +98 ... cannot obtain separate guessing budgets.
  if (digits.startsWith("98") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+98${digits.slice(1)}`;

  // Also collapse the common +1 / 1 international representation.
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (trimmed.startsWith("+")) return `+${digits}`;

  // Do not infer a country code for other national numbers.
  return digits;
}

export function hashOtpPhone(phone: string): string {
  return hmac("otp-phone", canonicalOtpPhone(phone));
}

// Generic non-secret hash for identifiers that are already public/non-secret.
export function hashSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
