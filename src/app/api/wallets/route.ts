import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { releaseWalletTransaction } from "@/lib/wallet-release";

// GET /api/wallets
// Returns the wallet + recent transactions for the authenticated technician.
// technicianId is derived from the session — the query param is IGNORED (BOLA protection).
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  // Only TECHNICIAN or ADMIN can view a wallet
  if (session.role !== "TECHNICIAN" && session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  let technicianId: string;
  if (session.role === "ADMIN") {
    // Admin may pass technicianId in query for inspection
    const url = new URL(req.url);
    const q = url.searchParams.get("technicianId");
    if (!q) return NextResponse.json({ error: "technicianId is required" }, { status: 400 });
    technicianId = q;
  } else {
    const tech = await getTechnicianFromSession(session);
    if (!tech) return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 403 });
    technicianId = tech.id;
  }

  // Find or create wallet
  const db = await getDbForLib();
  let wallet = await db.wallet.findUnique({
    where: { technicianId },
    include: {
      transactions: { orderBy: { createdAt: "desc" }, take: 50 },
      withdrawals: { orderBy: { requestedAt: "desc" }, take: 20 },
    },
  });
  if (!wallet) {
    wallet = await db.wallet.create({
      data: { technicianId },
      include: {
        transactions: { orderBy: { createdAt: "desc" }, take: 50 },
        withdrawals: { orderBy: { requestedAt: "desc" }, take: 20 },
      },
    });
  }

  // Development convenience only. Production GET handlers must remain
  // read-only: matured escrow is released by the scheduled Cron Worker, not
  // by a user opening or refreshing the wallet screen. Until the worker has
  // passed isolated D1 staging and is deployed, matured entries remain pending.
  if (process.env.NODE_ENV !== "production") {
    const now = new Date();
    const releasable = wallet.transactions.filter(
      (t) => t.status === "PENDING" && t.holdUntil && t.holdUntil.getTime() <= now.getTime()
    );
    for (const transaction of releasable) {
      await releaseWalletTransaction(db, wallet.id, transaction.id, now);
    }
  }

  const fresh = await db.wallet.findUnique({
    where: { technicianId },
    include: {
      transactions: { orderBy: { createdAt: "desc" }, take: 50 },
      withdrawals: { orderBy: { requestedAt: "desc" }, take: 20 },
    },
  });

  return NextResponse.json(fresh);
}
