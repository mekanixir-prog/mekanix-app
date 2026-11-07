import type { PrismaClient } from "@prisma/client";
import { getD1Binding, IdempotencyConflictError } from "@/lib/idempotency";

export type ServiceRequestCreateInput = {
  idempotencyKey: string;
  requestFingerprint: string;
  code: string;
  customerId: string;
  actorUserId: string;
  vehicleId: string;
  category: string;
  urgency: "NORMAL" | "URGENT" | "EMERGENCY";
  title: string;
  description: string;
  mediaUrls: string;
  voiceNote: string | null;
  address: string;
  lat: number;
  lng: number;
};

type CreateResult = { id: string; created: boolean };

export class ServiceRequestVehicleError extends Error {
  constructor() {
    super("A registered vehicle owned by this customer is required");
    this.name = "ServiceRequestVehicleError";
  }
}

function assertFingerprint(existing: { requestFingerprint: string | null }, fingerprint: string) {
  if (existing.requestFingerprint !== fingerprint) throw new IdempotencyConflictError();
}

async function createWithPrisma(db: PrismaClient, input: ServiceRequestCreateInput): Promise<CreateResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.serviceRequest.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, requestFingerprint: true },
    });
    if (existing) {
      assertFingerprint(existing, input.requestFingerprint);
      return { id: existing.id, created: false };
    }

    const vehicle = await tx.vehicle.findUnique({
      where: { id: input.vehicleId },
      select: { id: true, customerId: true },
    });
    if (!vehicle || vehicle.customerId !== input.customerId) throw new ServiceRequestVehicleError();

    const request = await tx.serviceRequest.create({
      data: {
        code: input.code,
        customerId: input.customerId,
        vehicleId: vehicle.id,
        category: input.category,
        urgency: input.urgency,
        title: input.title,
        description: input.description,
        mediaUrls: input.mediaUrls,
        voiceNote: input.voiceNote,
        address: input.address,
        lat: input.lat,
        lng: input.lng,
        status: "OPEN",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      },
      select: { id: true },
    });
    return { id: request.id, created: true };
  });
}

async function createWithD1(
  db: PrismaClient,
  d1: NonNullable<Awaited<ReturnType<typeof getD1Binding>>>,
  input: ServiceRequestCreateInput
): Promise<CreateResult> {
  const now = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const statement = d1.prepare(`
    INSERT INTO "ServiceRequest"
      ("id", "code", "customerId", "vehicleId", "category", "urgency", "title",
       "description", "mediaUrls", "voiceNote", "address", "lat", "lng", "status",
       "idempotencyKey", "requestFingerprint", "createdAt", "updatedAt")
    SELECT ?, ?, ?, v."id", ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?
    FROM "Vehicle" v
    WHERE v."id" = ? AND v."customerId" = ?
      AND NOT EXISTS (SELECT 1 FROM "ServiceRequest" WHERE "idempotencyKey" = ?)
    ON CONFLICT("idempotencyKey") DO NOTHING
  `).bind(
    requestId, input.code, input.customerId, input.category, input.urgency,
    input.title, input.description, input.mediaUrls, input.voiceNote, input.address,
    input.lat, input.lng, input.idempotencyKey, input.requestFingerprint, now, now,
    input.vehicleId, input.customerId, input.idempotencyKey
  );

  const results = await d1.batch([statement]);
  const insertResult = results[0];
  const existing = await db.serviceRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, requestFingerprint: true },
  });
  if (!existing) {
    const vehicle = await db.vehicle.findUnique({
      where: { id: input.vehicleId },
      select: { id: true, customerId: true },
    });
    if (!vehicle || vehicle.customerId !== input.customerId) throw new ServiceRequestVehicleError();
    throw new Error("D1 batch completed without a readable service request");
  }
  assertFingerprint(existing, input.requestFingerprint);
  return { id: existing.id, created: (insertResult?.meta?.changes ?? 0) > 0 };
}

export async function createServiceRequestAtomically(
  db: PrismaClient,
  input: ServiceRequestCreateInput
): Promise<CreateResult> {
  const existing = await db.serviceRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, requestFingerprint: true },
  });
  if (existing) {
    assertFingerprint(existing, input.requestFingerprint);
    return { id: existing.id, created: false };
  }

  const d1 = await getD1Binding();
  try {
    if (d1) return await createWithD1(db, d1, input);
    return await createWithPrisma(db, input);
  } catch (error) {
    const raced = await db.serviceRequest.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, requestFingerprint: true },
    });
    if (!raced) throw error;
    assertFingerprint(raced, input.requestFingerprint);
    return { id: raced.id, created: false };
  }
}
