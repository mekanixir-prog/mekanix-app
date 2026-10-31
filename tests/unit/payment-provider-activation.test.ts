// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("payment provider fail-closed activation boundary", () => {
  it("never permits the successful simulator in production when no provider is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "simulator");
    const provider = await import("@/lib/payment-provider");
    await expect(provider.createPayment({
      amount: 100_000,
      description: "VIP subscription",
      callbackUrl: "https://mekanix.test/api/gateway/callback",
      orderId: "order-1",
    })).rejects.toThrow("Live payments are disabled");
    await expect(provider.verifyPayment("authority-1", 100_000))
      .rejects.toThrow("Live payments are disabled");
  });

  it("does not enable a real adapter in production merely because credentials exist", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "zarinpal");
    vi.stubEnv("ZARINPAL_MERCHANT_ID", "test-merchant");
    const provider = await import("@/lib/payment-provider");
    await expect(provider.createPayment({
      amount: 100_000,
      description: "Invoice",
      callbackUrl: "https://mekanix.test/api/gateway/callback",
      orderId: "order-2",
    })).rejects.toThrow("not wired into the authoritative payment lifecycle");
  });

  it("keeps simulator use available only in non-production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PAYMENT_PROVIDER", "simulator");
    const provider = await import("@/lib/payment-provider");
    const result = await provider.createPayment({
      amount: 100_000,
      description: "Development test",
      callbackUrl: "https://mekanix.test/api/gateway/callback",
      orderId: "order-3",
    });
    expect(result.success).toBe(true);
    expect(result.authority).toMatch(/^sim_/);
  });

  it("rejects selecting a real provider before sandbox certification and route wiring", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYMENT_PROVIDER", "idpay");
    vi.stubEnv("IDPAY_API_KEY", "test-api-key");
    const provider = await import("@/lib/payment-provider");
    await expect(provider.createPayment({
      amount: 100_000,
      description: "Development test",
      callbackUrl: "https://mekanix.test/api/gateway/callback",
      orderId: "order-4",
    })).rejects.toThrow("not enabled yet");
  });

  it("never reports live readiness while the authoritative route integration is absent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "zarinpal");
    vi.stubEnv("ZARINPAL_MERCHANT_ID", "test-merchant");
    const provider = await import("@/lib/payment-provider");
    const status = provider.getPaymentProviderStatus();
    expect(status.configured).toBe(true);
    expect(status.integrationWired).toBe(false);
    expect(status.liveReady).toBe(false);
  });
});
