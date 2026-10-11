# MEKANIX — Database Migration Guide

**Last Updated:** 2026-10-11  
**Commit:** `7109d65`

## Architecture

### Dev (Node.js)
- **Database:** SQLite (`db/custom.db`)
- **Client:** `PrismaClient` (rust engine)
- **Access:** Sync `db` from `src/lib/db.ts`

### Production (Cloudflare Workers)
- **Database:** Cloudflare D1 (SQLite-based)
- **Client:** `PrismaClient` with `PrismaD1` adapter
- **Access:** Async `getDbForLib()` from `src/lib/db-access.ts`

### How `getDbForLib()` Works

```
getDbForLib()
  ├── Workers runtime → getDb() → getCloudflareContext() → PrismaD1(env.DB)
  │   └── Cached per-request via Symbol on ctx object
  └── Dev runtime → import { db } from "./db" → PrismaClient (rust engine)
      └── Cached in module-level devDb variable
```

## D1 Limitations

1. **No `$transaction`** — D1 does not support Prisma transactions.
   - Multi-step writes are sequential `await db.X()` calls.
   - If step N fails, steps 1..N-1 persist (no rollback).
   - `$transaction` appears in 10 files but ONLY in comments.

2. **No `fs.readFileSync`** — Workers runtime uses `unenv` which stubs `fs`.
   - Solved by `engineType = "client"` in schema (during build only).
   - Solved by `serverExternalPackages` in `next.config.worker.ts`.

3. **Single-writer model** — D1 executes queries serially per database.
   - Not suitable for high-concurrency write workloads.
   - Optimistic concurrency (`updateMany` with `where` conditions) is the pattern.

4. **No native `batch()`** — D1 has `batch()` but Prisma adapter doesn't expose it.
   - Sequential writes are the only option through Prisma.

## Build Process

### Normal Build (Node.js / Docker)
```bash
bun run build
# Uses original schema.prisma (no engineType)
# Uses next.config.ts (output: "standalone")
# Uses src/lib/db.ts (PrismaClient without adapter)
```

### Cloudflare Worker Build
```bash
bash scripts/build-cloudflare.sh
```

This script:
1. Backs up `schema.prisma`, `next.config.ts`, `src/lib/db.ts`
2. Adds `engineType = "client"` to schema
3. Swaps `next.config.ts` → `next.config.worker.ts`
4. Swaps `db.ts` → `db.worker.ts`
5. Generates Prisma Client
6. Applies OpenNext PR #1356 patch (preview-props.json)
7. Runs `opennextjs-cloudflare build`
8. Restores original files (via `trap EXIT`)

## Migration SQL Generation

```bash
# Generate SQL from current schema
bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > migration.sql

# Apply to local D1 (miniflare)
bunx wrangler d1 execute mekanix --local --file=migration.sql

# Apply to remote D1 (PRODUCTION — requires explicit approval)
# bunx wrangler d1 execute mekanix --remote --file=migration.sql
```

## Optimistic Concurrency Pattern

Used in: `payments`, `prepay`, `wallets/withdraw`, `care/technician/missions/[id]`

```typescript
// Instead of non-atomic read-then-write:
const item = await db.X.findUnique({ where: { id } });
if (item.status !== "PAID") {
  await db.X.update({ where: { id }, data: { status: "PAID" } });
}

// Use atomic conditional update:
const result = await db.X.updateMany({
  where: { id, status: { not: "PAID" } },
  data: { status: "PAID" },
});
if (result.count === 0) {
  // Race condition: another request already updated
  return NextResponse.json({ error: "Already processed" }, { status: 409 });
}
```

## Environment Variables

### `.dev.vars` (local, gitignored)
```
JWT_SECRET=<your-dev-secret>
DATABASE_URL=file:./db/custom.db
```

### `wrangler.toml [vars]` (non-secret config)
```toml
SMS_PROVIDER = "console"
PAYMENT_PROVIDER = "simulator"
NODE_ENV = "production"
```

### `wrangler secret put` (production secrets)
```
JWT_SECRET
DATABASE_URL (if needed)
```

## Inventory

See `docs/d1-migration-inventory.json` for the machine-readable inventory.
See `docs/d1-migration-plan.md` for the migration progress summary.

## Verification Steps

1. **Local dev:** `bun run dev` → test endpoints on localhost:3000
2. **Workers local:** `bash scripts/build-cloudflare.sh` + `wrangler dev --local`
3. **Staging:** `wrangler deploy` → test on staging URL
4. **Production:** After all checks pass + explicit approval
