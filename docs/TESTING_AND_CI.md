# MEKANIX — Testing & CI Guide

**Last Updated:** 2026-10-11  
**Commit:** `7109d65`

## Local Testing Commands

### TypeScript Check
```bash
bunx tsc --noEmit
# Expected: exit 0
```

### ESLint
```bash
NODE_OPTIONS="--max-old-space-size=8192" npx eslint src/
# Expected: 0 errors, 2 warnings (unused eslint-disable directives)
```

### Unit + Integration Tests
```bash
bun run test
# Expected: 335 tests passed (13 test files)
```

### Hygiene Check
```bash
bash scripts/check-hygiene.sh
# Expected: "✅ Repository hygiene is clean."
```

### Full Local CI (all checks)
```bash
bun run check:repo
# Runs: lint + tsc + hygiene
```

## Test Categories

### Unit Tests (`tests/unit/`)
- `session-lifecycle.test.ts` — 26 tests (session create, verify, revoke)
  - Includes fail-closed tests for production mode
  - Includes fail-hard tests for revocation
- `care-auth.test.ts` — 45 tests
- `service-unified.test.ts` — tests for unified service layer

### E2E Tests (`tests/browser/`)
- Playwright-based browser tests (require `bun run dev` running)
- `login.spec.ts`, `home.spec.ts`, `navigation.spec.ts`, `health.spec.ts`

### Failure Scenarios (`tests/e2e/`)
- `failure-scenarios.test.ts` — 28 tests
  - DB failure handling
  - Redis fallback
  - SMS provider fallback
  - Payment simulator
  - Idempotency

## GitHub Actions Workflows

### CI (`.github/workflows/ci.yml`)
- **Trigger:** push/PR to `main`
- **Steps:** install → prisma generate → hygiene → ESLint → TypeScript → tests
- **Timeout:** 15 minutes

### PostgreSQL CI (`.github/workflows/postgresql-ci.yml`)
- **Trigger:** push/PR to `main`
- **Steps:** PostgreSQL service → migrate → test
- **Timeout:** 20 minutes

### Production Readiness (`.github/workflows/production-readiness.yml`)
- **Trigger:** push/PR to `main`, `hardening/**`
- **Steps:** install → generate → hygiene → ESLint → TypeScript → tests → security audit → build
- **Timeout:** 20 minutes

### Docker E2E (`.github/workflows/docker-e2e.yml`)
- **Trigger:** push/PR to `main`
- **Steps:** Docker build → compose → health check
- **Timeout:** 30 minutes

## Important Notes

- **Local vs CI:** Local results are reported by the developer. CI results are
  independently verified on GitHub Actions. Only CI results are authoritative.
- **Test count:** 335 tests as of commit `7109d65`. This number changes with
  each commit — always run `bun run test` to get current count.
- **ESLint memory:** ESLint may OOM on machines with <4GB RAM. Use
  `NODE_OPTIONS="--max-old-space-size=8192"` if needed.
- **Prisma Client:** Must run `bunx prisma generate` before TypeScript check
  if schema.prisma was modified.

## Cloudflare Workers Testing

### Build + Run
```bash
bash scripts/build-cloudflare.sh
bunx wrangler dev --local --port 8800
```

### Quick Smoke Test
```bash
curl http://localhost:8800/api/health
curl http://localhost:8800/api/ready
```

### OTP Flow Test
```bash
# Send OTP
curl -X POST http://localhost:8800/api/auth/otp/send \
  -H "Content-Type: application/json" \
  -d '{"phone":"+989121234567"}'

# Check console for code (DEV SMS log)
# Then verify
curl -X POST http://localhost:8800/api/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"phone":"+989121234567","code":"<code>"}'
```
