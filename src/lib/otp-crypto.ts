// MEKANIX — OTP cryptographic helpers.
//
// Centralizes the two security-sensitive OTP operations so that the send and
// verify routes cannot drift apart:
//
//   1. `generateOtpCode()` — produces a 6-digit numeric code using Node's
//      CSPRNG (`crypto.randomInt`). This replaces the old `Math.random()`
//      generator, which was NOT cryptographically secure and could be
//      predicted by an attacker who observed enough outputs.
//
//      Per OWASP Authentication Cheat Sheet §"Out-of-Band Verifiers":
//      "The verifier SHALL use a cryptographically secure random number
//      generator to choose the verification secret." `Math.random()` does
//      not meet that bar; `crypto.randomInt()` does.
//
//   2. `hashOtpCode(code)` — SHA-256 hex digest of the code. The hashed
//      form is what gets persisted to `OtpCode.code` in the DB so that a
//      read-only DB leak (SQL injection, backup theft, snapshot access)
//      cannot reveal usable OTP codes. Verification re-hashes the
//      user-supplied code and matches the hash.
//
//      SHA-256 is sufficient here because the OTP code space is only
//      10^6 (1,000,000 possible values) and codes expire in 5 minutes —
//      an offline brute force of the *full* code is feasible in theory,
//      but a single leaked hash is only useful for ~5 minutes and only
//      for the phone it was issued to. Adding per-code salt would not
//      raise the effective security (the phone IS the salt-equivalent
//      in our schema: `@@index([phone, createdAt])`). We use SHA-256
//      (not bcrypt/argon2) deliberately because OTP hashes must be
//      cheap to compute on every verify request — the rate limiter +
//      short TTL are the primary defenses, not KDF cost.
//
// Both helpers use `node:crypto` (built-in) — no new dependencies.

import { randomInt, createHash } from "node:crypto";

// Generate a 6-digit numeric OTP code using a CSPRNG.
// Returns a string of exactly 6 digits ("100000".."999999").
//
// `randomInt(min, max)` returns an integer n such that min <= n < max,
// so `randomInt(100000, 1000000)` covers [100000, 999999] inclusive —
// always 6 digits, no leading-zero padding concerns.
export function generateOtpCode(): string {
  return String(randomInt(100000, 1000000));
}

// Hash an OTP code for secure storage using SHA-256.
// Returns a 64-character lowercase hex string.
//
// Idempotent: the same input always produces the same hash, so the verify
// route can hash the user-supplied code and match it against the stored hash.
export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
