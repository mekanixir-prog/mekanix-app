// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("mechanic application review claims on PostgreSQL", () => {
  const runId = crypto.randomUUID().replace(/-/g, "");
  let db: Awaited<ReturnType<typeof getDbForLib>> | null = null;
  let applicationId: string | null = null;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    db = await getDbForLib();
    const application = await db!.mechanicApplication.create({
      data: {
        code: `APP-PG-${runId}`,
        fullName: "Review Concurrency Integration",
        phone: `+9891${runId.slice(0, 9)}`,
        specialties: "[]",
        status: "PENDING",
      },
    });
    applicationId = application.id;
  });

  afterAll(async () => {
    if (db && applicationId) {
      await db.mechanicApplication.deleteMany({ where: { id: applicationId } });
    }
    vi.unstubAllEnvs();
  });

  it("allows exactly one competing approve/reject compare-and-set claim to win", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 80 }, (_, index) => {
        const status = index % 2 === 0 ? "APPROVING" : "REJECTING";
        return db!.mechanicApplication.updateMany({
          where: { id: applicationId!, status: "PENDING" },
          data: { status },
        });
      })
    );

    expect(attempts.reduce((sum, result) => sum + result.count, 0)).toBe(1);
    const application = await db!.mechanicApplication.findUnique({ where: { id: applicationId! } });
    expect(["APPROVING", "REJECTING"]).toContain(application?.status);
  });
});
