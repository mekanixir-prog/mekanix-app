// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({ $queryRaw: dbMocks.queryRaw }),
}));
import { getPaymentProviderStatus } from "@/lib/payment-provider";
import { getSmsProviderStatus } from "@/lib/sms-provider";
import { GET as readyGET, checkProductionGates } from "@/app/api/ready/route";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("SMS provider live readiness", () => {
  it("does not treat console logging as live SMS delivery", () => {
    vi.stubEnv("SMS_PROVIDER", "console");
    const status = getSmsProviderStatus();
    expect(status.configured).toBe(true);
    expect(status.liveReady).toBe(false);
  });

  it("requires all MeliPayamak credentials including sender", () => {
    vi.stubEnv("SMS_PROVIDER", "melipayamak");
    vi.stubEnv("MELIPAYAMAK_USERNAME", "user");
    vi.stubEnv("MELIPAYAMAK_PASSWORD", "pass");
    vi.stubEnv("MELIPAYAMAK_SENDER", "");
    expect(getSmsProviderStatus()).toMatchObject({
      configured: false,
      liveReady: false,
      warnings: ["MELIPAYAMAK_SENDER is not configured"],
    });
  });

  it("rejects unsupported SMS providers", () => {
    vi.stubEnv("SMS_PROVIDER", "unknown-sms");
    expect(getSmsProviderStatus()).toMatchObject({
      configured: false,
      liveReady: false,
    });
  });

  it("accepts a fully configured real SMS adapter as configured", () => {
    vi.stubEnv("SMS_PROVIDER", "kavenegar");
    vi.stubEnv("KAVENEGAR_API_KEY", "test-key");
    expect(getSmsProviderStatus()).toMatchObject({
      configured: true,
      provider: "kavenegar",
      liveReady: true,
    });
  });
});

describe("payment provider live readiness", () => {
  it("keeps simulator configured for development but not live-ready", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "simulator");
    expect(getPaymentProviderStatus()).toMatchObject({
      configured: true,
      provider: "simulator",
      integrationWired: false,
      liveReady: false,
    });
  });

  it("does not call NextPay ready while its adapter is still a stub", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "nextpay");
    vi.stubEnv("NEXTPAY_API_KEY", "test-key");
    expect(getPaymentProviderStatus()).toMatchObject({
      configured: false,
      provider: "nextpay",
      integrationWired: false,
      liveReady: false,
    });
  });

  it("does not call Zarinpal live-ready while production gateway routes remain unwired", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "zarinpal");
    vi.stubEnv("ZARINPAL_MERCHANT_ID", "merchant-id");
    expect(getPaymentProviderStatus()).toMatchObject({
      configured: true,
      provider: "zarinpal",
      integrationWired: false,
      liveReady: false,
    });
  });

  it("rejects unknown payment providers", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "unknown-provider");
    expect(getPaymentProviderStatus()).toMatchObject({
      configured: false,
      liveReady: false,
    });
  });
});

describe("production readiness gates", () => {
  it("blocks production until both SMS and payment are genuinely live-ready", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "kavenegar");
    vi.stubEnv("KAVENEGAR_API_KEY", "test-key");
    vi.stubEnv("PAYMENT_PROVIDER", "zarinpal");
    vi.stubEnv("ZARINPAL_MERCHANT_ID", "merchant-id");
    vi.stubEnv("DATABASE_URL", "postgresql://db.example/mekanix");

    const gates = checkProductionGates();
    expect(gates).toHaveLength(1);
    expect(gates[0].reason).toContain("Payment provider is not live-ready");
    expect(gates[0].reason).toContain("production checkout integration is not wired");
  });

  it("blocks incomplete SMS credentials and a local SQLite production URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "farapayamak");
    vi.stubEnv("FARAPAYAMAK_USERNAME", "user");
    vi.stubEnv("FARAPAYAMAK_PASSWORD", "");
    vi.stubEnv("FARAPAYAMAK_SENDER", "");
    vi.stubEnv("PAYMENT_PROVIDER", "simulator");
    vi.stubEnv("DATABASE_URL", "file:./production.db");

    const gates = checkProductionGates();
    expect(gates).toHaveLength(3);
    expect(gates.some((gate) => gate.reason.includes("FARAPAYAMAK_PASSWORD"))).toBe(true);
    expect(gates.some((gate) => gate.reason.includes("local SQLite"))).toBe(true);
  });

  it("returns 503 from /api/ready when database is healthy but live checkout is not wired", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "kavenegar");
    vi.stubEnv("KAVENEGAR_API_KEY", "test-key");
    vi.stubEnv("PAYMENT_PROVIDER", "zarinpal");
    vi.stubEnv("ZARINPAL_MERCHANT_ID", "merchant-id");
    vi.stubEnv("DATABASE_URL", "postgresql://db.example/mekanix");
    dbMocks.queryRaw.mockResolvedValue(1);

    const response = await readyGET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: { database: true, productionGates: false },
    });
  });

  it("does not apply production-only gates in development", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SMS_PROVIDER", "console");
    vi.stubEnv("PAYMENT_PROVIDER", "simulator");
    expect(checkProductionGates()).toEqual([]);
  });
});
