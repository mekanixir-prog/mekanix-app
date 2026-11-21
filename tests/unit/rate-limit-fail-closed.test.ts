// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDbForLib } = vi.hoisted(() => ({
  mockGetDbForLib: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: mockGetDbForLib,
}));

import { getClientId, rateLimitAsync } from "@/lib/rate-limit";

describe("getClientId trusted proxy extraction", () => {
  it("prefers Cloudflare's visitor IP over a spoofed X-Forwarded-For prefix", () => {
    const req = new Request("https://mekanix.test", {
      headers: {
        "cf-connecting-ip": "198.51.100.27",
        "x-forwarded-for": "203.0.113.99, 198.51.100.27",
      },
    });
    expect(getClientId(req)).toBe("198.51.100.27");
  });

  it("uses the right-most X-Forwarded-For entry when Cloudflare's header is absent", () => {
    const req = new Request("https://mekanix.test", {
      headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.27" },
    });
    expect(getClientId(req)).toBe("198.51.100.27");
  });

  it("does not trust x-real-ip when no trusted proxy address is present", () => {
    const req = new Request("https://mekanix.test", {
      headers: { "x-real-ip": "203.0.113.99" },
    });
    expect(getClientId(req)).toBe("anonymous");
  });

  it("uses an authenticated user id ahead of proxy headers", () => {
    const req = new Request("https://mekanix.test", {
      headers: { "cf-connecting-ip": "198.51.100.27" },
    });
    expect(getClientId(req, "user-123")).toBe("user-123");
  });
});

describe("rateLimitAsync production failure behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows a request when the atomic shared counter returns a count within the limit", async () => {
    const windowMs = 60_000;
    const queryRaw = vi.fn().mockResolvedValue([{
      count: 1,
      expiresAt: new Date(Date.now() + windowMs),
    }]);
    mockGetDbForLib.mockResolvedValue({ $queryRaw: queryRaw });

    vi.stubEnv("NODE_ENV", "production");
    const result = await rateLimitAsync("test:d1-allow", 5, windowMs);

    expect(result.success).toBe(true);
    expect(result.unavailable).toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("denies a request when the atomic shared counter returns max+1", async () => {
    const windowMs = 60_000;
    const queryRaw = vi.fn().mockResolvedValue([{
      count: 6,
      expiresAt: new Date(Date.now() + windowMs),
    }]);
    mockGetDbForLib.mockResolvedValue({ $queryRaw: queryRaw });

    vi.stubEnv("NODE_ENV", "production");
    const result = await rateLimitAsync("test:d1-deny", 5, windowMs);

    expect(result.success).toBe(false);
    expect(result.unavailable).toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("fails closed with an unavailable result when D1 is down in production", async () => {
    const windowMs = 60_000;
    mockGetDbForLib.mockRejectedValue(new Error("D1 unavailable"));

    vi.stubEnv("NODE_ENV", "production");
    const result = await rateLimitAsync("test:prod-outage", 5, windowMs);

    expect(result).toEqual({
      success: false,
      resetMs: windowMs,
      unavailable: true,
    });
  });

  it("keeps the in-memory fallback in non-production development", async () => {
    mockGetDbForLib.mockRejectedValue(new Error("local database unavailable"));

    vi.stubEnv("NODE_ENV", "test");
    const key = `test:dev-fallback:${Date.now()}`;

    const first = await rateLimitAsync(key, 1, 60_000);
    const second = await rateLimitAsync(key, 1, 60_000);

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(first.unavailable).toBeUndefined();
  });
});
