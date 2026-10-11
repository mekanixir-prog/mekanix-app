import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getSessionFromRequest } from "@/lib/auth";

const TECHNICIAN_INCLUDE = {
  specialties: true,
  certifications: true,
  serviceAreas: true,
} as const;

// Safe user select — NEVER expose password
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  phoneVerified: true,
  name: true,
  avatar: true,
  role: true,
  status: true,
  country: true,
  currency: true,
  language: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Resolve user session — JWT ONLY, no userId fallback
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "احراز هویت نشده" }, { status: 401 });
  }

  const db = await getDbForLib();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: {
      ...SAFE_USER_SELECT,
      customer: true,
      technician: { include: TECHNICIAN_INCLUDE },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "کاربر یافت نشد" }, { status: 404 });
  }

  // Ensure customer record exists (for users created before customer profile was required)
  if (!user.customer && (user.role === "CUSTOMER" || user.role === "TECHNICIAN")) {
    try {
      await db.customer.create({ data: { userId: user.id } });
      // Re-fetch to include the new customer record
      const fresh = await db.user.findUnique({
        where: { id: session.userId },
        select: {
          ...SAFE_USER_SELECT,
          customer: true,
          technician: { include: TECHNICIAN_INCLUDE },
        },
      });
      if (fresh) return NextResponse.json({ user: fresh });
    } catch {}
  }

  return NextResponse.json({ user });
}

// GET also requires JWT
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "احراز هویت نشده" }, { status: 401 });
  }

  const db = await getDbForLib();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: {
      ...SAFE_USER_SELECT,
      customer: true,
      technician: { include: TECHNICIAN_INCLUDE },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "کاربر یافت نشد" }, { status: 404 });
  }

  return NextResponse.json({ user });
}
