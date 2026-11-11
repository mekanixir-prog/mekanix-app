// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  requireRole: vi.fn(),
  applicationFindUnique: vi.fn(),
  applicationUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdateMany: vi.fn(),
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
      updateMany: mocks.applicationUpdateMany,
    },
    user: {
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
      updateMany: mocks.userUpdateMany,
    },
    technician: {
      findUnique: mocks.technicianFindUnique,
      create: mocks.technicianCreate,
    },
    notification: { create: mocks.notificationCreate },
  })),
}));

import { POST as approve } from "@/app/api/mechanic-applications/[id]/approve/route";
import { POST as reject } from "@/app/api/mechanic-applications/[id]/reject/route";

let application: Record<string, any>;
let currentUser: Record<string, any> | null;
let currentTechnician: Record<string, any> | null;

function makeRequest(action: "approve" | "reject") {
  return new Request(`https://mekanix.test/api/mechanic-applications/application-1/${action}`, {
    method: "POST",
    headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
    body: JSON.stringify({ notes: "Reviewed by admin" }),
  });
}

const context = { params: Promise.resolve({ id: "application-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  application = {
    id: "application-1",
    status: "PENDING",
    phone: "+989121234567",
    fullName: "Test Technician",
    email: null,
    specialties: JSON.stringify(["hydraulics"]),
    certifications: null,
    experienceYears: 4,
    bio: "Experienced mechanic",
    city: "Tabriz",
    userId: null,
    reviewerId: null,
  };
  currentUser = null;
  currentTechnician = null;

  mocks.verifySession.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.requireRole.mockReturnValue(null);
  mocks.applicationFindUnique.mockImplementation(async () => ({ ...application }));
  // Model Prisma updateMany's compare-and-set behavior: one status transition
  // wins, and every competing transition observes count=0.
  mocks.applicationUpdateMany.mockImplementation(async ({ where, data }) => {
    if (application.id !== where.id || application.status !== where.status) return { count: 0 };
    Object.assign(application, data);
    return { count: 1 };
  });
  mocks.userFindUnique.mockImplementation(async () => currentUser ? { ...currentUser } : null);
  mocks.userCreate.mockImplementation(async ({ data }) => {
    currentUser = { id: "user-1", status: "ACTIVE", ...data };
    return { ...currentUser };
  });
  mocks.userUpdateMany.mockImplementation(async ({ where, data }) => {
    if (!currentUser || currentUser.id !== where.id || currentUser.role !== where.role || currentUser.status === "SUSPENDED") {
      return { count: 0 };
    }
    Object.assign(currentUser, data);
    return { count: 1 };
  });
  mocks.technicianFindUnique.mockImplementation(async () => currentTechnician ? { ...currentTechnician } : null);
  mocks.technicianCreate.mockImplementation(async ({ data }) => {
    currentTechnician = { id: "technician-1", ...data };
    return { ...currentTechnician };
  });
  mocks.notificationCreate.mockResolvedValue({ id: "notification-1" });
});

describe("mechanic application review state machine", () => {
  it("atomically allows only one of concurrent approval and rejection to claim a pending application", async () => {
    const [approveResponse, rejectResponse] = await Promise.all([
      approve(makeRequest("approve"), context),
      reject(makeRequest("reject"), context),
    ]);

    expect([approveResponse.status, rejectResponse.status].filter((status) => status === 200)).toHaveLength(1);
    expect([approveResponse.status, rejectResponse.status].filter((status) => status === 409)).toHaveLength(1);
    expect(["APPROVED", "REJECTED"]).toContain(application.status);

    if (application.status === "APPROVED") {
      expect(currentUser?.role).toBe("TECHNICIAN");
      expect(currentTechnician?.status).toBe("OFFLINE");
    } else {
      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(currentTechnician).toBeNull();
    }
  });

  it("approves with a durable claim, keeps the phone unverified, and activates no dispatch location", async () => {
    const response = await approve(makeRequest("approve"), context);
    expect(response.status).toBe(200);
    expect(application.status).toBe("APPROVED");
    expect(currentUser?.role).toBe("TECHNICIAN");
    expect(currentUser?.phoneVerified).toBe(false);
    expect(currentTechnician?.status).toBe("OFFLINE");
    expect(currentTechnician?.availableNow).toBe(false);
    expect(currentTechnician?.lat).toBeNull();
    expect(currentTechnician?.lng).toBeNull();
    expect(currentTechnician).not.toHaveProperty("serviceAreas");
    expect(mocks.applicationUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "application-1", status: "PENDING" },
      data: { status: "APPROVING", reviewerId: "admin-1" },
    });
  });

  it("resumes an interrupted approval that was already claimed", async () => {
    application.status = "APPROVING";
    application.reviewerId = "admin-1";

    const response = await approve(makeRequest("approve"), context);
    expect(response.status).toBe(200);
    expect(application.status).toBe("APPROVED");
    expect(mocks.applicationUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.applicationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "application-1", status: "APPROVING" },
      data: expect.objectContaining({ status: "APPROVED" }),
    }));
  });

  it("resumes an interrupted rejection that was already claimed", async () => {
    application.status = "REJECTING";
    application.reviewerId = "admin-1";

    const response = await reject(makeRequest("reject"), context);
    expect(response.status).toBe(200);
    expect(application.status).toBe("REJECTED");
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.technicianCreate).not.toHaveBeenCalled();
  });

  it("does not let rejection overwrite an approval claim", async () => {
    application.status = "APPROVING";
    const response = await reject(makeRequest("reject"), context);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.status).toBe("APPROVING");
    expect(application.status).toBe("APPROVING");
  });

  it("does not let approval overwrite a rejection claim", async () => {
    application.status = "REJECTING";
    const response = await approve(makeRequest("approve"), context);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.status).toBe("REJECTING");
    expect(application.status).toBe("REJECTING");
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("treats a retry of an already completed rejection as idempotent success", async () => {
    application.status = "REJECTED";
    const response = await reject(makeRequest("reject"), context);
    expect(response.status).toBe(200);
    expect(mocks.applicationUpdateMany).not.toHaveBeenCalled();
  });

  it("repairs an already approved application after an interrupted account promotion", async () => {
    application.status = "APPROVED";
    application.userId = "user-1";
    currentUser = {
      id: "user-1",
      phone: application.phone,
      role: "CUSTOMER",
      status: "ACTIVE",
      phoneVerified: false,
    };

    const response = await approve(makeRequest("approve"), context);
    expect(response.status).toBe(200);
    expect(application.status).toBe("APPROVED");
    expect(currentUser?.role).toBe("TECHNICIAN");
    expect(currentTechnician?.status).toBe("OFFLINE");
    expect(mocks.applicationUpdateMany).not.toHaveBeenCalled();
  });

  it("reuses a legacy local-format user when approving a canonical Iranian application", async () => {
    currentUser = {
      id: "user-1",
      phone: "09121234567",
      role: "CUSTOMER",
      status: "ACTIVE",
      phoneVerified: false,
    };
    mocks.userFindUnique.mockImplementation(async ({ where }) => {
      if (where.id === "user-1") return { ...currentUser! };
      if (where.phone === "09121234567") return { ...currentUser! };
      return null;
    });

    const response = await approve(makeRequest("approve"), context);

    expect(response.status).toBe(200);
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(application.userId).toBe("user-1");
    expect(currentUser?.role).toBe("TECHNICIAN");
  });
});
