import { releaseWalletTransactionWithD1, type D1Binding, type D1PreparedStatement as ReleaseStatement } from "../../src/lib/wallet-release-d1";

type DueTransaction = { id: string; walletId: string };
type D1PreparedStatement = ReleaseStatement & {
  all: <T = unknown>() => Promise<{ results?: T[] }>;
};
type D1Database = Omit<D1Binding, "prepare"> & {
  prepare: (sql: string) => D1PreparedStatement;
};
type Env = { DB: D1Database };
type ScheduledController = { scheduledTime: number };
type ExecutionContext = { waitUntil: (promise: Promise<unknown>) => void };

async function releaseDueTransactions(env: Env, now: Date): Promise<void> {
  const due = await env.DB.prepare(`
    SELECT "id", "walletId"
    FROM "WalletTransaction"
    WHERE "status" = 'PENDING'
      AND "holdUntil" IS NOT NULL
      AND "holdUntil" <= ?
    ORDER BY "holdUntil" ASC
    LIMIT 100
  `).bind(now.toISOString()).all<DueTransaction>();

  let released = 0;
  let failed = 0;
  for (const transaction of due.results ?? []) {
    try {
      const didRelease = await releaseWalletTransactionWithD1(
        env.DB,
        transaction.walletId,
        transaction.id,
        now
      );
      if (didRelease) released += 1;
    } catch (error) {
      failed += 1;
      console.error("[wallet-escrow-release] transaction failed", {
        transactionId: transaction.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log("[wallet-escrow-release] run complete", {
    scanned: due.results?.length ?? 0,
    released,
    failed,
    at: now.toISOString(),
  });
}

const walletReleaseWorker = {
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(releaseDueTransactions(env, new Date(controller.scheduledTime)));
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
};

export default walletReleaseWorker;
