import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getSmsProviderStatus } from "@/lib/sms-provider";
import { getPaymentProviderStatus } from "@/lib/payment-provider";

type GateResult = { ok: boolean; reason: string };

/**
 * Production-only release gates. Provider-name presence is not sufficient:
 * credentials must be complete, the adapter must be implemented, and the
 * production checkout routes must actually be wired before readiness is green.
 */
export function checkProductionGates(): GateResult[] {
  if (process.env.NODE_ENV !== "production") return [];

  const gates: GateResult[] = [];
  const sms = getSmsProviderStatus();
  const payment = getPaymentProviderStatus();

  if (!sms.liveReady) {
    gates.push({
      ok: false,
      reason: `SMS provider is not live-ready (${sms.provider}): ${sms.warnings.join("; ") || "provider configuration is incomplete"}.`,
    });
  }

  if (!payment.liveReady) {
    gates.push({
      ok: false,
      reason: `Payment provider is not live-ready (${payment.provider}): ${payment.warnings.join("; ") || "production checkout integration is not wired"}.`,
    });
  }

  const dbUrl = process.env.DATABASE_URL ?? "";
  if (dbUrl.startsWith("file:")) {
    gates.push({
      ok: false,
      reason: "DATABASE_URL points at a local SQLite file in production — use the D1 binding or a remote PostgreSQL URL.",
    });
  }

  return gates;
}

export async function GET() {
  const checks: Record<string, boolean> = {};
  const errors: string[] = [];

  if (process.env.NODE_ENV === "production") {
    const gates = checkProductionGates();
    checks.productionGates = gates.every((gate) => gate.ok);
    for (const gate of gates) {
      if (!gate.ok) errors.push(`[gate] ${gate.reason}`);
    }
  }

  try {
    const db = await getDbForLib();
    await db.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch (error: unknown) {
    checks.database = false;
    errors.push(error instanceof Error ? error.message : "DB check failed");
  }

  const ok = Object.values(checks).every(Boolean);
  return NextResponse.json(
    {
      ok,
      checks,
      errors,
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 }
  );
}
