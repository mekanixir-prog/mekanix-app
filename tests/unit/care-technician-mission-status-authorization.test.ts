// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  technician: vi.fn(),
  db: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  timelineCreate: vi.fn(),
  validateTransition: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({ getTechnicianFromSession: mocks.technician }));
vi.mock("@/lib/db-access", () => ({ getDbForLib: mocks.db }));
vi.mock("@/lib/care-auth", () => ({
  requireBookingParticipant: vi.fn(),
  validateTransition: mocks.validateTransition,
}));

import { PATCH } from "@/app/api/care/technician/missions/[id]/route";

function request(status = "EN_ROUTE") {
  return new Request("https://mekanix.test/api/care/technician/missions/booking-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "tech-user", role: "TECHNICIAN" });
  mocks.technician.mockResolvedValue({ id: "tech-1", userId: "tech-user" });
  mocks.validateTransition.mockReturnValue(null);
  mocks.findUnique.mockResolvedValue({
    id: "booking-1",
    status: "ASSIGNED",
    technicianId: "tech-1",
    updatedAt: new Date("2026-11-26T10:00:00.000Z"),
  });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.timelineCreate.mockResolvedValue({});
  mocks.db.mockResolvedValue({
    serviceBooking: { findUnique: mocks.findUnique },
    $transaction: vi.fn(async (callback) => callback({
      serviceBooking: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
      serviceTimelineEvent: { create: mocks.timelineCreate },
    })),
  });
});

describe("PATCH /api/care/technician/missions/[id] assignment-bound CAS", () => {
  it("includes the authenticated technician ID in the conditional status write", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const response = await PATCH(request(), { params: Promise.resolve({ id: "booking-1" }) });

    expect(response.status).toBe(409);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: "ASSIGNED",
        updatedAt: new Date("2026-11-26T10:00:00.000Z"),
        technicianId: "tech-1",
      },
      data: { status: "EN_ROUTE", updatedAt: expect.any(Date) },
    });
    expect(mocks.timelineCreate).not.toHaveBeenCalled();
  });

  it("denies a technician whose assignment has already changed before the read", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "booking-1",
      status: "ASSIGNED",
      technicianId: "another-tech",
    });
    const response = await PATCH(request(), { params: Promise.resolve({ id: "booking-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.timelineCreate).not.toHaveBeenCalled();
  });

  it.each(["FLEET_MANAGER", "PARTNER"] as const)(
    "denies unscoped role %s before opening the database",
    async (role) => {
      mocks.auth.mockResolvedValue({ userId: "unscoped-user", role });
      const response = await PATCH(request(), { params: Promise.resolve({ id: "booking-1" }) });

      expect(response.status).toBe(403);
      expect(mocks.db).not.toHaveBeenCalled();
      expect(mocks.findUnique).not.toHaveBeenCalled();
    },
  );
});
