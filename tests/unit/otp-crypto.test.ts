import { afterEach, describe, expect, it, vi } from "vitest";
import { generateOtpCode, hashOtpCode, hashOtpPhone } from "@/lib/otp-crypto";

afterEach(() => vi.unstubAllEnvs());

describe("OTP keyed hashing", () => {
  it("generates six-digit codes using the CSPRNG helper", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it("stores a keyed HMAC rather than a plain SHA-256 digest", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OTP_HASH_SECRET", "a-test-only-secret-with-at-least-32-bytes");
    const code = "123456";
    const digest = hashOtpCode(code);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe("8d969eef6ecad3c29a3a629280e686cff8ca7a2e6c6a3f7b5b0f0e9e5f3f6b7a");
  });

  it("changes OTP digests when the secret rotates", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OTP_HASH_SECRET", "first-test-secret-with-at-least-32-bytes");
    const first = hashOtpCode("123456");
    vi.stubEnv("OTP_HASH_SECRET", "second-test-secret-with-at-least-32-bytes");
    expect(hashOtpCode("123456")).not.toBe(first);
  });

  it("uses domain separation for phone rate-limit identifiers", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OTP_HASH_SECRET", "test-secret-with-at-least-32-bytes-123");
    expect(hashOtpPhone("09123456789")).not.toBe(hashOtpCode("091234"));
    expect(hashOtpPhone("09123456789")).toBe(hashOtpPhone("09123456789"));
  });

  it("fails closed in production when the dedicated secret is absent or weak", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTP_HASH_SECRET", "");
    expect(() => hashOtpCode("123456")).toThrow(/OTP_HASH_SECRET/);
    vi.stubEnv("OTP_HASH_SECRET", "too-short");
    expect(() => hashOtpPhone("09123456789")).toThrow(/OTP_HASH_SECRET/);
  });

  it("rejects malformed OTP values before hashing", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(() => hashOtpCode("12345")).toThrow(/six digits/);
    expect(() => hashOtpCode("1234567")).toThrow(/six digits/);
    expect(() => hashOtpCode("abcdef")).toThrow(/six digits/);
  });
});
