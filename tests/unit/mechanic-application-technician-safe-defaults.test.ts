// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  requireRole: vi.fn(),
  applicationFindUnique: vi.fn(),
  applicationUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  technicianFindUnique: vi.fn(),
  technicianCreate: vi.fn(),
  notificationCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  verifySession: mocks.verifySession,
  requireRole: mocks.requireRole,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    mechanicApplication: { findUnique: mocks.applicationFindUnique, update: mocks.applicationUpdate },
    user: { findUnique: mocks.userFindUnique, create: mocks.userCreate, update: mocks.userUpdate },
    technician: { findUnique: mocks.technicianFindUnique, create: mocks.technicianCreate },
    notification: { create: mocks.notificationCreate },
  })),
}));

import { POST } from "@/app/api/mechanic-applications/[id]/approve/route";

describe("mechanic approval technician defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifySession.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    mocks.requireRole.mockReturnValue(null);
    mocks.applicationFindUnique.mockResolvedValue({
      id: "application-1",
      status: "PENDING",
      phone: "+989121234567",
      fullName: "Test Technician",
      email: null,
      specialties: JSON.stringify(["hydraulics"]),
      certifications: JSON.stringify([{ name: "Self-reported certificate" }]),
      experienceYears: 4,
      bio: "Experienced mechanic",
      city: "Tabriz",
    });
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({
      id: "user-1",
      role: "TECHNICIAN",
      status: "ACTIVE",
      phone: "+989121234567",
    });
    mocks.technicianFindUnique.mockResolvedValue(null);
    mocks.technicianCreate.mockResolvedValue({ id: "technician-1" });
    mocks.applicationUpdate.mockResolvedValue({ id: "application-1", status: "APPROVED" });
    mocks.notificationCreate.mockResolvedValue({ id: "notification-1" });
  });

  it("does not publish a newly approved technician as online or invent a location", async () => {
    const request = new Request("https://mekanix.test/api/mechanic-applications/application-1/approve", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "application-1" }) });
    expect(response.status).toBe(200);

    const createArgs = mocks.technicianCreate.mock.calls[0][0];
    expect(createArgs.data.status).toBe("OFFLINE");
    expect(createArgs.data.availableNow).toBe(false);
    expect(createArgs.data.lat).toBeNull();
    expect(createArgs.data.lng).toBeNull();
    expect(createArgs.data).not.toHaveProperty("serviceAreas");
    expect(createArgs.data).not.toHaveProperty("rating");
    expect(createArgs.data).not.toHaveProperty("level");
    expect(createArgs.data).not.toHaveProperty("hourlyRate");
    expect(createArgs.data).not.toHaveProperty("travelFeeBase");
  });
});
