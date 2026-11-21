// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  userFind: vi.fn(),
  customerCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionFromRequest: mocks.session }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    user: { findUnique: mocks.userFind },
    customer: { create: mocks.customerCreate },
  }),
}));

import { GET, POST } from "@/app/api/auth/session/route";

const user = {
  id: "technician-user-1",
  role: "TECHNICIAN",
  customer: { id: "customer-1" },
  technician: {
    id: "technician-1",
    financialUnitStatus: "UNVERIFIED",
    hourlyRate: 900_000,
    travelFeeBase: 200_000,
    inspectionFee: 300_000,
    inspectionFeeHeavy: 1_200_000,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ userId: user.id, role: "TECHNICIAN" });
  mocks.userFind.mockResolvedValue(user);
});

describe("auth session financial projection", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
  ])("%s never exposes unverified technician fees", async (_name, handler) => {
    const response = await handler(new Request("https://mekanix.test/api/auth/session", {
      method: _name,
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.user.technician).toMatchObject({
      financialUnitStatus: "UNVERIFIED",
      hourlyRate: null,
      travelFeeBase: null,
      inspectionFee: null,
      inspectionFeeHeavy: null,
    });
  });
});
