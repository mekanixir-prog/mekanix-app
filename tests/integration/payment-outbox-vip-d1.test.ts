// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../workers/payment-outbox/index";

function makeD1(onBeforeBatch?: (sqlite:DatabaseSync)=>void) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE "PaymentOutboxEvent" (
      "id" TEXT PRIMARY KEY, "eventType" TEXT NOT NULL, "aggregateType" TEXT NOT NULL,
      "aggregateId" TEXT NOT NULL, "payload" TEXT NOT NULL, "idempotencyKey" TEXT UNIQUE NOT NULL,
      "status" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0, "availableAt" TEXT NOT NULL,
      "lockedAt" TEXT, "processedAt" TEXT, "lastError" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE "Payment" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "amount" REAL NOT NULL, "currency" TEXT NOT NULL,
      "status" TEXT NOT NULL, "financialUnitStatus" TEXT NOT NULL, "gatewayLogId" TEXT UNIQUE
    );
    CREATE TABLE "PaymentGatewayLog" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "paymentId" TEXT, "amount" REAL NOT NULL,
      "currency" TEXT NOT NULL, "status" TEXT NOT NULL, "purpose" TEXT NOT NULL,
      "targetPlanId" TEXT, "targetPlanDurationDays" INTEGER, "financialUnitStatus" TEXT NOT NULL
    );
    CREATE TABLE "VipPlan" (
      "id" TEXT PRIMARY KEY, "durationDays" INTEGER NOT NULL, "active" INTEGER NOT NULL,
      "financialUnitStatus" TEXT NOT NULL
    );
    CREATE TABLE "Notification" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL,
      "body" TEXT NOT NULL, "category" TEXT NOT NULL, "link" TEXT, "read" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TEXT NOT NULL
    );
    CREATE TABLE "UserVipSubscription" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "planId" TEXT NOT NULL, "status" TEXT NOT NULL,
      "startedAt" TEXT, "expiresAt" TEXT, "paymentId" TEXT UNIQUE, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
    );
  `);
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first<T>() { return Promise.resolve(sqlite.prepare(sql).get(...values as never[]) as T ?? null); },
            run() { const r=sqlite.prepare(sql).run(...values as never[]); return Promise.resolve({meta:{changes:Number(r.changes)}}); },
          };
        },
      };
    },
    async batch(items: Array<{first?:()=>Promise<unknown>;run:()=>Promise<{meta:{changes:number}}>}>) {
      onBeforeBatch?.(sqlite);
      try {
        sqlite.exec("BEGIN");
        const result: Array<{meta:{changes:number}}> = [];
        for (const item of items) result.push(await item.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {sqlite,d1};
}

const now = new Date("2026-11-08T10:00:00.000Z");
function seed(sqlite:DatabaseSync, amount=100000) {
  const payload=JSON.stringify({
    eventType:"PAYMENT_SUCCEEDED",paymentId:"payment-1",gatewayLogId:"gateway-1",
    userId:"user-1",amount,currency:"IRR",purpose:"vip",targetPlanId:"plan-1",durationDays:30,
  });
  sqlite.prepare(`INSERT INTO "Payment" VALUES (?,?,?,?,?,?,?)`).run("payment-1","user-1",100000,"IRR","SUCCEEDED","VERIFIED_IRR","gateway-1");
  sqlite.prepare(`INSERT INTO "PaymentGatewayLog" VALUES (?,?,?,?,?,?,?,?,?,?)`).run("gateway-1","user-1","payment-1",100000,"IRR","VERIFIED","vip","plan-1",30,"VERIFIED_IRR");
  sqlite.prepare(`INSERT INTO "VipPlan" VALUES (?,?,?,?)`).run("plan-1",30,1,"VERIFIED_IRR");
  sqlite.prepare(`INSERT INTO "PaymentOutboxEvent" VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "event-1","PAYMENT_SUCCEEDED","Payment","payment-1",payload,"payment.succeeded:gateway-1",
    "PENDING",0,now.toISOString(),null,null,null,now.toISOString(),now.toISOString()
  );
}

async function runWorker(d1:unknown) {
  let task:Promise<unknown>|undefined;
  worker.scheduled({scheduledTime:now.getTime()},{DB:d1} as never,{waitUntil(p:Promise<unknown>){task=p;}});
  await task;
}

describe("VIP payment outbox dispatcher D1 integration",()=>{
  const dbs:DatabaseSync[]=[];
  afterEach(()=>{for(const db of dbs.splice(0)) db.close();});

  it("atomically creates one VIP subscription and marks the event processed",async()=>{
    const {sqlite,d1}=makeD1(); dbs.push(sqlite); seed(sqlite);
    await runWorker(d1);
    expect(sqlite.prepare(`SELECT "status","attempts","processedAt" FROM "PaymentOutboxEvent"`).get()).toEqual({
      status:"PROCESSED",attempts:1,processedAt:now.toISOString()
    });
    expect(sqlite.prepare(`SELECT "userId","planId","status","paymentId" FROM "UserVipSubscription"`).get()).toEqual({
      userId:"user-1",planId:"plan-1",status:"ACTIVE",paymentId:"payment-1"
    });
    await runWorker(d1);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "UserVipSubscription"`).get()).toEqual({count:1});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Notification"`).get()).toEqual({count:1});
  });

  it("uses the purchase-time duration snapshot after the VIP plan is edited and emits one notice",async()=>{
    const {sqlite,d1}=makeD1(); dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`UPDATE "VipPlan" SET "durationDays"=365,"active"=0 WHERE "id"='plan-1'`).run();
    await runWorker(d1);
    const expectedExpiry=new Date(now.getTime()+30*86400000).toISOString();
    expect(sqlite.prepare(`SELECT "expiresAt" FROM "UserVipSubscription" WHERE "paymentId"='payment-1'`).get()).toEqual({expiresAt:expectedExpiry});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Notification" WHERE "id"='vip-activated:payment-1'`).get()).toEqual({count:1});
    await runWorker(d1);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Notification" WHERE "id"='vip-activated:payment-1'`).get()).toEqual({count:1});
  });

  it("preserves an API-created subscription inserted after the worker initial read",async()=>{
    let injected=false;
    const {sqlite,d1}=makeD1((db)=>{
      if(injected) return;
      injected=true;
      db.prepare(`INSERT INTO "UserVipSubscription" VALUES (?,?,?,?,?,?,?,?,?)`).run(
        "api-sub","user-1","plan-1","ACTIVE",now.toISOString(),
        new Date(now.getTime()+30*86400000).toISOString(),"payment-1",now.toISOString(),now.toISOString()
      );
    });
    dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`INSERT INTO "UserVipSubscription" VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "old-sub","user-1","old-plan","ACTIVE",now.toISOString(),null,"old-payment",now.toISOString(),now.toISOString()
    );
    await runWorker(d1);
    expect(sqlite.prepare(`SELECT "status" FROM "UserVipSubscription" WHERE "id"='api-sub'`).get()).toEqual({status:"ACTIVE"});
    expect(sqlite.prepare(`SELECT "status" FROM "UserVipSubscription" WHERE "id"='old-sub'`).get()).toEqual({status:"CANCELLED"});
    expect(sqlite.prepare(`SELECT "status" FROM "PaymentOutboxEvent"`).get()).toEqual({status:"PROCESSED"});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "UserVipSubscription" WHERE "paymentId"='payment-1'`).get()).toEqual({count:1});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Notification" WHERE "id"='vip-activated:payment-1'`).get()).toEqual({count:1});
  });
  it("does not complete an existing subscription when payment provenance no longer verifies",async()=>{
    const {sqlite,d1}=makeD1(); dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`INSERT INTO "UserVipSubscription" VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "existing-sub","user-1","plan-1","ACTIVE",now.toISOString(),
      new Date(now.getTime()+30*86400000).toISOString(),"payment-1",now.toISOString(),now.toISOString()
    );
    sqlite.prepare(`UPDATE "PaymentGatewayLog" SET "financialUnitStatus"='UNVERIFIED' WHERE "id"='gateway-1'`).run();

    await runWorker(d1);

    expect(sqlite.prepare(`SELECT "status","attempts","lastError" FROM "PaymentOutboxEvent"`).get()).toMatchObject({
      status:"PENDING",attempts:1,lastError:"PAYMENT_SOURCE_OF_TRUTH_MISMATCH"
    });
    expect(sqlite.prepare(`SELECT "status" FROM "UserVipSubscription" WHERE "id"='existing-sub'`).get()).toEqual({status:"ACTIVE"});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Notification"`).get()).toEqual({count:0});
  });

  it("rolls back replay completion if payment provenance changes after preflight",async()=>{
    let tampered=false;
    const {sqlite,d1}=makeD1((db)=>{
      if(tampered) return;
      tampered=true;
      db.prepare(`UPDATE "PaymentGatewayLog" SET "financialUnitStatus"='UNVERIFIED' WHERE "id"='gateway-1'`).run();
    });
    dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`INSERT INTO "UserVipSubscription" VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "existing-sub","user-1","plan-1","ACTIVE",now.toISOString(),
      new Date(now.getTime()+30*86400000).toISOString(),"payment-1",now.toISOString(),now.toISOString()
    );

    await runWorker(d1);

    expect(sqlite.prepare(`SELECT "status","attempts" FROM "PaymentOutboxEvent"`).get()).toEqual({
      status:"PENDING",attempts:1
    });
    expect(sqlite.prepare(`SELECT "status" FROM "UserVipSubscription" WHERE "id"='existing-sub'`).get()).toEqual({status:"ACTIVE"});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Notification"`).get()).toEqual({count:0});
  });

  it("refuses to complete against an existing subscription with a different duration",async()=>{
    const {sqlite,d1}=makeD1(); dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`INSERT INTO "UserVipSubscription" VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "wrong-duration","user-1","plan-1","ACTIVE",now.toISOString(),
      new Date(now.getTime()+365*86400000).toISOString(),"payment-1",now.toISOString(),now.toISOString()
    );
    await runWorker(d1);
    expect(sqlite.prepare(`SELECT "status","attempts" FROM "PaymentOutboxEvent"`).get()).toEqual({status:"PENDING",attempts:1});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Notification"`).get()).toEqual({count:0});
    expect(sqlite.prepare(`SELECT "status" FROM "UserVipSubscription" WHERE "id"='wrong-duration'`).get()).toEqual({status:"ACTIVE"});
  });

  it("reclaims an abandoned PROCESSING event after its lease expires",async()=>{
    const {sqlite,d1}=makeD1(); dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`UPDATE "PaymentOutboxEvent" SET "status"='PROCESSING',"lockedAt"=? WHERE "id"='event-1'`)
      .run(new Date(now.getTime()-10*60*1000).toISOString());
    await runWorker(d1);
    expect(sqlite.prepare(`SELECT "status","attempts" FROM "PaymentOutboxEvent"`).get()).toEqual({
      status:"PROCESSED",attempts:1
    });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "UserVipSubscription"`).get()).toEqual({count:1});
  });

  it("moves a repeatedly failing event to DEAD after the configured eighth claim",async()=>{
    const {sqlite,d1}=makeD1(); dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`UPDATE "PaymentOutboxEvent" SET "attempts"=7,"payload"='not-json' WHERE "id"='event-1'`).run();
    await runWorker(d1);
    const event = sqlite.prepare(`SELECT "status","attempts","lastError" FROM "PaymentOutboxEvent"`).get() as {
      status:string; attempts:number; lastError:string|null;
    };
    expect(event.status).toBe("DEAD");
    expect(event.attempts).toBe(8);
    expect(event.lastError).toBeTruthy();
  });

  it("cancels the previous active subscription in the same fulfillment batch",async()=>{
    const {sqlite,d1}=makeD1(); dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`INSERT INTO "UserVipSubscription" VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "old-sub","user-1","old-plan","ACTIVE",now.toISOString(),null,"old-payment",now.toISOString(),now.toISOString()
    );
    await runWorker(d1);
    expect(sqlite.prepare(`SELECT "status" FROM "UserVipSubscription" WHERE "id"='old-sub'`).get()).toEqual({status:"CANCELLED"});
    expect(sqlite.prepare(`SELECT "status" FROM "UserVipSubscription" WHERE "paymentId"='payment-1'`).get()).toEqual({status:"ACTIVE"});
  });

  it("rolls back cancellation and subscription insertion if the outbox completion assertion fails",async()=>{
    const {sqlite,d1}=makeD1(); dbs.push(sqlite); seed(sqlite);
    sqlite.prepare(`INSERT INTO "UserVipSubscription" VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "old-sub","user-1","old-plan","ACTIVE",now.toISOString(),null,"old-payment",now.toISOString(),now.toISOString()
    );
    sqlite.exec(`CREATE TRIGGER "reject_outbox_completion" BEFORE UPDATE OF "status" ON "PaymentOutboxEvent"
      WHEN NEW."status"='PROCESSED' BEGIN SELECT RAISE(IGNORE); END;`);
    await runWorker(d1);
    expect(sqlite.prepare(`SELECT "status" FROM "UserVipSubscription" WHERE "id"='old-sub'`).get()).toEqual({status:"ACTIVE"});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "UserVipSubscription" WHERE "paymentId"='payment-1'`).get()).toEqual({count:0});
    expect(sqlite.prepare(`SELECT "status","attempts" FROM "PaymentOutboxEvent"`).get()).toEqual({status:"PENDING",attempts:1});
  });
});
