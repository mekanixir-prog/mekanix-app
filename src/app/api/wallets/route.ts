import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";

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

  // Auto-release: any PENDING txns with holdUntil < now → AVAILABLE
  const now = new Date();
  const releasable = wallet.transactions.filter(
    (t) => t.status === "PENDING" && t.holdUntil && t.holdUntil.getTime() < now.getTime()
  );
  for (const t of releasable) {
    // SEC-8 fix: conditional updateMany with count check.
    // Previously: unconditional walletTransaction.update + wallet.update was
    // non-atomic. Two concurrent GET /api/wallets requests could both see the
    // same PENDING transaction, both call update (idempotent set to AVAILABLE),
    // and both increment wallet.balance — doubling the credit.
    //
    // Now: conditional updateMany with WHERE on status=PENDING ensures only
    // the first request that wins the race transitions the row. If count === 1,
    // apply the wallet delta; if count === 0, skip it to avoid double-crediting.
    const releaseResult = await db.walletTransaction.updateMany({
      where: { id: t.id, status: "PENDING" },
      data: { status: "AVAILABLE", releasedAt: now },
    });
    if (releaseResult.count === 1) {
      await db.wallet.update({
        where: { id: wallet.id },
        data: {
          pendingBalance: { decrement: t.netAmount },
          balance: { increment: t.netAmount },
        },
      });
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
