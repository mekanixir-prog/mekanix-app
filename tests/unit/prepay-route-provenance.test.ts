// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, recordPrepay } = vi.hoisted(() => ({
  db: {
    job: { findUnique: vi.fn() },
    notification: { create: vi.fn() },
    message: { create: vi.fn() },
  },
  recordPrepay: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => db),
}));
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: vi.fn(async () => ({ userId: "customer-1", role: "CUSTOMER" })),
}));
vi.mock("@/lib/auth", () => ({
  requireJobParticipant: vi.fn(async () => null),
}));
vi.mock("@/lib/prepay-atomic", () => ({
  recordPrepayAtomically: (...args: unknown[]) => recordPrepay(...args),
}));

import { POST } from "@/app/api/prepay/route";

describe("POST /api/prepay — technician fee currency provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED", "false");
    db.notification.create.mockResolvedValue({});
    db.message.create.mockResolvedValue({});
    db.job.findUnique.mockResolvedValue({
      id: "job-1",
      code: "JOB-1",
      prepayPaid: false,
      request: {
        vehicle: { type: "CAR" },
        customer: { user: { id: "customer-user-1" } },
      },
      technician: {
        id: "tech-1",
        inspectionFee: 7,
        inspectionFeeHeavy: 20,
        travelFeeBase: 3,
        wallet: null,
        user: { id: "technician-user-1" },
      },
    });
  });

  it("rounds the 10% commission half-up to an integer Rial", async () => {
    vi.stubEnv("MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED", "true");
    vi.stubEnv("MEKANIX_WALLET_IRR_PROVENANCE_VERIFIED", "true");
    const job = {
      id: "job-1",
      code: "JOB-1",
      prepayPaid: false,
      request: {
        vehicle: { type: "CAR" },
        customer: { user: { id: "customer-user-1" } },
      },
      technician: {
        id: "tech-1",
        inspectionFee: 1001,
        inspectionFeeHeavy: 2000,
        travelFeeBase: 0,
        wallet: null,
        user: { id: "technician-user-1", name: "Technician" },
      },
    };
    db.job.findUnique.mockReset().mockResolvedValueOnce(job).mockResolvedValueOnce(job);
    recordPrepay.mockResolvedValue(true);

    const request = new Request("https://mekanix.test/api/prepay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job-1", method: "card", cardNumber: "4111111111111111" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(recordPrepay).toHaveBeenCalledWith(db, expect.objectContaining({
      gross: 1001,
      commission: 100,
      net: 901,
    }));
  });

  it("rejects fractional legacy fees even after the provenance flag is enabled", async () => {
    vi.stubEnv("MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED", "true");
    vi.stubEnv("MEKANIX_WALLET_IRR_PROVENANCE_VERIFIED", "true");
    const job = {
      id: "job-1",
      code: "JOB-1",
      prepayPaid: false,
      request: {
        vehicle: { type: "CAR" },
        customer: { user: { id: "customer-user-1" } },
      },
      technician: {
        id: "tech-1",
        inspectionFee: 1001.5,
        inspectionFeeHeavy: 2000,
        travelFeeBase: 0,
        wallet: null,
        user: { id: "technician-user-1", name: "Technician" },
      },
    };
    db.job.findUnique.mockReset().mockResolvedValue(job);

    const request = new Request("https://mekanix.test/api/prepay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job-1", method: "card", cardNumber: "4111111111111111" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(recordPrepay).not.toHaveBeenCalled();
  });

  it("blocks prepay before persisting ambiguous legacy technician fees as IRR", async () => {
    const request = new Request("https://mekanix.test/api/prepay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job-1", method: "card", cardNumber: "4111111111111111" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("TECHNICIAN_FEE_CURRENCY_UNVERIFIED");
    expect(recordPrepay).not.toHaveBeenCalled();
  });
});
