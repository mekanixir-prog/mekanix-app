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
  customer: randomUUID(),
  vehicle: randomUUID(),
  technician: randomUUID(),
  specialty: randomUUID(),
  customerSession: randomUUID(),
  technicianSession: randomUUID(),
};
const phoneSuffix = String(randomInt(1_000_000, 9_999_999));
const customerPhone = "+98912" + phoneSuffix;
const technicianPhone = "+98913" + phoneSuffix;
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

const seedSql = [
  "BEGIN;",
  'INSERT INTO "User" ("id", "phone", "phoneVerified", "name", "role", "status") VALUES',
  "(" + [sql(ids.customerUser), sql(customerPhone), "TRUE", sql("MEKANIX HTTP E2E Customer"), sql("CUSTOMER"), sql("ACTIVE")].join(", ") + "),",
  "(" + [sql(ids.technicianUser), sql(technicianPhone), "TRUE", sql("MEKANIX HTTP E2E Technician"), sql("TECHNICIAN"), sql("ACTIVE")].join(", ") + ");",
  'INSERT INTO "Customer" ("id", "userId") VALUES (' + sql(ids.customer) + ", " + sql(ids.customerUser) + ");",
  'INSERT INTO "Vehicle" ("id", "customerId", "type", "make", "model", "year") VALUES (' +
    [sql(ids.vehicle), sql(ids.customer), sql("EXCAVATOR"), sql("Caterpillar"), sql("320D E2E"), "2024"].join(", ") + ");",
  'INSERT INTO "Technician" ("id", "userId", "financialUnitStatus", "hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy", "status", "verified", "availableNow", "responseMins") VALUES (' +
    [sql(ids.technician), sql(ids.technicianUser), sql("VERIFIED_IRR"), "200000", "50000", "20000", "50000", sql("ONLINE"), "TRUE", "TRUE", "5"].join(", ") + ");",
  'INSERT INTO "TechnicianSpecialty" ("id", "technicianId", "category", "label") VALUES (' +
    [sql(ids.specialty), sql(ids.technician), sql("diagnostic"), sql("Heavy machinery diagnostics")].join(", ") + ");",
  'INSERT INTO "Session" ("id", "userId", "tokenHash", "expiresAt") VALUES (' +
    [sql(ids.customerSession), sql(ids.customerUser), sql(customerSession.tokenHash), sql(expiresAt)].join(", ") + "), (" +
    [sql(ids.technicianSession), sql(ids.technicianUser), sql(technicianSession.tokenHash), sql(expiresAt)].join(", ") + ");",
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
  paymentRows: 0,
  warrantyRows: 0,
  scope: "real HTTP + PostgreSQL + signed sessions; no external SMS/payment provider",
}, null, 2));
