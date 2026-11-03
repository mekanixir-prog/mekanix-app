import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";

const include = {
  request: { include: { customer: { include: { user: { select: PARTICIPANT_USER_SELECT } } }, vehicle: true } },
  technician: { include: { user: { select: PARTICIPANT_USER_SELECT }, specialties: true } },
  parts: true,
  diagnosisRecords: true,
  invoice: true,
  reviews: true,
  messages: { include: { fromUser: { select: PARTICIPANT_USER_SELECT } }, orderBy: { createdAt: "asc" } },
  tracking: { orderBy: { ts: "asc" } },
} as const;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const access = await requireJobParticipant(session, id);
  if (access) return access;

  const db = await getDbForLib();
  const job = await db.job.findUnique({ where: { id }, include });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(job);
}
