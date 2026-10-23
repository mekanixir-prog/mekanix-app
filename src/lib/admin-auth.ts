import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getDbForLib } from "./db-access";

// ─────────────────────────────────────────────────────────────────────────────
// SEC-21 fix: Admin JWT isolation + payload-shape validation.
//
// Previously `verifyAdminToken` accepted ANY token signed with `JWT_SECRET`,
// which in production collides with the user-OTP secret (`src/lib/auth.ts`).
// A user JWT therefore passed the admin gate (adminId/username were `undefined`
// but truthy enough to bypass `if (!adminSession)`).
//
// Two layers of defense now:
//   (1) Secret separation — admin tokens prefer `ADMIN_JWT_SECRET`. If unset,
//       admin falls back to `JWT_SECRET` (backward compat) but a prod warning
//       is emitted recommending explicit separation. A user token signed with
//       `JWT_SECRET` can no longer verify when `ADMIN_JWT_SECRET` is set.
//   (2) Payload-shape validation — even if secrets still collide, a token is
//       only accepted as an admin session if it carries a non-empty `adminId`
//       and a role in {ADMIN, SUPER_ADMIN}. A user token has role "CUSTOMER"
//       and is rejected.
//
// The secret is read INSIDE the function (not module-level) so test harnesses
// can stub env per-test (fixes SEC-17).
// ─────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);

function getAdminSecret(): Uint8Array {
  // Prefer a dedicated admin secret to guarantee cryptographic isolation
  // from user-session JWTs.
  const adminSecret = process.env.ADMIN_JWT_SECRET;
  if (adminSecret) return encoder.encode(adminSecret);

  // Backward-compat fallback: reuse JWT_SECRET. This keeps existing admin
  // tokens working, but relies on payload-shape validation below for safety.
  const sharedSecret = process.env.JWT_SECRET;
  if (sharedSecret) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "⚠ SECURITY: ADMIN_JWT_SECRET is not set — admin tokens fall back to JWT_SECRET. " +
          "Set ADMIN_JWT_SECRET to fully isolate admin sessions from user sessions."
      );
    }
    return encoder.encode(sharedSecret);
  }

  // No secret configured at all.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET (or ADMIN_JWT_SECRET) environment variable is required in production"
    );
  }
  // Dev-only fallback — NEVER in production
  return encoder.encode("mekanix-admin-dev-secret-change-me");
}

export type AdminSession = {
  adminId: string;
  username: string;
  role: string;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createAdminToken(payload: AdminSession): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getAdminSecret());
}

export async function verifyAdminToken(token: string): Promise<AdminSession | null> {
  try {
    const { payload } = await jwtVerify(token, getAdminSecret());

    // ── Payload-shape validation (SEC-21 layer 2) ──────────────────────────
    // Reject any token that does not carry a real admin identity. This blocks
    // user-session JWTs (role "CUSTOMER", no adminId) even if the signing
    // secret happens to match.
    const adminId = payload.adminId;
    const role = payload.role;
    if (typeof adminId !== "string" || adminId.length === 0) return null;
    if (typeof role !== "string" || !ADMIN_ROLES.has(role)) return null;

    return {
      adminId,
      username: typeof payload.username === "string" ? payload.username : "",
      role,
    };
  } catch {
    return null;
  }
}

export async function getAdminFromRequest(req: Request): Promise<AdminSession | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return verifyAdminToken(auth.slice(7));
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
