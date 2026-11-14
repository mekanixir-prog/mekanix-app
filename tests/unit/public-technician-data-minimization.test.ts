// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    technician: {
      findMany: (...args: unknown[]) => mocks.findMany(...args),
      findUnique: (...args: unknown[]) => mocks.findUnique(...args),
    },
  })),
}));

import { GET as listTechnicians } from "@/app/api/technicians/route";
import { GET as getTechnician } from "@/app/api/technicians/[id]/route";

const privateHeavyFixture = {
  id: "tech-1",
  userId: "user-private-1",
  bio: "Heavy equipment technician",
  experienceYears: 8,
  completedJobs: 42,
  rating: 4.8,
  reviewCount: 17,
  hourlyRate: 500_000,
  travelFeeBase: 100_000,
  inspectionFee: 200_000,
  inspectionFeeHeavy: 500_000,
  financialUnitStatus: "VERIFIED_IRR",
  status: "ONLINE",
  verified: true,
  level: "GOLD",
  availableNow: true,
  responseMins: 12,
  lat: 35.71,
  lng: 51.41,
  heading: 90,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  user: { id: "user-private-1", name: "Technician", avatar: "/avatar.png", phone: "private-phone" },
  specialties: [{ id: "sp-1", category: "hydraulic", label: "Hydraulics", privateMeta: "hidden" }],
  certifications: [{ id: "cert-1", name: "Hydraulic Systems", issuer: "Institute", year: 2024, verified: true }],
  serviceAreas: [{ id: "area-1", name: "Tehran West", radiusKm: 25, lat: 35.7, lng: 51.3 }],
  reviews: [{
    id: "review-1", rating: 5, comment: "Excellent", tags: "fast", createdAt: new Date(),
    fromUser: { id: "customer-private-1", name: "Customer", avatar: "/customer.png", phone: "private-phone" },
  }],
  jobsAssigned: [{
    id: "job-private-1",
    request: {
      vehicle: {
        id: "vehicle-private-1", vin: "PRIVATE-VIN", plate: "PRIVATE-PLATE",
        location: "Private address", lat: 35.7, lng: 51.3, notes: "Private notes",
      },
    },
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([{ ...privateHeavyFixture }]);
  mocks.findUnique.mockResolvedValue({ ...privateHeavyFixture });
});

function expectPrivateFieldsRemoved(technician: any) {
  for (const field of ["userId", "lat", "lng", "heading", "financialUnitStatus", "jobsAssigned"]) {
    expect(technician).not.toHaveProperty(field);
  }
  expect(technician.user).toEqual({ name: "Technician", avatar: "/avatar.png" });
  expect(technician.serviceAreas[0]).toEqual({ id: "area-1", name: "Tehran West", radiusKm: 25 });
  expect(technician.reviews[0].fromUser).toEqual({ name: "Customer", avatar: "/customer.png" });
  expect(JSON.stringify(technician)).not.toContain("PRIVATE-VIN");
  expect(JSON.stringify(technician)).not.toContain("PRIVATE-PLATE");
  expect(JSON.stringify(technician)).not.toContain("Private address");
  expect(JSON.stringify(technician)).not.toContain("private-phone");
}

describe("public technician data minimization", () => {
  it("returns distance but never returns live technician coordinates or private relations in listing", async () => {
    const response = await listTechnicians(new Request("https://mekanix.test/api/technicians?lat=35.7&lng=51.4"));
    expect(response.status).toBe(200);
    const [technician] = await response.json();
    expect(technician.distanceKm).toBeGreaterThan(0);
    expectPrivateFieldsRemoved(technician);

    const query = mocks.findMany.mock.calls[0][0];
    expect(query.select.jobsAssigned).toBeUndefined();
    expect(query.select.lat).toBe(true);
    expect(query.select.lng).toBe(true);
    expect(query.select.serviceAreas.select.lat).toBeUndefined();
  });

  it("returns a safe public detail projection without job/customer vehicle data", async () => {
    const response = await getTechnician(
      new Request("https://mekanix.test/api/technicians/tech-1"),
      { params: Promise.resolve({ id: "tech-1" }) },
    );
    expect(response.status).toBe(200);
    const technician = await response.json();
    expectPrivateFieldsRemoved(technician);

    const query = mocks.findUnique.mock.calls[0][0];
    expect(query.select.jobsAssigned).toBeUndefined();
    expect(query.select.lat).toBeUndefined();
    expect(query.select.lng).toBeUndefined();
  });

  it("rejects partial or malformed coordinates instead of calculating an invalid distance", async () => {
    const partial = await listTechnicians(new Request("https://mekanix.test/api/technicians?lat=35.7"));
    expect(partial.status).toBe(400);
    const malformed = await listTechnicians(new Request("https://mekanix.test/api/technicians?lat=abc&lng=51.4"));
    expect(malformed.status).toBe(400);
  });
});
