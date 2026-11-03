import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDbForLib: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: mocks.getDbForLib,
}));

import {
  AUTO_SEED_SCHEMA_PUSH_COMMAND,
  ensureSeedData,
  runAutoSeedSchemaPush,
} from "@/lib/auto-seed";

describe("auto-seed safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
  });

  it("does not inspect, push schema, or seed from production startup", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await ensureSeedData();

    expect(mocks.getDbForLib).not.toHaveBeenCalled();
  });

  it("uses only the non-destructive schema push command", () => {
    const execute = vi.fn();

    runAutoSeedSchemaPush(execute as any);

    expect(AUTO_SEED_SCHEMA_PUSH_COMMAND).toBe("bunx prisma db push");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe("bunx prisma db push");
    expect(execute.mock.calls[0][0]).not.toContain("--accept-data-loss");
    expect(execute.mock.calls[0][1]).toMatchObject({ stdio: "inherit" });
  });
});
