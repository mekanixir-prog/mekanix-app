// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sms: vi.fn(),
  payment: vi.fn(),
}));

vi.mock("@/lib/sms-provider", () => ({ getSmsProviderStatus: mocks.sms }));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProviderStatus: mocks.payment }));

import { checkProductionGates } from "@/app/api/ready/route";

function approveAllFinancialGates() {
  vi.stubEnv("MEKANIX_PRICING_IRR_APPROVED", "true");
  vi.stubEnv("MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED", "true");
  vi.stubEnv("MEKANIX_JOB_PART_IRR_PROVENANCE_VERIFIED", "true");
  vi.stubEnv("MEKANIX_WITHDRAWAL_IRR_POLICY_APPROVED", "true");
  vi.stubEnv("MEKANIX_WITHDRAWAL_MIN_IRR", "10000");
  vi.stubEnv("MEKANIX_WITHDRAWAL_MAX_IRR", "100000000");
  vi.stubEnv("MEKANIX_WITHDRAWAL_IRR_PROVENANCE_VERIFIED", "true");
  vi.stubEnv("WALLET_RELEASE_SCHEDULED", "true");
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "https://remote-db.example");
  mocks.sms.mockReturnValue({ liveReady: true, provider: "live-sms", warnings: [] });
  mocks.payment.mockReturnValue({ liveReady: true, provider: "live-payment", warnings: [] });
});

afterEach(() => vi.unstubAllEnvs());

describe("production financial readiness gates", () => {
  it("does not apply production release gates in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(checkProductionGates()).toEqual([]);
    expect(mocks.sms).not.toHaveBeenCalled();
    expect(mocks.payment).not.toHaveBeenCalled();
  });

  it("blocks readiness until all IRR and scheduled escrow controls are approved", () => {
    const gates = checkProductionGates();
    const reasons = gates.map((gate) => gate.reason);

    expect(gates.every((gate) => !gate.ok)).toBe(true);
    expect(reasons).toContain("IRR pricing policy has not been explicitly approved.");
    expect(reasons).toContain("Legacy technician fee units have not been reconciled and verified as IRR.");
    expect(reasons).toContain("Legacy job-part prices have not been reconciled and verified as IRR.");
    expect(reasons).toContain("Owner-approved integer-IRR withdrawal limits are missing or invalid.");
    expect(reasons).toContain("Historical withdrawal records have not been reconciled to integer IRR.");
    expect(reasons).toContain("Scheduled escrow release worker has not been deployed and verified.");
  });

  it("reports production financial readiness only when all explicit attestations are present", () => {
    approveAllFinancialGates();
    expect(checkProductionGates()).toEqual([]);
  });

  it("rejects fractional, zero, unsafe, or inverted withdrawal limits", () => {
    approveAllFinancialGates();
    vi.stubEnv("MEKANIX_WITHDRAWAL_MIN_IRR", "1000.5");
    expect(checkProductionGates().some((gate) => gate.reason.includes("withdrawal limits"))).toBe(true);

    vi.stubEnv("MEKANIX_WITHDRAWAL_MIN_IRR", "0");
    vi.stubEnv("MEKANIX_WITHDRAWAL_MAX_IRR", "1000");
    expect(checkProductionGates().some((gate) => gate.reason.includes("withdrawal limits"))).toBe(true);

    vi.stubEnv("MEKANIX_WITHDRAWAL_MIN_IRR", "2000");
    vi.stubEnv("MEKANIX_WITHDRAWAL_MAX_IRR", "1000");
    expect(checkProductionGates().some((gate) => gate.reason.includes("withdrawal limits"))).toBe(true);
  });

  it("keeps local SQLite unavailable for production even when financial gates pass", () => {
    approveAllFinancialGates();
    vi.stubEnv("DATABASE_URL", "file:./production.db");
    expect(checkProductionGates().some((gate) => gate.reason.includes("local SQLite"))).toBe(true);
  });
});
