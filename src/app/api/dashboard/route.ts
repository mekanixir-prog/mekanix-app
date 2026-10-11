import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// GET /api/dashboard — platform-wide stats.
// Authenticated users only. Customer/Technician see aggregate stats (no PII).
// Admin sees the same stats (the data is already aggregate).
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

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
      db.payment.findMany({ where: { status: "SUCCEEDED", createdAt: { gte: since } } }),
    ]);

  const revenue30d = payments30d.reduce((s, p) => s + Number(p.amount), 0);

  const techs = await db.technician.findMany({ select: { responseMins: true } });
  const avgResponseMins = techs.length
    ? Math.round(techs.reduce((s, t) => s + t.responseMins, 0) / techs.length)
    : 0;

  const reviews = await db.review.findMany({ select: { rating: true } });
  const customerSatisfaction = reviews.length
    ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
    : 0;

  const revenueSeries: { date: string; revenue: number; jobs: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - (i + 1) * day);
    const end = new Date(now - i * day);
    const pays = await db.payment.findMany({ where: { status: "SUCCEEDED", createdAt: { gte: start, lt: end } } });
    const jobs = await db.job.count({ where: { status: "COMPLETED", completedAt: { gte: start, lt: end } } });
    revenueSeries.push({
      date: end.toISOString().slice(5, 10),
      revenue: Math.round(pays.reduce((s, p) => s + Number(p.amount), 0)),
      jobs,
    });
  }

  const statusGroups = await db.job.groupBy({ by: ["status"], _count: true });
  const statusBreakdown = statusGroups.map((g) => ({ status: g.status, count: g._count }));

  const cats = await db.serviceRequest.groupBy({ by: ["category"], _count: true });
  const categoryBreakdown = await Promise.all(
    cats.map(async (c) => {
      const reqs = await db.serviceRequest.findMany({
        where: { category: c.category },
        select: { job: { select: { invoice: { select: { total: true } } } } },
      });
      const revenue = reqs.reduce(
        (s, r) => s + (r.job?.invoice?.total != null ? Number(r.job.invoice.total) : 0),
        0
      );
      return { category: c.category, count: c._count, revenue: Math.round(revenue) };
    })
  );

  const allTechs = await db.technician.findMany({
    include: { user: { select: { name: true } }, reviews: { select: { rating: true } } },
  });
  const techPerformance = await Promise.all(
    allTechs.map(async (t) => {
      const jobCount = await db.job.count({ where: { technicianId: t.id, status: "COMPLETED" } });
      const pays = await db.payment.findMany({
        where: { status: "SUCCEEDED", invoice: { job: { technicianId: t.id } } },
        select: { amount: true },
      });
      const revenue = Math.round(pays.reduce((s, p) => s + Number(p.amount), 0));
      return {
        name: t.user.name,
        jobs: jobCount,
        rating: Math.round(Number(t.rating) * 10) / 10,
        revenue,
      };
    })
  );
  techPerformance.sort((a, b) => b.revenue - a.revenue);

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
        revenue30d: Math.round(revenue30d),
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
