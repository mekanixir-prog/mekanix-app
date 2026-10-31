// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("SMS provider production fail-closed behavior", () => {
  it("rejects a missing provider in production without logging an OTP", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { sendOtp } = await import("@/lib/sms-provider");

    await expect(sendOtp("+989121234567", "123456")).rejects.toThrow(/real SMS_PROVIDER/);
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects the console provider explicitly in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "console");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { sendOtp } = await import("@/lib/sms-provider");

    await expect(sendOtp("+989121234567", "123456")).rejects.toThrow(/console OTP delivery is disabled/);
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects incomplete credentials instead of falling back to console", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "melipayamak");
    vi.stubEnv("MELIPAYAMAK_USERNAME", "merchant");
    vi.stubEnv("MELIPAYAMAK_PASSWORD", "");
    vi.stubEnv("MELIPAYAMAK_SENDER", "1000");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { sendOtp } = await import("@/lib/sms-provider");

    await expect(sendOtp("+989121234567", "123456")).rejects.toThrow(/MELIPAYAMAK_USERNAME/);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps console OTP delivery available only in non-production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SMS_PROVIDER", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { sendOtp } = await import("@/lib/sms-provider");

    await expect(sendOtp("+989121234567", "123456")).resolves.toMatchObject({ success: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[DEV SMS]"));
  });

  it("uses the configured real provider when production credentials are complete", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "kavenegar");
    vi.stubEnv("KAVENEGAR_API_KEY", "test-api-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ return: { status: 200 }, entries: { messageid: 42 } }),
    }));
    const { sendOtp } = await import("@/lib/sms-provider");

    await expect(sendOtp("+989121234567", "123456")).resolves.toEqual({
      success: true,
      messageId: "42",
    });
  });
});
