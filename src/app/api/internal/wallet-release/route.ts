import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { releaseWalletTransaction } from "@/lib/wallet-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RELEASES_PER_RUN = 100;

async function getConfiguredCronSecret(): Promise<string | undefined> {
  const isWorker = typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers";
  if (!isWorker) return process.env.CRON_SECRET;

  // Read Worker secrets from the actual environment binding. This avoids
  // depending on process.env compatibility behavior across Wrangler dates.
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const context = await getCloudflareContext({ async: true });
  return (context.env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
}

async function constantTimeSecretMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

/**
 * POST /api/internal/wallet-release
 * Intended for a trusted scheduler only. Never expose the cron secret to clients.
 * Each escrow release is independently atomic and safe to retry.
 */
export async function POST(req: Request) {
  const expected = await getConfiguredCronSecret();
  if (!expected || expected.length < 32) {
    return NextResponse.json({ error: "Scheduled wallet release is not configured" }, { status: 503 });
  }

  const authorization = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match || !(await constantTimeSecretMatch(match[1], expected))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const db = await getDbForLib();
  const pending = await db.walletTransaction.findMany({
    where: {
      status: "PENDING",
      holdUntil: { not: null, lte: now },
    },
    orderBy: [{ holdUntil: "asc" }, { createdAt: "asc" }],
    take: MAX_RELEASES_PER_RUN,
    select: { id: true, walletId: true },
  });

  let released = 0;
  let skipped = 0;
  for (const transaction of pending) {
    // A competing scheduler may win the conditional transition; false is safe.
    const changed = await releaseWalletTransaction(
      db,
      transaction.walletId,
      transaction.id,
      now
    );
    if (changed) released++;
    else skipped++;
  }

  return NextResponse.json({
    ok: true,
    scanned: pending.length,
    released,
    skipped,
    hasMore: pending.length === MAX_RELEASES_PER_RUN,
  });
}
