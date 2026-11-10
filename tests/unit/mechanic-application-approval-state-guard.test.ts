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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifySession.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.requireRole.mockReturnValue(null);
});

describe("POST /api/mechanic-applications/[id]/approve state guard", () => {
  it.each(["APPROVED", "REJECTED", "ON_HOLD"])(
    "refuses to provision an application already in %s state",
    async (status) => {
      mocks.applicationFindUnique.mockResolvedValue({
        id: "application-1",
        status,
      });

      const request = new Request("https://mekanix.test/api/mechanic-applications/application-1/approve", {
        method: "POST",
        headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "application-1" }) });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.status).toBe(status);
      expect(mocks.userFindUnique).not.toHaveBeenCalled();
      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(mocks.userUpdate).not.toHaveBeenCalled();
      expect(mocks.technicianCreate).not.toHaveBeenCalled();
      expect(mocks.applicationUpdate).not.toHaveBeenCalled();
    }
  );
});
