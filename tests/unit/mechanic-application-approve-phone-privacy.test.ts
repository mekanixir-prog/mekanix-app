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
    mechanicApplication: {
      findUnique: mocks.applicationFindUnique,
      update: mocks.applicationUpdate,
    },
    user: {
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
      update: mocks.userUpdate,
    },
    technician: {
      findUnique: mocks.technicianFindUnique,
      create: mocks.technicianCreate,
    },
    notification: { create: mocks.notificationCreate },
  })),
}));

import { POST } from "@/app/api/mechanic-applications/[id]/approve/route";

const applicantPhone = "+989121234567";
const application = {
  id: "application-1",
  phone: applicantPhone,
  fullName: "Test Applicant",
  email: null,
  specialties: "[]",
  certifications: "[]",
  bio: null,
  experienceYears: 3,
  city: "Tehran",
  status: "PENDING",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifySession.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.requireRole.mockReturnValue(null);
  mocks.applicationFindUnique.mockResolvedValue(application);
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.userCreate.mockResolvedValue({
    id: "user-1",
    phone: applicantPhone,
    role: "TECHNICIAN",
    avatar: null,
  });
  mocks.technicianFindUnique.mockResolvedValue(null);
  mocks.technicianCreate.mockResolvedValue({ id: "technician-1", userId: "user-1" });
  mocks.applicationUpdate.mockResolvedValue({ ...application, status: "APPROVED" });
  mocks.notificationCreate.mockResolvedValue({ id: "notification-1" });
});

describe("POST /api/mechanic-applications/[id]/approve privacy", () => {
  it("does not send the applicant phone number to a third-party avatar service", async () => {
    const request = new Request("https://mekanix.test/api/mechanic-applications/application-1/approve", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      body: JSON.stringify({ notes: "Approved" }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "application-1" }) });

    expect(response.status).toBe(200);
    const createArgs = mocks.userCreate.mock.calls[0][0];
    expect(createArgs.data.avatar).toBeNull();
    expect(JSON.stringify(createArgs)).not.toContain(applicantPhone);
    expect(JSON.stringify(createArgs)).not.toContain("pravatar.cc");
  });
});
