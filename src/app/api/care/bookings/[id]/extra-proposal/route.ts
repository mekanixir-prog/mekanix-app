// MEKANIX CARE — Extra cost proposal (technician → customer)

import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { maskFinancialFields } from "@/lib/money/financial-read-mask";
import { getTechnicianFromSession } from "@/lib/auth";
import { validateExtraProposalInput } from "@/lib/care-extra-pricing";
import {
  requireAssignedTechnician,
  isValidTransition,
} from "@/lib/care-auth";
import {
  CareExtraProposalConflictError,
  createCareExtraProposalAtomically,
  type CareExtraFindingInput,
} from "@/lib/care-extra-proposal-atomic";

const EXTRA_PROPOSAL_ALLOWED_STATES = ["INSPECTING", "IN_SERVICE"] as const;
const PART_TYPES = ["OEM", "AFTERMARKET", "ALTERNATIVE"] as const;
const FINDING_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

function optionalText(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false } {
  const value = input[key];
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || value.trim().length > maxLength) {
    return { ok: false };
  }
  return { ok: true, value: value.trim() };
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const authz = await requireAssignedTechnician(session, id);
  if (authz) return authz;

  // Carry the trusted technician profile ID into the atomic write. The earlier
  // route-level authorization alone is not sufficient: assignment may change
  // between that check and the database compare-and-set.
  const actorTechnician = session.role === "TECHNICIAN"
    ? await getTechnicianFromSession(session)
    : null;
  if (session.role === "TECHNICIAN" && !actorTechnician?.id) {
    return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 403 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه JSON نامعتبر است" }, { status: 400 });
  }

  const validated = validateExtraProposalInput(rawBody);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const body = rawBody as Record<string, unknown>;
  const proposal = validated.value;

  const description = optionalText(body, "description", 2000);
  const partName = optionalText(body, "partName", 160);
  const partBrand = optionalText(body, "partBrand", 120);
  const partNumber = optionalText(body, "partNumber", 120);
  const imageUrl = optionalText(body, "imageUrl", 2048);
  const technicianNote = optionalText(body, "technicianNote", 1000);
  if (
    !description.ok || !partName.ok || !partBrand.ok || !partNumber.ok ||
    !imageUrl.ok || !technicianNote.ok
  ) {
    return NextResponse.json({ error: "یکی از فیلدهای متنی پیشنهاد نامعتبر یا بیش از حد طولانی است" }, { status: 400 });
  }

  const partTypeValue = body.partType === undefined || body.partType === null || body.partType === ""
    ? "OEM"
    : body.partType;
  if (typeof partTypeValue !== "string" || !PART_TYPES.includes(partTypeValue as typeof PART_TYPES[number])) {
    return NextResponse.json({ error: "نوع قطعه نامعتبر است" }, { status: 400 });
  }

  let newFinding: CareExtraFindingInput | null = null;
  if (body.finding !== undefined && body.finding !== null) {
    if (typeof body.finding !== "object" || Array.isArray(body.finding)) {
      return NextResponse.json({ error: "اطلاعات عیب نامعتبر است" }, { status: 400 });
    }
    const finding = body.finding as Record<string, unknown>;
    const title = typeof finding.title === "string" ? finding.title.trim() : "";
    const category = finding.category === undefined ? "general" : finding.category;
    const severity = finding.severity === undefined ? "MEDIUM" : finding.severity;
    const findingDescription = optionalText(finding, "description", 2000);
    if (
      !title || title.length > 160 ||
      typeof category !== "string" || !category.trim() || category.trim().length > 64 ||
      typeof severity !== "string" ||
      !FINDING_SEVERITIES.includes(severity as typeof FINDING_SEVERITIES[number]) ||
      !findingDescription.ok
    ) {
      return NextResponse.json({ error: "اطلاعات عیب نامعتبر است" }, { status: 400 });
    }
    newFinding = {
      category: category.trim(),
      title,
      description: findingDescription.value,
      severity,
    };
  }
  if (proposal.findingId && newFinding) {
    return NextResponse.json({ error: "هم‌زمان شناسه عیب و عیب جدید ارسال نکنید" }, { status: 400 });
  }

  const booking = await db.serviceBooking.findUnique({
    where: { id },
    select: { id: true, status: true, userId: true },
  });
  if (!booking) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }

  if (!EXTRA_PROPOSAL_ALLOWED_STATES.includes(booking.status as typeof EXTRA_PROPOSAL_ALLOWED_STATES[number])) {
    return NextResponse.json(
      {
        error: "در وضعیت فعلی سفارش امکان ثبت پیشنهاد هزینه اضافه وجود ندارد",
        currentStatus: booking.status,
        allowedStates: EXTRA_PROPOSAL_ALLOWED_STATES,
      },
      { status: 409 },
    );
  }

  if (!isValidTransition(session.role, booking.status, "WAITING_CUSTOMER_APPROVAL")) {
    return NextResponse.json(
      {
        error: `انتقال وضعیت مجاز نیست: ${booking.status} → WAITING_CUSTOMER_APPROVAL برای نقش ${session.role}`,
        currentStatus: booking.status,
        nextStatus: "WAITING_CUSTOMER_APPROVAL",
      },
      { status: 409 },
    );
  }

  try {
    const approval = await createCareExtraProposalAtomically(db, {
      bookingId: id,
      expectedBookingStatus: booking.status as "INSPECTING" | "IN_SERVICE",
      actorRole: session.role === "ADMIN" ? "ADMIN" : "TECHNICIAN",
      actorUserId: session.userId,
      actorTechnicianId: actorTechnician?.id ?? null,
      proposal,
      details: {
        description: description.value,
        partName: partName.value,
        partBrand: partBrand.value,
        partNumber: partNumber.value,
        partType: partTypeValue,
        imageUrl: imageUrl.value,
        technicianNote: technicianNote.value,
      },
      newFinding,
    });

    try {
      await db.notification.create({
        data: {
          userId: booking.userId,
          type: "extra_proposal",
          title: "پیشنهاد هزینه اضافه",
          body: `${proposal.proposedItem} — پیشنهاد هزینه ثبت شد و پس از تأیید واحد مالی قابل بررسی است.`,
          category: "job",
          link: "care-detail",
        },
      });
    } catch (error) {
      console.error(
        "[care-extra-proposal] customer notification failed",
        error instanceof Error ? error.message : "unknown error",
      );
    }

    return NextResponse.json(maskFinancialFields(approval, ["partPrice", "laborPrice", "totalPrice"]));
  } catch (error) {
    if (error instanceof CareExtraProposalConflictError) {
      return NextResponse.json(
        { error: "وضعیت سفارش یا عیب هم‌زمان تغییر کرده است؛ صفحه را تازه‌سازی کنید" },
        { status: 409 },
      );
    }
    throw error;
  }
}
