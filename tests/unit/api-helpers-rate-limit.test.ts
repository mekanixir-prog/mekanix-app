// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimitAsync: vi.fn(),
  getClientId: vi.fn(),
  getSessionFromRequest: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: mocks.rateLimitAsync,
  getClientId: mocks.getClientId,
  rateLimit: vi.fn(() => ({ success: true, resetMs: 60_000 })),
}));
vi.mock("@/lib/auth", () => ({
  getSessionFromRequest: mocks.getSessionFromRequest,
}));

import { requireAuth } from "@/lib/api-helpers";

const req = new Request("https://mekanix.test/api/private", {
  headers: { "x-forwarded-for": "203.0.113.20" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClientId.mockReturnValue("203.0.113.20");
  mocks.rateLimitAsync.mockResolvedValue({ success: true, resetMs: 60_000 });
  mocks.getSessionFromRequest.mockResolvedValue({ userId: "u1", role: "CUSTOMER" });
});

describe("requireAuth shared rate-limit failure behavior", () => {
  it("returns 503 before session lookup when the shared counter is unavailable", async () => {
    mocks.rateLimitAsync.mockResolvedValue({
      success: false, resetMs: 30_000, unavailable: true,
    });
    const response = await requireAuth(req);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
    expect((response as Response).headers.get("Retry-After")).toBe("30");
    expect(mocks.getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("returns 429 when the shared counter denies an over-limit request", async () => {
    mocks.rateLimitAsync.mockResolvedValue({ success: false, resetMs: 45_000 });
    const response = await requireAuth(req);
    expect((response as Response).status).toBe(429);
    expect((response as Response).headers.get("Retry-After")).toBe("45");
    expect(mocks.getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("checks the session only after the shared rate-limit budget allows the request", async () => {
    const response = await requireAuth(req);
    expect(response).toEqual({ userId: "u1", role: "CUSTOMER" });
    expect(mocks.getSessionFromRequest).toHaveBeenCalledTimes(1);
  });
});
