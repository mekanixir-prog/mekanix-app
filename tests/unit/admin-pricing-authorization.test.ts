// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdmin: vi.fn(),
  csrf: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: (...args: unknown[]) => mocks.getAdmin(...args),
  hasValidAdminCookieCsrf: (...args: unknown[]) => mocks.csrf(...args),
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    platformSetting: {
      findUnique: (...args: unknown[]) => mocks.findUnique(...args),
      updateMany: (...args: unknown[]) => mocks.updateMany(...args),
      create: (...args: unknown[]) => mocks.create(...args),
    },
  })),
}));
vi.mock("@/lib/admin-api", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.audit(...args),
}));

import { GET, PUT } from "@/app/api/admin-panel/pricing/route";
import { DEFAULT_PRICING_RATE_CARD } from "@/lib/pricing-rate-card";

function putRequest(body: unknown) {
  return new Request("https://mekanix.test/api/admin-panel/pricing", {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "https://mekanix.test" },
    body: JSON.stringify(body),
  });
}

describe("admin pricing authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.csrf.mockReturnValue(true);
    mocks.findUnique.mockResolvedValue(null);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.create.mockResolvedValue({});
    mocks.audit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows ordinary ADMIN to read the rate card", async () => {
    mocks.getAdmin.mockResolvedValue({ adminId: "admin-1", username: "admin", role: "ADMIN" });
    const response = await GET(new Request("https://mekanix.test/api/admin-panel/pricing"));
    expect(response.status).toBe(200);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("denies ordinary ADMIN rate-card mutations before reading or writing settings", async () => {
    mocks.getAdmin.mockResolvedValue({ adminId: "admin-1", username: "admin", role: "ADMIN" });
    const response = await PUT(putRequest({}));
    expect(response.status).toBe(403);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN to persist a valid versioned rate card with strict audit", async () => {
    mocks.getAdmin.mockResolvedValue({ adminId: "root-1", username: "root", role: "SUPER_ADMIN" });
    const response = await PUT(putRequest({
      expectedVersion: 1,
      rateCard: DEFAULT_PRICING_RATE_CARD,
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.current.version).toBe(2);
    expect(body.current.updatedBy).toBe("root");
    expect(body.history).toHaveLength(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ATTEMPT_UPDATE_PRICING_RATE_CARD",
      strict: true,
    }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("requires SUPER_ADMIN before validating a pricing mutation payload", async () => {
    mocks.getAdmin.mockResolvedValue({ adminId: "root-1", username: "root", role: "SUPER_ADMIN" });
    const response = await PUT(putRequest({}));
    expect(response.status).toBe(400);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
