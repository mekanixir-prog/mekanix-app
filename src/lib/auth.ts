// MEKANIX — Centralized Authentication & Authorization System
// Based on OWASP API Security Top 10 — implements:
// - API1: Broken Object Level Authorization (BOLA)
// - API2: Broken Authentication
// - API3: Broken Object Property Level Authorization (Mass Assignment)
// - API5: Broken Function Level Authorization
//
// NOTE: The User model has a `password` field for legacy compatibility,
// but MEKANIX uses OTP-only authentication (per ARCHITECTURE.md §6).
// The password field is NOT used for login and should be ignored.

import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "./db";

// ──────────── JWT ────────────

const JWT_SECRET = process.env.JWT_SECRET;
const encoder = new TextEncoder();

function getSecret(): Uint8Array {
  if (!JWT_SECRET) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET environment variable is required in production");
    }
    // Dev-only fallback — NEVER in production
    return encoder.encode("mekanix-dev-secret-change-in-production");
  }
  return encoder.encode(JWT_SECRET);
}

export type Session = {
  userId: string;
  role: "CUSTOMER" | "TECHNICIAN" | "ADMIN" | "FLEET_MANAGER" | "PARTNER";
  phone: string | null;
  isGuest: boolean;
};

// ──────────── Session DB helpers ────────────
//
// We NEVER store the raw JWT in the database — only a SHA-256 hash of it.
// This way a DB read alone is never enough to authenticate as a user; an
// attacker with read-only DB access cannot replay any session token.
//
// The Session table gives us:
//   - Real logout (mark revokedAt = now → verifySession returns null)
//   - Admin "revoke all sessions" (revokeAllUserSessions) for password
//     change / account compromise response
//   - Per-device tracking (device + ip columns) for the security dashboard
//
// Backward compatibility: if the Session table doesn't exist yet (e.g. a
// pre-migration DB) or the DB call throws, `createSession`/`verifySession`
// fall back to JWT-only behaviour so existing deployments keep working
// without forcing a migration.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches JWT exp

/** SHA-256 hex digest of the token — what we store in `Session.tokenHash`. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Extract the User-Agent header (best-effort device label). */
function getDeviceFromRequest(req?: Request): string | null {
  if (!req) return null;
  return req.headers.get("user-agent") ?? null;
}

/** Extract the client IP, preferring X-Forwarded-For (first hop). */
function getIpFromRequest(req?: Request): string | null {
  if (!req) return null;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? null;
}

export async function createSession(payload: Session, req?: Request): Promise<string> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());

  // Persist a Session DB record so the token can be revoked/tracked.
  // Wrap in try/catch: if the Session table doesn't exist (pre-migration
  // DB) or the DB is unavailable, we still return the JWT so login works.
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  try {
    await db.session.create({
      data: {
        userId: payload.userId,
        tokenHash,
        device: getDeviceFromRequest(req),
        ip: getIpFromRequest(req),
        expiresAt,
      },
    });
  } catch (e) {
    console.error("[auth] Failed to create Session DB record:", e);
  }

  return token;
}

export async function verifySession(token: string): Promise<Session | null> {
  // 1. Verify JWT signature + expiry first. If the JWT itself is invalid
  //    (bad signature, expired, malformed), nothing else matters.
  let payload;
  try {
    ({ payload } = await jwtVerify(token, getSecret()));
  } catch {
    return null;
  }

  const session: Session = {
    userId: payload.userId as string,
    role: payload.role as Session["role"],
    phone: payload.phone as string | null,
    isGuest: payload.isGuest as boolean,
  };

  // 2. Check the Session DB for revocation. Wrap in try/catch for backward
  //    compat: if the Session table doesn't exist (pre-migration DB) or the
  //    DB call throws, fall back to JWT-only auth so existing deployments
  //    keep working.
  try {
    const tokenHash = hashToken(token);
    const sessionRecord = await db.session.findUnique({
      where: { tokenHash },
    });

    if (!sessionRecord) return null;                  // not in DB → revoked or never existed
    if (sessionRecord.revokedAt) return null;         // explicitly revoked
    if (sessionRecord.expiresAt.getTime() < Date.now()) return null; // expired
  } catch (e) {
    console.error("[auth] Failed to query Session DB:", e);
    // Fall through — return the JWT-derived session (backward compat).
  }

  return session;
}

// ──────────── Session revocation ────────────

/**
 * Revoke a single session by its raw JWT token.
 * Used by the logout endpoint: marks `revokedAt = now` so subsequent
 * `verifySession` calls return null even though the JWT itself hasn't
 * expired yet.
 *
 * `updateMany` + `revokedAt: null` filter makes this idempotent — calling
 * logout twice on the same token is a no-op the second time.
 */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  try {
    await db.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch (e) {
    console.error("[auth] Failed to revoke session:", e);
  }
}

/**
 * Revoke every active session for a user.
 * Used by:
 *   - Admin "revoke all sessions" action (account compromise response)
 *   - Password change (force re-login on all devices)
 *
 * Idempotent: only touches sessions where `revokedAt` is still null.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  try {
    await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch (e) {
    console.error("[auth] Failed to revoke all user sessions:", e);
  }
}

// ──────────── Session Extraction ────────────

export async function getSessionFromRequest(req: Request): Promise<Session | null> {
  // 1. Try Authorization header (Bearer token)
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    return verifySession(token);
  }
  // 2. Try cookie (for SSR)
  const cookie = req.headers.get("cookie");
  if (cookie) {
    const match = cookie.match(/mekanix-token=([^;]+)/);
    if (match) return verifySession(match[1]);
  }
  return null;
}

// ──────────── requireAuth ────────────
// Returns Session if authenticated, or NextResponse(401) if not.

export async function requireAuth(req: Request): Promise<Session | NextResponse> {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "احراز هویت نشده — لطفاً وارد شوید" }, { status: 401 });
  }
  return session;
}

// ──────────── requireRole ────────────
// Check if session has one of the required roles.
// Returns null if OK, or NextResponse(403) if forbidden.

export function requireRole(
  session: Session,
  roles: Session["role"] | Session["role"][]
): NextResponse | null {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(session.role)) {
    return NextResponse.json(
      { error: "دسترسی غیرمجاز — شما اجازه این عملیات را ندارید" },
      { status: 403 }
    );
  }
  return null;
}

// ──────────── requireOwnership ────────────
// Object-level authorization (BOLA protection).
// Resolves the authenticated user to their Customer or Technician profile.

export async function getCustomerFromSession(session: Session) {
  if (session.role !== "CUSTOMER") return null;
  return db.customer.findUnique({ where: { userId: session.userId } });
}

export async function getTechnicianFromSession(session: Session) {
  if (session.role !== "TECHNICIAN") return null;
  return db.technician.findUnique({ where: { userId: session.userId } });
}

// Check if user owns a vehicle
export async function requireVehicleOwner(session: Session, vehicleId: string): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null; // Admin can access all
  const customer = await getCustomerFromSession(session);
  if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });
  const vehicle = await db.vehicle.findUnique({ where: { id: vehicleId }, select: { customerId: true } });
  if (!vehicle) return NextResponse.json({ error: "خودرو یافت نشد" }, { status: 404 });
  if (vehicle.customerId !== customer.id) {
    return NextResponse.json({ error: "دسترسی به این خودرو مجاز نیست" }, { status: 403 });
  }
  return null;
}

// Check if user is participant in a job (customer or assigned technician)
export async function requireJobParticipant(session: Session, jobId: string): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null;
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { id: true, request: { select: { customerId: true } }, technicianId: true },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });

  if (session.role === "CUSTOMER") {
    const customer = await getCustomerFromSession(session);
    if (!customer || job.request.customerId !== customer.id) {
      return NextResponse.json({ error: "دسترسی به این کار مجاز نیست" }, { status: 403 });
    }
  } else if (session.role === "TECHNICIAN") {
    const technician = await getTechnicianFromSession(session);
    if (!technician || job.technicianId !== technician.id) {
      return NextResponse.json({ error: "دسترسی به این کار مجاز نیست" }, { status: 403 });
    }
  }
  return null;
}

// Check if user owns a notification
export async function requireNotificationOwner(session: Session, notificationId: string): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null;
  const notif = await db.notification.findUnique({ where: { id: notificationId }, select: { userId: true } });
  if (!notif) return NextResponse.json({ error: "اعلان یافت نشد" }, { status: 404 });
  if (notif.userId !== session.userId) {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }
  return null;
}

// Check if user owns a wallet (technician only)
export async function requireWalletOwner(session: Session, walletId: string): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null;
  const technician = await getTechnicianFromSession(session);
  if (!technician) return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 403 });
  const wallet = await db.wallet.findUnique({ where: { id: walletId }, select: { technicianId: true } });
  if (!wallet) return NextResponse.json({ error: "کیف پول یافت نشد" }, { status: 404 });
  if (wallet.technicianId !== technician.id) {
    return NextResponse.json({ error: "دسترسی به این کیف پول مجاز نیست" }, { status: 403 });
  }
  return null;
}

// Check if user owns a support ticket
export async function requireTicketOwner(session: Session, ticketId: string): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null;
  const ticket = await db.supportTicket.findUnique({ where: { id: ticketId }, select: { userId: true } });
  if (!ticket) return NextResponse.json({ error: "تیکت یافت نشد" }, { status: 404 });
  if (ticket.userId !== session.userId) {
    return NextResponse.json({ error: "دسترسی به این تیکت مجاز نیست" }, { status: 403 });
  }
  return null;
}

// Check if user owns an insurance policy
export async function requirePolicyOwner(session: Session, policyId: string): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null;
  const policy = await db.insurancePolicy.findUnique({ where: { id: policyId }, select: { userId: true } });
  if (!policy) return NextResponse.json({ error: "بیمه یافت نشد" }, { status: 404 });
  if (policy.userId !== session.userId) {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }
  return null;
}

// ──────────── Mass Assignment Protection ────────────
// Whitelist allowed fields for each entity type.

export const ALLOWED_FIELDS = {
  vehicle: ["type", "make", "model", "year", "plate", "engineHours", "location", "lat", "lng", "image", "notes"],
  profile: ["name", "email", "nationalId", "address", "postalCode", "city", "province"],
  technician: ["bio", "experienceYears", "hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy", "availableNow", "responseMins", "lat", "lng", "heading"],
  message: ["body", "kind"],
  review: ["rating", "comment", "tags"],
  ticket: ["subject", "category", "priority", "message"],
  insurance: ["provider", "policyNumber", "type", "startDate", "endDate", "premiumAmount", "coverageAmount", "vehicleId", "notes"],
  maintenance: ["category", "title", "intervalKm", "intervalHours", "intervalDays", "lastDoneKm", "lastDoneHours", "lastDoneDate", "nextDueKm", "nextDueDate", "notes", "active", "vehicleId"],
} as const;

// Fields that should NEVER be settable by client (server-authoritative only)
export const FORBIDDEN_FIELDS = new Set([
  "role", "status", "verified", "rating", "reviewCount", "balance",
  "completedJobs", "phoneVerified", "profileCompleted", "password",
  "passwordHash", "totalEarned", "totalCommission", "totalWithdrawn",
  "pendingBalance", "platformCommission", "netEarnings", "holdUntil",
  "reviewerId", "adminNotes", "createdAt", "updatedAt", "id",
]);

// Filter an object to only allow whitelisted fields
export function sanitizeInput<T extends Record<string, any>>(input: T, allowed: readonly string[]): Partial<T> {
  const result: Record<string, any> = {};
  for (const key of allowed) {
    if (key in input) {
      result[key] = input[key];
    }
  }
  return result as Partial<T>;
}

// ──────────── Request ID ────────────

export function generateRequestId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `MEK-${ts}-${rand}`;
}

// ──────────── Error Handler ────────────

export function apiError(message: string, status: number = 400, requestId?: string) {
  return NextResponse.json(
    {
      error: process.env.NODE_ENV === "production" ? "خطایی در پردازش درخواست رخ داد" : message,
      requestId: requestId || generateRequestId(),
    },
    { status }
  );
}

// ──────────── Idempotency ────────────
//
// Cached in the D1 `IdempotencyKey` table (when the DB is reachable) so the
// same idempotency-key returns the same response across all isolates that
// share the D1 database. Falls back to an in-memory Map (single-instance
// dev mode) when D1 is unavailable.
//
// Key shape: `idem:<key>` so idempotency entries live in their own namespace
// and are easy to inspect / flush independently of rate-limit counters.
//
// TTL is 24h — expired entries should be swept by a periodic cleanup job
// (or just left to accumulate; the table is small and indexed by expiresAt).

export function getIdempotencyKey(req: Request): string | null {
  return req.headers.get("x-idempotency-key") || req.headers.get("Idempotency-Key");
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// In-memory fallback store (used when D1 is unavailable — dev mode without DB).
// Each entry: { response: string, expiresAt: number }.
const idemMemStore = new Map<string, { response: string; expiresAt: number }>();

export async function withIdempotency<T>(
  req: Request,
  fn: () => Promise<T>
): Promise<{ cached: boolean; data: T } | null> {
  const key = getIdempotencyKey(req);
  if (!key) return null;

  const d1Key = `idem:${key}`;
  const now = Date.now();

  // Try D1 IdempotencyKey table (works on Cloudflare + local SQLite via Prisma)
  try {
    const existing = await db.idempotencyKey.findUnique({ where: { key: d1Key } });

    if (existing && existing.expiresAt.getTime() > now) {
      return { cached: true, data: JSON.parse(existing.response) as T };
    }

    // Execute and cache. D1 has no transaction — best-effort write.
    const result = await fn();
    const expiresAt = new Date(now + IDEMPOTENCY_TTL_MS);
    await db.idempotencyKey.upsert({
      where: { key: d1Key },
      create: {
        key: d1Key,
        response: JSON.stringify(result),
        expiresAt,
      },
      update: {
        response: JSON.stringify(result),
        expiresAt,
      },
    });
    return { cached: false, data: result };
  } catch {
    // Fall back to in-memory (dev mode without DB)
    const cached = idemMemStore.get(d1Key);
    if (cached && cached.expiresAt > now) {
      try {
        return { cached: true, data: JSON.parse(cached.response) as T };
      } catch {
        // Corrupt cache entry — fall through and re-execute.
      }
    }

    const result = await fn();
    idemMemStore.set(d1Key, {
      response: JSON.stringify(result),
      expiresAt: now + IDEMPOTENCY_TTL_MS,
    });
    return { cached: false, data: result };
  }
}
