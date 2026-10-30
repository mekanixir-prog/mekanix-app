import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";
import type { PrismaClient } from "@prisma/client";

// Each handler receives the db client (async-resolved per request) so it no
// longer depends on the module-level sync `db` import (a stub in Workers).
const HANDLERS: Record<string, (db: PrismaClient) => Promise<any[]>> = {
  customers: async (db) => {
    const list = await db.customer.findMany({
      include: { user: true, _count: { select: { vehicles: true, serviceRequests: true } } },
      orderBy: { createdAt: "desc" },
    });
    return list;
  },
  technicians: async (db) => {
    const list = await db.technician.findMany({
      include: { user: true, specialties: true, certifications: true },
      orderBy: { rating: "desc" },
    });
    return list;
  },
  jobs: async (db) => {
    const list = await db.job.findMany({
      include: {
        request: { include: { customer: { include: { user: true } }, vehicle: true } },
        technician: { include: { user: true } },
        invoice: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return list;
  },
  payments: async (db) => {
    const list = await db.payment.findMany({
      include: { invoice: { include: { job: true } }, user: true },
      orderBy: { createdAt: "desc" },
    });
    return list;
  },
  withdrawals: async (db) => {
    return db.withdrawalRequest.findMany({
      include: {
        wallet: { include: { technician: { include: { user: true } } } },
      },
      orderBy: { requestedAt: "desc" },
    });
  },
  reviews: async (db) => {
    const list = await db.review.findMany({
      include: { fromUser: true, technician: { include: { user: true } }, job: true },
      orderBy: { createdAt: "desc" },
    });
    return list;
  },
  vehicles: async (db) => {
    const list = await db.vehicle.findMany({
      include: { customer: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
    });
    return list;
  },
  categories: async (db) => {
    return db.serviceCategory.findMany({ orderBy: { order: "asc" } });
  },
  applications: async (db) => {
    const list = await db.mechanicApplication.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { include: { technician: true } } },
    });
    return list;
  },
};

export async function GET(req: Request, { params }: { params: Promise<{ resource: string }> }) {
  const adminSession = await getAdminFromRequest(req);
  if (!adminSession) return NextResponse.json({ error: "احراز هویت مدیر الزامی است" }, { status: 401 });

  const { resource } = await params;
  const handler = HANDLERS[resource];
  if (!handler) return NextResponse.json({ error: "Unknown resource" }, { status: 404 });
  const db = await getDbForLib();
  const data = await handler(db);
  return NextResponse.json(data);
}
