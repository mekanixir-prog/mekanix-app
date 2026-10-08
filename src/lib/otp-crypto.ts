// MEKANIX — OTP Crypto
// Works in both Node.js and Cloudflare Workers (nodejs_compat).

import { createHash, randomInt } from "node:crypto";

// Generate a 6-digit OTP code using CSPRNG
export function generateOtpCode(): string {
  return String(randomInt(100000, 1000000));
}

// Hash an OTP code for secure storage (SHA-256)
export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// Generic SHA-256 hash
export function hashSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
