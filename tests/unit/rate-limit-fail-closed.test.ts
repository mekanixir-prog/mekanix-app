// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDbForLib } = vi.hoisted(() => ({
  mockGetDbForLib: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: mockGetDbForLib,
}));

import { rateLimitAsync } from "@/lib/rate-limit";

describe("rateLimitAsync production failure behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows a request when the shared D1 counter is incremented", async () => {
    const windowMs = 60_000;
    mockGetDbForLib.mockResolvedValue({
      rateLimit: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          expiresAt: new Date(Date.now() + windowMs),
        }),
      },
    });

    vi.stubEnv("NODE_ENV", "production");
    const result = await rateLimitAsync("test:d1-allow", 5, windowMs);

    expect(result.success).toBe(true);
    expect(result.unavailable).toBeUndefined();
  });

  it("denies a request when the shared D1 counter has reached its limit", async () => {
    const windowMs = 60_000;
    mockGetDbForLib.mockResolvedValue({
      rateLimit: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          expiresAt: new Date(Date.now() + windowMs),
        }),
      },
    });

    vi.stubEnv("NODE_ENV", "production");
    const result = await rateLimitAsync("test:d1-deny", 5, windowMs);

    expect(result.success).toBe(false);
    expect(result.unavailable).toBeUndefined();
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
