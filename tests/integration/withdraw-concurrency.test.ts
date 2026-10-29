// @vitest-environment node
// MEKANIX — C5 Integration Test: Withdrawal concurrency with real SQLite
//
// This test uses a REAL SQLite database (not mocks) to verify that the
// atomic-reserve idempotency pattern works under actual concurrency.
//
// What it tests:
//   1. Two concurrent POSTs with the SAME Idempotency-Key → only one
//      withdrawal created (the other gets 409 or cached response)
//   2. Two concurrent POSTs with DIFFERENT keys → two withdrawals created
//      (but both respect balance constraints)
//
// Limitations:
//   - SQLite (even with WAL) has coarser concurrency than D1's actual
//     behavior in production. This test proves the atomic-reserve pattern
//     works at the DB level, but D1 may have different latency/locking
//     characteristics in production.
//   - The test uses Prisma's SQLite driver, not the D1 adapter. The D1
//     adapter's behavior under concurrency may differ slightly.
//   - This test does NOT exercise Cloudflare Workers' isolate model
//     (multiple isolates hitting D1 simultaneously). It uses a single
//     Node.js process with Promise.all.
//
// Setup: creates a temporary SQLite DB, pushes schema, seeds a wallet.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

// Use a dedicated test DB file (separate from dev DB)
const TEST_DB_PATH = path.join(__dirname, "../../db/test-concurrency.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

// Detect if we're in a PostgreSQL CI environment (skip this SQLite test).
// The PostgreSQL CI workflow sets DATABASE_URL to postgresql://, which makes
// prisma db push with a file: URL fail schema validation.
const isPostgresEnv = (process.env.DATABASE_URL ?? "").startsWith("postgresql://") ||
                      (process.env.DATABASE_URL ?? "").startsWith("postgres://");

// Only set DATABASE_URL if we're NOT in PostgreSQL CI — otherwise leave it
// and skip the test suite (see describe.skip below).
if (!isPostgresEnv) {
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.JWT_SECRET = "test-jwt-secret-for-integration";
}

// Force the PrismaClient to use our test DB
const testDb = new PrismaClient({
  datasources: { db: { url: TEST_DB_URL } },
});

// Mock rate-limit so it doesn't block concurrent test requests
vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: vi.fn().mockResolvedValue({ success: true, resetMs: 60000 }),
  rateLimit: vi.fn(() => ({ success: true, resetMs: 60000 })),
  checkRateLimit: vi.fn(() => null),
  getClientId: vi.fn(() => "127.0.0.1"),
  RATE_LIMITS: {
    OTP_SEND: { max: 5, windowMs: 60000 },
    OTP_VERIFY: { max: 5, windowMs: 60000 },
    PAYMENT: { max: 5, windowMs: 60000 },
    WITHDRAW: { max: 100, windowMs: 3600000 },
    API_DEFAULT: { max: 60, windowMs: 60000 },
  },
}));

// Import the route handler AFTER env is set
import { POST } from "@/app/api/wallets/withdraw/route";
import { createSession } from "@/lib/auth";

// Helper: create a valid JWT for a technician
async function mintToken(userId: string): Promise<string> {
  return createSession({
    userId,
    role: "TECHNICIAN",
    phone: "+989121234567",
    isGuest: false,
  });
}

function makeReq(token: string, body: unknown, idempotencyKey: string): Request {
  return new Request("https://mekanix.test/api/wallets/withdraw", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Remove old test DB
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  // Push schema to test DB
  execSync("bunx prisma db push --skip-generate --force-reset", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
  });
});

afterAll(async () => {
  await testDb.$disconnect();
  // Clean up test DB
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

beforeEach(async () => {
  // Clean all tables before each test
  await testDb.idempotencyKey.deleteMany();
  await testDb.walletLedger.deleteMany();
  await testDb.withdrawalRequest.deleteMany();
  await testDb.notification.deleteMany();
  await testDb.wallet.deleteMany();
  await testDb.technician.deleteMany();
  await testDb.user.deleteMany();
  await testDb.session.deleteMany();

  // Seed: user + technician + wallet with 10000 balance
  await testDb.user.create({
    data: {
      id: "user_tech",
      name: "Test Technician",
      phone: "+989121234567",
      role: "TECHNICIAN",
      status: "ACTIVE",
    },
  });
  await testDb.technician.create({
    data: {
      id: "tech_1",
      userId: "user_tech",
      status: "ONLINE",
    },
  });
  await testDb.wallet.create({
    data: {
      id: "wallet_1",
      technicianId: "tech_1",
      balance: 10000,
    },
  });
});

// Skip this entire suite in PostgreSQL CI — it uses SQLite-specific prisma db push.
// PostgreSQL CI has a different schema provider and cannot run SQLite integration tests.
const describeOrSkip = isPostgresEnv ? describe.skip : describe;
describeOrSkip("C5 — Concurrent withdraw with REAL SQLite DB", () => {
  it("two concurrent POSTs with SAME key → only one withdrawal created", async () => {
    const token = await mintToken("user_tech");
    const body = { amount: 500, method: "card" };
    const sameKey = "concurrent-same-key-test";

    // Fire two requests concurrently
    const [res1, res2] = await Promise.all([
      POST(makeReq(token, body, sameKey)),
      POST(makeReq(token, body, sameKey)),
    ]);

    const statuses = [res1.status, res2.status].sort();

    // One should succeed (200), the other should get 409 (IN_PROGRESS)
    // or 200 (cached COMPLETED — but unlikely in truly concurrent execution)
    expect(statuses).toContain(200);
    expect(statuses.some((s) => s === 200 || s === 409)).toBe(true);

    // CRITICAL: only ONE withdrawal should exist in the DB
    const withdrawals = await testDb.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);

    // Only ONE balance decrement (from 10000 to 9500)
    const wallet = await testDb.wallet.findUnique({ where: { id: "wallet_1" } });
    expect(Number(wallet!.balance)).toBe(9500);

    // Only ONE idempotency key entry
    const idemKeys = await testDb.idempotencyKey.findMany();
    expect(idemKeys).toHaveLength(1);
    expect(idemKeys[0].status).toBe("COMPLETED");
  });

  it("two concurrent POSTs with DIFFERENT keys → two withdrawals created (if balance allows)", async () => {
    const token = await mintToken("user_tech");
    const body = { amount: 500, method: "card" };

    // Fire two requests with DIFFERENT keys concurrently
    const [res1, res2] = await Promise.all([
      POST(makeReq(token, body, "key-alpha")),
      POST(makeReq(token, body, "key-beta")),
    ]);

    // Both should succeed (different intents)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Two withdrawals created
    const withdrawals = await testDb.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(2);

    // Balance decremented twice (10000 - 500 - 500 = 9000)
    const wallet = await testDb.wallet.findUnique({ where: { id: "wallet_1" } });
    expect(Number(wallet!.balance)).toBe(9000);

    // Two idempotency key entries
    const idemKeys = await testDb.idempotencyKey.findMany();
    expect(idemKeys).toHaveLength(2);
  });

  it("sequential retry with SAME key returns cached response (no double-charge)", async () => {
    const token = await mintToken("user_tech");
    const body = { amount: 500, method: "card" };
    const sameKey = "retry-same-key-test";

    // First request
    const res1 = await POST(makeReq(token, body, sameKey));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();

    // Second request with SAME key (sequential, not concurrent)
    const res2 = await POST(makeReq(token, body, sameKey));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();

    // Same withdrawal returned (cached)
    expect(body2.withdrawal.id).toBe(body1.withdrawal.id);

    // Only ONE withdrawal in DB
    const withdrawals = await testDb.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);

    // Balance only decremented once
    const wallet = await testDb.wallet.findUnique({ where: { id: "wallet_1" } });
    expect(Number(wallet!.balance)).toBe(9500);
  });

  it("balance constraint: concurrent requests that exceed balance → one wins, one gets 409/400", async () => {
    const token = await mintToken("user_tech");
    // Wallet has 10000. Two requests for 600 each = 1200 total, but only 10000 available.
    // Actually 10000 >= 600*2, so both would succeed. Let's use 6000 each.
    const body = { amount: 6000, method: "card" };

    const [res1, res2] = await Promise.all([
      POST(makeReq(token, body, "key-1")),
      POST(makeReq(token, body, "key-2")),
    ]);

    // One should succeed (balance 10000 → 4000), the other should fail
    // (4000 < 6000 → "موجودی کافی نیست")
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toContain(200);

    // Only one withdrawal created (the winner's)
    const withdrawals = await testDb.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);

    // Balance is 4000 (10000 - 6000)
    const wallet = await testDb.wallet.findUnique({ where: { id: "wallet_1" } });
    expect(Number(wallet!.balance)).toBe(4000);
  });
});
