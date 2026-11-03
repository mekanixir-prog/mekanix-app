import { releaseWalletTransactionWithD1, type D1Binding, type D1PreparedStatement as ReleaseStatement } from "../../src/lib/wallet-release-d1";

type DueTransaction = { id: string; walletId: string; holdUntil: string };
type CursorState = { cursorHoldUntil: string | null; cursorId: string | null };
type D1PreparedStatement = Omit<ReleaseStatement, "bind"> & {
  bind: (...values: unknown[]) => D1PreparedStatement;
  all: <T = unknown>() => Promise<{ results?: T[] }>;
  first: <T = unknown>() => Promise<T | null>;
  run: () => Promise<{ meta?: { changes?: number } }>;
};
type D1Database = Omit<D1Binding, "prepare"> & {
  prepare: (sql: string) => D1PreparedStatement;
};
type Env = { DB: D1Database };
type ScheduledController = { scheduledTime: number };
type ExecutionContext = { waitUntil: (promise: Promise<unknown>) => void };

const PAGE_SIZE = 100;
const MAX_PER_RUN = 1_000;
const CURSOR_ID = "wallet-release";

async function releaseDueTransactions(env: Env, now: Date): Promise<void> {
  const savedState = await env.DB.prepare(`
    SELECT "cursorHoldUntil", "cursorId"
    FROM "WalletReleaseWorkerState"
    WHERE "id" = ?
  `).bind(CURSOR_ID).first<CursorState>();

  let cursor: { holdUntil: string; id: string } | null =
    savedState?.cursorHoldUntil && savedState.cursorId
      ? { holdUntil: String(savedState.cursorHoldUntil), id: savedState.cursorId }
      : null;

  let scanned = 0;
  let released = 0;
  let unchanged = 0;
  let failed = 0;

  // The cursor is persisted between Cron runs. A permanently failing early
  // transaction therefore cannot pin every run to the same first 1,000 rows.
  while (scanned < MAX_PER_RUN) {
    const limit = Math.min(PAGE_SIZE, MAX_PER_RUN - scanned);
    const query = cursor
      ? `
        SELECT "id", "walletId", "holdUntil"
        FROM "WalletTransaction"
        WHERE "status" = 'PENDING'
          AND "holdUntil" IS NOT NULL
          AND "holdUntil" <= ?
          AND ("holdUntil" > ? OR ("holdUntil" = ? AND "id" > ?))
        ORDER BY "holdUntil" ASC, "id" ASC
        LIMIT ?
      `
      : `
        SELECT "id", "walletId", "holdUntil"
        FROM "WalletTransaction"
        WHERE "status" = 'PENDING'
          AND "holdUntil" IS NOT NULL
          AND "holdUntil" <= ?
        ORDER BY "holdUntil" ASC, "id" ASC
        LIMIT ?
      `;

    const statement = env.DB.prepare(query);
    const page = cursor
      ? await statement.bind(
          now.toISOString(), cursor.holdUntil, cursor.holdUntil, cursor.id, limit
        ).all<DueTransaction>()
      : await statement.bind(now.toISOString(), limit).all<DueTransaction>();
    const rows = page.results ?? [];

    if (rows.length === 0) {
      // We reached the end of the current keyset cycle. Reset so the next
      // Cron run picks up any still-pending failures and newly matured rows.
      cursor = null;
      break;
    }

    for (const transaction of rows) {
      cursor = { holdUntil: transaction.holdUntil, id: transaction.id };
      scanned += 1;
      try {
        const didRelease = await releaseWalletTransactionWithD1(
          env.DB,
          transaction.walletId,
          transaction.id,
          now
        );
        if (didRelease) released += 1;
        else unchanged += 1;
      } catch (error) {
        failed += 1;
        console.error("[wallet-escrow-release] transaction failed", {
          transactionId: transaction.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (rows.length < limit) {
      // All rows after this cursor were exhausted. Start a fresh cycle next run.
      cursor = null;
      break;
    }
  }

  await env.DB.prepare(`
    INSERT INTO "WalletReleaseWorkerState"
      ("id", "cursorHoldUntil", "cursorId", "updatedAt")
    VALUES (?, ?, ?, ?)
    ON CONFLICT("id") DO UPDATE SET
      "cursorHoldUntil" = excluded."cursorHoldUntil",
      "cursorId" = excluded."cursorId",
      "updatedAt" = excluded."updatedAt"
  `).bind(
    CURSOR_ID,
    cursor?.holdUntil ?? null,
    cursor?.id ?? null,
    now.toISOString()
  ).run();

  console.log("[wallet-escrow-release] run complete", {
    scanned,
    released,
    unchanged,
    failed,
    pageLimit: PAGE_SIZE,
    maxPerRun: MAX_PER_RUN,
    limitReached: scanned === MAX_PER_RUN,
    nextCursor: cursor?.id ?? null,
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
