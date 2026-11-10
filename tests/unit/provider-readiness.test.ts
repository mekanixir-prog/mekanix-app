// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ queryRaw: vi.fn(), rateLimitCount: vi.fn(), adminCount: vi.fn() }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    $queryRaw: dbMocks.queryRaw,
    rateLimit: { count: dbMocks.rateLimitCount },
    adminUser: { count: dbMocks.adminCount },
  }),
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
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://db.example/mekanix");
    vi.stubEnv("SMS_PROVIDER", "kavenegar");
    vi.stubEnv("KAVENEGAR_API_KEY", "test-key");
    vi.stubEnv("PAYMENT_PROVIDER", "zarinpal");
    vi.stubEnv("ZARINPAL_MERCHANT_ID", "merchant-id");
    dbMocks.queryRaw.mockResolvedValue(1);
    dbMocks.rateLimitCount.mockResolvedValue(0);
    dbMocks.adminCount.mockResolvedValue(1);
    vi.stubEnv("JWT_SECRET", "production-user-jwt-secret-at-least-32-bytes");
    vi.stubEnv("ADMIN_JWT_SECRET", "production-admin-jwt-secret-at-least-32-bytes");
    vi.stubEnv("OTP_HASH_SECRET", "production-otp-secret-at-least-32-bytes-long");
    // These tests isolate provider/database behavior. The separate
    // production-financial-readiness-gates suite verifies missing IRR controls.
    vi.stubEnv("MEKANIX_PRICING_IRR_APPROVED", "true");
    vi.stubEnv("MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED", "true");
    vi.stubEnv("MEKANIX_JOB_PART_IRR_PROVENANCE_VERIFIED", "true");
    vi.stubEnv("MEKANIX_WITHDRAWAL_IRR_POLICY_APPROVED", "true");
    vi.stubEnv("MEKANIX_WITHDRAWAL_MIN_IRR", "10000");
    vi.stubEnv("MEKANIX_WITHDRAWAL_MAX_IRR", "100000000");
    vi.stubEnv("MEKANIX_WITHDRAWAL_IRR_PROVENANCE_VERIFIED", "true");
    vi.stubEnv("WALLET_RELEASE_SCHEDULED", "true");
  });
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

  it("blocks production readiness when the shared rate-limit table is unavailable", async () => {
    dbMocks.rateLimitCount.mockRejectedValue(new Error("RateLimit table missing"));

    const response = await readyGET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.sharedRateLimitStore).toBe(false);
    expect(body.errors).toEqual(["One or more readiness checks failed"]);
  });

  it("blocks production readiness when no admin exists and bootstrap password is weak", async () => {
    dbMocks.adminCount.mockResolvedValue(0);
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "short");

    const response = await readyGET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.adminProvisioning).toBe(false);
    expect(body.errors).toEqual(["One or more readiness checks failed"]);
  });

  it("allows admin provisioning readiness with a valid existing admin or strong bootstrap secret", async () => {
    dbMocks.adminCount.mockResolvedValue(0);
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "a-long-unique-bootstrap-secret");

    const response = await readyGET();
    const body = await response.json();

    expect(body.checks.adminProvisioning).toBe(true);
    expect(body.errors).not.toContain(
      "No valid admin exists and ADMIN_BOOTSTRAP_PASSWORD is missing or shorter than 16 characters"
    );
  });

  it("does not expose database connection details in production readiness responses", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "kavenegar");
    vi.stubEnv("KAVENEGAR_API_KEY", "test-key");
    vi.stubEnv("PAYMENT_PROVIDER", "simulator");
    dbMocks.queryRaw.mockRejectedValue(new Error("connection failed: postgres://secret-host.internal:5432/private-db"));

    const response = await readyGET();
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.errors).toEqual(["One or more readiness checks failed"]);
    expect(JSON.stringify(body)).not.toContain("secret-host.internal");
    expect(JSON.stringify(body)).not.toContain("private-db");
  });
});
