import { SignJWT } from "jose";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || new TextEncoder().encode(jwtSecret).length < 32) {
  throw new Error("JWT_SECRET must be at least 32 bytes for the production-mode HTTP E2E");
}

const ids = {
  customerUser: randomUUID(),
  technicianUser: randomUUID(),
  otherCustomerUser: randomUUID(),
  otherTechnicianUser: randomUUID(),
  customer: randomUUID(),
  otherCustomer: randomUUID(),
  vehicle: randomUUID(),
  rollbackVehicle: randomUUID(),
  technician: randomUUID(),
  otherTechnician: randomUUID(),
  specialty: randomUUID(),
  customerSession: randomUUID(),
  technicianSession: randomUUID(),
  otherCustomerSession: randomUUID(),
  otherTechnicianSession: randomUUID(),
};
const phoneSuffix = String(randomInt(1_000_000, 9_999_999));
const customerPhone = "+98912" + phoneSuffix;
const technicianPhone = "+98913" + phoneSuffix;
const otherCustomerPhone = "+98914" + phoneSuffix;
const otherTechnicianPhone = "+98915" + phoneSuffix;
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return "'" + String(value).replaceAll("'", "''") + "'";
}

async function makeSession(userId, role, phone) {
  const token = await new SignJWT({ userId, role, phone, isGuest: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(jwtSecret));
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  };
}

const customerSession = await makeSession(ids.customerUser, "CUSTOMER", customerPhone);
const technicianSession = await makeSession(ids.technicianUser, "TECHNICIAN", technicianPhone);
const otherCustomerSession = await makeSession(ids.otherCustomerUser, "CUSTOMER", otherCustomerPhone);
const otherTechnicianSession = await makeSession(ids.otherTechnicianUser, "TECHNICIAN", otherTechnicianPhone);

const rateCardValue = {
  current: {
    schemaVersion: 1,
    version: 1,
    currency: "IRR",
    displayCurrency: "TOMAN",
    effectiveAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    updatedBy: "MEKANIX_HTTP_E2E_APPROVED_FIXTURE",
    fees: {
      passenger: { visitBaseIrr: 5000000, inspectionIrr: 6000000, includedKm: 10, perKmIrr: 100000 },
      heavy: { visitBaseIrr: 20000000, inspectionIrr: 20000000, includedKm: 10, perKmIrr: 300000 },
    },
    serviceFeesIrr: {
      passenger: { diagnostic: 8000000, electrical: 12000000, cooling: 12000000, brakes: 15000000, periodic: 18000000, engine_minor: 25000000, engine_major: 80000000, transmission: 60000000, hydraulic: null, undercarriage: null },
      heavy: { diagnostic: 35000000, electrical: 30000000, cooling: 40000000, brakes: 50000000, periodic: 50000000, engine_minor: 60000000, engine_major: 180000000, transmission: 120000000, hydraulic: 80000000, undercarriage: 90000000 },
    },
    emergencySurchargeBps: 3000,
    tax: { enabled: false, rateBps: 0 },
    commission: { enabled: false, rateBps: 0, appliesTo: "LABOR_ONLY" },
    vip: { enabled: false, annualPassengerPriceIrr: 18000000, annualHeavyPriceIrr: 60000000, freePeriodicVisitsPerYear: 4, coversVisitAndInspection: true, excludesRepairsAndParts: true },
    discounts: { maxManualDiscountBps: 1000 },
  },
};

const seedSql = [
  "BEGIN;",
  'INSERT INTO "User" ("id", "phone", "phoneVerified", "name", "role", "status") VALUES',
  "(" + [sql(ids.customerUser), sql(customerPhone), "TRUE", sql("MEKANIX HTTP E2E Customer"), sql("CUSTOMER"), sql("ACTIVE")].join(", ") + "),",
  "(" + [sql(ids.technicianUser), sql(technicianPhone), "TRUE", sql("MEKANIX HTTP E2E Technician"), sql("TECHNICIAN"), sql("ACTIVE")].join(", ") + "),",
  "(" + [sql(ids.otherCustomerUser), sql(otherCustomerPhone), "TRUE", sql("MEKANIX HTTP E2E Other Customer"), sql("CUSTOMER"), sql("ACTIVE")].join(", ") + "),",
  "(" + [sql(ids.otherTechnicianUser), sql(otherTechnicianPhone), "TRUE", sql("MEKANIX HTTP E2E Other Technician"), sql("TECHNICIAN"), sql("ACTIVE")].join(", ") + ");",
  'INSERT INTO "Customer" ("id", "userId") VALUES (' + sql(ids.customer) + ", " + sql(ids.customerUser) + "), (" + sql(ids.otherCustomer) + ", " + sql(ids.otherCustomerUser) + ");",
  'INSERT INTO "Vehicle" ("id", "customerId", "type", "make", "model", "year") VALUES (' +
    [sql(ids.vehicle), sql(ids.customer), sql("EXCAVATOR"), sql("Caterpillar"), sql("320D E2E"), "2024"].join(", ") + "), (" +
    [sql(ids.rollbackVehicle), sql(ids.customer), sql("EXCAVATOR"), sql("Caterpillar"), sql("320D E2E Rollback"), "2024"].join(", ") + ");",
  'INSERT INTO "Technician" ("id", "userId", "financialUnitStatus", "hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy", "status", "verified", "availableNow", "responseMins") VALUES (' +
    [sql(ids.technician), sql(ids.technicianUser), sql("VERIFIED_IRR"), "200000", "50000", "20000", "50000", sql("ONLINE"), "TRUE", "TRUE", "5"].join(", ") + "), (" +
    [sql(ids.otherTechnician), sql(ids.otherTechnicianUser), sql("VERIFIED_IRR"), "180000", "40000", "15000", "40000", sql("ONLINE"), "TRUE", "TRUE", "5"].join(", ") + ");",
  'INSERT INTO "TechnicianSpecialty" ("id", "technicianId", "category", "label") VALUES (' +
    [sql(ids.specialty), sql(ids.technician), sql("diagnostic"), sql("Heavy machinery diagnostics")].join(", ") + ");",
  'INSERT INTO "Session" ("id", "userId", "tokenHash", "expiresAt") VALUES (' +
    [sql(ids.customerSession), sql(ids.customerUser), sql(customerSession.tokenHash), sql(expiresAt)].join(", ") + "), (" +
    [sql(ids.technicianSession), sql(ids.technicianUser), sql(technicianSession.tokenHash), sql(expiresAt)].join(", ") + "), (" +
    [sql(ids.otherCustomerSession), sql(ids.otherCustomerUser), sql(otherCustomerSession.tokenHash), sql(expiresAt)].join(", ") + "), (" +
    [sql(ids.otherTechnicianSession), sql(ids.otherTechnicianUser), sql(otherTechnicianSession.tokenHash), sql(expiresAt)].join(", ") + ");",
  'INSERT INTO "PlatformSetting" ("key", "value", "description", "updatedAt", "updatedBy") VALUES (' +
    [sql("mekanix.pricing.rate-card.v1"), sql(JSON.stringify(rateCardValue)), sql("Isolated HTTP E2E owner-approved rate-card fixture"), "NOW()", sql("MEKANIX_HTTP_E2E")].join(", ") + ");",
  "COMMIT;",
].join("\n");

execFileSync("docker", [
  "compose", "-f", "/tmp/mekanix-build/docker-compose.yml",
  "exec", "-T", "db", "psql", "-U", "mekanix", "-d", "mekanix", "-v", "ON_ERROR_STOP=1",
], { input: seedSql, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });

async function request(path, method, token, body, extraHeaders = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    throw new Error(method + " " + path + " returned " + response.status + ": " + JSON.stringify(payload));
  }
  return payload;
}

const customerToken = customerSession.token;
const technicianToken = technicianSession.token;
const otherCustomerToken = otherCustomerSession.token;
const otherTechnicianToken = otherTechnicianSession.token;
const idempotencyKey = "business-http-e2e-" + randomUUID();

const serviceRequest = await request(
  "/api/service-requests",
  "POST",
  customerToken,
  {
    vehicleId: ids.vehicle,
    category: "diagnostic",
    urgency: "NORMAL",
    title: "بررسی سیستم هیدرولیک بیل مکانیکی",
    description: "Production-mode isolated HTTP business flow test",
    address: "MEKANIX isolated E2E test yard",
    lat: 35.7,
    lng: 51.4,
  },
  { "Idempotency-Key": idempotencyKey },
);
if (!serviceRequest || !serviceRequest.id || serviceRequest.status !== "OPEN") {
  throw new Error("Unexpected service request response: " + JSON.stringify(serviceRequest));
}

const assignedJob = await request(
  "/api/service-requests/" + serviceRequest.id + "/assign",
  "POST",
  customerToken,
  { technicianId: ids.technician },
);
if (!assignedJob || !assignedJob.id || assignedJob.status !== "REQUESTED") {
  throw new Error("Unexpected assignment response: " + JSON.stringify(assignedJob));
}

const foreignRequests = await request("/api/service-requests", "GET", otherCustomerToken);
if (!Array.isArray(foreignRequests) || foreignRequests.length !== 0) {
  throw new Error("BOLA: a different customer could see another customer's service requests");
}
const foreignWallet = await fetch(baseUrl + "/api/wallets", {
  headers: { Authorization: "Bearer " + customerToken },
});
if (foreignWallet.status !== 403) {
  throw new Error("BOLA: customer access to technician wallet should be denied, got " + foreignWallet.status);
}
const ownWallet = await request("/api/wallets", "GET", otherTechnicianToken);
if (ownWallet.technicianId !== ids.otherTechnician) {
  throw new Error("BOLA: technician wallet endpoint returned a wallet not owned by the authenticated technician");
}
const foreignTechStatus = await fetch(baseUrl + "/api/jobs/" + assignedJob.id + "/status", {
  method: "PATCH",
  headers: { Authorization: "Bearer " + otherTechnicianToken, "Content-Type": "application/json" },
  body: JSON.stringify({ status: "ACCEPTED" }),
});
if (foreignTechStatus.status !== 403) {
  throw new Error("BOLA: an unassigned technician changed another technician's job, got " + foreignTechStatus.status);
}

async function transition(status) {
  const result = await request(
    "/api/jobs/" + assignedJob.id + "/status",
    "PATCH",
    technicianToken,
    { status },
  );
  if (result.status !== status) {
    throw new Error("Expected job status " + status + ", received " + result.status);
  }
  return result;
}

for (const status of ["ACCEPTED", "EN_ROUTE", "ARRIVED", "DIAGNOSING", "REPAIRING"]) {
  await transition(status);
}
const waitingApproval = await transition("WAITING_APPROVAL");
const invoiceId = waitingApproval.invoice && waitingApproval.invoice.id;
if (!invoiceId || waitingApproval.invoice.currency !== "IRR" ||
    waitingApproval.invoice.financialUnitStatus !== "VERIFIED_IRR") {
  throw new Error("A verified IRR invoice was not atomically created: " + JSON.stringify(waitingApproval.invoice));
}

const foreignApproval = await fetch(baseUrl + "/api/invoices/" + invoiceId, {
  method: "PATCH",
  headers: { Authorization: "Bearer " + otherCustomerToken, "Content-Type": "application/json" },
  body: JSON.stringify({ customerApproved: true }),
});
if (foreignApproval.status !== 403) {
  throw new Error("BOLA: a different customer approved another customer's invoice, got " + foreignApproval.status);
}
const approved = await request(
  "/api/invoices/" + invoiceId,
  "PATCH",
  customerToken,
  { customerApproved: true },
);
if (approved && approved.status !== "SENT") {
  throw new Error("Unexpected invoice approval response: " + JSON.stringify(approved));
}

await transition("REPAIRING");
await transition("COMPLETED");

// Inject a real PostgreSQL failure after the service-request and technician
// claims but before Job insertion. The transaction must roll back both claims.
const rollbackRequest = await request(
  "/api/service-requests",
  "POST",
  customerToken,
  {
    vehicleId: ids.rollbackVehicle,
    category: "diagnostic",
    urgency: "NORMAL",
    title: "Atomic assignment rollback verification",
    description: "A trigger will reject Job insertion for this request only",
    address: "MEKANIX isolated E2E test yard",
    lat: 35.7,
    lng: 51.4,
  },
  { "Idempotency-Key": "rollback-e2e-" + randomUUID() },
);
if (!rollbackRequest || rollbackRequest.status !== "OPEN") {
  throw new Error("Rollback fixture request was not created OPEN");
}
const triggerSuffix = randomUUID().replaceAll("-", "");
const triggerName = "mekanix_e2e_fail_job_" + triggerSuffix;
const functionName = triggerName + "_fn";
const createTriggerSql = [
  "CREATE FUNCTION \"" + functionName + "\"() RETURNS trigger LANGUAGE plpgsql AS $fn$",
  "BEGIN",
  "  IF NEW.\"requestId\" = " + sql(rollbackRequest.id) + " THEN",
  "    RAISE EXCEPTION 'MEKANIX E2E injected Job insert failure';",
  "  END IF;",
  "  RETURN NEW;",
  "END;",
  "$fn$;",
  "CREATE TRIGGER \"" + triggerName + "\" BEFORE INSERT ON \"Job\" FOR EACH ROW EXECUTE FUNCTION \"" + functionName + "\"();",
].join("\n");
execFileSync("docker", [
  "compose", "-f", "/tmp/mekanix-build/docker-compose.yml",
  "exec", "-T", "db", "psql", "-U", "mekanix", "-d", "mekanix", "-v", "ON_ERROR_STOP=1",
], { input: createTriggerSql, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
let rollbackStatus = 0;
let rollbackState = "";
try {
  const failedAssignment = await fetch(baseUrl + "/api/service-requests/" + rollbackRequest.id + "/assign", {
    method: "POST",
    headers: { Authorization: "Bearer " + customerToken, "Content-Type": "application/json" },
    body: JSON.stringify({ technicianId: ids.technician }),
  });
  rollbackStatus = failedAssignment.status;
  if (rollbackStatus < 500 || rollbackStatus >= 600) {
    throw new Error("Injected Job insert failure should surface as 5xx, got " + rollbackStatus + ": " + await failedAssignment.text());
  }
  rollbackState = execFileSync("docker", [
    "compose", "-f", "/tmp/mekanix-build/docker-compose.yml",
    "exec", "-T", "db", "psql", "-U", "mekanix", "-d", "mekanix", "-Atc",
    'SELECT "status"::text || ' + sql(",") + ' || COALESCE("matchedTechId", ' + sql("NULL") + ') || ' + sql(",") +
      ' || (SELECT COUNT(*) FROM "Job" WHERE "requestId" = ' + sql(rollbackRequest.id) + ')::text || ' + sql(",") +
      ' || (SELECT "status"::text FROM "Technician" WHERE "id" = ' + sql(ids.technician) + ') || ' + sql(",") +
      ' || (SELECT "availableNow"::text FROM "Technician" WHERE "id" = ' + sql(ids.technician) + ') FROM "ServiceRequest" WHERE "id" = ' + sql(rollbackRequest.id) + ";",
  ], { encoding: "utf8" }).trim();
  if (rollbackState !== "OPEN,NULL,0,ONLINE,true") {
    throw new Error("Partial assignment failure was not fully rolled back: " + rollbackState);
  }
} finally {
  const dropTriggerSql = 'DROP TRIGGER IF EXISTS "' + triggerName + '" ON "Job"; DROP FUNCTION IF EXISTS "' + functionName + '"();';
  execFileSync("docker", [
    "compose", "-f", "/tmp/mekanix-build/docker-compose.yml",
    "exec", "-T", "db", "psql", "-U", "mekanix", "-d", "mekanix", "-v", "ON_ERROR_STOP=1",
  ], { input: dropTriggerSql, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
}

// Production intentionally disables the payment simulator. The request must
// fail closed and must not create Payment or Warranty records.
const paymentResponse = await fetch(baseUrl + "/api/payments", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + customerToken,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ invoiceId, method: "card" }),
});
const paymentText = await paymentResponse.text();
if (paymentResponse.status !== 404) {
  throw new Error("Production payment simulator should be disabled (404), got " +
    paymentResponse.status + ": " + paymentText);
}

const counts = execFileSync("docker", [
  "compose", "-f", "/tmp/mekanix-build/docker-compose.yml",
  "exec", "-T", "db", "psql", "-U", "mekanix", "-d", "mekanix", "-Atc",
  'SELECT (SELECT COUNT(*) FROM "Payment" WHERE "invoiceId" = ' + sql(invoiceId) +
    ')::text || ' + sql(",") + ' || (SELECT COUNT(*) FROM "Warranty" WHERE "jobId" = ' +
    sql(assignedJob.id) + ')::text;',
], { encoding: "utf8" }).trim();
if (counts !== "0,0") {
  throw new Error("Fail-closed payment unexpectedly wrote Payment/Warranty rows: " + counts);
}

console.log(JSON.stringify({
  result: "PASS",
  serviceRequestId: serviceRequest.id,
  jobId: assignedJob.id,
  invoiceId,
  finalJobStatus: "COMPLETED",
  paymentSimulator: "DISABLED_IN_PRODUCTION",
  atomicRollback: { injectedStatus: rollbackStatus, persistedState: rollbackState },
  paymentRows: 0,
  warrantyRows: 0,
  scope: "real HTTP + PostgreSQL + signed sessions; no external SMS/payment provider",
}, null, 2));
