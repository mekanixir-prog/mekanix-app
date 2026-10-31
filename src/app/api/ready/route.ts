import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";

// GET /api/ready — readiness probe.
//
// Returns 503 if ANY required production safety gate fails OR the DB is
// unreachable. The safety gates mirror the contract documented in
// `.env.example` (lines 50-53) so the readiness probe is honest about
// non-production-ready configuration.
//
// CFG-01 fix (Agent 1 coordinator, Task ID: FIX-CFG-01):
//   Previously /api/ready ONLY checked the DB, so a Worker deployed with
//   SMS_PROVIDER=console / PAYMENT_PROVIDER=simulator / a file: DATABASE_URL
//   in production would still report ok=true. That masked misconfiguration.
//
// Safety gates (production only):
//   G1. SMS_PROVIDER === "console"            → 503 (no real OTP delivery)
//   G2. PAYMENT_PROVIDER === "simulator"       → 503 (no real payment path)
//   G3. DATABASE_URL starts with "file:"      → 503 (local SQLite in prod)
//
// These gates do NOT change the env values; they only report readiness.
// The owner activates real services by setting the env vars (SMS key,
// payment gateway, remote D1) — at which point /api/ready returns 200.
// ─────────────────────────────────────────────────────────────────────────────

type GateResult = { ok: boolean; reason?: string };

function checkProductionGates(): GateResult[] {
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) return []; // gates only apply in production

  const gates: GateResult[] = [];

  // G1 — SMS provider must not be the dev console logger.
  if (process.env.SMS_PROVIDER === "console" || !process.env.SMS_PROVIDER) {
    gates.push({
      ok: false,
      reason:
        "SMS_PROVIDER is 'console' (or unset) in production — OTPs are not delivered. Set a real provider (kavenegar|melipayamak|farapayamak).",
    });
  }

  // G2 — Payment provider must not be the simulator.
  // NOTE: payment routes already hard-404 in production (per-route guard), so
  // this gate is advisory — it surfaces the misconfiguration on the
  // readiness probe rather than letting a deploy silently ship without a
  // real gateway wired.
  if (process.env.PAYMENT_PROVIDER === "simulator" || !process.env.PAYMENT_PROVIDER) {
    gates.push({
      ok: false,
      reason:
        "PAYMENT_PROVIDER is 'simulator' (or unset) in production — no real payment gateway is wired.",
    });
  }

  // G3 — Database URL must not be a local file path in production.
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (dbUrl.startsWith("file:")) {
    gates.push({
      ok: false,
      reason:
        "DATABASE_URL points at a local SQLite file in production — use the D1 binding (or a remote Postgres URL).",
    });
  }

  return gates;
}

export async function GET() {
  const checks: Record<string, boolean> = {};
  const errors: string[] = [];

  // Production safety gates
  const gates = checkProductionGates();
  if (gates.length > 0) {
    const failed = gates.filter((g) => !g.ok);
    checks.productionGates = failed.length === 0;
    for (const g of failed) errors.push(`[gate] ${g.reason}`);
  }

  // DB check (always runs)
  try {
    const db = await getDbForLib();
    await db.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch (e: unknown) {
    checks.database = false;
    errors.push(e instanceof Error ? e.message : "DB check failed");
  }

  const ok = Object.values(checks).every(Boolean);
  return NextResponse.json(
    { ok, checks, errors, timestamp: new Date().toISOString() },
    { status: ok ? 200 : 503 }
  );
}
