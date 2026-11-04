import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getDbForLib } from "./db-access";
import { verifySession } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// Standalone admin authentication security contract:
// - Dedicated admin tokens require ADMIN_JWT_SECRET (>=32 bytes in production);
//   production never falls back to the general OTP/user-session secret.
// - Dedicated tokens must contain an admin identity, an allowed role, and a
//   persisted sessionVersion. The database version is checked on every request.
// - The standalone panel transports the token only in an HttpOnly cookie.
// - The in-app AdminApp remains on its separate OTP session + database-role path.
// Secrets are read inside functions so tests can safely stub environment values.
// ─────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);

function getAdminSecret(): Uint8Array {
  // Dedicated admin JWTs must never fall back to the general user-session secret
  // in production. The regular OTP-session path is separately authorized below
  // against the persisted database role and ACTIVE status.
  const adminSecret = process.env.ADMIN_JWT_SECRET;
  if (adminSecret) {
    if (process.env.NODE_ENV === "production" && new TextEncoder().encode(adminSecret).length < 32) {
      throw new Error("ADMIN_JWT_SECRET must contain at least 32 bytes in production");
    }
    return encoder.encode(adminSecret);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_JWT_SECRET environment variable is required for dedicated admin tokens in production");
  }

  // Development-only compatibility for local admin tooling.
  const sharedSecret = process.env.JWT_SECRET;
  if (sharedSecret) return encoder.encode(sharedSecret);
  // Dev-only fallback — NEVER in production
  return encoder.encode("mekanix-admin-dev-secret-change-me");
}

export type AdminSession = {
  adminId: string;
  username: string;
  role: string;
  sessionVersion?: number;
};

export const ADMIN_SESSION_COOKIE = "mekanix_admin_session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const ADMIN_SESSION_COOKIE_PATH = "/api/admin-panel";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createAdminToken(
  payload: AdminSession & { sessionVersion?: number }
): Promise<string> {
  const sessionVersion = payload.sessionVersion ?? 0;
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) {
    throw new Error("Invalid admin session version");
  }

  return new SignJWT({
    adminId: payload.adminId,
    username: payload.username,
    role: payload.role,
    sessionVersion,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getAdminSecret());
}

export async function verifyAdminToken(
  token: string
): Promise<(AdminSession & { sessionVersion: number }) | null> {
  try {
    const { payload } = await jwtVerify(token, getAdminSecret(), { algorithms: ["HS256"] });
    const adminId = payload.adminId;
    const role = payload.role;
    const sessionVersion = payload.sessionVersion;

    if (typeof adminId !== "string" || adminId.length === 0) return null;
    if (typeof role !== "string" || !ADMIN_ROLES.has(role)) return null;
    if (typeof sessionVersion !== "number" || !Number.isSafeInteger(sessionVersion) || sessionVersion < 0) {
      return null;
    }

    return {
      adminId,
      username: typeof payload.username === "string" ? payload.username : "",
      role,
      sessionVersion,
    };
  } catch {
    return null;
  }
}

export function getAdminCookieToken(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== ADMIN_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }

  return null;
}

/**
 * Cookie-authenticated mutations require an explicit same-origin signal.
 * Origin is authoritative when present; Fetch Metadata is the fallback.
 */
export function isSameOriginRequest(req: Request): boolean {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(req.url).origin;
  } catch {
    return false;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== requestOrigin) return false;
    } catch {
      return false;
    }
  } else if (req.headers.get("sec-fetch-site") !== "same-origin") {
    return false;
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin";
}

export function hasValidAdminCookieCsrf(req: Request): boolean {
  return !getAdminCookieToken(req) || isSameOriginRequest(req);
}

export function setAdminSessionCookie(response: Response, token: string, req: Request): void {
  const secure = process.env.NODE_ENV === "production" || new URL(req.url).protocol === "https:";
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    `Path=${ADMIN_SESSION_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  response.headers.append("Set-Cookie", attributes.join("; "));
}

export function clearAdminSessionCookie(response: Response, req: Request): void {
  const secure = process.env.NODE_ENV === "production" || new URL(req.url).protocol === "https:";
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=`,
    `Path=${ADMIN_SESSION_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) attributes.push("Secure");
  response.headers.append("Set-Cookie", attributes.join("; "));
}

export async function getAdminFromRequest(req: Request): Promise<AdminSession | null> {
  // The standalone admin panel uses a revocable HttpOnly cookie. If a cookie
  // is present but invalid/revoked, do not fall back to a bearer credential.
  const cookieToken = getAdminCookieToken(req);
  if (cookieToken) {
    const adminToken = await verifyAdminToken(cookieToken);
    if (!adminToken) return null;

    const db = await getDbForLib();
    const admin = await db.adminUser.findUnique({
      where: { id: adminToken.adminId },
      select: { id: true, username: true, role: true, sessionVersion: true },
    });
    if (
      !admin ||
      !ADMIN_ROLES.has(admin.role) ||
      admin.role !== adminToken.role ||
      admin.sessionVersion !== adminToken.sessionVersion
    ) {
      return null;
    }

    return {
      adminId: admin.id,
      username: admin.username,
      role: admin.role,
      sessionVersion: admin.sessionVersion,
    };
  }

  // The in-app AdminApp continues to authenticate through the regular OTP
  // session flow. Dedicated admin JWTs are no longer accepted as bearer tokens.
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const userSession = await verifySession(auth.slice(7));
  if (!userSession || userSession.role !== "ADMIN") return null;

  const db = await getDbForLib();
  const user = await db.user.findUnique({
    where: { id: userSession.userId },
    select: { name: true, role: true, status: true },
  });
  if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE") return null;
  return {
    adminId: userSession.userId,
    username: user.name ?? "",
    role: "ADMIN",
  };
}

/**
 * Ensures the system has at least one admin user.
 *
 * - Development: creates a default `admin / admin12345` user for convenience.
 * - Production: NEVER creates a default admin. The initial admin must be
 *   provisioned via env vars (`ADMIN_BOOTSTRAP_PASSWORD` and optionally
 *   `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_EMAIL`). If no admin exists
 *   and no bootstrap password is provided, a warning is logged and no user
 *   is created — an operator must seed the admin out-of-band.
 */
export async function ensureDefaultAdmin() {
  const db = await getDbForLib();
  const count = await db.adminUser.count();
  if (count > 0) return;

  if (process.env.NODE_ENV === "production") {
    const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    const bootstrapUsername = process.env.ADMIN_BOOTSTRAP_USERNAME || "admin";
    const bootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL || "admin@mekanix.ir";

    if (!bootstrapPassword) {
      console.warn(
        "⚠ No admin user found. Set ADMIN_BOOTSTRAP_PASSWORD env var to create the initial admin."
      );
      return;
    }

    const passwordHash = await hashPassword(bootstrapPassword);
    await db.adminUser.create({
      data: {
        username: bootstrapUsername,
        email: bootstrapEmail,
        passwordHash,
        name: "Super Admin",
        role: "SUPER_ADMIN",
      },
    });
    console.log("✓ Admin user created from ADMIN_BOOTSTRAP_* env vars");
    return;
  }

  // Development only — convenience default admin
  const passwordHash = await hashPassword("admin12345");
  await db.adminUser.create({
    data: {
      username: "admin",
      email: "admin@mekanix.ir",
      passwordHash,
      name: "Super Admin (Dev)",
      role: "SUPER_ADMIN",
    },
  });
  console.log("✓ Default admin created (DEV ONLY): admin / admin12345");
}
