import { ADMIN_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";
import type { PrismaClient } from "@prisma/client";
import { maskFinancialFields, maskInvoiceFinancialData, maskJobFinancialData } from "@/lib/money/financial-read-mask";

// Each handler receives the db client (async-resolved per request) so it no
// longer depends on the module-level sync `db` import (a stub in Workers).
const HANDLERS: Record<string, (db: PrismaClient) => Promise<any[]>> = {
  customers: async (db) => {
    const list = await db.customer.findMany({
      include: { user: { select: ADMIN_USER_SELECT }, _count: { select: { vehicles: true, serviceRequests: true } } },
      orderBy: { createdAt: "desc" },
    });
    return list;
  },
  technicians: async (db) => {
    const list = await db.technician.findMany({
      include: { user: { select: ADMIN_USER_SELECT }, specialties: true, certifications: true },
      orderBy: { rating: "desc" },
    });
    return list.map((technician) => maskFinancialFields(technician, ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"]));
  },
  jobs: async (db) => {
    const list = await db.job.findMany({
      include: {
        request: { include: { customer: { include: { user: { select: ADMIN_USER_SELECT } } }, vehicle: true } },
        technician: { include: { user: { select: ADMIN_USER_SELECT } } },
        invoice: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return list.map((job) => maskJobFinancialData(job));
  },
  payments: async (db) => {
    const list = await db.payment.findMany({
      include: { invoice: { include: { job: true } }, user: { select: ADMIN_USER_SELECT } },
      orderBy: { createdAt: "desc" },
    });
    return list.map((payment) => ({
      ...maskFinancialFields(payment, ["amount"], "currency"),
      invoice: payment.invoice ? maskInvoiceFinancialData(payment.invoice) : payment.invoice,
    }));
  },
  withdrawals: async (db) => {
    return db.withdrawalRequest.findMany({
      select: {
        id: true,
        code: true,
        amount: true,
        financialUnitStatus: true,
        method: true,
        cardNumber: true,
        bankName: true,
        shebaNumber: true,
        status: true,
        requestedAt: true,
        processedAt: true,
        adminNotes: true,
        txnId: true,
        wallet: {
          select: {
            technician: {
              select: { user: { select: { name: true } } },
            },
          },
        },
      },
      orderBy: { requestedAt: "desc" },
    }).then((rows) => rows.map((row) => maskFinancialFields(row, ["amount"])));
  },
  reviews: async (db) => {
    const list = await db.review.findMany({
      include: { fromUser: { select: ADMIN_USER_SELECT }, technician: { include: { user: { select: ADMIN_USER_SELECT } } }, job: true },
      orderBy: { createdAt: "desc" },
    });
    return list.map((review) => ({
      ...review,
      job: review.job ? maskJobFinancialData(review.job) : review.job,
      technician: review.technician ? { ...review.technician, ...maskFinancialFields(review.technician, ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"]) } : review.technician,
    }));
  },
  vehicles: async (db) => {
    const list = await db.vehicle.findMany({
      include: { customer: { include: { user: { select: ADMIN_USER_SELECT } } } },
      orderBy: { createdAt: "desc" },
    });
    return list;
  },
  categories: async (db) => {
    const rows = await db.serviceCategory.findMany({ orderBy: { order: "asc" } });
    return rows.map((row) => maskFinancialFields(row, ["basePrice"]));
  },
  applications: async (db) => {
    const list = await db.mechanicApplication.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { select: { ...ADMIN_USER_SELECT, technician: true } } },
    });
    return list.map((application) => ({
      ...application,
      user: application.user?.technician
        ? { ...application.user, technician: maskFinancialFields(application.user.technician, ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"]) }
        : application.user,
    }));
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
