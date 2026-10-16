import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getDbForLib } from "./db-access";

// JWT secret — NEVER fall back to a hardcoded value in production.
// In dev we use a clearly-marked insecure secret so the app keeps working
// locally without forcing env setup, but production builds MUST set JWT_SECRET.
const JWT_SECRET = process.env.JWT_SECRET;
const encoder = new TextEncoder();

function getAdminSecret(): Uint8Array {
  if (!JWT_SECRET) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET environment variable is required in production");
    }
    // Dev-only fallback — NEVER in production
    return encoder.encode("mekanix-admin-dev-secret-change-me");
  }
  return encoder.encode(JWT_SECRET);
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
    return {
      adminId: payload.adminId as string,
      username: payload.username as string,
      role: payload.role as string,
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
