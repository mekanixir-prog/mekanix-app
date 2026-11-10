// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  technicianFindUnique: vi.fn(),
  technicianUpdateMany: vi.fn(),
  jobCount: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    technician: {
      findUnique: mocks.technicianFindUnique,
      updateMany: mocks.technicianUpdateMany,
    },
    job: { count: mocks.jobCount },
  })),
}));

import { PATCH } from "@/app/api/technicians/[id]/availability/route";

let technician: Record<string, any>;

const makeRequest = (body: Record<string, unknown>) => new Request(
  "https://mekanix.test/api/technicians/technician-1/availability",
  {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer valid-token" },
    body: JSON.stringify(body),
  }
);

const context = { params: Promise.resolve({ id: "technician-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  technician = {
    id: "technician-1",
    userId: "user-1",
    status: "OFFLINE",
    availableNow: false,
    verified: true,
    lat: null,
    lng: null,
    user: { id: "user-1", role: "TECHNICIAN", status: "ACTIVE" },
  };
  mocks.requireAuth.mockResolvedValue({ userId: "user-1", role: "TECHNICIAN" });
  mocks.technicianFindUnique.mockImplementation(async () => ({ ...technician, user: { ...technician.user } }));
  mocks.technicianUpdateMany.mockResolvedValue({ count: 1 });
  mocks.jobCount.mockResolvedValue(0);
});

describe("technician availability state transition", () => {
  it("allows the profile owner to go online only with verified status and valid GPS coordinates", async () => {
    const response = await PATCH(makeRequest({ availableNow: true, lat: 35.7, lng: 51.4 }), context);
    expect(response.status).toBe(200);
    expect(mocks.technicianUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "technician-1",
        userId: "user-1",
        status: "OFFLINE",
        availableNow: false,
        verified: true,
        user: { is: { status: "ACTIVE", role: "TECHNICIAN" } },
      },
      data: { status: "ONLINE", availableNow: true, lat: 35.7, lng: 51.4 },
    });
  });

  it("allows the owner to go offline when no active job exists", async () => {
    technician.status = "ONLINE";
    technician.availableNow = true;
    const response = await PATCH(makeRequest({ availableNow: false }), context);
    expect(response.status).toBe(200);
    expect(mocks.technicianUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "ONLINE", availableNow: true }),
      data: { status: "OFFLINE", availableNow: false },
    }));
  });

  it("rejects a technician who tries to change another technician's availability", async () => {
    technician.userId = "another-user";
    const response = await PATCH(makeRequest({ availableNow: true, lat: 35.7, lng: 51.4 }), context);
    expect(response.status).toBe(403);
    expect(mocks.technicianUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects online activation for an unverified or suspended technician", async () => {
    technician.verified = false;
    const response = await PATCH(makeRequest({ availableNow: true, lat: 35.7, lng: 51.4 }), context);
    expect(response.status).toBe(409);
    expect(mocks.technicianUpdateMany).not.toHaveBeenCalled();
  });

  it("requires a valid GPS position before going online", async () => {
    const response = await PATCH(makeRequest({ availableNow: true, lat: 91, lng: 51.4 }), context);
    expect(response.status).toBe(400);
    expect(mocks.technicianUpdateMany).not.toHaveBeenCalled();
  });

  it("prevents availability changes while the technician has an active job", async () => {
    mocks.jobCount.mockResolvedValue(1);
    const response = await PATCH(makeRequest({ availableNow: false }), context);
    expect(response.status).toBe(409);
    expect(mocks.technicianUpdateMany).not.toHaveBeenCalled();
  });

  it("does not allow a non-technician role to use the availability endpoint", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "customer-1", role: "CUSTOMER" });
    const response = await PATCH(makeRequest({ availableNow: true, lat: 35.7, lng: 51.4 }), context);
    expect(response.status).toBe(403);
    expect(mocks.technicianFindUnique).not.toHaveBeenCalled();
  });
});
