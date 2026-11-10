import { ADMIN_USER_SELECT, AUTH_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { verifySession, requireRole } from "@/lib/auth";

function isUniqueConflict(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "P2002" || /unique constraint/i.test(value?.message ?? "");
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// POST /api/mechanic-applications/[id]/approve — ADMIN ONLY.
//
// Review decisions are claimed with a single compare-and-set transition:
// PENDING -> APPROVING. The reject endpoint claims PENDING -> REJECTING.
// D1 has no Prisma transaction support, so the claim is the serialization
// point; provisioning is idempotent and APPROVING can be safely resumed.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const session = await verifySession(auth.slice(7));
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const forbidden = requireRole(session, "ADMIN");
  if (forbidden) return forbidden;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const notes = typeof body?.notes === "string" ? body.notes.slice(0, 2000) : null;
  const db = await getDbForLib();

  let app = await db.mechanicApplication.findUnique({ where: { id } });
  if (!app) return NextResponse.json({ error: "Application not found" }, { status: 404 });

  if (!["PENDING", "APPROVING", "APPROVED"].includes(app.status)) {
    return NextResponse.json(
      { error: "Application cannot be approved from its current state", status: app.status },
      { status: 409 }
    );
  }

  // Resolve the account before claiming the review. Never downgrade privileged
  // roles or promote suspended accounts through this public application flow.
  let user = app.userId
    ? await db.user.findUnique({ where: { id: app.userId }, select: AUTH_USER_SELECT })
    : await db.user.findUnique({ where: { phone: app.phone }, select: AUTH_USER_SELECT });

  if (user && (
    (user.role !== "CUSTOMER" && user.role !== "TECHNICIAN") ||
    user.status === "SUSPENDED"
  )) {
    return NextResponse.json(
      { error: "Existing account cannot be converted to a technician", code: "ACCOUNT_ROLE_CONFLICT" },
      { status: 409 }
    );
  }

  let reviewStatus = app.status;
  if (reviewStatus === "PENDING") {
    const claim = await db.mechanicApplication.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "APPROVING", reviewerId: session.userId },
    });
    if (claim.count === 1) {
      reviewStatus = "APPROVING";
    } else {
      app = await db.mechanicApplication.findUnique({ where: { id } });
      if (!app || (app.status !== "APPROVING" && app.status !== "APPROVED")) {
        return NextResponse.json(
          { error: "Application review was claimed by another decision", status: app?.status ?? "MISSING" },
          { status: 409 }
        );
      }
      reviewStatus = app.status;
    }
  }

  // Create or recover the user. Keep the account as CUSTOMER until the
  // application reaches APPROVED, and never mark an unverified phone verified.
  if (!user) {
    try {
      user = await db.user.create({
        data: {
          name: app.fullName,
          phone: app.phone,
          email: app.email || `mechanic+${app.phone}@mekanix.io`,
          role: "CUSTOMER",
          phoneVerified: false,
          avatar: null,
        },
        select: AUTH_USER_SELECT,
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      user = await db.user.findUnique({ where: { phone: app.phone }, select: AUTH_USER_SELECT });
      if (!user) throw error;
    }
  }

  // A previous attempt may have created the profile before failing. Unique
  // constraints plus read-after-conflict make retries safe on both D1 and PG.
  let tech = await db.technician.findUnique({ where: { userId: user.id } });
  if (!tech) {
    const specialties = parseJsonArray(app.specialties)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .slice(0, 20);
    const certs = parseJsonArray(app.certifications).slice(0, 50);

    try {
      tech = await db.technician.create({
        data: {
          userId: user.id,
          bio: app.bio || "MEKANIX-approved mobile technician.",
          experienceYears: app.experienceYears,
          // Approval is not consent to be dispatched. Location, service areas,
          // availability, and commercial terms are collected/configured later.
          status: "OFFLINE",
          availableNow: false,
          verified: true,
          lat: null,
          lng: null,
          specialties: {
            create: specialties.map((category) => ({
              category,
              label: category.replace(/-/g, " "),
            })),
          },
          certifications: {
            create: certs.map((cert) => {
              const item = cert && typeof cert === "object" ? cert as Record<string, unknown> : {};
              const name = typeof cert === "string"
                ? cert
                : typeof item.name === "string" ? item.name : "Self-reported";
              return {
                name,
                issuer: typeof item.issuer === "string" ? item.issuer : "Self-reported",
                year: Number.isInteger(item.year) ? Number(item.year) : new Date().getFullYear(),
                verified: false,
              };
            }),
          },
        },
        include: { user: { select: ADMIN_USER_SELECT }, specialties: true },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      tech = await db.technician.findUnique({ where: { userId: user.id } });
      if (!tech) throw error;
    }
  }

  let finalizedByThisRequest = false;
  if (reviewStatus === "APPROVING") {
    const finalized = await db.mechanicApplication.updateMany({
      where: { id, status: "APPROVING" },
      data: {
        status: "APPROVED",
        userId: user.id,
        reviewerId: session.userId,
        reviewedAt: new Date(),
        adminNotes: notes,
      },
    });
    finalizedByThisRequest = finalized.count === 1;
    if (!finalizedByThisRequest) {
      app = await db.mechanicApplication.findUnique({ where: { id } });
      if (app?.status !== "APPROVED") {
        return NextResponse.json(
          { error: "Application approval could not be finalized", status: app?.status ?? "MISSING" },
          { status: 409 }
        );
      }
    }
  } else if (!app.userId) {
    await db.mechanicApplication.updateMany({
      where: { id, status: "APPROVED", userId: null },
      data: { userId: user.id },
    });
  }

  // Promote only after the application is durably APPROVED. The conditional
  // update prevents a concurrent account suspension or role change being lost.
  if (user.role === "CUSTOMER") {
    const promoted = await db.user.updateMany({
      where: { id: user.id, role: "CUSTOMER", status: { not: "SUSPENDED" } },
      data: { role: "TECHNICIAN" },
    });
    if (promoted.count !== 1) {
      user = await db.user.findUnique({ where: { id: user.id }, select: AUTH_USER_SELECT });
      if (!user || user.role !== "TECHNICIAN" || user.status === "SUSPENDED") {
        return NextResponse.json(
          { error: "Application approved but account promotion needs administrator review", code: "ACCOUNT_PROMOTION_CONFLICT" },
          { status: 409 }
        );
      }
    } else {
      user = await db.user.findUnique({ where: { id: user.id }, select: AUTH_USER_SELECT });
    }
  }

  if (!user || user.role !== "TECHNICIAN" || user.status === "SUSPENDED") {
    return NextResponse.json(
      { error: "Application approved but technician account is not ready", code: "ACCOUNT_PROMOTION_CONFLICT" },
      { status: 409 }
    );
  }

  if (finalizedByThisRequest) {
    try {
      await db.notification.create({
        data: {
          userId: user.id,
          type: "review_request",
          title: "Welcome to MEKANIX!",
          body: "Your application was approved. Complete your profile to become available for service requests.",
          category: "system",
          link: "technician/requests",
        },
      });
    } catch (error) {
      console.error("[mechanic-applications/approve] Notification creation failed after approval:", error);
    }
  }

  const updated = await db.mechanicApplication.findUnique({
    where: { id },
    include: { user: { select: { ...ADMIN_USER_SELECT, technician: true } } },
  });
  return NextResponse.json({ application: updated, user, technician: tech });
}
