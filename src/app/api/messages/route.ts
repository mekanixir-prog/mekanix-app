import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";

export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return NextResponse.json([]);

  // BOLA: must be participant in the job (or admin)
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();
  const list = await db.message.findMany({
    where: { jobId },
    include: { fromUser: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(list);
}

export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { jobId, body: text, kind } = body;

  if (typeof jobId !== "string" || !jobId) {
    return NextResponse.json({ error: "jobId الزامی است" }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "متن پیام الزامی است" }, { status: 400 });
  }

  // BOLA: must be participant in the job to send a message
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();

  // Server-authoritative: fromUserId comes from session — NEVER from the request body
  const msg = await db.message.create({
    data: {
      jobId,
      fromUserId: session.userId,
      kind: typeof kind === "string" && ["text", "image", "voice"].includes(kind) ? kind : "text",
      body: text.slice(0, 5000),
    },
    include: { fromUser: true },
  });

  // Notify the other party — best-effort. A notification failure must not
  // cause a 500 after the message was already created.
  try {
    const job = await db.job.findUnique({
      where: { id: jobId },
      include: {
        technician: { include: { user: true } },
        request: { include: { customer: { include: { user: true } } } },
      },
    });
    if (job) {
      const isFromTech = session.userId === job.technician.userId;
      const target = isFromTech ? job.request.customer.user : job.technician.user;
      await db.notification.create({
        data: {
          userId: target.id,
          type: "new_message",
          title: "New message",
          body: text.slice(0, 80),
          category: "message",
          link: isFromTech ? "customer/chat" : "technician/job-detail",
        },
      });
    }
  } catch (e) {
    console.error("[messages] Failed to create new-message notification (message still sent):", e);
  }

  return NextResponse.json(msg);
}
