// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  customerFindUnique: vi.fn(),
  technicianFindUnique: vi.fn(),
  vehicleFindUnique: vi.fn(),
  scheduleFindMany: vi.fn(),
  requireVehicleOwner: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    customer: { findUnique: mocks.customerFindUnique },
    technician: { findUnique: mocks.technicianFindUnique },
    vehicle: { findUnique: mocks.vehicleFindUnique },
    maintenanceSchedule: { findMany: mocks.scheduleFindMany },
  })),
}));
vi.mock("@/lib/auth", () => ({
  sanitizeInput: vi.fn((value) => value),
  ALLOWED_FIELDS: { maintenance: {} },
  requireVehicleOwner: mocks.requireVehicleOwner,
}));

import { GET } from "@/app/api/maintenance/route";

const request = (vehicleId?: string) => new Request(
  `https://mekanix.test/api/maintenance${vehicleId ? `?vehicleId=${vehicleId}` : ""}`
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: "user-1", role: "CUSTOMER" });
  mocks.customerFindUnique.mockResolvedValue({ id: "customer-1" });
  mocks.technicianFindUnique.mockResolvedValue({ id: "technician-1" });
  mocks.vehicleFindUnique.mockResolvedValue({ customerId: "customer-1" });
  mocks.scheduleFindMany.mockResolvedValue([]);
});

describe("GET /api/maintenance role and object scoping", () => {
  it.each(["FLEET_MANAGER", "PARTNER", "SUPER_ADMIN"])(
    "denies %s until an explicit maintenance scope exists",
    async (role) => {
      mocks.requireAuth.mockResolvedValue({ userId: "user-1", role });
      const response = await GET(request());
      expect(response.status).toBe(403);
      expect(mocks.scheduleFindMany).not.toHaveBeenCalled();
    },
  );

  it("limits customers to their own vehicles", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "customer-user", role: "CUSTOMER" });
    await GET(request());
    expect(mocks.scheduleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { vehicle: { customerId: "customer-1" } },
    }));
  });

  it("limits technicians to vehicles in their assigned jobs", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "tech-user", role: "TECHNICIAN" });
    await GET(request());
    expect(mocks.scheduleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { vehicle: { serviceRequests: { some: { job: { technicianId: "technician-1" } } } } },
    }));
  });

  it("allows ADMIN to inspect all schedules", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "admin-user", role: "ADMIN" });
    await GET(request());
    expect(mocks.scheduleFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});
