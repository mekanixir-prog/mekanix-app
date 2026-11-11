// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  technicianFindMany: vi.fn(),
  technicianFindUnique: vi.fn(),
  verifySession: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    technician: {
      findMany: mocks.technicianFindMany,
      findUnique: mocks.technicianFindUnique,
    },
  })),
}));
vi.mock("@/lib/api-helpers", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn(), verifySession: mocks.verifySession }));

import { GET as listTechnicians } from "@/app/api/technicians/route";
import { GET as getTechnician } from "@/app/api/technicians/[id]/route";

const publicTechnicianFixture = () => ({
  id: "technician-1",
  userId: "user-1",
  status: "ONLINE",
  availableNow: true,
  verified: true,
  lat: 0,
  lng: 1,
  hourlyRate: "100",
  travelFeeBase: "10",
  financialUnitStatus: "UNVERIFIED",
  rating: 4.8,
  reviewCount: 12,
  completedJobs: 30,
  responseMins: 15,
  level: "GOLD",
  bio: "Hydraulic technician",
  experienceYears: 10,
  user: {
    id: "user-1",
    name: "Technician",
    avatar: null,
    role: "TECHNICIAN",
    status: "ACTIVE",
  },
  specialties: [{ id: "specialty-1", category: "hydraulics", label: "Hydraulics" }],
  certifications: [{ id: "cert-1", name: "Hydraulics", issuer: "Test", year: 2024, verified: true }],
  serviceAreas: [{ id: "area-1", name: "Tabriz", lat: 38.08, lng: 46.29, radiusKm: 25 }],
  reviews: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifySession.mockResolvedValue(null);
});

describe("public technician discovery privacy", () => {
  it("returns server-computed distance and never exposes exact technician or service-area coordinates", async () => {
    mocks.technicianFindMany.mockResolvedValue([publicTechnicianFixture()]);

    const response = await listTechnicians(new Request("https://mekanix.test/api/technicians?lat=0&lng=0"));
    expect(response.status).toBe(200);
    const [payload] = await response.json();

    expect(mocks.technicianFindMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ user: { select: { name: true, avatar: true } } }),
      where: expect.objectContaining({
        availableNow: true,
        verified: true,
        status: "ONLINE",
        user: { is: { status: "ACTIVE", role: "TECHNICIAN" } },
      }),
    }));
    expect(payload).not.toHaveProperty("userId");
    expect(payload.user).toEqual({ name: "Technician", avatar: null });
    expect(payload.lat).toBeNull();
    expect(payload.lng).toBeNull();
    expect(payload.distanceKm).toBeCloseTo(111.2, 1);
    expect(payload.serviceAreas).toEqual([{ name: "Tabriz", radiusKm: 25 }]);
    expect(JSON.stringify(payload)).not.toContain("38.08");
    expect(JSON.stringify(payload)).not.toContain("46.29");
  });

  it("rejects invalid or incomplete customer coordinates before querying technicians", async () => {
    const response = await listTechnicians(new Request("https://mekanix.test/api/technicians?lat=91"));
    expect(response.status).toBe(400);
    expect(mocks.technicianFindMany).not.toHaveBeenCalled();
  });

  it("does not expose completed job request, customer, or vehicle records in public profiles", async () => {
    mocks.technicianFindUnique.mockResolvedValue(publicTechnicianFixture());

    const response = await getTechnician(
      new Request("https://mekanix.test/api/technicians/technician-1"),
      { params: Promise.resolve({ id: "technician-1" }) }
    );
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(mocks.technicianFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ user: { select: { id: true, name: true, avatar: true, role: true, status: true } } }),
      where: { id: "technician-1" },
    }));
    expect(payload).not.toHaveProperty("jobsAssigned");
    expect(payload).not.toHaveProperty("userId");
    expect(payload.user).toEqual({ name: "Technician", avatar: null });
    expect(payload.lat).toBeNull();
    expect(payload.lng).toBeNull();
    expect(payload.serviceAreas).toEqual([{ name: "Tabriz", radiusKm: 25 }]);
    expect(JSON.stringify(payload)).not.toContain("38.08");
    expect(JSON.stringify(payload)).not.toContain("46.29");
  });

  it("allows an authenticated technician owner to read their own offline profile safely", async () => {
    const fixture = publicTechnicianFixture();
    fixture.status = "OFFLINE";
    fixture.availableNow = false;
    mocks.technicianFindUnique.mockResolvedValue(fixture);
    mocks.verifySession.mockResolvedValue({ userId: "user-1", role: "TECHNICIAN" });

    const response = await getTechnician(
      new Request("https://mekanix.test/api/technicians/technician-1", {
        headers: { authorization: "Bearer technician-token" },
      }),
      { params: Promise.resolve({ id: "technician-1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.user).toEqual({ name: "Technician", avatar: null });
    expect(payload.lat).toBeNull();
    expect(payload.lng).toBeNull();
    expect(payload).not.toHaveProperty("userId");
  });

  it("hides offline technician profiles from unauthenticated public requests", async () => {
    const fixture = publicTechnicianFixture();
    fixture.status = "OFFLINE";
    fixture.availableNow = false;
    mocks.technicianFindUnique.mockResolvedValue(fixture);

    const response = await getTechnician(
      new Request("https://mekanix.test/api/technicians/technician-1"),
      { params: Promise.resolve({ id: "technician-1" }) }
    );

    expect(response.status).toBe(404);
  });
});
