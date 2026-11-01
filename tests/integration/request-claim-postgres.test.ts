// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";
import { createServiceRequestAtomically } from "@/lib/service-request-atomic";
import { createInsuranceClaimAtomically } from "@/lib/insurance-claim-atomic";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("service request and insurance claim PostgreSQL transactions", () => {
  const runId = crypto.randomUUID().replace(/-/g, "");
  const customerPhone = `+9891${runId.slice(0, 9)}`;
  const serviceKey = `service-request:pg-test:${runId}`;
  const claimKey = `insurance-claim:pg-test:${runId}`;
  let db: Awaited<ReturnType<typeof getDbForLib>> | null = null;
  let userId: string;
  let customerId: string;
  let policyId: string;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    db = await getDbForLib();
    const user = await db!.user.create({
      data: {
        name: "Idempotency PostgreSQL Test",
        phone: customerPhone,
        role: "CUSTOMER",
      },
    });
    userId = user.id;
    const customer = await db!.customer.create({ data: { userId } });
    customerId = customer.id;
    const policy = await db!.insurancePolicy.create({
      data: {
        code: `POL-PG-${runId}`,
        userId,
        provider: "integration-test",
        policyNumber: `PG-${runId}`,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2027-01-01T00:00:00.000Z"),
        premiumAmount: 1000,
        status: "active",
      },
    });
    policyId = policy.id;
  });

  afterAll(async () => {
    if (db) {
      await db!.serviceRequest.deleteMany({ where: { idempotencyKey: serviceKey } });
      await db!.insuranceClaim.deleteMany({ where: { idempotencyKey: claimKey } });
      if (policyId) await db!.insurancePolicy.deleteMany({ where: { id: policyId } });
      if (customerId) await db!.customer.deleteMany({ where: { id: customerId } });
      if (userId) await db!.user.deleteMany({ where: { id: userId } });
    }
    vi.unstubAllEnvs();
  });

  it("creates one ad-hoc vehicle and one request for 80 concurrent identical PostgreSQL retries", async () => {
    const input = {
      idempotencyKey: serviceKey,
      requestFingerprint: JSON.stringify({ userId, customerId, title: "engine fault" }),
      code: `SR-PG-${runId}`,
      customerId,
      actorUserId: userId,
      vehicleId: null,
      machineType: "EXCAVATOR",
      make: "CAT",
      model: "320",
      category: "engine",
      urgency: "URGENT" as const,
      title: "Engine fault",
      description: "Power loss",
      mediaUrls: "[]",
      voiceNote: null,
      address: "Tehran",
      lat: 35.7,
      lng: 51.4,
    };

    const results = await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        createServiceRequestAtomically(db, { ...input, code: `SR-PG-${runId}-${index}` })
      )
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await db!.serviceRequest.count({ where: { idempotencyKey: serviceKey } })).toBe(1);
    expect(await db!.vehicle.count({ where: { customerId, notes: "Created atomically with service request" } })).toBe(1);
  });

  it("creates one claim and advances its policy once for 80 concurrent PostgreSQL retries", async () => {
    const input = {
      idempotencyKey: claimKey,
      requestFingerprint: JSON.stringify({ userId, policyId, amount: 250 }),
      code: `CLM-PG-${runId}`,
      policyId,
      jobId: null,
      description: "Accident damage",
      amount: 250,
    };

    const results = await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        createInsuranceClaimAtomically(db, { ...input, code: `CLM-PG-${runId}-${index}` })
      )
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await db!.insuranceClaim.count({ where: { idempotencyKey: claimKey } })).toBe(1);
    const policy = await db!.insurancePolicy.findUnique({ where: { id: policyId } });
    expect(policy?.status).toBe("claimed");
  });

  it("rolls back an ad-hoc vehicle if the PostgreSQL service request insert fails", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const functionName = `test_fail_service_request_${suffix}`;
    const triggerName = `test_fail_service_request_trigger_${suffix}`;
    const key = `service-request:pg-failure:${suffix}`;
    const customerVehicleCount = await db!.vehicle.count({ where: { customerId } });

    await db!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected service request insert failure'; END;
      $$ LANGUAGE plpgsql;
    `);
    await db!.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "ServiceRequest"
      FOR EACH ROW WHEN (NEW."customerId" = '${customerId}')
      EXECUTE FUNCTION "${functionName}"();
    `);

    try {
      await expect(createServiceRequestAtomically(db, {
        idempotencyKey: key,
        requestFingerprint: JSON.stringify({ userId, title: "failure" }),
        code: `SR-PG-FAIL-${suffix}`,
        customerId,
        actorUserId: userId,
        vehicleId: null,
        machineType: "EXCAVATOR",
        make: "CAT",
        model: "320",
        category: "engine",
        urgency: "NORMAL",
        title: "Injected failure",
        description: "Rollback check",
        mediaUrls: "[]",
        voiceNote: null,
        address: "Tehran",
        lat: 35.7,
        lng: 51.4,
      })).rejects.toThrow("injected service request insert failure");

      expect(await db!.serviceRequest.count({ where: { idempotencyKey: key } })).toBe(0);
      expect(await db!.vehicle.count({ where: { customerId } })).toBe(customerVehicleCount);
    } finally {
      await db!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "ServiceRequest"`);
      await db!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });

  it("rolls back a claim if the PostgreSQL policy transition fails", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const functionName = `test_fail_policy_update_${suffix}`;
    const triggerName = `test_fail_policy_update_trigger_${suffix}`;
    const key = `insurance-claim:pg-failure:${suffix}`;
    await db!.insurancePolicy.update({ where: { id: policyId }, data: { status: "active" } });

    await db!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected policy transition failure'; END;
      $$ LANGUAGE plpgsql;
    `);
    await db!.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON "InsurancePolicy"
      FOR EACH ROW WHEN (NEW.status = 'claimed' AND NEW.id = '${policyId}')
      EXECUTE FUNCTION "${functionName}"();
    `);

    try {
      await expect(createInsuranceClaimAtomically(db, {
        idempotencyKey: key,
        requestFingerprint: JSON.stringify({ userId, policyId, amount: 500 }),
        code: `CLM-PG-FAIL-${suffix}`,
        policyId,
        jobId: null,
        description: "Injected failure",
        amount: 500,
      })).rejects.toThrow("injected policy transition failure");

      expect(await db!.insuranceClaim.count({ where: { idempotencyKey: key } })).toBe(0);
      const policy = await db!.insurancePolicy.findUnique({ where: { id: policyId } });
      expect(policy?.status).toBe("active");
    } finally {
      await db!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "InsurancePolicy"`);
      await db!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });
});
