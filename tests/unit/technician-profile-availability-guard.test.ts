// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  technicianFindUnique: vi.fn(),
  technicianUpdate: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    technician: {
      findUnique: mocks.technicianFindUnique,
      update: mocks.technicianUpdate,
    },
  })),
}));
vi.mock("@/lib/auth", () => ({
  sanitizeInput: (input: Record<string, unknown>, allowed: readonly string[]) =>
    Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key))),
  ALLOWED_FIELDS: { technician: ["bio", "experienceYears", "hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy", "availableNow", "responseMins", "lat", "lng", "heading"] },
  FORBIDDEN_FIELDS: new Set(["role", "status", "verified", "rating", "reviewCount", "completedJobs", "phoneVerified", "profileCompleted", "password", "passwordHash", "totalEarned", "totalCommission", "totalWithdrawn", "pendingBalance", "platformCommission", "netEarnings", "holdUntil", "reviewerId", "adminNotes", "createdAt", "updatedAt", "id"]),
  verifySession: vi.fn(),
}));

import { PATCH } from "@/app/api/technicians/[id]/route";

describe("technician profile PATCH availability guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      userId: "owner-user",
      role: "TECHNICIAN",
      phone: null,
      isGuest: false,
    });
    mocks.technicianFindUnique.mockResolvedValue({ userId: "owner-user" });
  });

  it.each([
    ["availableNow", true],
    ["lat", 35.7],
    ["lng", 51.4],
    ["heading", 90],
  ])("rejects %s through the generic profile endpoint", async (field, value) => {
    const response = await PATCH(
      new Request("https://mekanix.test/api/technicians/tech-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      }),
      { params: Promise.resolve({ id: "tech-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "USE_AVAILABILITY_ENDPOINT" });
    expect(mocks.technicianUpdate).not.toHaveBeenCalled();
  });

  it("still allows ordinary profile fields", async () => {
    mocks.technicianUpdate.mockResolvedValue({ id: "tech-1", bio: "Hydraulic specialist" });

    const response = await PATCH(
      new Request("https://mekanix.test/api/technicians/tech-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bio: "Hydraulic specialist" }),
      }),
      { params: Promise.resolve({ id: "tech-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.technicianUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "tech-1" },
      data: { bio: "Hydraulic specialist" },
    }));
  });
});
