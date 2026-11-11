// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  technicianFindUnique: vi.fn(),
  applicationFindUnique: vi.fn(),
  applicationFindFirst: vi.fn(),
  applicationUpdateMany: vi.fn(),
  applicationCreate: vi.fn(),
  rateLimitAsync: vi.fn(),
  getClientId: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    user: { findUnique: mocks.userFindUnique },
    technician: { findUnique: mocks.technicianFindUnique },
    mechanicApplication: {
      findUnique: mocks.applicationFindUnique,
      findFirst: mocks.applicationFindFirst,
      updateMany: mocks.applicationUpdateMany,
      create: mocks.applicationCreate,
    },
  })),
}));
vi.mock("@/lib/api-helpers", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: mocks.rateLimitAsync,
  getClientId: mocks.getClientId,
  RATE_LIMITS: { MECHANIC_APPLICATION: { max: 3, windowMs: 3_600_000 } },
}));
vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
  sanitizeInput: vi.fn(),
  FORBIDDEN_FIELDS: [],
}));

import { POST } from "@/app/api/mechanic-applications/route";

const request = () => new Request("https://mekanix.test/api/mechanic-applications", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    fullName: "Applicant Name",
    phone: "+989121234567",
    city: "Tabriz",
    specialties: ["hydraulics"],
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.technicianFindUnique.mockResolvedValue(null);
  mocks.applicationFindUnique.mockResolvedValue(null);
  mocks.applicationFindFirst.mockResolvedValue(null);
  mocks.applicationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.applicationCreate.mockResolvedValue({ id: "application-new", status: "PENDING" });
  mocks.getClientId.mockReturnValue("203.0.113.10");
  mocks.rateLimitAsync.mockResolvedValue({ success: true, resetMs: 3_600_000 });
});

describe("public mechanic application resubmission state guard", () => {
  it.each(["PENDING", "APPROVING", "REJECTING", "APPROVED"])(
    "does not reset an application in %s back to PENDING",
    async (status) => {
      mocks.applicationFindFirst.mockResolvedValue({
        id: "application-1",
        status,
      });

      const response = await POST(request());
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.status).toBe(status);
      expect(mocks.applicationUpdateMany).not.toHaveBeenCalled();
      expect(mocks.applicationCreate).not.toHaveBeenCalled();
    }
  );

  it.each(["REJECTED", "ON_HOLD"])(
    "reopens a %s application with a compare-and-set transition",
    async (status) => {
      mocks.applicationFindFirst.mockResolvedValue({
        id: "application-1",
        status,
      });
      mocks.applicationFindUnique.mockResolvedValue({
        id: "application-1",
        status: "PENDING",
      });

      const response = await POST(request());
      expect(response.status).toBe(200);
      expect(mocks.applicationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "application-1", status },
        data: expect.objectContaining({
          status: "PENDING",
          reviewerId: null,
          reviewedAt: null,
          adminNotes: null,
        }),
      }));
      expect(mocks.applicationCreate).not.toHaveBeenCalled();
    }
  );

  it("creates a new pending application when no prior application exists", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.applicationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "PENDING",
        phone: "+989121234567",
        userId: null,
      }),
    }));
  });

  it("does not allow a suspended or privileged account to apply as a mechanic", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      role: "ADMIN",
      status: "ACTIVE",
    });

    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.applicationFindFirst).not.toHaveBeenCalled();
    expect(mocks.applicationCreate).not.toHaveBeenCalled();
  });

  it("returns a conflict when a concurrent submission wins the unique phone constraint", async () => {
    mocks.applicationFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "application-winner", status: "PENDING" });
    mocks.applicationCreate.mockRejectedValueOnce({ code: "P2002" });

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.status).toBe("PENDING");
    expect(mocks.applicationCreate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the production rate-limit store is unavailable", async () => {
    mocks.rateLimitAsync.mockResolvedValue({ success: false, resetMs: 60_000, unavailable: true });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.applicationCreate).not.toHaveBeenCalled();
  });

  it("rejects excessive application submissions before database work", async () => {
    mocks.rateLimitAsync.mockResolvedValue({ success: false, resetMs: 45_000 });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.applicationCreate).not.toHaveBeenCalled();
  });
});
