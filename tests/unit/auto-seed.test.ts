import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDbForLib: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: mocks.getDbForLib,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: mocks.execSync };
});

describe("auto-seed safety", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
  });

  it("does not inspect, push schema, or seed from production startup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { ensureSeedData } = await import("@/lib/auto-seed");

    await ensureSeedData();

    expect(mocks.getDbForLib).not.toHaveBeenCalled();
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it("never passes --accept-data-loss to automatic schema setup", async () => {
    const db = {
      user: {
        count: vi.fn()
          .mockRejectedValueOnce(new Error("User table missing"))
          .mockResolvedValueOnce(1),
      },
    };
    mocks.getDbForLib.mockResolvedValue(db);
    const { ensureSeedData } = await import("@/lib/auto-seed");

    await ensureSeedData();

    expect(mocks.execSync).toHaveBeenCalledTimes(1);
    expect(mocks.execSync.mock.calls[0][0]).toBe("bunx prisma db push");
    expect(mocks.execSync.mock.calls[0][0]).not.toContain("--accept-data-loss");
  });
});
