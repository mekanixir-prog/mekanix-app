import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";

// GET /api/ready — readiness probe.
// Keep detailed diagnostics out of production HTTP responses. The boolean
// checks are sufficient for orchestrators; local development retains details.
type GateResult = { ok: boolean; reason?: string };

function checkProductionGates(): GateResult[] {
  if (process.env.NODE_ENV !== "production") return [];

  const gates: GateResult[] = [];
  if (process.env.SMS_PROVIDER === "console" || !process.env.SMS_PROVIDER) {
    gates.push({
      ok: false,
      reason: "SMS provider is not configured for production.",
    });
  }
  if (process.env.PAYMENT_PROVIDER === "simulator" || !process.env.PAYMENT_PROVIDER) {
    gates.push({
      ok: false,
      reason: "Payment provider is not configured for production.",
    });
  }
  if ((process.env.DATABASE_URL ?? "").startsWith("file:")) {
    gates.push({
      ok: false,
      reason: "Production database configuration points to a local file.",
    });
  }
  return gates;
}

export async function GET() {
  const isProd = process.env.NODE_ENV === "production";
  const checks: Record<string, boolean> = {};
  const diagnostics: string[] = [];

  const gates = checkProductionGates();
  if (gates.length > 0) {
    checks.productionGates = gates.every((gate) => gate.ok);
    diagnostics.push(...gates.filter((gate) => !gate.ok).map((gate) => gate.reason ?? "Production gate failed."));
  }

  try {
    const db = await getDbForLib();
    await db.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch (error: unknown) {
    checks.database = false;
    diagnostics.push(error instanceof Error ? error.message : "DB check failed");
  }

  const ok = Object.values(checks).every(Boolean);
  const errors = isProd
    ? (ok ? [] : ["Readiness checks failed."])
    : diagnostics;

  return NextResponse.json(
    { ok, checks, errors, timestamp: new Date().toISOString() },
    { status: ok ? 200 : 503 }
  );
}
