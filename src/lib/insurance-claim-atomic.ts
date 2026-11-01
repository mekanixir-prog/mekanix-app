import type { PrismaClient } from "@prisma/client";
import { getD1Binding, IdempotencyConflictError } from "@/lib/idempotency";

export type InsuranceClaimCreateInput = {
  idempotencyKey: string;
  requestFingerprint: string;
  code: string;
  policyId: string;
  jobId: string | null;
  description: string;
  amount: number;
};

type CreateResult = { id: string; code: string; created: boolean };

function assertFingerprint(existing: { requestFingerprint: string | null }, fingerprint: string) {
  if (existing.requestFingerprint !== fingerprint) throw new IdempotencyConflictError();
}

async function createWithPrisma(db: PrismaClient, input: InsuranceClaimCreateInput): Promise<CreateResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.insuranceClaim.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, code: true, requestFingerprint: true },
    });
    if (existing) {
      assertFingerprint(existing, input.requestFingerprint);
      return { id: existing.id, code: existing.code, created: false };
    }

    const claim = await tx.insuranceClaim.create({
      data: {
        code: input.code,
        policyId: input.policyId,
        jobId: input.jobId,
        description: input.description,
        amount: input.amount,
        status: "submitted",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      },
      select: { id: true, code: true },
    });
    await tx.insurancePolicy.update({
      where: { id: input.policyId },
      data: { status: "claimed" },
    });
    return { ...claim, created: true };
  });
}

async function createWithD1(
  db: PrismaClient,
  d1: NonNullable<Awaited<ReturnType<typeof getD1Binding>>>,
  input: InsuranceClaimCreateInput
): Promise<CreateResult> {
  const now = new Date().toISOString();
  const claimId = crypto.randomUUID();
  await d1.batch([
    d1.prepare(`
      INSERT INTO "InsuranceClaim"
        ("id", "code", "policyId", "jobId", "description", "amount", "status",
         "idempotencyKey", "requestFingerprint", "createdAt")
      VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)
      ON CONFLICT("idempotencyKey") DO NOTHING
    `).bind(
      claimId, input.code, input.policyId, input.jobId, input.description,
      input.amount, input.idempotencyKey, input.requestFingerprint, now
    ),
    d1.prepare(`
      UPDATE "InsurancePolicy"
      SET "status" = 'claimed'
      WHERE "id" = ?
        AND EXISTS (
          SELECT 1 FROM "InsuranceClaim"
          WHERE "idempotencyKey" = ? AND "requestFingerprint" = ?
            AND "policyId" = ?
        )
    `).bind(
      input.policyId, input.idempotencyKey, input.requestFingerprint, input.policyId
    ),
  ]);

  const existing = await db.insuranceClaim.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, code: true, policyId: true, requestFingerprint: true },
  });
  if (!existing) throw new Error("D1 batch completed without a readable insurance claim");
  assertFingerprint(existing, input.requestFingerprint);
  if (existing.policyId !== input.policyId) throw new IdempotencyConflictError();
  return { id: existing.id, code: existing.code, created: existing.id === claimId };
}

export async function createInsuranceClaimAtomically(
  db: PrismaClient,
  input: InsuranceClaimCreateInput
): Promise<CreateResult> {
  const existing = await db.insuranceClaim.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, code: true, requestFingerprint: true },
  });
  if (existing) {
    assertFingerprint(existing, input.requestFingerprint);
    return { id: existing.id, code: existing.code, created: false };
  }

  const d1 = await getD1Binding();
  try {
    if (d1) return await createWithD1(db, d1, input);
    return await createWithPrisma(db, input);
  } catch (error) {
    const raced = await db.insuranceClaim.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, code: true, requestFingerprint: true },
    });
    if (!raced) throw error;
    assertFingerprint(raced, input.requestFingerprint);
    return { id: raced.id, code: raced.code, created: false };
  }
}
