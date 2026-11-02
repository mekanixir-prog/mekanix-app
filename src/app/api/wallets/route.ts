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

  // Repair the crash window where the Job reached COMPLETED but the separate
  // holdUntil write failed. Only PREPAY rows are eligible; use the immutable
  // completedAt timestamp so retries never restart the 12-hour hold.
  const strandedPrepay = wallet.transactions.filter(
    (transaction) =>
      transaction.kind === "PREPAY" &&
      transaction.status === "PENDING" &&
      transaction.holdUntil === null &&
      transaction.jobId !== null
  );
  if (strandedPrepay.length > 0) {
    const completedJobs = await db.job.findMany({
      where: {
        id: { in: strandedPrepay.map((transaction) => transaction.jobId as string) },
        status: "COMPLETED",
        completedAt: { not: null },
      },
      select: { id: true, completedAt: true },
    });
    const completedAtByJob = new Map(
      completedJobs
        .filter((job) => job.completedAt !== null)
        .map((job) => [job.id, job.completedAt as Date])
    );

    for (const transaction of strandedPrepay) {
      const completedAt = completedAtByJob.get(transaction.jobId as string);
      if (!completedAt) continue;
      const holdUntil = new Date(completedAt.getTime() + 12 * 60 * 60 * 1000);
      await db.walletTransaction.updateMany({
        where: {
          id: transaction.id,
          walletId: wallet.id,
          kind: "PREPAY",
          status: "PENDING",
          holdUntil: null,
        },
        data: { holdUntil },
      });
    }

    wallet = await db.wallet.findUnique({
      where: { technicianId },
      include: {
        transactions: { orderBy: { createdAt: "desc" }, take: 50 },
        withdrawals: { orderBy: { requestedAt: "desc" }, take: 20 },
      },
    }) ?? wallet;
  }

  // Auto-release matured escrow entries. The helper commits the transaction
  // state transition and both wallet balance changes atomically for D1 and
  // transactional Node databases. A failed balance update cannot strand an
  // AVAILABLE transaction without its matching wallet credit.
  const now = new Date();
  const releasable = wallet.transactions.filter(
    (t) => t.status === "PENDING" && t.holdUntil && t.holdUntil.getTime() <= now.getTime()
  );
  for (const transaction of releasable) {
    await releaseWalletTransaction(db, wallet.id, transaction.id, now);
  }

  const fresh = await db.wallet.findUnique({
    where: { technicianId },
    include: {
      transactions: { orderBy: { createdAt: "desc" }, take: 50 },
      withdrawals: { orderBy: { requestedAt: "desc" }, take: 20 },
    },
  });

  return NextResponse.json(fresh ? { ...fresh, currency: "IRR" as const } : fresh);
}
