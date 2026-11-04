// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    adminUser: {
      count: mocks.count,
      create: mocks.create,
    },
  }),
}));

import { ensureDefaultAdmin } from "@/lib/admin-auth";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  mocks.count.mockResolvedValue(0);
  mocks.create.mockResolvedValue({ id: "admin-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("production admin bootstrap security", () => {
  it("does not create the initial admin with a missing or weak bootstrap password", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "short-pass");

    await ensureDefaultAdmin();

    expect(mocks.count).toHaveBeenCalledWith({
      where: { role: { in: ["ADMIN", "SUPER_ADMIN"] } },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates the initial admin only when the bootstrap password has at least 16 characters", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "a-long-unique-bootstrap-secret");

    await ensureDefaultAdmin();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.role).toBe("SUPER_ADMIN");
    expect(data.passwordHash).not.toBe("a-long-unique-bootstrap-secret");
    expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it("does not bootstrap a duplicate admin when a valid admin already exists", async () => {
    mocks.count.mockResolvedValue(1);
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "");

    await ensureDefaultAdmin();

    expect(mocks.create).not.toHaveBeenCalled();
  });
});
