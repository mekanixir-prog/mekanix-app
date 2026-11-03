import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getDbForLib: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: mocks.getDbForLib,
}));

import { GET } from "@/app/api/dashboard/route";

describe("GET /api/dashboard authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["CUSTOMER", "TECHNICIAN"])(
    "denies %s sessions before querying platform analytics",
    async (role) => {
      mocks.requireAuth.mockResolvedValue({
        userId: "user-1",
        role,
      });

      const response = await GET(
        new Request("http://localhost/api/dashboard"),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "دسترسی مجاز نیست",
      });
      expect(mocks.getDbForLib).not.toHaveBeenCalled();
    },
  );
});
