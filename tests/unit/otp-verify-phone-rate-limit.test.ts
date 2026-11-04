// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimitAsync: vi.fn(),
  getDbForLib: vi.fn(),
  getClientId: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: mocks.rateLimitAsync,
  getClientId: mocks.getClientId,
  RATE_LIMITS: { OTP_VERIFY: { max: 5, windowMs: 60_000 } },
}));
vi.mock("@/lib/db-access", () => ({ getDbForLib: mocks.getDbForLib }));
vi.mock("@/lib/auth", () => ({ createSession: vi.fn() }));

import { POST } from "@/app/api/auth/otp/verify/route";
import { hashOtpPhone } from "@/lib/otp-crypto";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("OTP_HASH_SECRET", "test-secret-with-at-least-32-bytes-123");
  mocks.getClientId.mockReturnValue("203.0.113.10");
  mocks.rateLimitAsync.mockResolvedValue({ success: true, resetMs: 60_000 });
  mocks.getDbForLib.mockResolvedValue({
    otpCode: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("OTP verification phone rate limit", () => {
  it("checks both IP and keyed phone budgets before reading OTP records", async () => {
    const response = await POST(new Request("https://mekanix.ir/api/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "09123456789", code: "123456" }),
    }));

    expect(response.status).toBe(400); // no valid OTP row in the mocked database
    expect(mocks.rateLimitAsync).toHaveBeenCalledTimes(2);
    expect(mocks.rateLimitAsync).toHaveBeenNthCalledWith(
      1,
      "otp-verify:203.0.113.10",
      5,
      60_000,
    );
    expect(mocks.rateLimitAsync).toHaveBeenNthCalledWith(
      2,
      `otp-verify:phone:${hashOtpPhone("09123456789")}`,
      5,
      10 * 60 * 1000,
    );
    expect(mocks.getDbForLib).toHaveBeenCalledTimes(1);
  });

  it("fails closed before database access when the production HMAC secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTP_HASH_SECRET", "");

    const response = await POST(new Request("https://mekanix.ir/api/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "09123456789", code: "123456" }),
    }));

    expect(response.status).toBe(503);
    expect(mocks.getDbForLib).not.toHaveBeenCalled();
  });

  it("stops before database access when the phone budget is exhausted", async () => {
    mocks.rateLimitAsync
      .mockResolvedValueOnce({ success: true, resetMs: 60_000 })
      .mockResolvedValueOnce({ success: false, resetMs: 120_000 });

    const response = await POST(new Request("https://mekanix.ir/api/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "09123456789", code: "123456" }),
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(mocks.getDbForLib).not.toHaveBeenCalled();
  });
});
