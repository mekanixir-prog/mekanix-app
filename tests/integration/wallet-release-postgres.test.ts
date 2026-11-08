// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";
import { releaseWalletTransactionWithPrisma } from "@/lib/wallet-release";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("wallet escrow release PostgreSQL transaction integration", () => {
  const runId = crypto.randomUUID().replace(/-/g, "");
  let db: Awaited<ReturnType<typeof getDbForLib>> | null = null;
  const userIds: string[] = [];
  const technicianIds: string[] = [];
  const walletIds: string[] = [];
  const transactionIds: string[] = [];
  const ledgerKeys: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    db = await getDbForLib();
  });

  afterAll(async () => {
    if (db) {
      if (ledgerKeys.length) {
        await db.walletLedger.deleteMany({ where: { idempotencyKey: { in: ledgerKeys } } });
      }
      if (transactionIds.length) {
        await db.walletTransaction.deleteMany({ where: { id: { in: transactionIds } } });
      }
      if (walletIds.length) {
        await db.wallet.deleteMany({ where: { id: { in: walletIds } } });
      }
      if (technicianIds.length) {
        await db.technician.deleteMany({ where: { id: { in: technicianIds } } });
      }
      if (userIds.length) {
        await db.user.deleteMany({ where: { id: { in: userIds } } });
      }
    }
    vi.unstubAllEnvs();
  });

  async function makeDueTransaction(suffix: string, netAmount = 1000, pendingBalance = 1000, balance = 2000) {
    const user = await db!.user.create({
      data: {
        name: `Wallet Release PostgreSQL Test ${suffix}`,
        phone: `+9894${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`,
        role: "TECHNICIAN",
      },
    });
    userIds.push(user.id);
    const technician = await db!.technician.create({ data: { userId: user.id } });
    technicianIds.push(technician.id);
    const wallet = await db!.wallet.create({
      data: { technicianId: technician.id, balance, pendingBalance, financialUnitStatus: "VERIFIED_IRR" },
    });
    walletIds.push(wallet.id);
    const transaction = await db!.walletTransaction.create({
      data: {
        walletId: wallet.id,
        kind: "PREPAY",
        status: "PENDING",
        financialUnitStatus: "VERIFIED_IRR",
        grossAmount: netAmount,
        commissionAmount: 0,
        netAmount,
        holdUntil: new Date("2026-10-31T23:00:00.000Z"),
        description: `PostgreSQL escrow release test ${suffix}`,
        idempotencyKey: `wallet-release-pg:${runId}:${suffix}`,
      },
    });
    transactionIds.push(transaction.id);
    const ledgerKey = `wallet-release:${transaction.id}:LEDGER`;
    ledgerKeys.push(ledgerKey);
    return { walletId: wallet.id, transactionId: transaction.id, ledgerKey };
  }

  async function withLedgerFailureTrigger(key: string, action: () => Promise<void>) {
    const token = crypto.randomUUID().replace(/-/g, "");
    const functionName = `test_wallet_release_fail_${token}`;
    const triggerName = `test_wallet_release_fail_trigger_${token}`;
    await db!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected RELEASE ledger failure'; END;
      $$ LANGUAGE plpgsql;
    `);
    await db!.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "WalletLedger"
      FOR EACH ROW WHEN (NEW."idempotencyKey" = '${key}')
      EXECUTE FUNCTION "${functionName}"();
    `);
    try {
      await action();
    } finally {
      await db!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "WalletLedger"`);
      await db!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  }

  const releaseAt = new Date("2026-11-01T06:00:00.000Z");

  it("releases once under 50 concurrent retries and writes exactly one RELEASE ledger proof", async () => {
    const fixture = await makeDueTransaction("concurrent");
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        releaseWalletTransactionWithPrisma(db!, fixture.walletId, fixture.transactionId, releaseAt)
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const walletAfterRelease = await db!.wallet.findUnique({
      where: { id: fixture.walletId },
      select: { balance: true, pendingBalance: true },
    });
    expect(Number(walletAfterRelease?.balance)).toBe(3000);
    expect(Number(walletAfterRelease?.pendingBalance)).toBe(0);
    expect(await db!.walletTransaction.findUnique({
      where: { id: fixture.transactionId },
      select: { status: true, releasedAt: true },
    })).toEqual({ status: "AVAILABLE", releasedAt: releaseAt });
    expect(await db!.walletLedger.count({ where: { idempotencyKey: fixture.ledgerKey } })).toBe(1);
    const ledger = await db!.walletLedger.findUnique({ where: { idempotencyKey: fixture.ledgerKey } });
    expect(ledger).toMatchObject({
      walletId: fixture.walletId,
      type: "RELEASE",
      referenceType: "WalletTransaction",
      referenceId: fixture.transactionId,
    });
    expect(Number(ledger?.amount)).toBe(1000);
    expect(Number(ledger?.balanceBefore)).toBe(2000);
    expect(Number(ledger?.balanceAfter)).toBe(3000);
    await expect(releaseWalletTransactionWithPrisma(
      db!, fixture.walletId, fixture.transactionId, releaseAt
    )).resolves.toBe(false);
  });

  it("rolls back the balance and AVAILABLE transition when RELEASE ledger insertion fails", async () => {
    const fixture = await makeDueTransaction("ledger-failure");
    await withLedgerFailureTrigger(fixture.ledgerKey, async () => {
      await expect(releaseWalletTransactionWithPrisma(
        db!, fixture.walletId, fixture.transactionId, releaseAt
      )).rejects.toThrow("injected RELEASE ledger failure");
    });

    const walletAfterRollback = await db!.wallet.findUnique({
      where: { id: fixture.walletId },
      select: { balance: true, pendingBalance: true },
    });
    expect(Number(walletAfterRollback?.balance)).toBe(2000);
    expect(Number(walletAfterRollback?.pendingBalance)).toBe(1000);
    expect(await db!.walletTransaction.findUnique({
      where: { id: fixture.transactionId },
      select: { status: true, releasedAt: true },
    })).toEqual({ status: "PENDING", releasedAt: null });
    expect(await db!.walletLedger.count({ where: { idempotencyKey: fixture.ledgerKey } })).toBe(0);
  });

  it("leaves the transaction PENDING when the wallet pending balance is insufficient", async () => {
    const fixture = await makeDueTransaction("insufficient", 1000, 100);
    await expect(releaseWalletTransactionWithPrisma(
      db!, fixture.walletId, fixture.transactionId, releaseAt
    )).rejects.toThrow("escrow release rolled back");
    const walletAfterEdgeCase = await db!.wallet.findUnique({
      where: { id: fixture.walletId },
      select: { balance: true, pendingBalance: true },
    });
    expect(Number(walletAfterEdgeCase?.balance)).toBe(2000);
    expect(Number(walletAfterEdgeCase?.pendingBalance)).toBe(100);
    expect(await db!.walletTransaction.findUnique({
      where: { id: fixture.transactionId },
      select: { status: true },
    })).toEqual({ status: "PENDING" });
    expect(await db!.walletLedger.count({ where: { idempotencyKey: fixture.ledgerKey } })).toBe(0);
  });

  it("does not release escrow into a negative available wallet balance", async () => {
    const fixture = await makeDueTransaction("negative-wallet", 1000, 1000, -100);
    await expect(releaseWalletTransactionWithPrisma(
      db!, fixture.walletId, fixture.transactionId, releaseAt
    )).rejects.toThrow("escrow release rolled back");
    const walletAfterNegativeBalance = await db!.wallet.findUnique({
      where: { id: fixture.walletId },
      select: { balance: true, pendingBalance: true },
    });
    expect(Number(walletAfterNegativeBalance?.balance)).toBe(-100);
    expect(Number(walletAfterNegativeBalance?.pendingBalance)).toBe(1000);
    expect(await db!.walletTransaction.findUnique({ where: { id: fixture.transactionId }, select: { status: true } })).toEqual({ status: "PENDING" });
    expect(await db!.walletLedger.count({ where: { idempotencyKey: fixture.ledgerKey } })).toBe(0);
  });

  it("does not release a negative net amount", async () => {
    const fixture = await makeDueTransaction("negative", -100, 100);
    await expect(releaseWalletTransactionWithPrisma(
      db!, fixture.walletId, fixture.transactionId, releaseAt
    )).resolves.toBe(false);
    const walletAfterNegative = await db!.wallet.findUnique({
      where: { id: fixture.walletId },
      select: { balance: true, pendingBalance: true },
    });
    expect(Number(walletAfterNegative?.balance)).toBe(2000);
    expect(Number(walletAfterNegative?.pendingBalance)).toBe(100);
    expect(await db!.walletTransaction.findUnique({
      where: { id: fixture.transactionId },
      select: { status: true },
    })).toEqual({ status: "PENDING" });
    expect(await db!.walletLedger.count({ where: { idempotencyKey: fixture.ledgerKey } })).toBe(0);
  });
});
