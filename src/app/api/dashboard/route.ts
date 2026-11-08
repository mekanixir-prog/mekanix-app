import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { sumVerifiedIrrAmounts } from "@/lib/money/financial-read-mask";

// GET /api/dashboard — platform-wide administrative analytics.
// Admin-only: the response includes financial aggregates, technician-level
// revenue/performance, and recent activity involving customer and technician names.
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  // This endpoint contains platform-wide financial analytics, technician
  // performance/revenue, and recent customer/technician activity. It is an
  // internal administration surface and must not be exposed to customer or
  // technician sessions.
  if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  const now = Date.now();
  const day = 86400000;
  const since = new Date(now - 30 * day);

  const db = await getDbForLib();

  const [activeRequests, techniciansOnline, jobsInProgress, completedJobs30d, payments30d] =
    await Promise.all([
      db.serviceRequest.count({ where: { status: "OPEN" } }),
      db.technician.count({ where: { status: "ONLINE" } }),
      db.job.count({
        where: {
          status: { in: ["ACCEPTED", "EN_ROUTE", "ARRIVED", "DIAGNOSING", "REPAIRING", "WAITING_APPROVAL"] },
        },
      }),
      db.job.count({ where: { status: "COMPLETED", completedAt: { gte: since } } }),
      db.payment.findMany({
        where: { status: "SUCCEEDED", currency: "IRR", financialUnitStatus: "VERIFIED_IRR", createdAt: { gte: since } },
        select: { amount: true },
      }),
    ]);

  const revenue30d = sumVerifiedIrrAmounts(payments30d.map((payment) => payment.amount));

  const techs = await db.technician.findMany({ select: { responseMins: true } });
  const avgResponseMins = techs.length
    ? Math.round(techs.reduce((s, t) => s + t.responseMins, 0) / techs.length)
    : 0;

  const reviews = await db.review.findMany({ select: { rating: true } });
  const customerSatisfaction = reviews.length
    ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
    : 0;

  const revenueSeries: { date: string; revenue: number | null; jobs: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - (i + 1) * day);
    const end = new Date(now - i * day);
    const pays = await db.payment.findMany({
      where: { status: "SUCCEEDED", currency: "IRR", financialUnitStatus: "VERIFIED_IRR", createdAt: { gte: start, lt: end } },
      select: { amount: true },
    });
    const jobs = await db.job.count({ where: { status: "COMPLETED", completedAt: { gte: start, lt: end } } });
    revenueSeries.push({
      date: end.toISOString().slice(5, 10),
      revenue: sumVerifiedIrrAmounts(pays.map((payment) => payment.amount)),
      jobs,
    });
  }

  const statusGroups = await db.job.groupBy({ by: ["status"], _count: true });
  const statusBreakdown = statusGroups.map((g) => ({ status: g.status, count: g._count }));

  const cats = await db.serviceRequest.groupBy({ by: ["category"], _count: true });
  const categoryBreakdown = await Promise.all(
    cats.map(async (c) => {
      // Revenue means successful, verified payments—not merely issued invoice
      // totals. An unverified or unsafe amount makes this aggregate unavailable.
      const payments = await db.payment.findMany({
        where: {
          status: "SUCCEEDED",
          currency: "IRR",
          financialUnitStatus: "VERIFIED_IRR",
          invoice: { job: { request: { category: c.category } } },
        },
        select: { amount: true },
      });
      return {
        category: c.category,
        count: c._count,
        revenue: sumVerifiedIrrAmounts(payments.map((payment) => payment.amount)),
      };
    })
  );

  const allTechs = await db.technician.findMany({
    include: { user: { select: { name: true } }, reviews: { select: { rating: true } } },
  });
  const techPerformance = await Promise.all(
    allTechs.map(async (t) => {
      const jobCount = await db.job.count({ where: { technicianId: t.id, status: "COMPLETED" } });
      const pays = await db.payment.findMany({
        where: {
          status: "SUCCEEDED",
          currency: "IRR",
          financialUnitStatus: "VERIFIED_IRR",
          invoice: { job: { technicianId: t.id } },
        },
        select: { amount: true },
      });
      const revenue = sumVerifiedIrrAmounts(pays.map((payment) => payment.amount));
      return {
        name: t.user.name,
        jobs: jobCount,
        rating: Math.round(Number(t.rating) * 10) / 10,
        revenue,
      };
    })
  );
  techPerformance.sort((a, b) => {
    if (a.revenue === null) return b.revenue === null ? 0 : 1;
    if (b.revenue === null) return -1;
    return b.revenue - a.revenue;
  });

  const recentJobs = await db.job.findMany({
    take: 8,
    orderBy: { updatedAt: "desc" },
    include: {
      request: { include: { customer: { include: { user: { select: { name: true } } } } } },
      technician: { include: { user: { select: { name: true } } } },
    },
  });
  const recentActivity = recentJobs.map((j) => ({
    id: j.id,
    label: `${j.code} · ${j.request.title}`,
    sub: `${j.technician.user.name} → ${j.request.customer.user.name}`,
    tone: j.status,
    ts: j.updatedAt.toISOString(),
  }));

  return NextResponse.json({
    data: {
      kpis: {
        activeRequests,
        techniciansOnline,
        jobsInProgress,
        completedJobs30d,
        revenue30d,
        avgResponseMins,
        customerSatisfaction: Math.round(customerSatisfaction * 10) / 10,
      },
      revenueSeries,
      statusBreakdown,
      categoryBreakdown,
      techPerformance,
      recentActivity,
    },
  });
}
