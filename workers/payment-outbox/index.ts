type D1Result<T = unknown> = { results?: T[]; meta?: { changes?: number } };
type D1Statement = { bind(...values: unknown[]): D1Statement; first<T = unknown>(): Promise<T | null>; run(): Promise<D1Result> };
type D1Database = { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<D1Result[]> };
type Env = { DB: D1Database };
type OutboxRow = { id:string; eventType:string; aggregateType:string; aggregateId:string; payload:string; idempotencyKey:string; attempts:number; lockedAt:string|null };
type VipPayload = { eventType:"PAYMENT_SUCCEEDED"; paymentId:string; gatewayLogId:string; userId:string; amount:number; currency:"IRR"; purpose:"vip"; targetPlanId:string; durationDays:number };

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

function parsePayload(raw:string):VipPayload {
  const v = JSON.parse(raw) as Partial<VipPayload>;
  if (v.eventType !== "PAYMENT_SUCCEEDED" || typeof v.paymentId !== "string" || !v.paymentId ||
      typeof v.gatewayLogId !== "string" || !v.gatewayLogId || typeof v.userId !== "string" || !v.userId ||
      !Number.isSafeInteger(v.amount) || (v.amount ?? 0) <= 0 || v.currency !== "IRR" ||
      v.purpose !== "vip" || typeof v.targetPlanId !== "string" || !v.targetPlanId ||
      !Number.isSafeInteger(v.durationDays) || (v.durationDays ?? 0) <= 0 || (v.durationDays ?? 0) > 36500) {
    throw new Error("INVALID_VIP_OUTBOX_PAYLOAD");
  }
  return v as VipPayload;
}

async function claimOne(db:D1Database, now:Date):Promise<OutboxRow|null> {
  const stale = new Date(now.getTime()-LEASE_MS).toISOString();
  const candidate = await db.prepare(
    `SELECT "id" FROM "PaymentOutboxEvent"
     WHERE ("status"='PENDING' AND "availableAt"<=?)
        OR ("status"='PROCESSING' AND "lockedAt"<=?)
     ORDER BY "availableAt" ASC,"createdAt" ASC LIMIT 1`
  ).bind(now.toISOString(),stale).first<{id:string}>();
  if (!candidate) return null;
  const lease = now.toISOString();
  const claimed = await db.prepare(
    `UPDATE "PaymentOutboxEvent"
     SET "status"='PROCESSING',"lockedAt"=?,"attempts"="attempts"+1,"updatedAt"=?
     WHERE "id"=? AND (("status"='PENDING' AND "availableAt"<=?) OR ("status"='PROCESSING' AND "lockedAt"<=?))`
  ).bind(lease,lease,candidate.id,lease,stale).run();
  if ((claimed.meta?.changes ?? 0)!==1) return null;
  return db.prepare(
    `SELECT "id","eventType","aggregateType","aggregateId","payload","idempotencyKey","attempts","lockedAt"
     FROM "PaymentOutboxEvent" WHERE "id"=? AND "status"='PROCESSING' AND "lockedAt"=?`
  ).bind(candidate.id,lease).first<OutboxRow>();
}

async function recordFailure(db:D1Database,event:OutboxRow,now:Date,error:unknown) {
  const dead = event.attempts >= MAX_ATTEMPTS;
  const delay = Math.min(30_000 * (2 ** Math.max(0,event.attempts-1)),MAX_BACKOFF_MS);
  const code = error instanceof Error ? error.message.slice(0,180) : "OUTBOX_PROCESSING_FAILED";
  await db.prepare(
    `UPDATE "PaymentOutboxEvent"
     SET "status"=?,"lockedAt"=NULL,"availableAt"=?,"lastError"=?,"updatedAt"=?
     WHERE "id"=? AND "status"='PROCESSING' AND "lockedAt"=?`
  ).bind(dead?"DEAD":"PENDING",new Date(now.getTime()+delay).toISOString(),code,now.toISOString(),event.id,event.lockedAt).run();
}

async function fulfillVip(db:D1Database,event:OutboxRow,p:VipPayload,now:Date) {
  const existing = await db.prepare(
    `SELECT "id","userId","planId","expiresAt" FROM "UserVipSubscription" WHERE "paymentId"=?`
  ).bind(p.paymentId).first<{id:string;userId:string;planId:string;expiresAt:string|null}>();
  if (existing) {
    if (existing.userId!==p.userId || existing.planId!==p.targetPlanId) throw new Error("PAYMENT_ALREADY_BOUND_TO_DIFFERENT_SUBSCRIPTION");
    const notification = db.prepare(
      `INSERT INTO "Notification" ("id","userId","type","title","body","category","link","read","createdAt")
       SELECT ?,?,'vip_activated','اشتراک VIP فعال شد','اشتراک VIP شما ثبت و فعال‌سازی شد.','system','customer/settings',0,?
       WHERE EXISTS (SELECT 1 FROM "UserVipSubscription" WHERE "paymentId"=? AND "userId"=? AND "planId"=?)
       ON CONFLICT("id") DO NOTHING`
    ).bind(`vip-activated:${p.paymentId}`,p.userId,now.toISOString(),p.paymentId,p.userId,p.targetPlanId);
    const done = db.prepare(
      `UPDATE "PaymentOutboxEvent" SET "status"='PROCESSED',"processedAt"=?,"lockedAt"=NULL,"lastError"=NULL,"updatedAt"=?
       WHERE "id"=? AND "status"='PROCESSING' AND "lockedAt"=? AND "idempotencyKey"=?`
    ).bind(now.toISOString(),now.toISOString(),event.id,event.lockedAt,event.idempotencyKey);
    const assertion = db.prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM "PaymentOutboxEvent" o JOIN "UserVipSubscription" s ON s."paymentId"=?
         WHERE o."id"=? AND o."status"='PROCESSED' AND o."processedAt"=?
           AND s."userId"=? AND s."planId"=?
       ) THEN 1 ELSE json_extract('not-json','
  }

  // The payment event carries the immutable duration accepted at initiation.
  // Current plan edits must not retroactively alter a paid entitlement.
  const plan = await db.prepare(
    `SELECT "id" FROM "VipPlan" WHERE "id"=?`
  ).bind(p.targetPlanId).first<{id:string}>();
  if (!plan) throw new Error("VIP_PLAN_NOT_FOUND_FOR_PAID_ENTITLEMENT");
  const started = now.toISOString();
  const expires = new Date(now.getTime()+p.durationDays*86400000).toISOString();
  const subscriptionId = crypto.randomUUID();

  // The current payment is explicitly excluded from retirement. The API may
  // fulfill the same payment after the initial read but before this batch.
  // In that race, the guarded insert is skipped and the existing subscription
  // remains ACTIVE while the outbox event is completed idempotently.
  const cancelPrevious = db.prepare(
    `UPDATE "UserVipSubscription" SET "status"='CANCELLED',"updatedAt"=?
     WHERE "userId"=? AND "status"='ACTIVE'
       AND ("paymentId" IS NULL OR "paymentId"<>?)
       AND EXISTS (SELECT 1 FROM "Payment" p JOIN "PaymentGatewayLog" g ON g."id"=p."gatewayLogId"
         WHERE p."id"=? AND p."userId"=? AND p."amount"=? AND p."currency"='IRR'
           AND p."status"='SUCCEEDED' AND p."financialUnitStatus"='VERIFIED_IRR'
           AND p."gatewayLogId"=? AND g."paymentId"=p."id" AND g."status"='VERIFIED'
           AND g."purpose"='vip' AND g."targetPlanId"=? AND g."targetPlanDurationDays"=? AND g."amount"=p."amount"
           AND g."currency"='IRR' AND g."financialUnitStatus"='VERIFIED_IRR')`
  ).bind(now.toISOString(),p.userId,p.paymentId,p.paymentId,p.userId,p.amount,p.gatewayLogId,p.targetPlanId,p.durationDays);

  const insertSubscription = db.prepare(
    `INSERT INTO "UserVipSubscription"
       ("id","userId","planId","status","startedAt","expiresAt","paymentId","createdAt","updatedAt")
     SELECT ?,p."userId",?,'ACTIVE',?,?,p."id",?,?
     FROM "Payment" p
     JOIN "PaymentGatewayLog" g ON g."id"=p."gatewayLogId"
     JOIN "VipPlan" v ON v."id"=?
     WHERE p."id"=? AND p."userId"=? AND p."amount"=? AND p."currency"='IRR'
       AND p."status"='SUCCEEDED' AND p."financialUnitStatus"='VERIFIED_IRR'
       AND p."gatewayLogId"=? AND g."paymentId"=p."id" AND g."status"='VERIFIED'
       AND g."purpose"='vip' AND g."targetPlanId"=? AND g."targetPlanDurationDays"=? AND g."amount"=p."amount"
       AND g."currency"='IRR' AND g."financialUnitStatus"='VERIFIED_IRR'
       AND NOT EXISTS (SELECT 1 FROM "UserVipSubscription" s WHERE s."paymentId"=p."id")`
  ).bind(subscriptionId,p.targetPlanId,started,expires,started,started,p.targetPlanId,p.paymentId,p.userId,p.amount,p.gatewayLogId,p.targetPlanId,p.durationDays);

  const notification = db.prepare(
    `INSERT INTO "Notification" ("id","userId","type","title","body","category","link","read","createdAt")
     SELECT ?,?,'vip_activated','اشتراک VIP فعال شد','اشتراک VIP شما ثبت و فعال‌سازی شد.','system','customer/settings',0,?
     WHERE EXISTS (SELECT 1 FROM "UserVipSubscription" WHERE "paymentId"=? AND "userId"=? AND "planId"=?)
     ON CONFLICT("id") DO NOTHING`
  ).bind(`vip-activated:${p.paymentId}`,p.userId,now.toISOString(),p.paymentId,p.userId,p.targetPlanId);

  const markProcessed = db.prepare(
    `UPDATE "PaymentOutboxEvent" SET "status"='PROCESSED',"processedAt"=?,"lockedAt"=NULL,"lastError"=NULL,"updatedAt"=?
     WHERE "id"=? AND "status"='PROCESSING' AND "lockedAt"=? AND "idempotencyKey"=?
       AND EXISTS (SELECT 1 FROM "UserVipSubscription" s WHERE s."paymentId"=? AND s."userId"=? AND s."planId"=?)`
  ).bind(now.toISOString(),now.toISOString(),event.id,event.lockedAt,event.idempotencyKey,p.paymentId,p.userId,p.targetPlanId);

  const assertion = db.prepare(
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM "PaymentOutboxEvent" o JOIN "UserVipSubscription" s ON s."paymentId"=?
       WHERE o."id"=? AND o."status"='PROCESSED' AND o."processedAt"=?
         AND s."userId"=? AND s."planId"=?
     ) THEN 1 ELSE json_extract('not-json','$') END`
  ).bind(p.paymentId,event.id,now.toISOString(),p.userId,p.targetPlanId);

  await db.batch([cancelPrevious,insertSubscription,notification,markProcessed,assertion]);
}

async function processBatch(db:D1Database,now:Date) {
  let processed=0,failed=0,dead=0;
  for(let i=0;i<BATCH_SIZE;i++) {
    const event=await claimOne(db,now);
    if(!event) break;
    try {
      if(event.eventType!=="PAYMENT_SUCCEEDED" || event.aggregateType!=="Payment") throw new Error("UNSUPPORTED_OUTBOX_EVENT");
      const p=parsePayload(event.payload);
      if(p.paymentId!==event.aggregateId || event.idempotencyKey!==`payment.succeeded:${p.gatewayLogId}`) throw new Error("OUTBOX_IDEMPOTENCY_BINDING_MISMATCH");
      if(p.purpose!=="vip") throw new Error("UNSUPPORTED_PAYMENT_PURPOSE");
      await fulfillVip(db,event,p,now);
      processed++;
    } catch(error) {
      await recordFailure(db,event,now,error);
      failed++;
      if(event.attempts>=MAX_ATTEMPTS) dead++;
    }
  }
  console.log("[payment-outbox] run complete",{processed,failed,dead,batchSize:BATCH_SIZE,at:now.toISOString()});
}

const worker = {
  scheduled(controller:{scheduledTime:number},env:Env,ctx:{waitUntil(p:Promise<unknown>):void}) {
    ctx.waitUntil(processBatch(env.DB,new Date(controller.scheduledTime)));
  },
  fetch() { return new Response("Not Found",{status:404}); },
};
export default worker;
) END`
    ).bind(p.paymentId,event.id,now.toISOString(),p.userId,p.targetPlanId);
    await db.batch([notification,done,assertion]);
    return;
  }

  // The payment event carries the immutable duration accepted at initiation.
  // Current plan edits must not retroactively alter a paid entitlement.
  const plan = await db.prepare(
    `SELECT "id" FROM "VipPlan" WHERE "id"=?`
  ).bind(p.targetPlanId).first<{id:string}>();
  if (!plan) throw new Error("VIP_PLAN_NOT_FOUND_FOR_PAID_ENTITLEMENT");
  const started = now.toISOString();
  const expires = new Date(now.getTime()+p.durationDays*86400000).toISOString();
  const subscriptionId = crypto.randomUUID();

  // The current payment is explicitly excluded from retirement. The API may
  // fulfill the same payment after the initial read but before this batch.
  // In that race, the guarded insert is skipped and the existing subscription
  // remains ACTIVE while the outbox event is completed idempotently.
  const cancelPrevious = db.prepare(
    `UPDATE "UserVipSubscription" SET "status"='CANCELLED',"updatedAt"=?
     WHERE "userId"=? AND "status"='ACTIVE'
       AND ("paymentId" IS NULL OR "paymentId"<>?)
       AND EXISTS (SELECT 1 FROM "Payment" p JOIN "PaymentGatewayLog" g ON g."id"=p."gatewayLogId"
         WHERE p."id"=? AND p."userId"=? AND p."amount"=? AND p."currency"='IRR'
           AND p."status"='SUCCEEDED' AND p."financialUnitStatus"='VERIFIED_IRR'
           AND p."gatewayLogId"=? AND g."paymentId"=p."id" AND g."status"='VERIFIED'
           AND g."purpose"='vip' AND g."targetPlanId"=? AND g."amount"=p."amount"
           AND g."currency"='IRR' AND g."financialUnitStatus"='VERIFIED_IRR')`
  ).bind(now.toISOString(),p.userId,p.paymentId,p.paymentId,p.userId,p.amount,p.gatewayLogId,p.targetPlanId,p.durationDays);

  const insertSubscription = db.prepare(
    `INSERT INTO "UserVipSubscription"
       ("id","userId","planId","status","startedAt","expiresAt","paymentId","createdAt","updatedAt")
     SELECT ?,p."userId",?,'ACTIVE',?,?,p."id",?,?
     FROM "Payment" p
     JOIN "PaymentGatewayLog" g ON g."id"=p."gatewayLogId"
     JOIN "VipPlan" v ON v."id"=?
     WHERE p."id"=? AND p."userId"=? AND p."amount"=? AND p."currency"='IRR'
       AND p."status"='SUCCEEDED' AND p."financialUnitStatus"='VERIFIED_IRR'
       AND p."gatewayLogId"=? AND g."paymentId"=p."id" AND g."status"='VERIFIED'
       AND g."purpose"='vip' AND g."targetPlanId"=? AND g."amount"=p."amount"
       AND g."currency"='IRR' AND g."financialUnitStatus"='VERIFIED_IRR'
       AND NOT EXISTS (SELECT 1 FROM "UserVipSubscription" s WHERE s."paymentId"=p."id")`
  ).bind(subscriptionId,p.targetPlanId,started,expires,started,started,p.targetPlanId,p.paymentId,p.userId,p.amount,p.gatewayLogId,p.targetPlanId);

  const notification = db.prepare(
    `INSERT INTO "Notification" ("id","userId","type","title","body","category","link","read","createdAt")
     SELECT ?,?,'vip_activated','اشتراک VIP فعال شد','اشتراک VIP شما ثبت و فعال‌سازی شد.','system','customer/settings',0,?
     WHERE EXISTS (SELECT 1 FROM "UserVipSubscription" WHERE "paymentId"=? AND "userId"=? AND "planId"=?)
     ON CONFLICT("id") DO NOTHING`
  ).bind(`vip-activated:${p.paymentId}`,p.userId,now.toISOString(),p.paymentId,p.userId,p.targetPlanId);

  const markProcessed = db.prepare(
    `UPDATE "PaymentOutboxEvent" SET "status"='PROCESSED',"processedAt"=?,"lockedAt"=NULL,"lastError"=NULL,"updatedAt"=?
     WHERE "id"=? AND "status"='PROCESSING' AND "lockedAt"=? AND "idempotencyKey"=?
       AND EXISTS (SELECT 1 FROM "UserVipSubscription" s WHERE s."paymentId"=? AND s."userId"=? AND s."planId"=?)`
  ).bind(now.toISOString(),now.toISOString(),event.id,event.lockedAt,event.idempotencyKey,p.paymentId,p.userId,p.targetPlanId);

  const assertion = db.prepare(
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM "PaymentOutboxEvent" o JOIN "UserVipSubscription" s ON s."paymentId"=?
       WHERE o."id"=? AND o."status"='PROCESSED' AND o."processedAt"=?
         AND s."userId"=? AND s."planId"=?
     ) THEN 1 ELSE json_extract('not-json','$') END`
  ).bind(p.paymentId,event.id,now.toISOString(),p.userId,p.targetPlanId);

  await db.batch([cancelPrevious,insertSubscription,notification,markProcessed,assertion]);
}

async function processBatch(db:D1Database,now:Date) {
  let processed=0,failed=0,dead=0;
  for(let i=0;i<BATCH_SIZE;i++) {
    const event=await claimOne(db,now);
    if(!event) break;
    try {
      if(event.eventType!=="PAYMENT_SUCCEEDED" || event.aggregateType!=="Payment") throw new Error("UNSUPPORTED_OUTBOX_EVENT");
      const p=parsePayload(event.payload);
      if(p.paymentId!==event.aggregateId || event.idempotencyKey!==`payment.succeeded:${p.gatewayLogId}`) throw new Error("OUTBOX_IDEMPOTENCY_BINDING_MISMATCH");
      if(p.purpose!=="vip") throw new Error("UNSUPPORTED_PAYMENT_PURPOSE");
      await fulfillVip(db,event,p,now);
      processed++;
    } catch(error) {
      await recordFailure(db,event,now,error);
      failed++;
      if(event.attempts>=MAX_ATTEMPTS) dead++;
    }
  }
  console.log("[payment-outbox] run complete",{processed,failed,dead,batchSize:BATCH_SIZE,at:now.toISOString()});
}

const worker = {
  scheduled(controller:{scheduledTime:number},env:Env,ctx:{waitUntil(p:Promise<unknown>):void}) {
    ctx.waitUntil(processBatch(env.DB,new Date(controller.scheduledTime)));
  },
  fetch() { return new Response("Not Found",{status:404}); },
};
export default worker;
