// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  rateLimit: vi.fn(),
  getClientId: vi.fn(),
  ready: vi.fn(),
  send: vi.fn(),
  createOtp: vi.fn(),
  updateOtp: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ validateBody: mocks.validate }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: mocks.rateLimit,
  getClientId: mocks.getClientId,
}));
vi.mock("@/lib/schemas", () => ({ otpSendSchema: {} }));
vi.mock("@/lib/otp-crypto", () => ({
  generateOtpCode: () => "123456",
  hashOtpCode: () => "hash-123456",
}));
vi.mock("@/lib/sms-provider", () => ({
  assertSmsProviderReady: mocks.ready,
  sendOtp: mocks.send,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    otpCode: { create: mocks.createOtp, updateMany: mocks.updateOtp },
  }),
}));

import { POST } from "@/app/api/auth/otp/send/route";

function request() {
  return new Request("https://mekanix.test/api/auth/otp/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "+989121234567" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validate.mockResolvedValue({ ok: true, data: { phone: "+989121234567" } });
  mocks.rateLimit.mockResolvedValue({ success: true, resetMs: 0 });
  mocks.getClientId.mockReturnValue("test-client");
  mocks.ready.mockImplementation(() => undefined);
  mocks.send.mockResolvedValue({ success: true, messageId: "sms-1" });
  mocks.createOtp.mockResolvedValue({});
  mocks.updateOtp.mockResolvedValue({ count: 0 });
});

describe("OTP send route SMS delivery handling", () => {
  it("returns 503 before persisting an OTP when provider configuration is not ready", async () => {
    mocks.ready.mockImplementation(() => { throw new Error("SMS provider not configured"); });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.createOtp).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("consumes the newly persisted OTP and returns 502 when the provider rejects delivery", async () => {
    mocks.send.mockResolvedValue({ success: false, error: "provider rejected" });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(mocks.createOtp).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ phone: "+989121234567", code: "hash-123456" }),
    }));
    expect(mocks.updateOtp).toHaveBeenCalledTimes(2);
    expect(mocks.updateOtp).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { phone: "+989121234567", code: "hash-123456", consumed: false },
      data: { consumed: true },
    }));
    await expect(response.json()).resolves.not.toHaveProperty("code");
  });

  it("consumes the newly persisted OTP and returns 503 when the provider throws", async () => {
    mocks.send.mockRejectedValue(new Error("provider timeout"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.updateOtp).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.not.toHaveProperty("code");
  });

  it("returns a success response without exposing the OTP in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(request());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data).not.toHaveProperty("code");
    expect(mocks.send).toHaveBeenCalledWith("+989121234567", "123456");
  });

  it("returns the OTP only in non-production development for console testing", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, code: "123456" });
  });
});
