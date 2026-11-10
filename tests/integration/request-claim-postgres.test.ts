// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";
import { createServiceRequestAtomically } from "@/lib/service-request-atomic";
import { createInsuranceClaimAtomically } from "@/lib/insurance-claim-atomic";
import { assignServiceRequestAtomically, ServiceRequestAssignmentConflictError } from "@/lib/service-request-assignment";

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
  let vehicleId: string;

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
    const vehicle = await db!.vehicle.create({
      data: { customerId, type: "EXCAVATOR", make: "CAT", model: "320", year: 2024 },
    });
    vehicleId = vehicle.id;
    const policy = await db!.insurancePolicy.create({
      data: {
        code: `POL-PG-${runId}`,
        userId,
        provider: "integration-test",
        policyNumber: `PG-${runId}`,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2027-01-01T00:00:00.000Z"),
        premiumAmount: 1000,
        financialUnitStatus: "VERIFIED_IRR",
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
      if (vehicleId) await db!.vehicle.deleteMany({ where: { id: vehicleId } });
      if (customerId) await db!.customer.deleteMany({ where: { id: customerId } });
      if (userId) await db!.user.deleteMany({ where: { id: userId } });
    }
    vi.unstubAllEnvs();
  });

  it("creates one request for a registered vehicle across 80 concurrent PostgreSQL retries", async () => {
    const input = {
      idempotencyKey: serviceKey,
      requestFingerprint: JSON.stringify({ userId, customerId, title: "engine fault" }),
      code: `SR-PG-${runId}`,
      customerId,
      actorUserId: userId,
      vehicleId,
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
        createServiceRequestAtomically(db!, { ...input, code: `SR-PG-${runId}-${index}` })
      )
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await db!.serviceRequest.count({ where: { idempotencyKey: serviceKey } })).toBe(1);
    expect(await db!.vehicle.count({ where: { id: vehicleId } })).toBe(1);
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
        createInsuranceClaimAtomically(db!, { ...input, code: `CLM-PG-${runId}-${index}` })
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
      await expect(createServiceRequestAtomically(db!, {
        idempotencyKey: key,
        requestFingerprint: JSON.stringify({ userId, title: "failure" }),
        code: `SR-PG-FAIL-${suffix}`,
        customerId,
        actorUserId: userId,
        vehicleId,
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
      await expect(createInsuranceClaimAtomically(db!, {
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

  it("assigns one real PostgreSQL service request exactly once under 40 concurrent technician-claim races", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const requestKey = `service-request:assignment-pg-test:${suffix}`;
    const technicianUser = await db!.user.create({
      data: {
        name: "Assignment PostgreSQL Technician",
        phone: `+9893${suffix.slice(0, 9)}`,
        role: "TECHNICIAN",
      },
    });
    const technician = await db!.technician.create({
      data: {
        userId: technicianUser.id,
        status: "ONLINE",
        verified: true,
        availableNow: true,
      },
    });
    await db!.technicianSpecialty.create({
      data: { technicianId: technician.id, category: "hydraulic", label: "Hydraulic systems" },
    });

    let requestId: string | undefined;
    try {
      const created = await createServiceRequestAtomically(db!, {
        idempotencyKey: requestKey,
        requestFingerprint: JSON.stringify({ userId, vehicleId, suffix }),
        code: `SR-ASSIGN-PG-${suffix}`,
        customerId,
        actorUserId: userId,
        vehicleId,
        category: "hydraulic",
        urgency: "NORMAL",
        title: "Hydraulic system inspection",
        description: "PostgreSQL assignment race test",
        mediaUrls: "[]",
        voiceNote: null,
        address: "Tehran",
        lat: 35.7,
        lng: 51.4,
      });
      requestId = created.id;

      const attempts = await Promise.allSettled(
        Array.from({ length: 40 }, () =>
          assignServiceRequestAtomically(db!, {
            requestId: created.id,
            technicianId: technician.id,
            category: "hydraulic",
            etaMins: 18,
            existingRejectedJobId: null,
          })
        )
      );

      const fulfilled = attempts.filter((item) => item.status === "fulfilled");
      const rejected = attempts.filter((item) => item.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(39);
      for (const item of rejected) {
        if (item.status === "rejected") {
          expect(item.reason).toBeInstanceOf(ServiceRequestAssignmentConflictError);
        }
      }

      const request = await db!.serviceRequest.findUnique({ where: { id: created.id } });
      const claimedTechnician = await db!.technician.findUnique({ where: { id: technician.id } });
      const jobs = await db!.job.findMany({ where: { requestId: created.id } });
      expect(request?.status).toBe("ASSIGNED");
      expect(request?.matchedTechId).toBe(technician.id);
      expect(claimedTechnician?.status).toBe("ON_JOB");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].technicianId).toBe(technician.id);
      expect(jobs[0].status).toBe("REQUESTED");
    } finally {
      if (requestId) {
        await db!.job.deleteMany({ where: { requestId } });
        await db!.serviceRequest.deleteMany({ where: { id: requestId } });
      }
      await db!.technicianSpecialty.deleteMany({ where: { technicianId: technician.id } });
      await db!.technician.delete({ where: { id: technician.id } });
      await db!.user.delete({ where: { id: technicianUser.id } });
    }
  });

  it("rolls back the request claim when PostgreSQL rejects the technician state update", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const requestKey = `service-request:assignment-rollback-pg-test:${suffix}`;
    const functionName = `test_fail_tech_claim_${suffix}`;
    const triggerName = `test_fail_tech_claim_trigger_${suffix}`;
    const technicianUser = await db!.user.create({
      data: {
        name: "Assignment Rollback Technician",
        phone: `+9894${suffix.slice(0, 9)}`,
        role: "TECHNICIAN",
      },
    });
    const technician = await db!.technician.create({
      data: {
        userId: technicianUser.id,
        status: "ONLINE",
        verified: true,
        availableNow: true,
      },
    });
    await db!.technicianSpecialty.create({
      data: { technicianId: technician.id, category: "hydraulic", label: "Hydraulic systems" },
    });

    let requestId: string | undefined;
    try {
      const created = await createServiceRequestAtomically(db!, {
        idempotencyKey: requestKey,
        requestFingerprint: JSON.stringify({ userId, vehicleId, suffix }),
        code: `SR-ASSIGN-ROLLBACK-PG-${suffix}`,
        customerId,
        actorUserId: userId,
        vehicleId,
        category: "hydraulic",
        urgency: "NORMAL",
        title: "Hydraulic rollback test",
        description: "Injected technician update failure",
        mediaUrls: "[]",
        voiceNote: null,
        address: "Tehran",
        lat: 35.7,
        lng: 51.4,
      });
      requestId = created.id;

      await db!.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected technician claim failure'; END;
        $$ LANGUAGE plpgsql;
      `);
      await db!.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON "Technician"
        FOR EACH ROW WHEN (NEW."id" = '${technician.id}' AND NEW."status" = 'ON_JOB')
        EXECUTE FUNCTION "${functionName}"();
      `);

      await expect(assignServiceRequestAtomically(db!, {
        requestId: created.id,
        technicianId: technician.id,
        category: "hydraulic",
        etaMins: 18,
        existingRejectedJobId: null,
      })).rejects.toThrow("injected technician claim failure");

      const request = await db!.serviceRequest.findUnique({ where: { id: created.id } });
      const currentTechnician = await db!.technician.findUnique({ where: { id: technician.id } });
      expect(request?.status).toBe("OPEN");
      expect(request?.matchedTechId).toBeNull();
      expect(currentTechnician?.status).toBe("ONLINE");
      expect(await db!.job.count({ where: { requestId: created.id } })).toBe(0);
    } finally {
      await db!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "Technician"`).catch(() => undefined);
      await db!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => undefined);
      if (requestId) {
        await db!.job.deleteMany({ where: { requestId } });
        await db!.serviceRequest.deleteMany({ where: { id: requestId } });
      }
      await db!.technicianSpecialty.deleteMany({ where: { technicianId: technician.id } });
      await db!.technician.delete({ where: { id: technician.id } });
      await db!.user.delete({ where: { id: technicianUser.id } });
    }
  });

});
