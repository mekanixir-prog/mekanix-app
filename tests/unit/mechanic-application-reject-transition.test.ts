// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  requireRole: vi.fn(),
  updateMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  verifySession: mocks.verifySession,
  requireRole: mocks.requireRole,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    mechanicApplication: {
      updateMany: mocks.updateMany,
      findUnique: mocks.findUnique,
    },
  })),
}));

import { POST } from "@/app/api/mechanic-applications/[id]/reject/route";

function request() {
  return new Request("https://mekanix.test/api/mechanic-applications/app-1/reject", {
    method: "POST",
    headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
    body: JSON.stringify({ notes: "Not eligible" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifySession.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.requireRole.mockReturnValue(null);
});

describe("POST /api/mechanic-applications/[id]/reject", () => {
  it("rejects only a pending application using compare-and-set", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue({ id: "app-1", status: "REJECTED" });

    const response = await POST(request(), { params: Promise.resolve({ id: "app-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "app-1", status: "PENDING" },
      data: expect.objectContaining({ status: "REJECTED", adminNotes: "Not eligible" }),
    }));
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: "app-1" } });
  });

  it("does not overwrite an already approved application", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue({ id: "app-1", status: "APPROVED" });

    const response = await POST(request(), { params: Promise.resolve({ id: "app-1" }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "APPROVED" });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "app-1", status: "PENDING" },
    }));
  });

  it("returns 404 when the application does not exist", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue(null);

    const response = await POST(request(), { params: Promise.resolve({ id: "missing" }) });

    expect(response.status).toBe(404);
  });
});
