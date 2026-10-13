import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireRole, sanitizeInput, ALLOWED_FIELDS, FORBIDDEN_FIELDS } from "@/lib/auth";

// Mass-assignment protection: define per-resource whitelists.
const RESOURCE_ALLOWED_FIELDS: Record<string, readonly string[]> = {
  // Technicians: admin can edit profile fields, but NOT server-authoritative metrics.
  technicians: ["bio", "experienceYears", "hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy", "availableNow", "responseMins", "lat", "lng", "heading", "status", "verified", "level"],
  // Customers: editable profile fields
  customers: ["company", "taxId"],
  // Service categories: full edit
  categories: ["slug", "name", "nameFa", "icon", "basePrice", "order", "active"],
  // Reviews: status only (publish / unpublish / flag)
  reviews: ["status"],
  // Payments: status only (mark as REFUNDED, etc.)
  payments: ["status"],
};

// S3 FIX: valid User status values, matching the UserStatus enum in
// prisma/schema.prisma. Any other value must be rejected with 400 BEFORE
// any DB write — never cast to `any` and pass to Prisma.
const VALID_USER_STATUSES = ["ACTIVE", "SUSPENDED", "PENDING"] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ resource: string; id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  // Function-level authorization
  const forbidden = requireRole(session, "ADMIN");
  if (forbidden) return forbidden;

  const { resource, id } = await params;

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // S3 FIX: validate user.status BEFORE stripping FORBIDDEN_FIELDS.
  // 'status' is in FORBIDDEN_FIELDS (so it can't be mass-assigned to
  // technician/customer records), but for the customers resource, the admin
  // CAN set the linked User's status (ban/activate). We read it from the
  // original body here, validate it, and apply it to user.update below —
  // before the FORBIDDEN_FIELDS strip removes it.
  const requestedUserStatus = body.status;
  if (resource === "customers" && requestedUserStatus !== undefined) {
    if (
      typeof requestedUserStatus !== "string" ||
      !(VALID_USER_STATUSES as readonly string[]).includes(requestedUserStatus)
    ) {
      return NextResponse.json(
        { error: `status باید یکی از ${VALID_USER_STATUSES.join("، ")} باشد` },
        { status: 400 }
      );
    }
  }

  // Mass-assignment: strip forbidden fields (defense in depth)
  // This removes 'status' from body so it won't flow to customer.update
  // (where it would be a mass-assignment on the Customer record). The
  // validated status is applied to the User record separately below.
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      delete body[key];
    }
  }

  const db = await getDbForLib();
  let result: any = null;

  if (resource === "technicians") {
    const allowed = RESOURCE_ALLOWED_FIELDS.technicians ?? ALLOWED_FIELDS.technician;
    const safe = sanitizeInput(body, allowed);
    result = await db.technician.update({ where: { id }, data: safe as any, include: { user: true } });
  } else if (resource === "customers") {
    // Allow direct updates to customer record (company, taxId) — but block userId
    const allowed = RESOURCE_ALLOWED_FIELDS.customers ?? ALLOWED_FIELDS.profile;
    const safe = sanitizeInput(body, allowed);

    // Mid-failure ordering: update user.status FIRST (security-critical —
    // ban/activate the user), THEN update customer profile fields. If the
    // second write fails, the user IS banned/activated (the security action
    // took effect) — the admin can retry to complete the profile update.
    // Reversing the order would risk: admin thinks they banned a user, but
    // the ban didn't take effect (worse failure mode for a security op).
    if (typeof requestedUserStatus === "string") {
      const customer = await db.customer.findUnique({ where: { id }, select: { userId: true } });
      if (customer) {
        await db.user.update({
          where: { id: customer.userId },
          data: { status: requestedUserStatus as (typeof VALID_USER_STATUSES)[number] },
        });
      }
    }
    result = await db.customer.update({ where: { id }, data: safe as any, include: { user: true } });
  } else if (resource === "categories") {
    const allowed = RESOURCE_ALLOWED_FIELDS.categories ?? ALLOWED_FIELDS.profile;
    const safe = sanitizeInput(body, allowed);
    result = await db.serviceCategory.update({ where: { id }, data: safe as any });
  } else if (resource === "reviews") {
    const allowed = RESOURCE_ALLOWED_FIELDS.reviews ?? ALLOWED_FIELDS.review;
    const safe = sanitizeInput(body, allowed);
    result = await db.review.update({ where: { id }, data: safe as any });
  } else if (resource === "payments") {
    const allowed = RESOURCE_ALLOWED_FIELDS.payments ?? ALLOWED_FIELDS.review;
    const safe = sanitizeInput(body, allowed);
    result = await db.payment.update({ where: { id }, data: safe as any });
  } else {
    return NextResponse.json({ error: "Unsupported resource" }, { status: 400 });
  }
  return NextResponse.json(result);
}
