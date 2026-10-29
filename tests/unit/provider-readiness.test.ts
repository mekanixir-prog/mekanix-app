import { afterEach, describe, expect, it, vi } from "vitest";
import { getPaymentProviderStatus } from "@/lib/payment-provider";
import { getSmsProviderStatus } from "@/lib/sms-provider";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SMS provider production configuration status", () => {
  it("marks console and unsupported providers as not configured", () => {
    vi.stubEnv("SMS_PROVIDER", "console");
    expect(getSmsProviderStatus().configured).toBe(false);

    vi.stubEnv("SMS_PROVIDER", "unknown-provider");
    expect(getSmsProviderStatus().configured).toBe(false);
  });

  it("requires all MeliPayamak credentials including sender", () => {
    vi.stubEnv("SMS_PROVIDER", "melipayamak");
    vi.stubEnv("MELIPAYAMAK_USERNAME", "user");
    vi.stubEnv("MELIPAYAMAK_PASSWORD", "password");
    vi.stubEnv("MELIPAYAMAK_SENDER", "");
    expect(getSmsProviderStatus().configured).toBe(false);

    vi.stubEnv("MELIPAYAMAK_SENDER", "5000123456");
    expect(getSmsProviderStatus().configured).toBe(true);
  });

  it("requires provider credentials for Kavenegar and Farapayamak", () => {
    vi.stubEnv("SMS_PROVIDER", "kavenegar");
    vi.stubEnv("KAVENEGAR_API_KEY", "");
    expect(getSmsProviderStatus().configured).toBe(false);
    vi.stubEnv("KAVENEGAR_API_KEY", "test-key");
    expect(getSmsProviderStatus().configured).toBe(true);

    vi.stubEnv("SMS_PROVIDER", "farapayamak");
    vi.stubEnv("FARAPAYAMAK_USERNAME", "user");
    vi.stubEnv("FARAPAYAMAK_PASSWORD", "password");
    vi.stubEnv("FARAPAYAMAK_SENDER", "");
    expect(getSmsProviderStatus().configured).toBe(false);
    vi.stubEnv("FARAPAYAMAK_SENDER", "5000123456");
    expect(getSmsProviderStatus().configured).toBe(true);
  });
});

describe("payment provider production configuration status", () => {
  it("reports missing credentials and unsupported providers as not configured", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "zarinpal");
    vi.stubEnv("ZARINPAL_MERCHANT_ID", "");
    expect(getPaymentProviderStatus().configured).toBe(false);
    vi.stubEnv("ZARINPAL_MERCHANT_ID", "merchant-id");
    expect(getPaymentProviderStatus().configured).toBe(true);

    vi.stubEnv("PAYMENT_PROVIDER", "idpay");
    vi.stubEnv("IDPAY_API_KEY", "test-key");
    expect(getPaymentProviderStatus().configured).toBe(true);

    vi.stubEnv("PAYMENT_PROVIDER", "unsupported-provider");
    expect(getPaymentProviderStatus().configured).toBe(false);
  });

  it("does not treat the unimplemented NextPay stub as configured, even with a key", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "nextpay");
    vi.stubEnv("NEXTPAY_API_KEY", "test-key");
    expect(getPaymentProviderStatus().configured).toBe(false);
  });
});
