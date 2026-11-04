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

  const jwtSecret = process.env.JWT_SECRET ?? "";
  const adminJwtSecret = process.env.ADMIN_JWT_SECRET ?? "";
  if (new TextEncoder().encode(jwtSecret).length < 32) {
    gates.push({
      ok: false,
      reason: "JWT_SECRET is missing or shorter than 32 bytes.",
    });
  }
  if (new TextEncoder().encode(adminJwtSecret).length < 32) {
    gates.push({
      ok: false,
      reason: "ADMIN_JWT_SECRET is missing or shorter than 32 bytes.",
    });
  }

  const otpHashSecret = process.env.OTP_HASH_SECRET ?? "";
  if (new TextEncoder().encode(otpHashSecret).length < 32) {
    gates.push({
      ok: false,
      reason: "Dedicated OTP_HASH_SECRET is missing or shorter than 32 bytes.",
    });
  }

  // Financial release gates are intentionally independent of provider health.
  // A healthy database/provider must never make legacy or unapproved money
  // paths appear production-ready.
  if (process.env.MEKANIX_PRICING_IRR_APPROVED !== "true") {
    gates.push({
      ok: false,
      reason: "IRR pricing policy has not been explicitly approved.",
    });
  }

  if (process.env.MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED !== "true") {
    gates.push({
      ok: false,
      reason: "Legacy technician fee units have not been reconciled and verified as IRR.",
    });
  }

  // Conservative gate: legacy JobPart rows may not carry reliable currency
  // provenance. Do not infer their unit from locale or historical display.
  if (process.env.MEKANIX_JOB_PART_IRR_PROVENANCE_VERIFIED !== "true") {
    gates.push({
      ok: false,
      reason: "Legacy job-part prices have not been reconciled and verified as IRR.",
    });
  }

  const minWithdrawalIrr = Number(process.env.MEKANIX_WITHDRAWAL_MIN_IRR);
  const maxWithdrawalIrr = Number(process.env.MEKANIX_WITHDRAWAL_MAX_IRR);
  const withdrawalPolicyValid =
    process.env.MEKANIX_WITHDRAWAL_IRR_POLICY_APPROVED === "true" &&
    Number.isSafeInteger(minWithdrawalIrr) &&
    Number.isSafeInteger(maxWithdrawalIrr) &&
    minWithdrawalIrr > 0 &&
    maxWithdrawalIrr >= minWithdrawalIrr;

  if (!withdrawalPolicyValid) {
    gates.push({
      ok: false,
      reason: "Owner-approved integer-IRR withdrawal limits are missing or invalid.",
    });
  }

  if (process.env.MEKANIX_WITHDRAWAL_IRR_PROVENANCE_VERIFIED !== "true") {
    gates.push({
      ok: false,
      reason: "Historical withdrawal records have not been reconciled to integer IRR.",
    });
  }

  if (process.env.WALLET_RELEASE_SCHEDULED !== "true") {
    gates.push({
      ok: false,
      reason: "Scheduled escrow release worker has not been deployed and verified.",
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
    const detail = error instanceof Error ? error.message : "DB check failed";
    console.error("[ready] Database readiness check failed", { detail });
    errors.push(
      process.env.NODE_ENV === "production"
        ? "Database is unavailable"
        : detail
    );
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
