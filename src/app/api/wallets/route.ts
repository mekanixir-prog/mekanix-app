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
        .map((job) => [job.id, job.completedAt as Date] as const)
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

  const nowForSummary = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const tehranDateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowForSummary);
  const part = (type: string) => Number(tehranDateParts.find((item) => item.type === type)?.value);
  const todayStart = new Date(Date.UTC(part("year"), part("month") - 1, part("day")) - 210 * 60 * 1000);
  const fourteenDaysStart = new Date(todayStart.getTime() - 13 * dayMs);
  const earningRows = fresh
    ? await db.walletTransaction.findMany({
        where: {
          walletId: fresh.id,
          createdAt: { gte: fourteenDaysStart },
          netAmount: { gt: 0 },
        },
        select: { createdAt: true, netAmount: true },
      })
    : [];

  const normalizedEarnings = earningRows.map((row) => ({
    createdAt: row.createdAt,
    amount: Number(row.netAmount),
  }));
  const rowsValid = normalizedEarnings.every(
    (row) => Number.isSafeInteger(row.amount) && row.amount > 0
  );
  const safeSum = (rows: typeof normalizedEarnings): number | null => {
    let total = 0;
    for (const row of rows) {
      const next = total + row.amount;
      if (!Number.isSafeInteger(next)) return null;
      total = next;
    }
    return total;
  };
  const sumSince = (startDate: Date) =>
    safeSum(normalizedEarnings.filter((row) => row.createdAt >= startDate));
  const dateKey = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  const dailyTotals = Array.from({ length: 14 }, (_, index) => {
    const start = new Date(todayStart.getTime() + (index - 13) * dayMs);
    const end = new Date(start.getTime() + dayMs);
    const total = safeSum(normalizedEarnings.filter((row) => row.createdAt >= start && row.createdAt < end));
    return { date: dateKey(start), revenue: total, jobs: 0 };
  });
  const todayIrr = sumSince(todayStart);
  const last7DaysIrr = sumSince(new Date(todayStart.getTime() - 6 * dayMs));
  const earningsValid = rowsValid && todayIrr !== null && last7DaysIrr !== null &&
    dailyTotals.every((day) => day.revenue !== null);
  const earningsSeries14d = earningsValid
    ? dailyTotals.map((day) => ({ ...day, revenue: day.revenue as number }))
    : [];

  return NextResponse.json(fresh ? {
    ...fresh,
    currency: "IRR" as const,
    earningsSummary: {
      currency: "IRR" as const,
      valid: earningsValid,
      todayIrr: earningsValid ? todayIrr : null,
      last7DaysIrr: earningsValid ? last7DaysIrr : null,
      series14d: earningsValid ? earningsSeries14d : [],
    },
  } : fresh);
}
