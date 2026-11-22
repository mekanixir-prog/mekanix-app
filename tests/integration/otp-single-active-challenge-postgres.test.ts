// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDbForLib } from "@/lib/db-access";

const isPostgres = /^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isPostgres)("one pending OTP per phone — PostgreSQL", () => {
  const phone = "+989900000001";
  let db: Awaited<ReturnType<typeof getDbForLib>> | null = null;

  beforeAll(async () => {
    db = await getDbForLib();
    await db.otpCode.deleteMany({ where: { phone } });
  });

  afterAll(async () => {
    if (db) await db.otpCode.deleteMany({ where: { phone } });
  });

  it("rejects a second pending code and permits a new one after consumption", async () => {
    if (!db) throw new Error("PostgreSQL test database was not initialized");
    const database = db;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await database.otpCode.create({
      data: { phone, code: "otp-hash-first", expiresAt },
    });

    await expect(database.otpCode.create({
      data: { phone, code: "otp-hash-second", expiresAt },
    })).rejects.toMatchObject({ code: "P2002" });

    const consumed = await database.otpCode.updateMany({
      where: { phone, consumed: false },
      data: { consumed: true },
    });
    expect(consumed.count).toBe(1);

    await expect(database.otpCode.create({
      data: { phone, code: "otp-hash-third", expiresAt },
    })).resolves.toMatchObject({ phone, consumed: false });
  });
});
