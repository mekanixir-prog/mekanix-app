// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("mechanic application unique phone constraint", () => {
  const runId = crypto.randomUUID().replace(/-/g, "");
  const phone = `+9891${runId.slice(0, 9)}`;
  let db: Awaited<ReturnType<typeof getDbForLib>> | null = null;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    db = await getDbForLib();
  });

  afterAll(async () => {
    if (db) await db.mechanicApplication.deleteMany({ where: { phone } });
    vi.unstubAllEnvs();
  });

  it("allows exactly one concurrent first application for a phone number", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 40 }, (_, index) =>
        db!.mechanicApplication.create({
          data: {
            code: `APP-UNIQUE-${runId}-${index}`,
            fullName: `Concurrent Applicant ${index}`,
            phone,
            specialties: "[]",
            status: "PENDING",
          },
        })
      )
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const stored = await db!.mechanicApplication.findMany({ where: { phone } });
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("PENDING");
  });
});
